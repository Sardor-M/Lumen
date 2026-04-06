import { appendFileSync } from 'node:fs';
import chalk from 'chalk';
import { getAuditLogPath } from './paths.js';

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

type AuditEntry = {
  ts: string;
  level: LogLevel;
  action: string;
  detail?: Record<string, unknown>;
};

export function audit(action: string, detail?: Record<string, unknown>): void {
  const entry: AuditEntry = {
    ts: new Date().toISOString(),
    level: 'info',
    action,
    detail,
  };
  try {
    appendFileSync(getAuditLogPath(), JSON.stringify(entry) + '\n', 'utf-8');
  } catch {
    // Don't crash on audit log failures
  }
}

export function info(msg: string): void {
  console.log(chalk.blue('ℹ'), msg);
}

export function success(msg: string): void {
  console.log(chalk.green('✓'), msg);
}

export function warn(msg: string): void {
  console.log(chalk.yellow('⚠'), msg);
}

export function error(msg: string): void {
  console.error(chalk.red('✗'), msg);
}

export function dim(msg: string): void {
  console.log(chalk.dim(msg));
}

export function heading(msg: string): void {
  console.log(chalk.bold.white(`\n${msg}`));
}

export function table(rows: Record<string, string | number>): void {
  const maxKeyLen = Math.max(...Object.keys(rows).map(k => k.length));
  for (const [key, value] of Object.entries(rows)) {
    console.log(`  ${chalk.dim(key.padEnd(maxKeyLen))}  ${value}`);
  }
}
