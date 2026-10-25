import { LockMode } from "@mikro-orm/core";
import { EntityManager } from "@mikro-orm/postgresql";
import { Injectable } from "@nestjs/common";
import { Money } from "../../../shared/domain/money";
import { Wallet } from "../../domain/wallet";
import type { WalletLedgerEntry } from "../../domain/wallet-ledger-entry";
import {
  type ReconciliationSnapshot,
  WalletLedgerRepository,
  WalletRepository,
} from "../../domain/wallet.repository";
import { WalletLedgerEntryRecord } from "./wallet-ledger-entry.record";
import { WalletRecord } from "./wallet.record";

@Injectable()
export class MikroOrmWalletRepository extends WalletRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async findById(id: string): Promise<Wallet | null> {
    const record = await this.em.findOne(WalletRecord, { id });
    return record ? toDomain(record) : null;
  }

  async lockById(id: string): Promise<Wallet | null> {
    const record = await this.em.findOne(WalletRecord, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    return record ? toDomain(record) : null;
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null> {
    const record = await this.em.findOne(WalletRecord, { playerId, currency });
    return record ? toDomain(record) : null;
  }
  async save(wallet: Wallet): Promise<void> {
    const record = await this.em.findOne(WalletRecord, { id: wallet.id });
    if (record) {
      record.balance = wallet.balance.toString();
      record.updatedAt = wallet.updatedAt;
      return;
    }

    this.em.create(WalletRecord, {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.toString(),
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    });
  }
}

function toDomain(record: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: record.id,
    playerId: record.playerId,
    currency: record.currency,
    balance: Money.from({ amount: record.balance, currency: record.currency }),
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

@Injectable()
export class MikroOrmWalletLedgerRepository extends WalletLedgerRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async add(entry: WalletLedgerEntry): Promise<void> {
    this.em.create(WalletLedgerEntryRecord, {
      id: entry.id,
      wallet: entry.walletId,
      transaction: entry.transactionId,
      direction: entry.direction,
      amount: entry.money.toString(),
      balanceBefore: entry.balanceBefore.toString(),
      balanceAfter: entry.balanceAfter.toString(),
      currency: entry.money.currency,
      createdAt: entry.createdAt,
    });
  }

  async reconciliationSnapshot(walletId: string): Promise<ReconciliationSnapshot | null> {
    const [row] = await this.em.execute<{ balance: string; currency: string; calculated: string; entries: string }[]>(
      `select w.balance, w.currency,
              coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)::numeric(19,2) as calculated,
              count(l.id) as entries
         from wallets w
         left join wallet_ledger_entries l on l.wallet_id = w.id
        where w.id = ?
        group by w.id`,
      [walletId],
    );
    if (!row) return null;

    return {
      storedBalance: signedMoney(row.balance, row.currency),
      calculatedBalance: signedMoney(row.calculated, row.currency),
      checkedEntries: Number(row.entries),
    };
  }
}

function signedMoney(amount: string, currency: string): Money {
  return amount.startsWith("-")
    ? Money.from({ amount: amount.slice(1), currency }).negate()
    : Money.from({ amount, currency });
}
