import { Injectable } from "@nestjs/common";
import { EventOutbox } from "../../shared/application/event-outbox";
import { Money, type MoneyProps } from "../../shared/domain/money";
import { WalletRepository } from "../../wallet/domain/wallet.repository";
import { WalletNotFoundError } from "../../wallet/domain/wallet.errors";
import { WagerTransactionPendingReference } from "../domain/events/wager-transaction-pending-reference.event";
import { WagerTransaction } from "../domain/wager-transaction";
import { WagerTransactionKind } from "../domain/wager-transaction-kind";
import type { WagerTransactionStatus } from "../domain/wager-transaction-status";
import { WagerTransactionRepository } from "../domain/wager-transaction.repository";
import { IdempotencyConflictError, KindNotAllowedError } from "../domain/wagering.errors";
import { hashWagerPayload, type WagerPayload } from "./payload-hash";
import { WagerTransactionApplier } from "./wager-transaction-applier";

export interface ProcessWagerTransactionInput extends WagerPayload {
  idempotencyKey: string;
  causationId?: string;
}

export interface ProcessWagerTransactionOutput {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  idempotentReplay: boolean;
}

const SUBMITTABLE_KINDS = new Set<string>(
  Object.values(WagerTransactionKind).filter((kind) => kind !== WagerTransactionKind.Opening),
);

@Injectable()
export class ProcessWagerTransactionUseCase {
  constructor(
    private readonly transactions: WagerTransactionRepository,
    private readonly wallets: WalletRepository,
    private readonly applier: WagerTransactionApplier,
    private readonly outbox: EventOutbox,
  ) {}

  async execute(input: ProcessWagerTransactionInput): Promise<ProcessWagerTransactionOutput> {
    if (!SUBMITTABLE_KINDS.has(input.kind)) throw new KindNotAllowedError(input.kind);
    const money = Money.from(input.money);
    const payloadHash = hashWagerPayload(input);

    const existing = await this.transactions.findByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      if (!existing.matchesPayload(payloadHash)) throw new IdempotencyConflictError(input.idempotencyKey);
      const current = existing.observedBalance ? undefined : (await this.wallets.findById(existing.walletId))?.balance;
      return this.toOutput(existing, true, current);
    }
    if (await this.transactions.findByExternalId(input.providerId, input.externalTransactionId)) {
      throw new IdempotencyConflictError(input.idempotencyKey);
    }

    const wallet = await this.wallets.lockById(input.walletId);
    if (!wallet) throw new WalletNotFoundError(input.walletId);

    const now = new Date();
    const transaction = WagerTransaction.create({
      id: crypto.randomUUID(),
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      idempotencyKey: input.idempotencyKey,
      payloadHash,
      walletId: input.walletId,
      playerId: input.playerId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind as WagerTransactionKind,
      money,
      referenceExternalTransactionId: input.referenceExternalTransactionId,
      createdAt: now,
    });
    const ctx = { correlationId: input.idempotencyKey, causationId: input.causationId, occurredAt: now };

    const result = await this.applier.apply(transaction, wallet, ctx);
    if (result === "pending-reference") {
      transaction.markPendingReference();
      transaction.scheduleReferenceRetry(now);
      await this.outbox.enqueue([WagerTransactionPendingReference.from(transaction, ctx)]);
    }

    await this.transactions.save(transaction);
    return this.toOutput(transaction, false, wallet.balance);
  }

  private toOutput(
    transaction: WagerTransaction,
    idempotentReplay: boolean,
    currentBalance?: Money,
  ): ProcessWagerTransactionOutput {
    const balance = transaction.observedBalance ?? currentBalance;
    return {
      transactionId: transaction.id,
      status: transaction.status,
      balance: balance ? balance.toJSON() : { amount: "0.00", currency: transaction.money.currency },
      idempotentReplay,
    };
  }
}
