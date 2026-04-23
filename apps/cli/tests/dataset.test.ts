import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractDataset, isDatasetPath, isHuggingFaceUrl } from '../src/ingest/dataset.js';
import { IngestError } from '../src/ingest/errors.js';

let workDir: string;

beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'lumen-dataset-test-'));
});

afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('isDatasetPath', () => {
    it('matches dataset extensions', () => {
        expect(isDatasetPath('data.csv')).toBe(true);
        expect(isDatasetPath('data.tsv')).toBe(true);
        expect(isDatasetPath('data.jsonl')).toBe(true);
        expect(isDatasetPath('data.ndjson')).toBe(true);
        expect(isDatasetPath('data.parquet')).toBe(true);
    });

    it('is case-insensitive on extension', () => {
        expect(isDatasetPath('DATA.CSV')).toBe(true);
    });

    it('rejects non-dataset extensions', () => {
        expect(isDatasetPath('README.md')).toBe(false);
        expect(isDatasetPath('archive.zip')).toBe(false);
    });
});

describe('isHuggingFaceUrl', () => {
    it('matches dataset URLs', () => {
        expect(isHuggingFaceUrl('https://huggingface.co/datasets/glue')).toBe(true);
        expect(isHuggingFaceUrl('https://huggingface.co/datasets/org/name')).toBe(true);
    });

    it('does not match model or space URLs', () => {
        expect(isHuggingFaceUrl('https://huggingface.co/bert-base-uncased')).toBe(false);
        expect(isHuggingFaceUrl('https://huggingface.co/spaces/org/demo')).toBe(false);
    });
});

describe('extractDataset — CSV', () => {
    it('parses a basic CSV and emits schema + preview sections', async () => {
        const csv = ['name,age,score', 'Alice,30,95.5', 'Bob,25,88.2', 'Charlie,40,72.1'].join(
            '\n',
        );
        const path = join(workDir, 'people.csv');
        writeFileSync(path, csv);

        const result = await extractDataset(path);
        expect(result.source_type).toBe('dataset');
        expect(result.content).toContain('## Schema');
        expect(result.content).toContain('## Preview');
        expect(result.content).toContain('name');
        expect(result.content).toContain('Alice');

        const meta = result.metadata as Record<string, unknown>;
        expect(meta.format).toBe('csv');
        expect(meta.row_count).toBe(3);
        expect(meta.column_count).toBe(3);
    });

    it('infers integer, float, and string column types', async () => {
        const csv = ['id,score,label', '1,1.5,cat', '2,2.0,dog'].join('\n');
        writeFileSync(join(workDir, 'types.csv'), csv);

        const result = await extractDataset(join(workDir, 'types.csv'));
        const meta = result.metadata as Record<string, unknown>;
        const schema = meta.schema as { name: string; type: string }[];
        const byName = Object.fromEntries(schema.map((s) => [s.name, s.type]));

        expect(byName.id).toBe('integer');
        expect(byName.score).toBe('float');
        expect(byName.label).toBe('string');
    });

    it('counts empty fields as nulls in schema', async () => {
        const csv = ['a,b', '1,x', ',y', '3,'].join('\n');
        writeFileSync(join(workDir, 'nulls.csv'), csv);

        const result = await extractDataset(join(workDir, 'nulls.csv'));
        const meta = result.metadata as Record<string, unknown>;
        const schema = meta.schema as { name: string; null_count: number }[];
        const byName = Object.fromEntries(schema.map((s) => [s.name, s.null_count]));
        expect(byName.a).toBe(1);
        expect(byName.b).toBe(1);
    });

    it('handles quoted CSV fields with commas and doubled-quote escapes', async () => {
        const csv = ['name,comment', '"Smith, J.","said ""hi"""', 'Jones,plain'].join('\n');
        writeFileSync(join(workDir, 'quoted.csv'), csv);

        const result = await extractDataset(join(workDir, 'quoted.csv'));
        expect(result.content).toContain('Smith, J.');
        expect(result.content).toContain('said "hi"');
    });

    it('detects TSV delimiter from file extension', async () => {
        const tsv = ['a\tb\tc', '1\t2\t3'].join('\n');
        writeFileSync(join(workDir, 'sample.tsv'), tsv);

        const result = await extractDataset(join(workDir, 'sample.tsv'));
        const meta = result.metadata as Record<string, unknown>;
        expect(meta.column_count).toBe(3);
    });

    it('throws NO_CONTENT when the CSV has only a header', async () => {
        writeFileSync(join(workDir, 'empty.csv'), 'a,b,c\n');
        try {
            await extractDataset(join(workDir, 'empty.csv'));
            expect.fail('expected NO_CONTENT');
        } catch (err) {
            expect(err).toBeInstanceOf(IngestError);
            expect((err as IngestError).code).toBe('NO_CONTENT');
        }
    });
});

