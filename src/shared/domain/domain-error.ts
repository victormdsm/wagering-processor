export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  readonly code = "INVALID_MONEY";

  constructor(reason: string) {
    super(`valor monetário inválido: ${reason}`);
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = "CURRENCY_MISMATCH";

  constructor(expected: string, received: string) {
    super(`moeda esperada ${expected}, recebida ${received}`);
  }
}
