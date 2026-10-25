import { Migrator } from "@mikro-orm/migrations";
import { defineConfig } from "@mikro-orm/postgresql";
import { IdempotencyKeyRecord } from "../../../wagering/infrastructure/persistence/idempotency-key.record";
import { WagerTransactionRecord } from "../../../wagering/infrastructure/persistence/wager-transaction.record";
import { WalletLedgerEntryRecord } from "../../../wallet/infrastructure/persistence/wallet-ledger-entry.record";
import { WalletRecord } from "../../../wallet/infrastructure/persistence/wallet.record";
import { InboxMessageRecord } from "./inbox-message.record";
import { OutboxMessageRecord } from "./outbox-message.record";

export default defineConfig({
  clientUrl: process.env.DATABASE_URL,

  entities: [
    WalletRecord,
    WalletLedgerEntryRecord,
    WagerTransactionRecord,
    IdempotencyKeyRecord,
    InboxMessageRecord,
    OutboxMessageRecord,
  ],

  extensions: [Migrator],

  migrations: {
    path: "src/shared/infrastructure/persistence/migrations",
    snapshot: false,
  },
});