describe('extractDataset — JSONL', () => {
    it('parses JSONL, unions column names across rows', async () => {
        const jsonl = [
            JSON.stringify({ id: 1, name: 'Alice' }),
            JSON.stringify({ id: 2, name: 'Bob', extra: true }),
        ].join('\n');
        writeFileSync(join(workDir, 'data.jsonl'), jsonl);

        const result = await extractDataset(join(workDir, 'data.jsonl'));
        const meta = result.metadata as Record<string, unknown>;
        expect(meta.format).toBe('jsonl');
        expect(meta.row_count).toBe(2);
        expect(meta.column_count).toBe(3);
    });

    it('skips malformed JSONL lines without throwing', async () => {
        const jsonl = [
            JSON.stringify({ id: 1 }),
            'not json at all',
            JSON.stringify({ id: 2 }),
        ].join('\n');
        writeFileSync(join(workDir, 'mixed.jsonl'), jsonl);

        const result = await extractDataset(join(workDir, 'mixed.jsonl'));
        const meta = result.metadata as Record<string, unknown>;
        expect(meta.row_count).toBe(2);
    });
});

describe('extractDataset — Parquet', () => {
    it('throws MALFORMED with a duckdb hint', async () => {
        writeFileSync(join(workDir, 'data.parquet'), '');
        try {
            await extractDataset(join(workDir, 'data.parquet'));
            expect.fail('expected MALFORMED');
        } catch (err) {
            expect(err).toBeInstanceOf(IngestError);
            expect((err as IngestError).code).toBe('MALFORMED');
            expect((err as IngestError).hint).toMatch(/duckdb/i);
        }
    });
});

describe('extractDataset — colocated card', () => {
    it('inlines a sibling README.md as the dataset card', async () => {
        writeFileSync(join(workDir, 'README.md'), '# Dataset Card\n\nAbout this data.');
        writeFileSync(join(workDir, 'data.csv'), 'a\n1\n2');

        const result = await extractDataset(join(workDir, 'data.csv'));
        expect(result.content).toContain('Dataset card');
        expect(result.content).toContain('About this data.');

        const meta = result.metadata as Record<string, unknown>;
        expect(meta.has_card).toBe(true);
    });

    it('has_card is false when no sibling card exists', async () => {
        writeFileSync(join(workDir, 'only.csv'), 'a\n1\n2');

        const result = await extractDataset(join(workDir, 'only.csv'));
        const meta = result.metadata as Record<string, unknown>;
        expect(meta.has_card).toBe(false);
    });
});

describe('extractDataset — local path errors', () => {
    it('throws NOT_FOUND for missing files', async () => {
        try {
            await extractDataset(join(workDir, 'missing.csv'));
            expect.fail('expected NOT_FOUND');
        } catch (err) {
            expect(err).toBeInstanceOf(IngestError);
            expect((err as IngestError).code).toBe('NOT_FOUND');
        }
    });
});

describe('extractDataset — HuggingFace', () => {
    it('fetches the dataset card via the HF API and returns it as content', async () => {
        const apiBody = {
            description: 'GLUE benchmark',
            cardData: { license: 'cc' },
        };
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: Parameters<typeof fetch>[0]) => {
                const url = typeof input === 'string' ? input : input.toString();
                if (url.includes('/api/datasets/')) {
                    return makeResponse(200, apiBody);
                }
                if (url.includes('/raw/main/README.md')) {
                    return makeResponse(200, '# GLUE\n\nDataset card body');
                }
                return makeResponse(404, { message: 'not found' });
            }),
        );

        const result = await extractDataset('https://huggingface.co/datasets/glue');
        expect(result.source_type).toBe('dataset');
        expect(result.url).toBe('https://huggingface.co/datasets/glue');
        expect(result.content).toContain('GLUE benchmark');
        expect(result.content).toContain('Dataset card body');

        const meta = result.metadata as Record<string, unknown>;
        expect(meta.source).toBe('huggingface');
        expect(meta.dataset_id).toBe('glue');
        expect(meta.has_card).toBe(true);
    });

    it('parses owner/name dataset IDs', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => makeResponse(200, { description: 'ds', cardData: {} })),
        );

        const result = await extractDataset('https://huggingface.co/datasets/org/my-data');
        const meta = result.metadata as Record<string, unknown>;
        expect(meta.dataset_id).toBe('org/my-data');
    });

    it('throws MALFORMED for a datasets URL with an empty slug', async () => {
        try {
            await extractDataset('https://huggingface.co/datasets/');
            expect.fail('expected MALFORMED');
        } catch (err) {
            expect(err).toBeInstanceOf(IngestError);
            expect((err as IngestError).code).toBe('MALFORMED');
        }
    });
});

function makeResponse(status: number, body: unknown): Response {
    const isText = typeof body === 'string';
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 200 ? 'OK' : 'ERR',
        json: async () => (isText ? {} : body),
        text: async () => (isText ? (body as string) : JSON.stringify(body)),
        headers: { get: () => null } as unknown as Headers,
    } as unknown as Response;
}
