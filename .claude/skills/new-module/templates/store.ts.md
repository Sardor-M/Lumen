# Store Module Template

Store modules provide CRUD for a single SQLite table. They follow this pattern:

```typescript
import { getDb } from './database.js';
import type { YourType } from '../types/index.js';

/** Insert a single row. Use named parameters from the type. */
export function insertThing(thing: YourType): void {
    getDb()
        .prepare(
            `INSERT INTO things (col_a, col_b, col_c)
       VALUES (@col_a, @col_b, @col_c)`,
        )
        .run(thing);
}

/** Get by primary key. Returns null if not found. */
export function getThing(id: string): YourType | null {
    return (getDb().prepare('SELECT * FROM things WHERE id = ?').get(id) as YourType) ?? null;
}

/** List with optional filters. Build SQL dynamically. */
export function listThings(opts?: { someFilter?: string }): YourType[] {
    let sql = 'SELECT * FROM things';
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts?.someFilter) {
        conditions.push('some_column = ?');
        params.push(opts.someFilter);
    }

    if (conditions.length > 0) {
        sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY created_at DESC';

    return getDb()
        .prepare(sql)
        .all(...params) as YourType[];
}

/** Batch insert uses a transaction for performance. */
export function insertThings(items: YourType[]): void {
    const stmt = getDb().prepare(`INSERT INTO things (...) VALUES (...)`);
    const tx = getDb().transaction((rows: YourType[]) => {
        for (const row of rows) stmt.run(row);
    });
    tx(items);
}

/** Upsert with ON CONFLICT for idempotent operations. */
export function upsertThing(thing: YourType): void {
    getDb()
        .prepare(
            `INSERT INTO things (...) VALUES (...)
       ON CONFLICT(id) DO UPDATE SET
         col_b = @col_b`,
        )
        .run(thing);
}

/** Simple count. */
export function countThings(): number {
    const row = getDb().prepare('SELECT COUNT(*) as count FROM things').get() as { count: number };
    return row.count;
}

export function deleteThing(id: string): void {
    getDb().prepare('DELETE FROM things WHERE id = ?').run(id);
}
```

## Key Patterns

- `getDb()` singleton — never open your own connection
- Named parameters (`@col`) for inserts/upserts — pass the type object directly
- Positional `?` for simple queries
- Cast results: `as YourType` or `as YourType | undefined`
- Null coalesce: `?? null` for get-one queries
- Transactions: `getDb().transaction()` for batch operations
