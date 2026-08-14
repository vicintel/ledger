# ledger

A double-entry ledger for marketplace payouts, in TypeScript on Postgres.

Myshoplet's payout ledger runs on MongoDB in production and handles real money
for real sellers. This is that ledger rebuilt on Postgres and TypeScript, to
find out which of the safeguards I wrote by hand the database could have
enforced for me.

The answer was most of them. A retried payment webhook once double-paid our
ambassadors; I fixed it with a conditional update. Here it is a unique
constraint, and the bug is not expressible.

---

## What the database enforces that the application used to

| In production (MongoDB) | Here (Postgres) |
| --- | --- |
| A `$ne`-filtered `updateOne`, so a retried webhook could not double-pay | `unique (idem_key)` and `insert … on conflict do nothing` |
| `fee` and `gatewayFee` as sibling columns, kept apart by a comment | `platform.revenue` and `gateway.expense` as separate accounts |
| `balance` stored on the wallet and updated on every change | `sum(amount)` over the entries, never stored, cannot drift |
| A seven-day hold enforced by application logic before each payout | A `holds` row with `clears_at`; a payout query cannot see uncleared funds |
| Multi-step money writes with no surrounding transaction | `begin … commit`, with the balance check deferred to the end |

The middle column is not a criticism of the production system — it works, and it
has held real money for a year. It is a record of what a different tool would
have given for free.

## The invariant

Every transaction's entries sum to zero. A ₦10,000 order splits four ways:

| Account | Side | Amount |
| --- | --- | ---: |
| `cash.paystack` | debit | ₦10,000.00 |
| `seller.pending:STORE_42` | credit | ₦9,650.00 |
| `platform.revenue` | credit | ₦100.00 |
| `gateway.expense` | credit | ₦250.00 |
| | | **₦0.00** |

Paystack's ₦250 is their real charge, passed through at cost. It is an expense,
never revenue, and because it lives in its own account the question "what did we
earn" has exactly one answer.

That zero is enforced by a deferred constraint trigger, so it is checked once at
`COMMIT` rather than after every insert. There is a test that bypasses the
TypeScript entirely and posts an unbalanced transaction through raw SQL, to show
that the guarantee does not depend on going through the front door.

## The test that matters

```ts
const hook = chargeTransaction({ reference: 'PSK_9f2a11', /* … */ });

await post(hook);
await post(hook);   // Paystack really does this
await post(hook);

assert.equal(await balanceOf('seller.pending:STORE_42'), -965_000);
assert.equal(await txnCount('PSK_9f2a11'), 1);
```

## Money

Amounts are whole kobo carried as a branded `number`, so naira and kobo cannot
be added together and a float cannot reach the arithmetic:

```ts
declare const brand: unique symbol;
export type Kobo = number & { readonly [brand]: 'Kobo' };
```

The type check and the database constraint are deliberately redundant. They are
not the same guarantee: a type helps whoever is writing the code, and a
constraint protects the data from every path that was never typed at all.

## Running it

Requires Node 20+ and Postgres 17.

```bash
npm install
npm run db:up      # creates ledger_dev and applies migrations/001_ledger.sql
npm test           # 8 tests
npm run typecheck  # tsc --noEmit, strict
```

`pg` is used directly rather than an ORM. The point of the project is the SQL
and the transaction boundaries, and an ORM hides both.

## Not in scope

No HTTP layer, no authentication, no UI, no multi-currency, no deployment. Each
of those would make it a bigger project and a worse example.

---

MIT
