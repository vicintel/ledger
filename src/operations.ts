/**
 * The three things that happen to money after it arrives: it clears, it goes
 * out, or it goes back.
 *
 * Each one is a transaction like any other — no operation here is allowed a
 * private route into the entries table, which is why the balance invariant
 * holds for all of them without any of them checking it.
 *
 * Each one also takes the seller's lock before it reads anything it is about
 * to act on. A check made outside the transaction that acts on it is a check
 * on a balance that may already be gone.
 */

import { pool } from './db.ts';
import { kobo, type Kobo } from './money.ts';
import {
  transaction,
  postWithin,
  inTransaction,
  lockSeller,
  assertSameRequest,
  owedTo,
  type Line,
  type PostResult,
} from './ledger.ts';

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

export class NotRefundable extends Error {
  constructor(reference: string, kind: string) {
    super(`${reference} is a ${kind}; only a paid order can be refunded`);
    this.name = 'NotRefundable';
  }
}

const PENDING = /^seller\.pending:(.*)$/;

/**
 * Moves every hold whose clearance date has passed from pending to available.
 *
 * Run it on a schedule. It is safe to run twice, and safe to run alongside a
 * refund: each hold is re-read under the seller's lock, so one that a refund
 * cancelled in the meantime is skipped, and the release and the stamp on the
 * hold commit together or not at all.
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
        and h.cancelled_at is null
        and h.clears_at <= $1
        and a.code like 'seller.pending:%'`,
    [now],
  );

  let released = 0;

  for (const row of due.rows) {
    const moved = await inTransaction(async (client) => {
      await lockSeller(client, row.store);

      const still = await client.query(
        `select 1 from holds
          where txn_id = $1 and released_at is null and cancelled_at is null
          for update`,
        [row.txn_id],
      );
      if (still.rowCount === 0) return false; // refunded or released since we looked

      // The pending entry is a credit, so its amount is negative. The seller is
      // owed the absolute value.
      const share = kobo(-row.amount);
      const result = await postWithin(
        client,
        transaction(`release:${row.txn_id}`, 'hold.released', [
          { account: `seller.pending:${row.store}`, amount: share },
          { account: `seller.available:${row.store}`, amount: kobo(-share) },
        ]),
      );

      await client.query('update holds set released_at = $1 where txn_id = $2', [now, row.txn_id]);
      return result.posted;
    });

    if (moved) released += 1;
  }

  return released;
}

/**
 * Pays a seller out to their bank.
 *
 * The guard reads `seller.available`, which only ever contains money that has
 * cleared. It reads it under the seller's lock, inside the same transaction as
 * the payout, so two payouts arriving together are checked one after the
 * other rather than both against the same balance.
 */
export async function payout(storeId: string, amount: Kobo, reference: string): Promise<PostResult> {
  if (amount <= 0) {
    throw new RangeError(`payout must be positive, got ${amount}`);
  }

  const txn = transaction(reference, 'payout', [
    { account: `seller.available:${storeId}`, amount },
    { account: 'cash.bank', amount: kobo(-amount) },
  ]);

  return inTransaction(async (client) => {
    await lockSeller(client, storeId);

    // Idempotency is checked before the funds guard, and the order matters.
    // A retried payout has already moved the money, so the balance it is
    // validated against is the one it itself reduced — checking funds first
    // rejects the retry with InsufficientFunds and raises a false alarm about
    // a payout that in fact succeeded. A reference reused for a different
    // request is not a retry, and raises IdempotencyConflict.
    if (await assertSameRequest(client, txn)) {
      return { posted: false, txnId: null };
    }

    const available = await owedTo(storeId, client);
    if (amount > available) {
      throw new InsufficientFunds(storeId, amount, available);
    }

    return postWithin(client, txn);
  });
}

/**
 * Reverses a paid order in full.
 *
 * Every line of the original transaction comes back with the opposite sign —
 * the platform fee and the gateway cost too, not only the seller's share.
 * Whether the gateway actually returns its fee is a commercial question; if
 * Paystack keeps its charge that is a separate entry, not a fudged one here.
 *
 * The seller's share is taken back from wherever it now sits:
 *   - still on hold: out of pending, and the hold is cancelled so the scheduled
 *     release never pays it;
 *   - cleared: out of available, as far as the balance covers it;
 *   - already paid out: the rest becomes a receivable, money the seller owes
 *     us, recorded rather than lost.
 */
export async function refund(reference: string): Promise<PostResult> {
  const found = await pool.query<{ id: number; kind: string }>(
    'select id, kind from transactions where idem_key = $1',
    [reference],
  );
  const original = found.rows[0];
  if (!original) throw new UnknownTransaction(reference);
  if (original.kind !== 'order.paid') throw new NotRefundable(reference, original.kind);

  const lines = await pool.query<{ code: string; amount: number }>(
    `select a.code, e.amount
       from entries e
       join accounts a on a.id = e.account_id
      where e.txn_id = $1`,
    [original.id],
  );

  const sellerLine = lines.rows.find((row) => PENDING.test(row.code));
  if (!sellerLine) throw new Error(`order ${reference} has no seller share to refund`);
  const store = PENDING.exec(sellerLine.code)![1]!;
  const share = -sellerLine.amount;

  return inTransaction(async (client) => {
    await lockSeller(client, store);

    // A retried refund. Checked before anything else, because the lines a
    // refund posts depend on where the money is now, and that changes once
    // the first refund has gone through.
    const done = await client.query('select 1 from transactions where idem_key = $1', [
      `refund:${reference}`,
    ]);
    if (done.rowCount) return { posted: false, txnId: null };

    const reversal: Line[] = lines.rows
      .filter((row) => row !== sellerLine)
      .map((row) => ({ account: row.code, amount: kobo(-row.amount) }));

    const hold = await client.query<{ released_at: Date | null }>(
      'select released_at from holds where txn_id = $1 for update',
      [original.id],
    );
    const cleared = hold.rows[0]?.released_at != null;

    if (!cleared) {
      reversal.push({ account: `seller.pending:${store}`, amount: kobo(share) });
      if (hold.rowCount) {
        await client.query('update holds set cancelled_at = now() where txn_id = $1', [original.id]);
      }
    } else {
      const available = await owedTo(store, client);
      const fromAvailable = Math.min(Math.max(available, 0), share);
      const shortfall = share - fromAvailable;
      if (fromAvailable > 0) {
        reversal.push({ account: `seller.available:${store}`, amount: kobo(fromAvailable) });
      }
      if (shortfall > 0) {
        reversal.push({ account: `seller.receivable:${store}`, amount: kobo(shortfall) });
      }
    }

    return postWithin(client, transaction(`refund:${reference}`, 'order.refunded', reversal));
  });
}
