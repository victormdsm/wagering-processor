import { defineEntity, p } from "@mikro-orm/core";
import { WagerTransactionRecord } from "../../../wagering/infrastructure/persistence/wager-transaction.record";
import { LedgerDirection } from "../../domain/ledger-direction";
import { WalletRecord } from "./wallet.record";

const WalletLedgerEntrySchema = defineEntity({
  name: "WalletLedgerEntryRecord",
  tableName: "wallet_ledger_entries",
  properties: {
    id: p.uuid().primary(),
    wallet: () => p.manyToOne(WalletRecord).mapToPk(),
    transaction: () => p.manyToOne(WagerTransactionRecord).mapToPk(),
    direction: p.enum(() => LedgerDirection),
    amount: p.decimal().precision(19).scale(2),
    balanceBefore: p.decimal().precision(19).scale(2),
    balanceAfter: p.decimal().precision(19).scale(2),
    currency: p.string().length(3),
    createdAt: p.datetime(),
  },
  uniques: [{ properties: ["wallet", "transaction"] }],
  indexes: [{ properties: ["wallet", "createdAt", "id"] }],
  checks: [
    { name: "wallet_ledger_entries_amount_positive", expression: "amount > 0" },
    { name: "wallet_ledger_entries_balance_after_non_negative", expression: "balance_after >= 0" },
    {
      name: "wallet_ledger_entries_balanced",
      expression:
        "(direction = 'CREDIT' and balance_after = balance_before + amount) or " +
        "(direction = 'DEBIT' and balance_after = balance_before - amount)",
    },
  ],
  triggers: [
    {
      name: "wallet_ledger_entries_immutable",
      timing: "before",
      events: ["update", "delete"],
      forEach: "row",
      body: "raise exception 'wallet_ledger_entries é imutável';",
    },
  ],
});

export class WalletLedgerEntryRecord extends WalletLedgerEntrySchema.class {}
WalletLedgerEntrySchema.setClass(WalletLedgerEntryRecord);
