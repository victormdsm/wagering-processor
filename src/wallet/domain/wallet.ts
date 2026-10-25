import { CurrencyMismatchError, InvalidMoneyError } from "../../shared/domain/domain-error";
import type { Money } from "../../shared/domain/money";
import { LedgerDirection } from "./ledger-direction";
import { WalletLedgerEntry } from "./wallet-ledger-entry";
import { InsufficientFundsError } from "./wallet.errors";

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletMovementProps {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new InvalidMoneyError(`saldo inicial ${props.initialBalance.toString()} negativo`);
    }

    const now = new Date();
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      now,
      now,
    );
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(props: WalletMovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);

    if (this._balance.isLessThan(props.money)) {
      throw new InsufficientFundsError(this.id);
    }

    return this.apply(LedgerDirection.Debit, props, this._balance.subtract(props.money));
  }

  credit(props: WalletMovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);

    return this.apply(LedgerDirection.Credit, props, this._balance.add(props.money));
  }

  private apply(direction: LedgerDirection, props: WalletMovementProps, balanceAfter: Money): WalletLedgerEntry {
    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore: this._balance,
      balanceAfter,
      createdAt: props.at,
    });

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = props.at;

    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
