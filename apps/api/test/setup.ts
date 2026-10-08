// Runs before every test file (vitest.config.ts `setupFiles`). Each test file gets its own fresh
// storage, so the migrations are applied here once per file; applyD1Migrations is idempotent.
import { applyD1Migrations, env } from 'cloudflare:test';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
