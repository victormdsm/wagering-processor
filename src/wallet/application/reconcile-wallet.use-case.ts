import { Injectable } from "@nestjs/common";
import type { MoneyProps } from "../../shared/domain/money";
import { WalletNotFoundError } from "../domain/wallet.errors";
import { WalletLedgerRepository } from "../domain/wallet.repository";

export interface ReconcileWalletOutput {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

@Injectable()
export class ReconcileWalletUseCase {
  constructor(private readonly ledger: WalletLedgerRepository) {}

  async execute(walletId: string): Promise<ReconcileWalletOutput> {
    const snapshot = await this.ledger.reconciliationSnapshot(walletId);
    if (!snapshot) throw new WalletNotFoundError(walletId);

    const difference = snapshot.storedBalance.subtract(snapshot.calculatedBalance);
    return {
      walletId,
      storedBalance: snapshot.storedBalance.toJSON(),
      calculatedBalance: snapshot.calculatedBalance.toJSON(),
      difference: difference.toJSON(),
      consistent: difference.isZero(),
      checkedEntries: snapshot.checkedEntries,
    };
  }
}
