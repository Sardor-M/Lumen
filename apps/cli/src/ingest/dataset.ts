import { readFileSync, statSync, existsSync } from 'node:fs';
import { extname, basename, dirname, join } from 'node:path';
import type { ExtractionResult } from '../types/index.js';
import { IngestError, errorFromStatus } from './errors.js';

/** How many rows we sample for type inference and the preview table. */
const PREVIEW_ROWS = 20;
/** How many rows we scan from the head for schema inference only. */
const SCHEMA_SAMPLE_ROWS = 500;

type DatasetFormat = 'csv' | 'jsonl' | 'parquet' | 'huggingface';

type ColumnStats = {
    name: string;
    inferred_type: 'integer' | 'float' | 'boolean' | 'string' | 'null';
    null_count: number;
    sample_values: unknown[];
};

/**
 * Ingest a tabular dataset — CSV, JSONL, Parquet, or a HuggingFace dataset URL.
 * Produces one markdown document with the optional dataset card, a schema table,
 * and the first 20 rows rendered as markdown.
 */
export async function extractDataset(input: string): Promise<ExtractionResult> {
    if (isHuggingFaceUrl(input)) return extractHuggingFace(input);
    return extractLocalDataset(input);
}

function extractLocalDataset(path: string): ExtractionResult {
    if (!existsSync(path)) throw new IngestError('NOT_FOUND', `Dataset not found: ${path}`);
    const stat = statSync(path);
    if (!stat.isFile()) {
        throw new IngestError('MALFORMED', `Dataset source must be a file: ${path}`);
    }

    const format = detectDatasetFormat(path);
    if (format === 'parquet') {
        throw new IngestError('MALFORMED', `Parquet is not supported natively: ${path}`, {
            hint: "Convert with duckdb: `duckdb -c \"COPY (SELECT * FROM 'file.parquet') TO 'file.csv'\"` or use a CSV export.",
        });
    }

    const { rows, columnNames } = format === 'jsonl' ? parseJsonl(path) : parseCsv(path);
    if (rows.length === 0) {
        throw new IngestError('NO_CONTENT', `Dataset is empty: ${path}`);
    }

    const stats = inferSchema(rows, columnNames);
    const title = basename(path)
        .replace(/\.(csv|jsonl|parquet)$/i, '')
        .replace(/[-_]/g, ' ');
    const card = loadColocatedCard(path);
    const content = renderDataset({
        title,
        card,
        stats,
        rows,
        totalRows: rows.length,
        format,
    });

    return {
        title,
        content,
        url: null,
        source_type: 'dataset',
        language: null,
        metadata: {
            path,
            format,
            row_count: rows.length,
            column_count: stats.length,
            schema: stats.map((s) => ({
                name: s.name,
                type: s.inferred_type,
                null_count: s.null_count,
            })),
            has_card: card !== null,
        },
    };
}

async function extractHuggingFace(url: string): Promise<ExtractionResult> {
    const datasetId = parseHuggingFaceDatasetId(url);
    if (!datasetId) {
        throw new IngestError('MALFORMED', `Not a HuggingFace dataset URL: ${url}`);
    }

    /** `https://huggingface.co/api/datasets/{id}` returns the card + metadata in JSON. */
    const apiUrl = `https://huggingface.co/api/datasets/${datasetId}`;
    let res: Response;
    try {
        res = await fetch(apiUrl, { signal: AbortSignal.timeout(15000) });
    } catch (err) {
        throw new IngestError(
            'NETWORK',
            `Failed to fetch HuggingFace dataset: ${err instanceof Error ? err.message : err}`,
            {
                retryable: true,
            },
        );
    }
    if (!res.ok) throw errorFromStatus(res.status, apiUrl);

    const json = (await res.json()) as Record<string, unknown>;
    const cardData =
        typeof json.cardData === 'object' && json.cardData !== null ? json.cardData : {};
    const description = typeof json.description === 'string' ? json.description : '';

    /** Prefer the rendered card at /raw/main/README.md; fall back to description-only. */
    let card = '';
    try {
        const cardRes = await fetch(
            `https://huggingface.co/datasets/${datasetId}/raw/main/README.md`,
            {
                signal: AbortSignal.timeout(15000),
            },
        );
        if (cardRes.ok) card = await cardRes.text();
    } catch {
        /** Card fetch is best-effort. */
    }

    const title = datasetId;
    const body = [
        `# ${datasetId}`,
        description ? `\n${description}\n` : '',
        card ? `\n## Dataset card\n\n${card}` : '',
    ]
        .filter(Boolean)
        .join('\n');

    return {
        title,
        content: body,
        url,
        source_type: 'dataset',
        language: null,
        metadata: {
            source: 'huggingface',
            dataset_id: datasetId,
            card_data: cardData,
            has_card: card.length > 0,
        },
    };
}

