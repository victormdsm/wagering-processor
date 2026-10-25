import { LockMode } from "@mikro-orm/core";
import { EntityManager } from "@mikro-orm/postgresql";
import { Injectable } from "@nestjs/common";
import { Money } from "../../../shared/domain/money";
import type { FailureCode } from "../../domain/failure-code";
import { WagerTransaction } from "../../domain/wager-transaction";
import { WagerTransactionKind } from "../../domain/wager-transaction-kind";
import { WagerTransactionStatus } from "../../domain/wager-transaction-status";
import { WagerTransactionRepository } from "../../domain/wager-transaction.repository";
import { WagerTransactionRecord } from "./wager-transaction.record";

@Injectable()
export class MikroOrmWagerTransactionRepository extends WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | null> {
    const record = await this.em.findOne(WagerTransactionRecord, { idempotencyKey });
    return record ? toDomain(record) : null;
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
    const record = await this.em.findOne(WagerTransactionRecord, { providerId, externalTransactionId });
    return record ? toDomain(record) : null;
  }

  async isAlreadyReversed(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRecord, {
      referenceTransaction: referenceTransactionId,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
      status: WagerTransactionStatus.Processed,
    });
    return count > 0;
  }

  async lockDuePendingReferences(now: Date, limit: number): Promise<WagerTransaction[]> {
    const records = await this.em.find(
      WagerTransactionRecord,
      { status: WagerTransactionStatus.PendingReference, nextAttemptAt: { $lte: now } },
      { orderBy: { nextAttemptAt: "asc" }, limit, lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE },
    );
    return records.map(toDomain);
  }

  async save(transaction: WagerTransaction): Promise<void> {
    const data = toRecordData(transaction);
    const record = await this.em.findOne(WagerTransactionRecord, { id: transaction.id });
    if (record) {
      this.em.assign(record, data);
      return;
    }
    this.em.create(WagerTransactionRecord, data);
  }
}

function toDomain(record: WagerTransactionRecord): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: record.id,
    providerId: record.providerId,
    externalTransactionId: record.externalTransactionId,
    idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash,
    walletId: record.wallet,
    playerId: record.playerId,
    roundId: record.roundId,
    gameId: record.gameId,
    kind: record.kind,
    money: Money.from({ amount: record.amount, currency: record.currency }),
    referenceExternalTransactionId: record.referenceExternalTransactionId ?? undefined,
    createdAt: record.createdAt,
    status: record.status,
    referenceTransactionId: record.referenceTransaction ?? undefined,
    failureCode: (record.failureCode as FailureCode | null) ?? undefined,
    processedAt: record.processedAt ?? undefined,
    observedBalance: record.observedBalance
      ? Money.from({ amount: record.observedBalance, currency: record.currency })
      : undefined,
    attempts: record.attempts,
    nextAttemptAt: record.nextAttemptAt ?? undefined,
  });
}

function toRecordData(transaction: WagerTransaction) {
  return {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    payloadHash: transaction.payloadHash,
    wallet: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    amount: transaction.money.toString(),
    currency: transaction.money.currency,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    referenceTransaction: transaction.referenceTransactionId ?? null,
    status: transaction.status,
    failureCode: transaction.failureCode ?? null,
    processedAt: transaction.processedAt ?? null,
    observedBalance: transaction.observedBalance?.toString() ?? null,
    createdAt: transaction.createdAt,
    attempts: transaction.attempts,
    nextAttemptAt: transaction.nextAttemptAt ?? null,
  };
}
