import { describe, expect, test } from "bun:test";
import { CurrencyMismatchError, InvalidMoneyError } from "../../src/shared/domain/domain-error";
import { Money } from "../../src/shared/domain/money";
import { LedgerDirection } from "../../src/wallet/domain/ledger-direction";
import { Wallet } from "../../src/wallet/domain/wallet";
import { WalletLedgerEntry } from "../../src/wallet/domain/wallet-ledger-entry";
import { InsufficientFundsError, InvalidLedgerEntryError } from "../../src/wallet/domain/wallet.errors";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const open = (amount = "100.00") =>
  Wallet.open({ id: crypto.randomUUID(), playerId: crypto.randomUUID(), initialBalance: brl(amount) });
const movement = (amount: string, currency = "BRL") => ({
  entryId: crypto.randomUUID(),
  transactionId: crypto.randomUUID(),
  money: Money.from({ amount, currency }),
  at: new Date(),
});

describe("Wallet", () => {
  test("nasce com version 1 e a moeda do saldo inicial", () => {
    const wallet = open();
    expect(wallet.version).toBe(1);
    expect(wallet.currency).toBe("BRL");
    expect(wallet.balance.toString()).toBe("100.00");
  });

  test("débito gera o lançamento correspondente e incrementa a version", () => {
    const wallet = open();
    const entry = wallet.debit(movement("25.00"));
    expect(wallet.balance.toString()).toBe("75.00");
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toString()).toBe("100.00");
    expect(entry.balanceAfter.toString()).toBe("75.00");
    expect(entry.isBalanced()).toBe(true);
  });

  test("crédito gera o lançamento correspondente e incrementa a version", () => {
    const wallet = open();
    const entry = wallet.credit(movement("0.01"));
    expect(wallet.balance.toString()).toBe("100.01");
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });

  test("saldo nunca negativo: débito maior que o saldo é recusado sem alterar estado", () => {
    const wallet = open("10.00");
    expect(() => wallet.debit(movement("10.01"))).toThrow(InsufficientFundsError);
    expect(wallet.balance.toString()).toBe("10.00");
    expect(wallet.version).toBe(1);
  });

  test("débito de todo o saldo deixa zero", () => {
    const wallet = open("10.00");
    wallet.debit(movement("10.00"));
    expect(wallet.balance.isZero()).toBe(true);
  });

  test("moeda da operação deve ser a da wallet", () => {
    const wallet = open();
    expect(() => wallet.debit(movement("1.00", "USD"))).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(movement("1.00", "USD"))).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test("rehydrate reconstrói o estado sem revalidar", () => {
    const now = new Date();
    const wallet = Wallet.rehydrate({
      id: "w",
      playerId: "p",
      currency: "BRL",
      balance: brl("5.00"),
      version: 7,
      createdAt: now,
      updatedAt: now,
    });
    expect(wallet.version).toBe(7);
    expect(wallet.balance.toString()).toBe("5.00");
  });

  test("saldo inicial negativo é recusado", () => {
    expect(() =>
      Wallet.open({ id: "w", playerId: "p", initialBalance: brl("1.00").negate() }),
    ).toThrow(InvalidMoneyError);
  });
});

describe("WalletLedgerEntry", () => {
  const base = {
    id: "e",
    walletId: "w",
    transactionId: "t",
    createdAt: new Date(),
  };

  test("create valida a aritmética do lançamento", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: brl("10.00"),
        balanceBefore: brl("0.00"),
        balanceAfter: brl("9.99"),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test("create recusa valor zero", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl("0.00"),
        balanceBefore: brl("1.00"),
        balanceAfter: brl("1.00"),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test("não expõe métodos de transição (imutabilidade estrutural)", () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Debit,
      money: brl("1.00"),
      balanceBefore: brl("1.00"),
      balanceAfter: brl("0.00"),
    });
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(entry)).filter((m) => m !== "constructor");
    expect(methods).toEqual(["isBalanced"]);
  });
});
