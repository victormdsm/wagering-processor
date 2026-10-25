import { InvalidMoneyError } from "../../shared/domain/domain-error";
import type { Money } from "../../shared/domain/money";
import { LedgerDirection } from "../../wallet/domain/ledger-direction";
import type { FailureCode } from "./failure-code";
import { WagerTransactionKind } from "./wager-transaction-kind";
import { WagerTransactionStatus } from "./wager-transaction-status";
import {
  InvalidReferenceKindError,
  InvalidTransactionStateError,
  ReferenceMismatchError,
  ReferenceNotProcessedError,
  ReferenceRequiredError,
  ReversalAmountMismatchError,
} from "./wagering.errors";

const REFERENCE_RETRY_BASE_MS = 1_000;
const REFERENCE_RETRY_MAX_DELAY_MS = 5 * 60_000;
const REFERENCE_RETRY_MAX_ATTEMPTS = 10;

const TERMINAL = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

const ALLOWED_REFERENCE_KINDS: Partial<Record<WagerTransactionKind, WagerTransactionKind[]>> = {
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
};

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  observedBalance?: Money;
  attempts: number;
  nextAttemptAt?: Date;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _observedBalance?: Money,
    private _attempts: number = 0,
    private _nextAttemptAt?: Date,
  ) {}

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const transaction = WagerTransaction.rehydrate({
      ...props,
      status: WagerTransactionStatus.Pending,
      attempts: 0,
    });

    if (transaction.requiresReference() && !props.referenceExternalTransactionId) {
      throw new ReferenceRequiredError(props.kind);
    }
    if (transaction.affectsBalance() && !props.money.isPositive()) {
      throw new InvalidMoneyError(`${props.kind} exige valor positivo`);
    }

    return transaction;
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.observedBalance,
      state.attempts,
      state.nextAttemptAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date, observedBalance: Money): void {
    this.assertNotTerminal("markProcessed");
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._observedBalance = observedBalance;
    this._nextAttemptAt = undefined;
  }

  markPendingReference(): void {
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(this.id, this._status, "markPendingReference");
    }
    this._status = WagerTransactionStatus.PendingReference;
  }

  reject(code: FailureCode, observedBalance: Money): void {
    this.assertNotTerminal("reject");
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._observedBalance = observedBalance;
    this._nextAttemptAt = undefined;
  }

  fail(code: FailureCode): void {
    this.assertNotTerminal("fail");
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._nextAttemptAt = undefined;
  }

  scheduleReferenceRetry(now: Date): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(this.id, this._status, "scheduleReferenceRetry");
    }
    this._attempts += 1;
    const delay = Math.min(REFERENCE_RETRY_BASE_MS * 2 ** (this._attempts - 1), REFERENCE_RETRY_MAX_DELAY_MS);
    this._nextAttemptAt = new Date(now.getTime() + delay);
  }

  hasExhaustedReferenceRetries(): boolean {
    return this._attempts >= REFERENCE_RETRY_MAX_ATTEMPTS;
  }

  isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) throw new ReferenceRequiredError(this.kind);
        return reference.ledgerDirectionFor() === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new Error("LOSS não gera lançamento");
    }
  }

  assertCanReference(reference: WagerTransaction): void {
    if (reference.status !== WagerTransactionStatus.Processed) {
      throw new ReferenceNotProcessedError(reference.status);
    }

    if (reference.providerId !== this.providerId) throw new ReferenceMismatchError("provider");
    if (reference.playerId !== this.playerId) throw new ReferenceMismatchError("player");
    if (reference.walletId !== this.walletId) throw new ReferenceMismatchError("wallet");
    if (reference.money.currency !== this.money.currency) throw new ReferenceMismatchError("moeda");
    if (reference.roundId !== this.roundId) throw new ReferenceMismatchError("rodada");

    if (!ALLOWED_REFERENCE_KINDS[this.kind]?.includes(reference.kind)) {
      throw new InvalidReferenceKindError(this.kind, reference.kind);
    }

    if (this.requiresReference() && !reference.money.equals(this.money)) {
      throw new ReversalAmountMismatchError();
    }
  }

  private assertNotTerminal(attempted: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this.id, this._status, attempted);
    }
  }
}
