import { Migration } from '@mikro-orm/migrations';

export class Migration20261025013949 extends Migration {
  override name = 'Migration20261025013949';

  override up(): void | Promise<void> {
    this.addSql(`create table "idempotency_keys" ("id" bigserial primary key, "created_at" timestamptz not null default now(), "idempotency_key" varchar(100) not null, "provider_id" varchar(255) not null, "payload_hash" varchar(255) not null, "response_code" int null, "response_body" jsonb null);`);
    this.addSql(`create index "idempotency_keys_created_at_index" on "idempotency_keys" ("created_at");`);
    this.addSql(`alter table "idempotency_keys" add constraint "idempotency_keys_provider_id_idempotency_key_unique" unique ("provider_id", "idempotency_key");`);

    this.addSql(`create table "inbox_messages" ("consumer_name" varchar(255) not null, "message_id" varchar(255) not null, "payload_hash" varchar(255) not null, "received_at" timestamptz not null, "processed_at" timestamptz null, primary key ("consumer_name", "message_id"));`);
    this.addSql(`create index "inbox_messages_received_at_index" on "inbox_messages" ("received_at");`);

    this.addSql(`create table "outbox_messages" ("id" uuid not null, "aggregate_id" varchar(255) not null, "event_type" varchar(255) not null, "payload" jsonb not null, "occurred_at" timestamptz not null, "attempts" int not null, "next_attempt_at" timestamptz null, "published_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "outbox_messages_occurred_at_index" on "outbox_messages" ("occurred_at") where published_at is null;`);

    this.addSql(`create table "wallets" ("id" uuid not null, "player_id" uuid not null, "currency" varchar(3) not null, "balance" numeric(19,2) not null, "version" int not null default 1, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "wallets" add constraint "wallets_player_id_currency_unique" unique ("player_id", "currency");`);

    this.addSql(`create table "wager_transactions" ("id" uuid not null, "provider_id" varchar(255) not null, "external_transaction_id" varchar(255) not null, "idempotency_key" varchar(255) not null, "payload_hash" varchar(255) not null, "wallet_id" uuid not null, "player_id" uuid not null, "round_id" varchar(255) not null, "game_id" varchar(255) not null, "kind" text not null, "amount" numeric(19,2) not null, "currency" varchar(3) not null, "reference_external_transaction_id" varchar(255) null, "reference_transaction_id" uuid null, "status" text not null, "failure_code" varchar(255) null, "processed_at" timestamptz null, "observed_balance" numeric(19,2) null, "created_at" timestamptz not null, "attempts" int not null default 0, "next_attempt_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "wager_transactions_next_attempt_at_index" on "wager_transactions" ("next_attempt_at") where status = 'PENDING_REFERENCE';`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_provider_id_external_transaction_id_unique" unique ("provider_id", "external_transaction_id");`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_idempotency_key_unique" unique ("idempotency_key");`);
    this.addSql(`create unique index "wager_transactions_reversal_unique" on "wager_transactions" ("reference_transaction_id") where kind in ('REFUND', 'ROLLBACK');`);

    this.addSql(`create table "wallet_ledger_entries" ("id" uuid not null, "wallet_id" uuid not null, "transaction_id" uuid not null, "direction" text not null, "amount" numeric(19,2) not null, "balance_before" numeric(19,2) not null, "balance_after" numeric(19,2) not null, "currency" varchar(3) not null, "created_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "wallet_ledger_entries_wallet_id_created_at_id_index" on "wallet_ledger_entries" ("wallet_id", "created_at", "id");`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_wallet_id_transaction_id_unique" unique ("wallet_id", "transaction_id");`);

    this.addSql(`alter table "outbox_messages" add constraint "outbox_messages_attempts_non_negative" check (attempts >= 0);`);

    this.addSql(`alter table "wallets" add constraint "wallets_balance_non_negative" check (balance >= 0);`);

    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_wallet_id_foreign" foreign key ("wallet_id") references "wallets" ("id");`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_reference_transaction_id_foreign" foreign key ("reference_transaction_id") references "wager_transactions" ("id") on delete set null;`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_amount_non_negative" check (amount >= 0);`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_attempts_non_negative" check (attempts >= 0);`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_reference_required" check (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null);`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_kind_check" check ("kind" in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'));`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_status_check" check ("status" in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'));`);

    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_wallet_id_foreign" foreign key ("wallet_id") references "wallets" ("id");`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_transaction_id_foreign" foreign key ("transaction_id") references "wager_transactions" ("id");`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_amount_positive" check (amount > 0);`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_balance_after_non_negative" check (balance_after >= 0);`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_balanced" check ((direction = 'CREDIT' and balance_after = balance_before + amount) or (direction = 'DEBIT' and balance_after = balance_before - amount));`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_direction_check" check ("direction" in ('DEBIT', 'CREDIT'));`);
    this.addSql(`create or replace function "wallet_ledger_entries_wallet_ledger_entries_immutable_fn"() returns trigger as $$ begin raise exception 'wallet_ledger_entries é imutável'; end; $$ language plpgsql;`);
    this.addSql(`create trigger "wallet_ledger_entries_immutable" BEFORE UPDATE OR DELETE on "wallet_ledger_entries" for each ROW execute function "wallet_ledger_entries_wallet_ledger_entries_immutable_fn"();`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "wager_transactions" drop constraint "wager_transactions_wallet_id_foreign";`);
    this.addSql(`alter table "wallet_ledger_entries" drop constraint "wallet_ledger_entries_wallet_id_foreign";`);
    this.addSql(`alter table "wager_transactions" drop constraint "wager_transactions_reference_transaction_id_foreign";`);
    this.addSql(`alter table "wallet_ledger_entries" drop constraint "wallet_ledger_entries_transaction_id_foreign";`);

    this.addSql(`drop table if exists "idempotency_keys" cascade;`);
    this.addSql(`drop table if exists "inbox_messages" cascade;`);
    this.addSql(`drop table if exists "outbox_messages" cascade;`);
    this.addSql(`drop table if exists "wallets" cascade;`);
    this.addSql(`drop table if exists "wager_transactions" cascade;`);
    this.addSql(`drop trigger if exists "wallet_ledger_entries_immutable" on "wallet_ledger_entries";`);
    this.addSql(`drop function if exists "wallet_ledger_entries_wallet_ledger_entries_immutable_fn"();`);
    this.addSql(`drop table if exists "wallet_ledger_entries" cascade;`);
  }

}
