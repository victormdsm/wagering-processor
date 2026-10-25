import { DomainError } from "../../shared/domain/domain-error";

export enum FailureCode {
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  ReversalWouldOverdraft = "REVERSAL_WOULD_OVERDRAFT",
  CurrencyMismatch = "CURRENCY_MISMATCH",
  WalletPlayerMismatch = "WALLET_PLAYER_MISMATCH",
  ReferenceMismatch = "REFERENCE_MISMATCH",
  InvalidReferenceKind = "INVALID_REFERENCE_KIND",
  ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
  ReferenceAlreadyReversed = "REFERENCE_ALREADY_REVERSED",
  ReversalAmountMismatch = "REVERSAL_AMOUNT_MISMATCH",
  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  InfrastructureFailure = "INFRASTRUCTURE_FAILURE",
}

const REJECTABLE = new Set<string>(Object.values(FailureCode));

export function toFailureCode(error: unknown): FailureCode | undefined {
  if (error instanceof DomainError && REJECTABLE.has(error.code)) {
    return error.code as FailureCode;
  }
  return undefined;
}
