import { getDb } from './database.js';

type QueryLogEntry = {
    tool_name: string;
    query_text: string | null;
    result_count: number | null;
    latency_ms: number | null;
    session_id: string | null;
};

type FrequentTopic = {
    query_text: string;
    count: number;
};

type RecentQuery = {
    tool_name: string;
    query_text: string | null;
    timestamp: string;
};

export function logQuery(entry: QueryLogEntry): void {
    getDb()
        .prepare(
            `INSERT INTO query_log (tool_name, query_text, result_count, latency_ms, session_id)
             VALUES (@tool_name, @query_text, @result_count, @latency_ms, @session_id)`,
        )
        .run(entry);
}

export function recentQueries(limit = 20): RecentQuery[] {
    return getDb()
        .prepare(
            `SELECT tool_name, query_text, timestamp
             FROM query_log
             ORDER BY timestamp DESC
             LIMIT ?`,
        )
        .all(limit) as RecentQuery[];
}

export function frequentTopics(limit = 10): FrequentTopic[] {
    return getDb()
        .prepare(
            `SELECT query_text, COUNT(*) as count
             FROM query_log
             WHERE query_text IS NOT NULL AND query_text != ''
             GROUP BY query_text
             ORDER BY count DESC
             LIMIT ?`,
        )
        .all(limit) as FrequentTopic[];
}

export function queryCountByTool(): Record<string, number> {
    const rows = getDb()
        .prepare(
            `SELECT tool_name, COUNT(*) as count
             FROM query_log
             GROUP BY tool_name
             ORDER BY count DESC`,
        )
        .all() as Array<{ tool_name: string; count: number }>;

    const result: Record<string, number> = {};
    for (const row of rows) {
        result[row.tool_name] = row.count;
    }
    return result;
}
