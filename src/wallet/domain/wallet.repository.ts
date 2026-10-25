import type { Money } from "../../shared/domain/money";
import type { Wallet } from "./wallet";
import type { WalletLedgerEntry } from "./wallet-ledger-entry";

export abstract class WalletRepository {
  abstract findById(id: string): Promise<Wallet | null>;
  abstract lockById(id: string): Promise<Wallet | null>;
  abstract findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null>;
  abstract save(wallet: Wallet): Promise<void>;
}

export interface ReconciliationSnapshot {
  storedBalance: Money;
  calculatedBalance: Money;
  checkedEntries: number;
}

export abstract class WalletLedgerRepository {
  abstract add(entry: WalletLedgerEntry): Promise<void>;
  abstract reconciliationSnapshot(walletId: string): Promise<ReconciliationSnapshot | null>;
}
