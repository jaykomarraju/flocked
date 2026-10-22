// Runs before every test file: the watcher's own migrations on this file's fresh D1.
import { applyD1Migrations, env } from 'cloudflare:test';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
