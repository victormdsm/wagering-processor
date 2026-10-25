import Decimal from "decimal.js";
import { CurrencyMismatchError, InvalidMoneyError } from "./domain-error";

export interface MoneyProps {
  amount: string; 
  currency: string;
}

const AMOUNT_PATTERN = /^\d{1,17}\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const SCALE = 2;

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (typeof props?.amount !== "string" || !AMOUNT_PATTERN.test(props.amount)) {
      throw new InvalidMoneyError(`amount "${props?.amount}" fora do formato 0.00`);
    }
    Money.assertCurrency(props.currency);
    return new Money(new Decimal(props.amount), props.currency);
  }

  static zero(currency: string): Money {
    Money.assertCurrency(currency);
    return new Money(new Decimal(0), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  toString(): string {
    return this.value.toFixed(SCALE);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static assertCurrency(currency: unknown): void {
    if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`currency "${String(currency)}" nao e um codigo ISO-4217`);
    }
  }
}
