import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { pool, close } from '../src/db.ts';
import { kobo, naira, format } from '../src/money.ts';
import { transaction, post, balanceOf, txnCount, Unbalanced } from '../src/ledger.ts';
import { chargeTransaction } from '../src/charge.ts';

before(async () => {
  await pool.query('select 1');
});

beforeEach(async () => {
  await pool.query('truncate entries, holds, transactions, accounts restart identity cascade');
});

after(async () => {
  await close();
});

// ── the invariant ────────────────────────────────────────────────────────────

test('a transaction that does not balance cannot be built', () => {
  assert.throws(
    () =>
      transaction('T1', 'order.paid', [
        { account: 'cash.paystack', amount: kobo(1_000_000) },
        { account: 'seller.pending:STORE_42', amount: kobo(-999_999) },
      ]),
    (err: unknown) => err instanceof Unbalanced && err.drift === 1,
  );
});

test('a transaction needs two sides', () => {
  assert.throws(
    () => transaction('T2', 'order.paid', [{ account: 'cash.paystack', amount: kobo(100) }]),
    /at least two sides/,
  );
});

test('Postgres refuses an unbalanced transaction even when TypeScript is bypassed', async () => {
  // Reaching past the builder, the way psql or a future caller would.
  const client = await pool.connect();
  try {
    await client.query('begin');
    const txn = await client.query<{ id: string }>(
      `insert into transactions (idem_key, kind) values ('RAW_1', 'order.paid') returning id`,
    );
    const acct = await client.query<{ id: string }>(
      `insert into accounts (code, kind) values ('cash.paystack', 'asset') returning id`,
    );
    await client.query('insert into entries (txn_id, account_id, amount) values ($1, $2, $3)', [
      txn.rows[0]!.id,
      acct.rows[0]!.id,
      1_000_000,
    ]);
    await assert.rejects(client.query('commit'), /does not balance/);
  } finally {
    await client.query('rollback').catch(() => {});
    client.release();
  }
});

// ── the one that is the whole pitch ──────────────────────────────────────────

test('a retried webhook moves the money once', async () => {
  const hook = chargeTransaction({
    reference: 'PSK_9f2a11',
    storeId: 'STORE_42',
    gross: naira(10_000),
    platformFee: naira(100),
    gatewayFee: naira(250),
  });

  const first = await post(hook);
  const second = await post(hook); // Paystack really does this
  const third = await post(hook);

  assert.equal(first.posted, true);
  assert.equal(second.posted, false);
  assert.equal(third.posted, false);

  assert.equal(await balanceOf('seller.pending:STORE_42'), -965_000);
  assert.equal(await balanceOf('platform.revenue'), -10_000);
  assert.equal(await balanceOf('gateway.expense'), -25_000);
  assert.equal(await balanceOf('cash.paystack'), 1_000_000);
  assert.equal(await txnCount('PSK_9f2a11'), 1);
});

// ── the fee separation, which is the point of using accounts ─────────────────

test('platform revenue and gateway cost never merge', async () => {
  await post(
    chargeTransaction({
      reference: 'PSK_A',
      storeId: 'STORE_1',
      gross: naira(10_000),
      platformFee: naira(100),
      gatewayFee: naira(250),
    }),
  );
  await post(
    chargeTransaction({
      reference: 'PSK_B',
      storeId: 'STORE_1',
      gross: naira(5_000),
      platformFee: naira(50),
      gatewayFee: naira(175),
    }),
  );

  // What Myshoplet earned. Paystack's ₦425 is not in this number and cannot be.
  assert.equal(format(kobo(-(await balanceOf('platform.revenue')))), '₦150.00');
  assert.equal(format(kobo(-(await balanceOf('gateway.expense')))), '₦425.00');
});

// ── money ────────────────────────────────────────────────────────────────────

test('kobo rejects fractions', () => {
  assert.throws(() => kobo(10.5), /whole kobo/);
});

test('naira converts without float drift', () => {
  assert.equal(naira(96.5), 9650);
  assert.equal(naira(0.07), 7);
  assert.equal(naira(1839.03), 183903);
});

test('format is display only', () => {
  assert.equal(format(kobo(965_000)), '₦9,650.00');
  assert.equal(format(kobo(7)), '₦0.07');
  assert.equal(format(kobo(-25_000)), '-₦250.00');
});
