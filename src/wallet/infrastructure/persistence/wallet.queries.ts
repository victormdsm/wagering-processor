import { EntityManager } from "@mikro-orm/postgresql";
import { Injectable } from "@nestjs/common";
import type { MoneyProps } from "../../../shared/domain/money";
import { WalletNotFoundError } from "../../domain/wallet.errors";
import { WalletLedgerEntryRecord } from "./wallet-ledger-entry.record";
import { WalletRecord } from "./wallet.record";

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export interface LedgerPage {
  items: {
    id: string;
    transactionId: string;
    direction: string;
    money: MoneyProps;
    balanceBefore: MoneyProps;
    balanceAfter: MoneyProps;
    createdAt: string;
  }[];
  nextCursor: string | null;
}

const MAX_LIMIT = 100;

@Injectable()
export class WalletQueries {
  constructor(private readonly em: EntityManager) {}

  async byId(walletId: string): Promise<WalletView> {
    const record = await this.em.fork().findOne(WalletRecord, { id: walletId });
    if (!record) throw new WalletNotFoundError(walletId);
    return {
      id: record.id,
      playerId: record.playerId,
      balance: { amount: record.balance, currency: record.currency },
      version: record.version,
    };
  }

  async ledger(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPage> {
    const em = this.em.fork();
    if (!(await em.count(WalletRecord, { id: walletId }))) throw new WalletNotFoundError(walletId);

    const after = cursor ? decodeCursor(cursor) : undefined;
    const pageSize = Math.min(Math.max(limit, 1), MAX_LIMIT);

    const records = await em.find(
      WalletLedgerEntryRecord,
      {
        wallet: walletId,
        ...(after && {
          $or: [{ createdAt: { $gt: after.createdAt } }, { createdAt: after.createdAt, id: { $gt: after.id } }],
        }),
      },
      { orderBy: { createdAt: "asc", id: "asc" }, limit: pageSize + 1 },
    );

    const page = records.slice(0, pageSize);
    const last = page.at(-1);
    return {
      items: page.map((r) => ({
        id: r.id,
        transactionId: r.transaction,
        direction: r.direction,
        money: { amount: r.amount, currency: r.currency },
        balanceBefore: { amount: r.balanceBefore, currency: r.currency },
        balanceAfter: { amount: r.balanceAfter, currency: r.currency },
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor: records.length > pageSize && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const [iso, id] = Buffer.from(cursor, "base64url").toString().split("|");
  const createdAt = new Date(iso);
  if (!id || Number.isNaN(createdAt.getTime())) throw new InvalidCursorError();
  return { createdAt, id };
}

export class InvalidCursorError extends Error {}
