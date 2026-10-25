import { Injectable } from "@nestjs/common";
import { EventOutbox } from "../../shared/application/event-outbox";
import { WalletRepository } from "../../wallet/domain/wallet.repository";
import { WagerTransactionRejected } from "../domain/events/wager-transaction-rejected.event";
import { FailureCode } from "../domain/failure-code";
import { WagerTransactionRepository } from "../domain/wager-transaction.repository";
import { WagerTransactionApplier } from "./wager-transaction-applier";

@Injectable()
export class RetryPendingReferencesUseCase {
  constructor(
    private readonly transactions: WagerTransactionRepository,
    private readonly wallets: WalletRepository,
    private readonly applier: WagerTransactionApplier,
    private readonly outbox: EventOutbox,
  ) {}

  async processNext(now: Date): Promise<boolean> {
    const [transaction] = await this.transactions.lockDuePendingReferences(now, 1);
    if (!transaction) return false;

    const wallet = await this.wallets.lockById(transaction.walletId);
    if (!wallet) throw new Error(`wallet ${transaction.walletId} da transação ${transaction.id} sumiu`);

    const ctx = { correlationId: transaction.idempotencyKey, causationId: transaction.id, occurredAt: now };
    const result = await this.applier.apply(transaction, wallet, ctx);

    if (result === "pending-reference") {
      if (transaction.hasExhaustedReferenceRetries()) {
        transaction.reject(FailureCode.ReferenceNotFound, wallet.balance);
        await this.outbox.enqueue([WagerTransactionRejected.from(transaction, ctx)]);
      } else {
        transaction.scheduleReferenceRetry(now);
      }
    }

    await this.transactions.save(transaction);
    return true;
  }
}
