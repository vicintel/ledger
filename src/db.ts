import pg from 'pg';

/**
 * Postgres returns bigint as a string so it cannot silently lose precision in
 * a JavaScript number. For kobo that is over-cautious — ₦90 trillion fits in a
 * safe integer — so amounts are parsed back to numbers, and only here, where
 * the decision is visible.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://localhost:5432/ledger_dev',
  max: 4,
});

export async function close(): Promise<void> {
  await pool.end();
}
