import { readFileSync, writeFileSync } from 'node:fs';
import type { Command } from 'commander';
import { getDb } from '../store/database.js';
import { getDbPath, isInitialized } from '../utils/paths.js';
import * as log from '../utils/logger.js';

type ExportFormat = 'jsonl' | 'sql';

const EXPORTABLE_TABLES = [
    'sources',
    'chunks',
    'concepts',
    'edges',
    'source_concepts',
    'query_log',
    'profile_snapshot',
] as const;

export function registerMemory(program: Command): void {
    const memory = program
        .command('memory')
        .description('Export or import your knowledge base memory');

    memory
        .command('export <file>')
        .description('Export the full knowledge base to a portable file')
        .option('-f, --format <format>', 'Output format: jsonl or sql', 'jsonl')
        .action((file: string, opts: { format: string }) => {
            try {
                if (!isInitialized()) {
                    log.warn('Lumen is not initialized. Nothing to export.');
                    return;
                }

                const format = opts.format as ExportFormat;
                getDb();

                if (format === 'sql') {
                    exportSql(file);
                } else {
                    exportJsonl(file);
                }
            } catch (err) {
                log.error(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
            }
        });

    memory
        .command('import <file>')
        .description('Import a previously exported knowledge base')
        .option('--merge', 'Merge with existing data (default: replace)')
        .action((file: string, opts: { merge?: boolean }) => {
            try {
                getDb();

                const content = readFileSync(file, 'utf-8');

                if (file.endsWith('.sql')) {
                    importSql(content, opts.merge);
                } else {
                    importJsonl(content, opts.merge);
                }
            } catch (err) {
                log.error(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
            }
        });
}

function exportJsonl(file: string): void {
    const db = getDb();
    const lines: string[] = [];

    for (const table of EXPORTABLE_TABLES) {
        try {
            const rows = db.prepare(`SELECT * FROM ${table}`).all();
            for (const row of rows) {
                lines.push(JSON.stringify({ _table: table, ...(row as Record<string, unknown>) }));
            }
        } catch {
            /** Table may not exist in older schemas. */
        }
    }

    writeFileSync(file, lines.join('\n') + '\n', 'utf-8');
    log.success(`Exported ${lines.length} rows to ${file}`);

    const tableCounts = EXPORTABLE_TABLES.map((t) => {
        try {
            const row = db.prepare(`SELECT COUNT(*) as c FROM ${t}`).get() as { c: number };
            return `${t}: ${row.c}`;
        } catch {
            return null;
        }
    }).filter(Boolean);

    log.dim(`  ${tableCounts.join(', ')}`);
}

function exportSql(file: string): void {
    const db = getDb();
    const lines: string[] = [];

    lines.push('-- Lumen memory export');
    lines.push(`-- Generated: ${new Date().toISOString()}`);
    lines.push('');

    let totalRows = 0;

    for (const table of EXPORTABLE_TABLES) {
        try {
            const rows = db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
            if (rows.length === 0) continue;

            lines.push(`-- ${table} (${rows.length} rows)`);

            for (const row of rows) {
                const cols = Object.keys(row);
                const vals = cols.map((c) => {
                    const v = row[c];
                    if (v === null) return 'NULL';
                    if (typeof v === 'number') return String(v);
                    return `'${String(v).replace(/'/g, "''")}'`;
                });
                lines.push(
                    `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${vals.join(', ')});`,
                );
                totalRows++;
            }
            lines.push('');
        } catch {
            /** Table may not exist. */
        }
    }

    writeFileSync(file, lines.join('\n'), 'utf-8');
    log.success(`Exported ${totalRows} rows as SQL to ${file}`);
}

function importJsonl(content: string, merge?: boolean): void {
    const db = getDb();
    const lines = content.split('\n').filter((l) => l.trim());

    if (!merge) {
        for (const table of [...EXPORTABLE_TABLES].reverse()) {
            try {
                db.prepare(`DELETE FROM ${table}`).run();
            } catch {
                /** Table may not exist. */
            }
        }
    }

    let imported = 0;
    let skipped = 0;

    const tx = db.transaction(() => {
        for (const line of lines) {
            try {
                const obj = JSON.parse(line) as Record<string, unknown>;
                const table = obj._table as string;
                delete obj._table;

                if (!EXPORTABLE_TABLES.includes(table as (typeof EXPORTABLE_TABLES)[number])) {
                    skipped++;
                    continue;
                }

                const cols = Object.keys(obj);
                const placeholders = cols.map(() => '?').join(', ');
                const vals = cols.map((c) => obj[c]);

                db.prepare(
                    `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`,
                ).run(...vals);
                imported++;
            } catch {
                skipped++;
            }
        }
    });

    tx();
    log.success(`Imported ${imported} rows (${skipped} skipped)`);
}

function importSql(content: string, merge?: boolean): void {
    const db = getDb();

    if (!merge) {
        for (const table of [...EXPORTABLE_TABLES].reverse()) {
            try {
                db.prepare(`DELETE FROM ${table}`).run();
            } catch {
                /** Table may not exist. */
            }
        }
    }

    db.exec(content);
    log.success('Imported SQL dump');
}
