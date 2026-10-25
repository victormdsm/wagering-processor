import { Injectable } from "@nestjs/common";
import { EventOutbox } from "../../shared/application/event-outbox";
import { CurrencyMismatchError } from "../../shared/domain/domain-error";
import type { EventContext, IntegrationEvent } from "../../shared/domain/integration-event";
import { WalletBalanceChanged } from "../../wallet/domain/events/wallet-balance-changed.event";
import { LedgerDirection } from "../../wallet/domain/ledger-direction";
import type { Wallet } from "../../wallet/domain/wallet";
import { WalletLedgerRepository, WalletRepository } from "../../wallet/domain/wallet.repository";
import { WagerTransactionProcessed } from "../domain/events/wager-transaction-processed.event";
import { WagerTransactionRejected } from "../domain/events/wager-transaction-rejected.event";
import { toFailureCode } from "../domain/failure-code";
import type { WagerTransaction } from "../domain/wager-transaction";
import { WagerTransactionKind } from "../domain/wager-transaction-kind";
import { WagerTransactionStatus } from "../domain/wager-transaction-status";
import { WagerTransactionRepository } from "../domain/wager-transaction.repository";
import {
  ReferenceAlreadyReversedError,
  ReversalWouldOverdraftError,
  WalletPlayerMismatchError,
} from "../domain/wagering.errors";

export type ApplyResult = "applied" | "pending-reference";

@Injectable()
export class WagerTransactionApplier {
  constructor(
    private readonly transactions: WagerTransactionRepository,
    private readonly wallets: WalletRepository,
    private readonly ledger: WalletLedgerRepository,
    private readonly outbox: EventOutbox,
  ) {}

  async apply(transaction: WagerTransaction, wallet: Wallet, ctx: EventContext): Promise<ApplyResult> {
    let reference: WagerTransaction | null = null;
    if (transaction.referenceExternalTransactionId) {
      reference = await this.transactions.findByExternalId(
        transaction.providerId,
        transaction.referenceExternalTransactionId,
      );
      if (!reference || !reference.isTerminal()) return "pending-reference";
    }

    const events: IntegrationEvent<unknown>[] = [];
    try {
      if (wallet.playerId !== transaction.playerId) throw new WalletPlayerMismatchError();
      if (wallet.currency !== transaction.money.currency) {
        throw new CurrencyMismatchError(wallet.currency, transaction.money.currency);
      }

      if (reference) {
        transaction.assertCanReference(reference);
        if (transaction.requiresReference() && (await this.transactions.isAlreadyReversed(reference.id))) {
          throw new ReferenceAlreadyReversedError(transaction.kind);
        }
      }

      if (transaction.affectsBalance()) {
        const movement = {
          entryId: crypto.randomUUID(),
          transactionId: transaction.id,
          money: transaction.money,
          at: ctx.occurredAt,
        };
        const direction = transaction.ledgerDirectionFor(reference ?? undefined);

        if (
          direction === LedgerDirection.Debit &&
          transaction.kind === WagerTransactionKind.Rollback &&
          wallet.balance.isLessThan(transaction.money)
        ) {
          throw new ReversalWouldOverdraftError();
        }

        const entry = direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
        await this.ledger.add(entry);
        await this.wallets.save(wallet);
        events.push(WalletBalanceChanged.from(wallet, entry, ctx));
      }

      transaction.markProcessed(reference?.id, ctx.occurredAt, wallet.balance);
      events.push(WagerTransactionProcessed.from(transaction, ctx));
    } catch (error) {
      const code = toFailureCode(error);
      if (!code || transaction.status === WagerTransactionStatus.Processed) throw error;
      transaction.reject(code, wallet.balance);
      events.length = 0;
      events.push(WagerTransactionRejected.from(transaction, ctx));
    }

    await this.outbox.enqueue(events);
    return "applied";
  }
}
