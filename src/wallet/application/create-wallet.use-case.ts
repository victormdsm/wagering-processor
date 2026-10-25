import { Injectable } from "@nestjs/common";
import { EventOutbox } from "../../shared/application/event-outbox";
import type { IntegrationEvent } from "../../shared/domain/integration-event";
import { Money, type MoneyProps } from "../../shared/domain/money";
import { hashWagerPayload } from "../../wagering/application/payload-hash";
import { WagerTransactionProcessed } from "../../wagering/domain/events/wager-transaction-processed.event";
import { WagerTransaction } from "../../wagering/domain/wager-transaction";
import { WagerTransactionKind } from "../../wagering/domain/wager-transaction-kind";
import { WagerTransactionRepository } from "../../wagering/domain/wager-transaction.repository";
import { WalletBalanceChanged } from "../domain/events/wallet-balance-changed.event";
import { LedgerDirection } from "../domain/ledger-direction";
import { Wallet } from "../domain/wallet";
import { WalletLedgerEntry } from "../domain/wallet-ledger-entry";
import { WalletAlreadyExistsError } from "../domain/wallet.errors";
import { WalletLedgerRepository, WalletRepository } from "../domain/wallet.repository";

export interface CreateWalletInput {
  playerId: string;
  initialBalance: MoneyProps;
}

export interface CreateWalletOutput {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

const INTERNAL_PROVIDER = "internal";
const OPENING_ROUND = "opening";

@Injectable()
export class CreateWalletUseCase {
  constructor(
    private readonly wallets: WalletRepository,
    private readonly ledger: WalletLedgerRepository,
    private readonly transactions: WagerTransactionRepository,
    private readonly outbox: EventOutbox,
  ) {}

  async execute(input: CreateWalletInput): Promise<CreateWalletOutput> {
    const initialBalance = Money.from(input.initialBalance);

    if (await this.wallets.findByPlayerAndCurrency(input.playerId, initialBalance.currency)) {
      throw new WalletAlreadyExistsError(input.playerId, initialBalance.currency);
    }

    const wallet = Wallet.open({ id: crypto.randomUUID(), playerId: input.playerId, initialBalance });
    await this.wallets.save(wallet);

    if (initialBalance.isPositive()) {
      await this.registerOpening(wallet, initialBalance);
    }

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }

  private async registerOpening(wallet: Wallet, initialBalance: Money): Promise<void> {
    const now = wallet.createdAt;
    const externalTransactionId = `opening:${wallet.id}`;
    const payload = {
      providerId: INTERNAL_PROVIDER,
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: OPENING_ROUND,
      gameId: OPENING_ROUND,
      kind: WagerTransactionKind.Opening,
      money: initialBalance.toJSON(),
    };

    const opening = WagerTransaction.create({
      ...payload,
      id: crypto.randomUUID(),
      idempotencyKey: `${INTERNAL_PROVIDER}:${externalTransactionId}`,
      payloadHash: hashWagerPayload(payload),
      money: initialBalance,
      createdAt: now,
    });

    const entry = WalletLedgerEntry.create({
      id: crypto.randomUUID(),
      walletId: wallet.id,
      transactionId: opening.id,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero(initialBalance.currency),
      balanceAfter: wallet.balance,
      createdAt: now,
    });

    opening.markProcessed(undefined, now, wallet.balance);
    await this.transactions.save(opening);
    await this.ledger.add(entry);

    const ctx = { correlationId: opening.idempotencyKey, occurredAt: now };
    const events: IntegrationEvent<unknown>[] = [
      WalletBalanceChanged.from(wallet, entry, ctx),
      WagerTransactionProcessed.from(opening, ctx),
    ];
    await this.outbox.enqueue(events);
  }
}
