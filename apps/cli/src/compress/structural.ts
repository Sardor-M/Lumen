/**
 * Structural compression: preserve headings, first paragraphs, and code blocks.
 * Collapse long lists and repetitive enumerations into summaries.
 */
export function compressStructural(text: string): string {
    const lines = text.split('\n');
    const result: string[] = [];
    let inCodeBlock = false;
    let listCount = 0;
    let listBuffer: string[] = [];

    for (const line of lines) {
        if (line.startsWith('```')) {
            flushList(result, listBuffer, listCount);
            listBuffer = [];
            listCount = 0;
            inCodeBlock = !inCodeBlock;
            result.push(line);
            continue;
        }

        if (inCodeBlock) {
            result.push(line);
            continue;
        }

        if (line.startsWith('#')) {
            flushList(result, listBuffer, listCount);
            listBuffer = [];
            listCount = 0;
            result.push(line);
            continue;
        }

        if (/^[\s]*[-*•]\s/.test(line) || /^[\s]*\d+[.)]\s/.test(line)) {
            listCount++;
            if (listCount <= 5) {
                listBuffer.push(line);
            }
            continue;
        }

        flushList(result, listBuffer, listCount);
        listBuffer = [];
        listCount = 0;
        result.push(line);
    }

    flushList(result, listBuffer, listCount);
    return result.join('\n');
}

function flushList(result: string[], buffer: string[], totalCount: number): void {
    if (buffer.length === 0) return;
    result.push(...buffer);
    if (totalCount > 5) {
        result.push(`  ... (${totalCount - 5} more items omitted)`);
    }
}
