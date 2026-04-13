import { betterAuth } from 'better-auth';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Auth DB lives next to Lumen's data dir so everything stays local.
 */
const authDbPath = process.env.LUMEN_AUTH_DB || join(homedir(), '.lumen', 'auth.db');
mkdirSync(dirname(authDbPath), { recursive: true });

export const auth = betterAuth({
    database: new Database(authDbPath),
    emailAndPassword: {
        enabled: true,
        autoSignIn: true,
    },
    session: {
        expiresIn: 60 * 60 * 24 * 30,
        updateAge: 60 * 60 * 24,
    },
    secret: process.env.BETTER_AUTH_SECRET || 'will be fixed in prod pushing',
    baseURL: process.env.BETTER_AUTH_URL || 'http://localhost:3000',
    trustedOrigins: ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:3002'],
});

export type Session = typeof auth.$Infer.Session;
