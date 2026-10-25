import { defineEntity, p } from "@mikro-orm/core";
import { WalletRecord } from "../../../wallet/infrastructure/persistence/wallet.record";
import { WagerTransactionKind } from "../../domain/wager-transaction-kind";
import { WagerTransactionStatus } from "../../domain/wager-transaction-status";

const WagerTransactionSchema = defineEntity({
  name: "WagerTransactionRecord",
  tableName: "wager_transactions",
  properties: {
    id: p.uuid().primary(),
    providerId: p.string(),
    externalTransactionId: p.string(),
    idempotencyKey: p.string(),
    payloadHash: p.string(),
    wallet: () => p.manyToOne(WalletRecord).mapToPk(),
    playerId: p.uuid(),
    roundId: p.string(),
    gameId: p.string(),
    kind: p.enum(() => WagerTransactionKind),
    amount: p.decimal().precision(19).scale(2),
    currency: p.string().length(3),
    referenceExternalTransactionId: p.string().nullable(),
    referenceTransaction: () => p.manyToOne(WagerTransactionRecord).mapToPk().nullable(),
    status: p.enum(() => WagerTransactionStatus),
    failureCode: p.string().nullable(),
    processedAt: p.datetime().nullable(),
    observedBalance: p.decimal().precision(19).scale(2).nullable(),
    createdAt: p.datetime(),
    attempts: p.integer().default(0),
    nextAttemptAt: p.datetime().nullable(),
  },
  indexes: [{ properties: ["nextAttemptAt"], where: "status = 'PENDING_REFERENCE'" }],
  uniques: [
    { properties: ["providerId", "externalTransactionId"] },
    { properties: ["idempotencyKey"] },
    {
      name: "wager_transactions_reversal_unique",
      properties: ["referenceTransaction"],
      where: "kind in ('REFUND', 'ROLLBACK')",
    },
  ],
  checks: [
    { name: "wager_transactions_amount_non_negative", expression: "amount >= 0" },
    { name: "wager_transactions_attempts_non_negative", expression: "attempts >= 0" },
    {
      name: "wager_transactions_reference_required",
      expression: "kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null",
    },
  ],
});

export class WagerTransactionRecord extends WagerTransactionSchema.class {}
WagerTransactionSchema.setClass(WagerTransactionRecord);
