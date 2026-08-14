import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { pool, close } from '../src/db.ts';
import { kobo, naira } from '../src/money.ts';
import { post, balanceOf, owedTo } from '../src/ledger.ts';
import { chargeTransaction } from '../src/charge.ts';
import {
  releaseCleared,
  payout,
  refund,
  CLEARANCE_DAYS,
  InsufficientFunds,
  UnknownTransaction,
} from '../src/operations.ts';

const STORE = 'STORE_42';

/** A ₦10,000 order: ₦9,650 to the seller, ₦100 to us, ₦250 to Paystack. */
const anOrder = (reference: string) =>
  chargeTransaction({
    reference,
    storeId: STORE,
    gross: naira(10_000),
    platformFee: naira(100),
    gatewayFee: naira(250),
  });

const daysFromNow = (n: number) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);

before(async () => {
  await pool.query('select 1');
});

beforeEach(async () => {
  await pool.query('truncate entries, holds, transactions, accounts restart identity cascade');
});

after(async () => {
  await close();
});

// ── the hold ─────────────────────────────────────────────────────────────────

test('money is not payable during the clearance hold', async () => {
  await post(anOrder('PSK_1'), { holdDays: CLEARANCE_DAYS });

  assert.equal(await balanceOf(`seller.pending:${STORE}`), -965_000);
  assert.equal(await owedTo(STORE), 0, 'nothing has cleared yet');

  const moved = await releaseCleared(); // today
  assert.equal(moved, 0);
  assert.equal(await owedTo(STORE), 0);
});

test('money becomes payable once the hold clears', async () => {
  await post(anOrder('PSK_1'), { holdDays: CLEARANCE_DAYS });

  const moved = await releaseCleared(daysFromNow(CLEARANCE_DAYS + 1));

  assert.equal(moved, 1);
  assert.equal(await balanceOf(`seller.pending:${STORE}`), 0, 'pending is drained');
  assert.equal(await owedTo(STORE), 965_000);
});

test('releasing twice does not pay twice', async () => {
  await post(anOrder('PSK_1'), { holdDays: CLEARANCE_DAYS });
  const later = daysFromNow(CLEARANCE_DAYS + 1);

  assert.equal(await releaseCleared(later), 1);
  assert.equal(await releaseCleared(later), 0, 'the hold is already released');
  assert.equal(await releaseCleared(later), 0);

  assert.equal(await owedTo(STORE), 965_000);
});

// ── the payout ───────────────────────────────────────────────────────────────

test('a payout cannot draw on money that has not cleared', async () => {
  await post(anOrder('PSK_1'), { holdDays: CLEARANCE_DAYS });

  await assert.rejects(
    () => payout(STORE, naira(9_650), 'PAYOUT_1'),
    (err: unknown) => err instanceof InsufficientFunds,
  );
});

test('a payout draws on cleared money and leaves the rest', async () => {
  await post(anOrder('PSK_1'), { holdDays: CLEARANCE_DAYS });
  await post(anOrder('PSK_2'), { holdDays: CLEARANCE_DAYS });
  await releaseCleared(daysFromNow(CLEARANCE_DAYS + 1));

  assert.equal(await owedTo(STORE), 1_930_000); // two orders

  await payout(STORE, naira(15_000), 'PAYOUT_1');

  assert.equal(await owedTo(STORE), 430_000);
  assert.equal(await balanceOf('cash.bank'), -1_500_000);
});

test('a payout larger than the balance is refused', async () => {
  await post(anOrder('PSK_1'), { holdDays: CLEARANCE_DAYS });
  await releaseCleared(daysFromNow(CLEARANCE_DAYS + 1));

  await assert.rejects(
    () => payout(STORE, naira(9_650.01), 'PAYOUT_1'),
    (err: unknown) => err instanceof InsufficientFunds,
  );
  assert.equal(await owedTo(STORE), 965_000, 'nothing moved');
});

test('a retried payout pays once', async () => {
  await post(anOrder('PSK_1'), { holdDays: CLEARANCE_DAYS });
  await releaseCleared(daysFromNow(CLEARANCE_DAYS + 1));

  const first = await payout(STORE, naira(5_000), 'PAYOUT_1');
  const second = await payout(STORE, naira(5_000), 'PAYOUT_1');

  assert.equal(first.posted, true);
  assert.equal(second.posted, false);
  assert.equal(await owedTo(STORE), 465_000);
});

// ── the refund ───────────────────────────────────────────────────────────────

test('a refund reverses every line, not just the seller share', async () => {
  await post(anOrder('PSK_1'), { holdDays: CLEARANCE_DAYS });
  await refund('PSK_1');

  assert.equal(await balanceOf('cash.paystack'), 0);
  assert.equal(await balanceOf(`seller.pending:${STORE}`), 0);
  assert.equal(await balanceOf('platform.revenue'), 0, 'the fee comes back out');
  assert.equal(await balanceOf('gateway.expense'), 0);
});

test('a retried refund refunds once', async () => {
  await post(anOrder('PSK_1'), { holdDays: CLEARANCE_DAYS });

  const first = await refund('PSK_1');
  const second = await refund('PSK_1');

  assert.equal(first.posted, true);
  assert.equal(second.posted, false);
  assert.equal(await balanceOf('cash.paystack'), 0);
});

test('refunding something that never happened is an error, not a silent no-op', async () => {
  await assert.rejects(() => refund('PSK_NEVER'), (e: unknown) => e instanceof UnknownTransaction);
});

// ── the invariant still holds across all of it ───────────────────────────────

test('every account together sums to zero, whatever happened', async () => {
  await post(anOrder('PSK_1'), { holdDays: CLEARANCE_DAYS });
  await post(anOrder('PSK_2'), { holdDays: CLEARANCE_DAYS });
  await releaseCleared(daysFromNow(CLEARANCE_DAYS + 1));
  await payout(STORE, naira(9_650), 'PAYOUT_1');
  await refund('PSK_2');

  const all = await pool.query<{ total: number }>('select coalesce(sum(amount), 0) as total from entries');
  assert.equal(kobo(all.rows[0]!.total), 0);
});
