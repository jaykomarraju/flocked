// Runs before every test file: apps/api's migrations on this file's fresh D1 (the signer reads the
// API's tables, never migrates them).
import { applyD1Migrations, env } from 'cloudflare:test';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
