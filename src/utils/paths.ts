import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';

const DEFAULT_DIR = '.lumen';

let dataDir: string | null = null;

export function getDataDir(): string {
  if (dataDir) return dataDir;
  const dir = process.env.LUMEN_DIR || join(homedir(), DEFAULT_DIR);
  ensureDir(dir);
  dataDir = dir;
  return dir;
}

export function setDataDir(dir: string): void {
  ensureDir(dir);
  dataDir = dir;
}

export function resetDataDir(): void {
  dataDir = null;
}

export function getDbPath(): string {
  return join(getDataDir(), 'lumen.db');
}

export function getConfigPath(): string {
  return join(getDataDir(), 'config.json');
}

export function getAuditLogPath(): string {
  return join(getDataDir(), 'audit.log');
}

export function getOutputDir(): string {
  const dir = join(getDataDir(), 'output');
  ensureDir(dir);
  return dir;
}

export function isInitialized(): boolean {
  return existsSync(getDataDir()) && existsSync(getDbPath());
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}
