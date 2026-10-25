import type { MoneyProps } from "../../../shared/domain/money";
import type { WagerTransaction } from "../wager-transaction";

export interface WagerTransactionData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  kind: string;
  status: string;
  money: MoneyProps;
}

export function wagerTransactionData(transaction: WagerTransaction): WagerTransactionData {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    kind: transaction.kind,
    status: transaction.status,
    money: transaction.money.toJSON(),
  };
}
