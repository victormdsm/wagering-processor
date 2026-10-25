import { describe, expect, test } from "bun:test";
import { InvalidMoneyError } from "../../src/shared/domain/domain-error";
import { Money } from "../../src/shared/domain/money";
import { hashWagerPayload } from "../../src/wagering/application/payload-hash";
import { FailureCode } from "../../src/wagering/domain/failure-code";
import { WagerTransaction } from "../../src/wagering/domain/wager-transaction";
import { WagerTransactionKind as Kind } from "../../src/wagering/domain/wager-transaction-kind";
import { WagerTransactionStatus as Status } from "../../src/wagering/domain/wager-transaction-status";
import {
  InvalidReferenceKindError,
  InvalidTransactionStateError,
  ReferenceMismatchError,
  ReferenceNotProcessedError,
  ReferenceRequiredError,
  ReversalAmountMismatchError,
} from "../../src/wagering/domain/wagering.errors";
import { LedgerDirection } from "../../src/wallet/domain/ledger-direction";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

function tx(kind: Kind, overrides: Partial<Parameters<typeof WagerTransaction.create>[0]> = {}) {
  return WagerTransaction.create({
    id: crypto.randomUUID(),
    providerId: "provider-a",
    externalTransactionId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    payloadHash: "hash",
    walletId: "wallet-1",
    playerId: "player-1",
    roundId: "round-1",
    gameId: "game-1",
    kind,
    money: brl("25.00"),
    referenceExternalTransactionId: kind === Kind.Refund || kind === Kind.Rollback ? "ref" : undefined,
    createdAt: new Date(),
    ...overrides,
  });
}

function processed(kind: Kind, overrides: Parameters<typeof tx>[1] = {}) {
  const t = tx(kind, overrides);
  t.markProcessed(undefined, new Date(), brl("0.00"));
  return t;
}

