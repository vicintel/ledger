-- Closing the gaps a review found in 001.
--
-- 001 checks that every transaction balances, but only on INSERT. An UPDATE to
-- one entry could unbalance the books with no error, so "Postgres keeps it
-- honest" held only for code that never edited a row. Here, posted money is
-- append-only: a mistake is corrected with a new transaction, never an edit.

begin;

-- ── append-only ─────────────────────────────────────────────────────────────

create function reject_change() returns trigger as $$
begin
  raise exception '% is append-only: % refused; post a correcting transaction instead',
    tg_table_name, tg_op
    using errcode = 'restrict_violation';
end;
$$ language plpgsql;

create trigger entries_append_only
  before update or delete on entries
  for each row execute function reject_change();

create trigger transactions_append_only
  before update or delete on transactions
  for each row execute function reject_change();

-- ── idempotency that notices a different request ────────────────────────────

-- A reference used twice for the same request is a retry. Used twice for a
-- different one (another amount, another kind of operation) it is a bug in
-- the caller, and silently ignoring the second would hide it. The fingerprint
-- lets post() tell the two apart. Rows from before this migration have none.
alter table transactions add column request_hash text;

-- ── holds that a refund can cancel ──────────────────────────────────────────

-- A refund during the clearance window has to stop the hold, or the scheduled
-- release later pays the seller for an order that was given back.
alter table holds add column cancelled_at timestamptz;

alter table holds add constraint holds_end_one_way
  check (released_at is null or cancelled_at is null);

drop index holds_pending_idx;
create index holds_pending_idx on holds (clears_at)
  where released_at is null and cancelled_at is null;

commit;
