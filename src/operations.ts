/**
 * The three things that happen to money after it arrives: it clears, it goes
 * out, or it goes back.
 *
 * Each one is a transaction like any other — no operation here is allowed a
 * private route into the entries table, which is why the balance invariant
 * holds for all of them without any of them checking it.
 */

import { pool } from './db.ts';
import { kobo, type Kobo } from './money.ts';
import { transaction, post, owedTo, alreadyPosted, type PostResult } from './ledger.ts';

/** How long a seller's share sits before it can be paid out. */
export const CLEARANCE_DAYS = 7;

export class InsufficientFunds extends Error {
  constructor(storeId: string, requested: Kobo, available: Kobo) {
    super(`store ${storeId} has ${available} kobo available, asked for ${requested}`);
    this.name = 'InsufficientFunds';
  }
}

export class UnknownTransaction extends Error {
  constructor(reference: string) {
    super(`no transaction with reference ${reference}`);
    this.name = 'UnknownTransaction';
  }
}

/**
 * Moves every hold whose clearance date has passed from pending to available.
 *
 * Run it on a schedule. It is safe to run twice: the idempotency key is derived
 * from the hold, so a second pass over the same hold posts nothing, and
 * `released_at` is only stamped on the pass that actually moved the money.
 */
export async function releaseCleared(now = new Date()): Promise<number> {
  const due = await pool.query<{ txn_id: number; store: string; amount: number }>(
    `select h.txn_id,
            substring(a.code from 'seller\\.pending:(.*)$') as store,
            e.amount
       from holds h
       join entries  e on e.txn_id = h.txn_id
       join accounts a on a.id = e.account_id
      where h.released_at is null
        and h.clears_at <= $1
        and a.code like 'seller.pending:%'`,
    [now],
  );

  let released = 0;

  for (const row of due.rows) {
    // The pending entry is a credit, so its amount is negative. The seller is
    // owed the absolute value.
    const share = kobo(-row.amount);

    const move = transaction(`release:${row.txn_id}`, 'hold.released', [
      { account: `seller.pending:${row.store}`, amount: share },
      { account: `seller.available:${row.store}`, amount: kobo(-share) },
    ]);

    const result = await post(move);
    if (result.posted) {
      await pool.query('update holds set released_at = $1 where txn_id = $2', [now, row.txn_id]);
      released += 1;
    }
  }

  return released;
}

/**
 * Pays a seller out to their bank.
 *
 * The guard reads `seller.available`, which only ever contains money that has
 * cleared — uncleared funds are in a different account and are not visible to
 * this query at all.
 */
export async function payout(storeId: string, amount: Kobo, reference: string): Promise<PostResult> {
  if (amount <= 0) {
    throw new RangeError(`payout must be positive, got ${amount}`);
  }

  // Idempotency is checked before the funds guard, and the order matters.
  // A retried payout has already moved the money, so the balance it is
  // validated against is the one it itself reduced — checking funds first
  // rejects the retry with InsufficientFunds and raises a false alarm about
  // a payout that in fact succeeded. A test caught this; the first version
  // of this function had the two the wrong way round.
  if (await alreadyPosted(reference)) {
    return { posted: false, txnId: null };
  }

  const available = await owedTo(storeId);
  if (amount > available) {
    throw new InsufficientFunds(storeId, amount, available);
  }

  return post(
    transaction(reference, 'payout', [
      { account: `seller.available:${storeId}`, amount },
      { account: 'cash.bank', amount: kobo(-amount) },
    ]),
  );
}

/**
 * Reverses a charge in full.
 *
 * Every line of the original transaction is posted with the opposite sign, so
 * the platform fee and the gateway cost come back out too — a refund is not
 * only the seller's share. Whether the gateway actually returns its fee is a
 * commercial question; the ledger records what was agreed, and if Paystack
 * keeps its charge that is a separate entry, not a fudged one here.
 */
export async function refund(reference: string): Promise<PostResult> {
  const original = await pool.query<{ code: string; amount: number }>(
    `select a.code, e.amount
       from transactions t
       join entries  e on e.txn_id = t.id
       join accounts a on a.id = e.account_id
      where t.idem_key = $1`,
    [reference],
  );

  if (original.rowCount === 0) {
    throw new UnknownTransaction(reference);
  }

  const reversal = original.rows.map((row) => ({
    account: row.code,
    amount: kobo(-row.amount),
  }));

  return post(transaction(`refund:${reference}`, 'order.refunded', reversal));
}
