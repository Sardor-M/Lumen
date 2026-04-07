# CLI Command Template

```typescript
import type { Command } from 'commander';
import { getDb } from '../store/database.js';
import { loadConfig } from '../utils/config.js';
import { audit } from '../utils/logger.js';
import * as log from '../utils/logger.js';

export function registerExample(program: Command): void {
    program
        .command('example <required-arg>')
        .description('One-line description of what this command does')
        .option('-n, --limit <n>', 'Max results', '10')
        .action(async (requiredArg: string, opts: { limit: string }) => {
            try {
                const config = loadConfig();
                const limit = parseInt(opts.limit) || 10;

                log.info(`Doing something with ${requiredArg}...`);

                /** Core logic here. */

                audit('example:run', { arg: requiredArg });

                log.success('Done');
                log.table({
                    Result: 'value',
                    Count: 42,
                });
            } catch (err) {
                log.error(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
            }
        });
}
```
