import { DomainError } from "../../shared/domain/domain-error";

export class InvalidTransactionStateError extends Error {
  constructor(transactionId: string, current: string, attempted: string) {
    super(`transação ${transactionId} em ${current} não aceita ${attempted}`);
    this.name = "InvalidTransactionStateError";
  }
}

export class IdempotencyConflictError extends DomainError {
  readonly code = "IDEMPOTENCY_CONFLICT";

  constructor(idempotencyKey: string) {
    super(`idempotency key ${idempotencyKey} já usada com outro payload`);
  }
}

export class WagerTransactionNotFoundError extends DomainError {
  readonly code = "WAGER_TRANSACTION_NOT_FOUND";

  constructor(identifier: string) {
    super(`transação ${identifier} não encontrada`);
  }
}

export class ReferenceRequiredError extends DomainError {
  readonly code = "REFERENCE_REQUIRED";

  constructor(kind: string) {
    super(`${kind} exige referenceExternalTransactionId`);
  }
}

export class ReferenceMismatchError extends DomainError {
  readonly code = "REFERENCE_MISMATCH";

  constructor(field: string) {
    super(`referência não pertence à mesma ${field}`);
  }
}

export class InvalidReferenceKindError extends DomainError {
  readonly code = "INVALID_REFERENCE_KIND";

  constructor(kind: string, referenceKind: string) {
    super(`${kind} não pode referenciar ${referenceKind}`);
  }
}

export class ReferenceAlreadyReversedError extends DomainError {
  readonly code = "REFERENCE_ALREADY_REVERSED";

  constructor(kind: string) {
    super(`referência já revertida; ${kind} recusado`);
  }
}

export class ReversalAmountMismatchError extends DomainError {
  readonly code = "REVERSAL_AMOUNT_MISMATCH";

  constructor() {
    super("valor da reversão diferente do valor da referência");
  }
}

export class ReversalWouldOverdraftError extends DomainError {
  readonly code = "REVERSAL_WOULD_OVERDRAFT";

  constructor() {
    super("reversão deixaria o saldo negativo");
  }
}

export class ReferenceNotFoundError extends DomainError {
  readonly code = "REFERENCE_NOT_FOUND";

  constructor(referenceExternalTransactionId: string) {
    super(`referência ${referenceExternalTransactionId} não encontrada`);
  }
}

export class KindNotAllowedError extends DomainError {
  readonly code = "KIND_NOT_ALLOWED";

  constructor(kind: string) {
    super(`kind ${kind} não é aceito nesta entrada`);
  }
}

export class WalletPlayerMismatchError extends DomainError {
  readonly code = "WALLET_PLAYER_MISMATCH";

  constructor() {
    super("wallet não pertence ao player informado");
  }
}

export class ReferenceNotProcessedError extends DomainError {
  readonly code = "REFERENCE_NOT_PROCESSED";

  constructor(status: string) {
    super(`referência em ${status} não pode ser referenciada`);
  }
}
