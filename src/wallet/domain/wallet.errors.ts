import { DomainError } from "../../shared/domain/domain-error";

export class WalletAlreadyExistsError extends DomainError {
  readonly code = "WALLET_ALREADY_EXISTS";

  constructor(playerId: string, currency: string) {
    super(`já existe wallet para o player ${playerId} em ${currency}`);
  }
}

export class WalletNotFoundError extends DomainError {
  readonly code = "WALLET_NOT_FOUND";

  constructor(walletId: string) {
    super(`wallet ${walletId} não encontrada`);
  }
}

export class InvalidLedgerEntryError extends Error {
  constructor(reason: string) {
    super(`lançamento inválido: ${reason}`);
    this.name = "InvalidLedgerEntryError";
  }
}

export class InsufficientFundsError extends DomainError {
  readonly code = "INSUFFICIENT_FUNDS";

  constructor(walletId: string) {
    super(`saldo insuficiente na wallet ${walletId}`);
  }
}
