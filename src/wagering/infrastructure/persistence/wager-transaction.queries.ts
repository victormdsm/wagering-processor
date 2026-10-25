import { EntityManager } from "@mikro-orm/postgresql";
import { Injectable } from "@nestjs/common";
import type { MoneyProps } from "../../../shared/domain/money";
import { WagerTransactionNotFoundError } from "../../domain/wagering.errors";
import { WagerTransactionRecord } from "./wager-transaction.record";

export interface WagerTransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  status: string;
  money: MoneyProps;
  referenceExternalTransactionId: string | null;
  failureCode: string | null;
  balance: MoneyProps | null;
  createdAt: string;
  processedAt: string | null;
}

@Injectable()
export class WagerTransactionQueries {
  constructor(private readonly em: EntityManager) {}

  async byId(transactionId: string): Promise<WagerTransactionView> {
    const record = await this.em.fork().findOne(WagerTransactionRecord, { id: transactionId });
    if (!record) throw new WagerTransactionNotFoundError(transactionId);
    return toView(record);
  }

  async byExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransactionView> {
    const record = await this.em.fork().findOne(WagerTransactionRecord, { providerId, externalTransactionId });
    if (!record) throw new WagerTransactionNotFoundError(`${providerId}:${externalTransactionId}`);
    return toView(record);
  }
}

function toView(record: WagerTransactionRecord): WagerTransactionView {
  return {
    transactionId: record.id,
    providerId: record.providerId,
    externalTransactionId: record.externalTransactionId,
    walletId: record.wallet,
    playerId: record.playerId,
    roundId: record.roundId,
    gameId: record.gameId,
    kind: record.kind,
    status: record.status,
    money: { amount: record.amount, currency: record.currency },
    referenceExternalTransactionId: record.referenceExternalTransactionId ?? null,
    failureCode: record.failureCode ?? null,
    balance: record.observedBalance ? { amount: record.observedBalance, currency: record.currency } : null,
    createdAt: record.createdAt.toISOString(),
    processedAt: record.processedAt?.toISOString() ?? null,
  };
}