/** Ordered so `.parquet` takes priority before we try to treat it as text. */
function detectDatasetFormat(path: string): DatasetFormat {
    const ext = extname(path).toLowerCase();
    if (ext === '.parquet') return 'parquet';
    if (ext === '.jsonl' || ext === '.ndjson') return 'jsonl';
    if (ext === '.csv' || ext === '.tsv') return 'csv';
    return 'csv';
}

export function isDatasetPath(path: string): boolean {
    const ext = extname(path).toLowerCase();
    return ['.csv', '.tsv', '.jsonl', '.ndjson', '.parquet'].includes(ext);
}

export function isHuggingFaceUrl(input: string): boolean {
    return /^https?:\/\/huggingface\.co\/datasets\//i.test(input);
}

function parseHuggingFaceDatasetId(url: string): string | null {
    try {
        const u = new URL(url);
        const parts = u.pathname.replace(/^\//, '').split('/');
        if (parts[0] !== 'datasets') return null;
        /** Dataset IDs are either `name` or `owner/name`. */
        if (parts.length >= 3) return `${parts[1]}/${parts[2]}`;
        if (parts.length === 2) return parts[1];
        return null;
    } catch {
        return null;
    }
}

/**
 * Minimal CSV parser. Handles quoted fields, doubled-quote escapes, and CRLF.
 * Not RFC 4180 complete — deliberately small since datasets are best-effort indexing,
 * not authoritative table storage.
 */
function parseCsv(path: string): { rows: Record<string, unknown>[]; columnNames: string[] } {
    const raw = readFileSync(path, 'utf-8');
    const lines = raw
        .replace(/\r\n/g, '\n')
        .split('\n')
        .filter((l) => l.length > 0);
    if (lines.length === 0) return { rows: [], columnNames: [] };

    const delimiter = path.toLowerCase().endsWith('.tsv') ? '\t' : detectDelimiter(lines[0]);
    const columnNames = splitCsvLine(lines[0], delimiter);
    const rows: Record<string, unknown>[] = [];
    const limit = Math.min(lines.length, SCHEMA_SAMPLE_ROWS + 1);

    for (let i = 1; i < limit; i++) {
        const values = splitCsvLine(lines[i], delimiter);
        const row: Record<string, unknown> = {};
        columnNames.forEach((name, idx) => {
            row[name] = values[idx] ?? null;
        });
        rows.push(row);
    }

    return { rows, columnNames };
}

function detectDelimiter(headerLine: string): string {
    const commas = (headerLine.match(/,/g) || []).length;
    const semicolons = (headerLine.match(/;/g) || []).length;
    const tabs = (headerLine.match(/\t/g) || []).length;
    if (tabs > commas && tabs > semicolons) return '\t';
    if (semicolons > commas) return ';';
    return ',';
}

function splitCsvLine(line: string, delimiter: string): string[] {
    const out: string[] = [];
    let cur = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
            if (ch === '"' && line[i + 1] === '"') {
                cur += '"';
                i++;
            } else if (ch === '"') {
                inQuotes = false;
            } else {
                cur += ch;
            }
            continue;
        }
        if (ch === '"') {
            inQuotes = true;
            continue;
        }
        if (ch === delimiter) {
            out.push(cur);
            cur = '';
            continue;
        }
        cur += ch;
    }
    out.push(cur);
    return out;
}