describe("WagerTransaction — regras por kind", () => {
  test("nasce PENDING", () => {
    expect(tx(Kind.Bet).status).toBe(Status.Pending);
  });

  test("BET debita; WIN e REFUND creditam", () => {
    expect(tx(Kind.Bet).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(tx(Kind.Win).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(tx(Kind.Refund).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test("LOSS não afeta saldo e não gera lançamento", () => {
    const loss = tx(Kind.Loss);
    expect(loss.affectsBalance()).toBe(false);
    expect(() => loss.ledgerDirectionFor()).toThrow();
  });

  test("ROLLBACK é o inverso da referência", () => {
    const rollback = tx(Kind.Rollback);
    expect(rollback.ledgerDirectionFor(processed(Kind.Bet))).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(processed(Kind.Win))).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(processed(Kind.Refund, { referenceExternalTransactionId: "x" }))).toBe(
      LedgerDirection.Debit,
    );
  });

  test("REFUND e ROLLBACK exigem referenceExternalTransactionId", () => {
    expect(tx(Kind.Refund).requiresReference()).toBe(true);
    expect(tx(Kind.Bet).requiresReference()).toBe(false);
    expect(() => tx(Kind.Refund, { referenceExternalTransactionId: undefined })).toThrow(ReferenceRequiredError);
    expect(() => tx(Kind.Rollback, { referenceExternalTransactionId: undefined })).toThrow(ReferenceRequiredError);
  });

  test("operações que movem saldo exigem valor positivo", () => {
    expect(() => tx(Kind.Bet, { money: brl("0.00") })).toThrow(InvalidMoneyError);
    expect(tx(Kind.Loss, { money: brl("0.00") }).status).toBe(Status.Pending);
  });

  test("REFUND só referencia BET; ROLLBACK referencia BET, WIN ou REFUND", () => {
    expect(() => tx(Kind.Refund).assertCanReference(processed(Kind.Win))).toThrow(InvalidReferenceKindError);
    expect(() => tx(Kind.Refund).assertCanReference(processed(Kind.Bet))).not.toThrow();
    for (const kind of [Kind.Bet, Kind.Win]) {
      expect(() => tx(Kind.Rollback).assertCanReference(processed(kind))).not.toThrow();
    }
    expect(() =>
      tx(Kind.Rollback).assertCanReference(processed(Kind.Refund, { referenceExternalTransactionId: "x" })),
    ).not.toThrow();
    expect(() => tx(Kind.Rollback).assertCanReference(processed(Kind.Loss))).toThrow(InvalidReferenceKindError);
  });

  test("referência precisa ser do mesmo provider, player, wallet, moeda e rodada", () => {
    const refund = tx(Kind.Refund);
    for (const field of ["providerId", "playerId", "walletId", "roundId"] as const) {
      expect(() => refund.assertCanReference(processed(Kind.Bet, { [field]: "outro" }))).toThrow(
        ReferenceMismatchError,
      );
    }
    const usdBet = processed(Kind.Bet, { money: Money.from({ amount: "25.00", currency: "USD" }) });
    expect(() => refund.assertCanReference(usdBet)).toThrow(ReferenceMismatchError);
  });

  test("valor da reversão deve ser igual ao da referência", () => {
    expect(() => tx(Kind.Refund).assertCanReference(processed(Kind.Bet, { money: brl("24.99") }))).toThrow(
      ReversalAmountMismatchError,
    );
  });

  test("referência que não está PROCESSED não pode ser revertida", () => {
    const rejected = tx(Kind.Bet);
    rejected.reject(FailureCode.InsufficientFunds, brl("0.00"));
    expect(() => tx(Kind.Refund).assertCanReference(rejected)).toThrow(ReferenceNotProcessedError);
  });
});

describe("WagerTransaction — transições", () => {
  test("PENDING → PENDING_REFERENCE → PROCESSED", () => {
    const t = tx(Kind.Refund);
    t.markPendingReference();
    expect(t.status).toBe(Status.PendingReference);
    t.markProcessed("ref-id", new Date(), brl("10.00"));
    expect(t.status).toBe(Status.Processed);
    expect(t.referenceTransactionId).toBe("ref-id");
    expect(t.observedBalance?.toString()).toBe("10.00");
  });

  test.each([
    ["PROCESSED", (t: WagerTransaction) => t.markProcessed(undefined, new Date(), brl("0.00"))],
    ["REJECTED", (t: WagerTransaction) => t.reject(FailureCode.InsufficientFunds, brl("0.00"))],
    ["FAILED", (t: WagerTransaction) => t.fail(FailureCode.InfrastructureFailure)],
  ])("%s é terminal: nova transição é erro de programação", (_, finish) => {
    const t = tx(Kind.Bet);
    finish(t);
    expect(t.isTerminal()).toBe(true);
    expect(() => t.markProcessed(undefined, new Date(), brl("0.00"))).toThrow(InvalidTransactionStateError);
    expect(() => t.reject(FailureCode.InsufficientFunds, brl("0.00"))).toThrow(InvalidTransactionStateError);
    expect(() => t.fail(FailureCode.InfrastructureFailure)).toThrow(InvalidTransactionStateError);
    expect(() => t.markPendingReference()).toThrow(InvalidTransactionStateError);
  });

  test("retry de referência: backoff exponencial com limite de tentativas", () => {
    const t = tx(Kind.Refund);
    t.markPendingReference();
    const now = new Date(0);
    const delays: number[] = [];
    while (!t.hasExhaustedReferenceRetries()) {
      t.scheduleReferenceRetry(now);
      delays.push(t.nextAttemptAt!.getTime());
    }
    expect(delays.slice(0, 4)).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(Math.max(...delays)).toBe(5 * 60_000);
    expect(delays.length).toBe(10);
  });
});

describe("Idempotência — payload hash", () => {
  const payload = {
    providerId: "provider-a",
    externalTransactionId: "transaction-123",
    playerId: "p",
    walletId: "w",
    roundId: "r",
    gameId: "g",
    kind: "BET",
    money: { amount: "25.00", currency: "BRL" },
  };

  test("JSON canônico: a ordem das chaves não muda o hash", () => {
    const reordered = Object.fromEntries(
      Object.entries({ ...payload, money: { currency: "BRL", amount: "25.00" } }).reverse(),
    ) as typeof payload;
    expect(hashWagerPayload(reordered)).toBe(hashWagerPayload(payload));
  });

  test("campos de transporte ficam fora do hash", () => {
    const withTransport = { ...payload, idempotencyKey: "x", causationId: "y" } as typeof payload;
    expect(hashWagerPayload(withTransport)).toBe(hashWagerPayload(payload));
  });

  test("mesma key com payload divergente não casa (conflito, não replay)", () => {
    const original = tx(Kind.Bet, { payloadHash: hashWagerPayload(payload) });
    const divergent = hashWagerPayload({ ...payload, money: { amount: "25.01", currency: "BRL" } });
    expect(original.matchesPayload(hashWagerPayload(payload))).toBe(true);
    expect(original.matchesPayload(divergent)).toBe(false);
  });
});
