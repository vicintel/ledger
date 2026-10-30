/**
 * Each test here failed against the code before migration 002. They are the
 * questions a payments reviewer asks first: what if two payouts land at once,
 * what if a refund lands mid-hold, what if someone edits a row.
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { pool, close } from '../src/db.ts';
import { naira } from '../src/money.ts';
import { post, balanceOf, owedTo, txnCount, IdempotencyConflict } from '../src/ledger.ts';
import { chargeTransaction } from '../src/charge.ts';
import {
  releaseCleared,
  payout,
  refund,
  CLEARANCE_DAYS,
  InsufficientFunds,
  NotRefundable,
} from '../src/operations.ts';

const STORE = 'STORE_42';

/** A ₦10,000 order: ₦9,650 to the seller, ₦100 to us, ₦250 to Paystack. */
const anOrder = (reference: string, gross = 10_000) =>
  chargeTransaction({
    reference,
    storeId: STORE,
    gross: naira(gross),
    platformFee: naira(100),
    gatewayFee: naira(250),
  });

const afterClearance = () => new Date(Date.now() + (CLEARANCE_DAYS + 1) * 24 * 60 * 60 * 1000);

async function clearedOrder(reference: string): Promise<void> {
  await post(anOrder(reference), { holdDays: CLEARANCE_DAYS });
  await releaseCleared(afterClearance());
}

async function everythingSumsToZero(): Promise<void> {
  const res = await pool.query<{ total: string | null }>('select sum(amount)::text as total from entries');
  assert.equal(Number(res.rows[0]!.total ?? 0), 0);
}

before(async () => {
  await pool.query('select 1');
});

beforeEach(async () => {
  await pool.query('truncate entries, holds, transactions, accounts restart identity cascade');
});

after(async () => {
  await close();
});

// ── concurrency ──────────────────────────────────────────────────────────────

test('concurrent payouts cannot overdraw a seller', async () => {
  await clearedOrder('PSK_1'); // ₦9,650 available

  // Before the fix all four passed the balance check and the seller ended at
  // −₦26,350.
  const results = await Promise.allSettled(
    ['PO_A', 'PO_B', 'PO_C', 'PO_D'].map((ref) => payout(STORE, naira(9_000), ref)),
  );

  const paid = results.filter((r) => r.status === 'fulfilled');
  const refused = results.filter(
    (r) => r.status === 'rejected' && r.reason instanceof InsufficientFunds,
  );
  assert.equal(paid.length, 1);
  assert.equal(refused.length, 3);
  assert.equal(await owedTo(STORE), naira(650));
});

test('a release racing a refund settles the hold exactly one way', async () => {
  await post(anOrder('PSK_1'), { holdDays: CLEARANCE_DAYS });

  await Promise.all([releaseCleared(afterClearance()), refund('PSK_1')]);

  // Whichever won, the seller is owed nothing and nothing is left pending.
  assert.equal(await owedTo(STORE), 0);
  assert.equal(await balanceOf(`seller.pending:${STORE}`), 0);
  assert.equal(await balanceOf(`seller.receivable:${STORE}`), 0);
  await everythingSumsToZero();
});

// ── refunds take the money back from where it is ────────────────────────────

test('a refund during the hold cancels it, so the release never pays', async () => {
  await post(anOrder('PSK_1'), { holdDays: CLEARANCE_DAYS });
  await refund('PSK_1');

  // Before the fix this released ₦9,650 for an order that had been refunded.
  assert.equal(await releaseCleared(afterClearance()), 0);
  assert.equal(await owedTo(STORE), 0);
  assert.equal(await balanceOf(`seller.pending:${STORE}`), 0);
  await everythingSumsToZero();
});

test('a refund after clearing takes the share back out of available', async () => {
  await clearedOrder('PSK_1');
  await refund('PSK_1');

  assert.equal(await owedTo(STORE), 0);
  assert.equal(await balanceOf(`seller.pending:${STORE}`), 0);
  assert.equal(await balanceOf(`seller.receivable:${STORE}`), 0);
  await everythingSumsToZero();
});

test('a refund after payout records what the seller now owes us', async () => {
  await clearedOrder('PSK_1');
  await payout(STORE, naira(9_000), 'PO_1'); // ₦650 left
  await refund('PSK_1');

  // ₦650 comes back out of available; the other ₦9,000 was already paid out
  // and is now a receivable instead of a silent hole in pending.
  assert.equal(await owedTo(STORE), 0);
  assert.equal(await balanceOf(`seller.receivable:${STORE}`), naira(9_000));
  assert.equal(await balanceOf(`seller.pending:${STORE}`), 0);
  await everythingSumsToZero();
});

test('only a paid order can be refunded', async () => {
  await clearedOrder('PSK_1');
  await payout(STORE, naira(1_000), 'PO_1');
  await refund('PSK_1');

  await assert.rejects(() => refund('PO_1'), NotRefundable);
  await assert.rejects(() => refund('refund:PSK_1'), NotRefundable);
  await assert.rejects(() => refund('release:1'), NotRefundable);
});

// ── the books are append-only ───────────────────────────────────────────────

test('an entry cannot be edited, even in raw SQL', async () => {
  await post(anOrder('PSK_1'));

  // Before the fix this succeeded and left the books off by 100 kobo.
  await assert.rejects(
    pool.query('update entries set amount = amount + 100 where id = (select min(id) from entries)'),
    /append-only/,
  );
  await assert.rejects(pool.query('delete from entries'), /append-only/);
  await assert.rejects(pool.query(`update transactions set idem_key = 'X'`), /append-only/);
  await everythingSumsToZero();
});

// ── idempotency tells a retry from a mistake ────────────────────────────────

test('the same reference with a different amount is an error, not a retry', async () => {
  await post(anOrder('PSK_1', 10_000));

  await assert.rejects(() => post(anOrder('PSK_1', 50_000)), IdempotencyConflict);
  assert.equal(await txnCount('PSK_1'), 1);
});

test('a payout cannot reuse an order reference and report success', async () => {
  await clearedOrder('REF_1');

  // Before the fix this returned { posted: false } and moved nothing.
  await assert.rejects(() => payout(STORE, naira(5_000), 'REF_1'), IdempotencyConflict);
  assert.equal(await owedTo(STORE), naira(9_650));
});

test('a retried payout with a different amount is refused', async () => {
  await clearedOrder('PSK_1');
  await payout(STORE, naira(1_000), 'PO_1');

  await assert.rejects(() => payout(STORE, naira(2_000), 'PO_1'), IdempotencyConflict);
  assert.equal(await owedTo(STORE), naira(8_650));
});