function parseJsonl(path: string): { rows: Record<string, unknown>[]; columnNames: string[] } {
    const raw = readFileSync(path, 'utf-8');
    const rows: Record<string, unknown>[] = [];
    const columnSet = new Set<string>();
    const lines = raw.split('\n');
    let parsed = 0;

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            const obj = JSON.parse(trimmed) as Record<string, unknown>;
            if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
                rows.push(obj);
                for (const key of Object.keys(obj)) columnSet.add(key);
            }
        } catch {
            /** Skip malformed lines rather than failing the whole ingest. */
        }
        parsed++;
        if (parsed >= SCHEMA_SAMPLE_ROWS) break;
    }

    return { rows, columnNames: Array.from(columnSet) };
}

function inferSchema(rows: Record<string, unknown>[], columnNames: string[]): ColumnStats[] {
    return columnNames.map((name) => {
        let nullCount = 0;
        const types = new Set<ColumnStats['inferred_type']>();
        const samples: unknown[] = [];

        for (const row of rows) {
            const value = row[name];
            if (value === null || value === undefined || value === '') {
                nullCount++;
                continue;
            }
            const t = inferValueType(value);
            types.add(t);
            if (samples.length < 3) samples.push(value);
        }

        const inferred: ColumnStats['inferred_type'] =
            types.size === 0
                ? 'null'
                : types.size === 1
                  ? [...types][0]
                  : types.has('string')
                    ? 'string'
                    : types.has('float') && types.has('integer')
                      ? 'float'
                      : 'string';

        return { name, inferred_type: inferred, null_count: nullCount, sample_values: samples };
    });
}

function inferValueType(value: unknown): ColumnStats['inferred_type'] {
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'float';
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (/^-?\d+$/.test(trimmed)) return 'integer';
        if (/^-?\d+\.\d+$/.test(trimmed)) return 'float';
        if (/^(true|false)$/i.test(trimmed)) return 'boolean';
        return 'string';
    }
    return 'string';
}

/** If a README.md or dataset-card.md sits next to the data file, inline it. */
function loadColocatedCard(dataPath: string): string | null {
    const dir = dirname(dataPath);
    const candidates = ['README.md', 'readme.md', 'dataset-card.md', 'DATASET.md'];
    for (const name of candidates) {
        const candidate = join(dir, name);
        if (existsSync(candidate)) {
            try {
                return readFileSync(candidate, 'utf-8');
            } catch {
                /** If we can't read it, skip it. */
            }
        }
    }
    return null;
}

function renderDataset(input: {
    title: string;
    card: string | null;
    stats: ColumnStats[];
    rows: Record<string, unknown>[];
    totalRows: number;
    format: DatasetFormat;
}): string {
    const parts: string[] = [`# ${input.title}`];

    if (input.card) {
        parts.push('## Dataset card\n\n' + input.card.trim());
    }

    parts.push('## Schema\n\n' + renderSchemaTable(input.stats));
    parts.push(
        `## Preview (first ${Math.min(PREVIEW_ROWS, input.rows.length)} rows)\n\n` +
            renderPreviewTable(input.stats, input.rows),
    );
    parts.push(
        `## Details\n\n- Format: \`${input.format}\`\n- Rows sampled: ${input.totalRows}\n- Columns: ${input.stats.length}`,
    );

    return parts.join('\n\n');
}

function renderSchemaTable(stats: ColumnStats[]): string {
    const header = '| Column | Type | Nulls (in sample) |\n|---|---|---|';
    const rows = stats.map(
        (s) => `| ${escapeTableCell(s.name)} | ${s.inferred_type} | ${s.null_count} |`,
    );
    return [header, ...rows].join('\n');
}

function renderPreviewTable(stats: ColumnStats[], rows: Record<string, unknown>[]): string {
    const columns = stats.map((s) => s.name);
    const header = `| ${columns.map(escapeTableCell).join(' | ')} |`;
    const divider = `| ${columns.map(() => '---').join(' | ')} |`;
    const body = rows
        .slice(0, PREVIEW_ROWS)
        .map((row) => `| ${columns.map((c) => escapeTableCell(formatCell(row[c]))).join(' | ')} |`);
    return [header, divider, ...body].join('\n');
}

function formatCell(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

function escapeTableCell(value: string): string {
    return value.replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 120);
}
