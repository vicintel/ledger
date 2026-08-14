/**
 * Posting money to the ledger.
 *
 * Two rules are enforced twice on purpose — once here in TypeScript, once in
 * Postgres. They are not the same guarantee. The type check helps whoever is
 * writing the code; the database constraint protects the data from every path
 * that was never typed at all, including psql at three in the morning.
 */

import type { PoolClient } from 'pg';
import { pool } from './db.ts';
import { kobo, type Kobo } from './money.ts';

export type Line = { account: string; amount: Kobo };

export class Unbalanced extends Error {
  constructor(idemKey: string, public readonly drift: Kobo) {
    super(`transaction ${idemKey} does not balance: off by ${drift} kobo`);
    this.name = 'Unbalanced';
  }
}

export type Transaction = {
  readonly idemKey: string;
  readonly kind: string;
  readonly lines: readonly Line[];
};

/**
 * Builds a transaction, or refuses to. There is no way to construct one that
 * does not balance, so nothing downstream has to check.
 */
export function transaction(idemKey: string, kind: string, lines: Line[]): Transaction {
  if (lines.length < 2) {
    throw new Error(`transaction ${idemKey} needs at least two sides, got ${lines.length}`);
  }
  const drift = lines.reduce((sum, line) => sum + line.amount, 0);
  if (drift !== 0) {
    throw new Unbalanced(idemKey, kobo(drift));
  }
  return { idemKey, kind, lines };
}

/** True when this transaction had already been posted. */
export type PostResult = { posted: boolean; txnId: number | null };

/**
 * Posts a transaction exactly once.
 *
 * A payment gateway will deliver the same webhook more than once — that is
 * normal operation, not a fault. `on conflict do nothing` on the unique
 * idempotency key means the second delivery moves no money, and the caller
 * does not have to know or care whether it was the first.
 */
export async function post(txn: Transaction): Promise<PostResult> {
  const client = await pool.connect();
  try {
    await client.query('begin');

    const inserted = await client.query<{ id: string }>(
      `insert into transactions (idem_key, kind)
       values ($1, $2)
       on conflict (idem_key) do nothing
       returning id`,
      [txn.idemKey, txn.kind],
    );

    if (inserted.rowCount === 0) {
      await client.query('rollback');
      return { posted: false, txnId: null };
    }

    const txnId = Number(inserted.rows[0]!.id);

    for (const line of txn.lines) {
      const accountId = await accountIdFor(client, line.account);
      await client.query(
        'insert into entries (txn_id, account_id, amount) values ($1, $2, $3)',
        [txnId, accountId, line.amount],
      );
    }

    // The balance trigger is deferred, so it fires here — not on each insert.
    await client.query('commit');
    return { posted: true, txnId };
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Accounts are created on first use; the code string is the identity. */
async function accountIdFor(client: PoolClient, code: string): Promise<number> {
  const kind = kindOf(code);
  const res = await client.query<{ id: string }>(
    `insert into accounts (code, kind) values ($1, $2)
     on conflict (code) do update set code = excluded.code
     returning id`,
    [code, kind],
  );
  return Number(res.rows[0]!.id);
}

function kindOf(code: string): string {
  if (code.startsWith('cash.')) return 'asset';
  if (code.startsWith('seller.')) return 'liability';
  if (code.startsWith('platform.')) return 'revenue';
  if (code.startsWith('gateway.')) return 'expense';
  throw new Error(`unknown account family: ${code}`);
}

/** Balance is derived from the entries, never stored. It cannot drift. */
export async function balanceOf(code: string): Promise<Kobo> {
  const res = await pool.query<{ balance: string | null }>(
    `select sum(e.amount)::text as balance
       from entries e
       join accounts a on a.id = e.account_id
      where a.code = $1`,
    [code],
  );
  return kobo(Number(res.rows[0]?.balance ?? 0));
}

export async function txnCount(idemKey: string): Promise<number> {
  const res = await pool.query<{ n: string }>(
    'select count(*)::text as n from transactions where idem_key = $1',
    [idemKey],
  );
  return Number(res.rows[0]!.n);
}
