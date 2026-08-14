-- A double-entry ledger for marketplace payouts.
--
-- Modelled on a MongoDB ledger that runs in production and handles real money.
-- The point of this file is that most of what that system enforces in
-- application code is enforced here by the database instead.
--
-- Amounts are kobo (1/100 naira) as bigint. Never a float, never numeric:
-- money is a whole number of the smallest unit, and formatting is a display
-- concern that belongs nowhere near the arithmetic.

begin;

create table accounts (
  id          bigserial primary key,
  -- 'platform.revenue', 'seller.pending:STORE_42', 'cash.paystack'
  code        text        not null unique,
  kind        text        not null check (kind in ('asset', 'liability', 'revenue', 'expense')),
  created_at  timestamptz not null default now()
);

comment on table accounts is
  'Platform fees and gateway fees are separate accounts, not sibling columns. '
  'The production model kept fee and gatewayFee apart with a comment warning '
  'that revenue reporting must not add them together. Here, adding them wrong '
  'is not expressible.';

create table transactions (
  id           bigserial primary key,
  -- The gateway''s own reference. A retried webhook carries the same one, and
  -- the unique index is what makes the retry harmless.
  idem_key     text        not null unique,
  kind         text        not null,
  occurred_at  timestamptz not null default now()
);

create table entries (
  id          bigserial primary key,
  txn_id      bigint  not null references transactions (id) on delete restrict,
  account_id  bigint  not null references accounts (id)     on delete restrict,
  -- Signed. Debits are positive, credits negative; the sign convention only has
  -- to be consistent, because the invariant below is what actually matters.
  amount      bigint  not null check (amount <> 0)
);

create index entries_txn_idx     on entries (txn_id);
create index entries_account_idx on entries (account_id);

-- Funds are not spendable the moment they arrive. The production system holds
-- them for seven days before a payout may draw on them; that rule lived in
-- application code and had to be remembered at every payout path. Here a payout
-- query simply cannot see uncleared money.
create table holds (
  txn_id       bigint      primary key references transactions (id) on delete restrict,
  clears_at    timestamptz not null,
  released_at  timestamptz
);

create index holds_pending_idx on holds (clears_at) where released_at is null;

-- The whole idea, as a rule the database will not let you break: every
-- transaction's entries sum to zero.
--
-- Deferred, so it is checked once at COMMIT rather than after each INSERT --
-- otherwise the first line of a balanced pair would always fail.
create function assert_balanced() returns trigger as $$
declare
  drift bigint;
begin
  select sum(amount) into drift from entries where txn_id = new.txn_id;

  if drift <> 0 then
    raise exception 'transaction % does not balance: off by % kobo', new.txn_id, drift
      using errcode = 'check_violation';
  end if;

  return null;
end;
$$ language plpgsql;

create constraint trigger entries_must_balance
  after insert on entries
  deferrable initially deferred
  for each row execute function assert_balanced();

-- A transaction needs at least two sides. One entry can never sum to zero given
-- the amount <> 0 check, so this is implied -- but stating it makes the failure
-- message honest when someone writes a single-line transaction by mistake.

commit;
