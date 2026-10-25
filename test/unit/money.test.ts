import { describe, expect, test } from "bun:test";
import { CurrencyMismatchError, InvalidMoneyError } from "../../src/shared/domain/domain-error";
import { Money } from "../../src/shared/domain/money";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

describe("Money", () => {
  test("serializa sempre com escala fixa de 2 casas", () => {
    expect(brl("25.00").toString()).toBe("25.00");
    expect(brl("25.00").toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
    expect(Money.zero("BRL").toString()).toBe("0.00");
  });

  test("aritmética exata, sem erro de ponto flutuante", () => {
    expect(brl("0.10").add(brl("0.20")).toString()).toBe("0.30");
    expect(brl("100.00").subtract(brl("80.01")).toString()).toBe("19.99");
    expect(brl("10.00").subtract(brl("10.01")).toString()).toBe("-0.01");
    expect(brl("10.00").negate().toString()).toBe("-10.00");
    expect(brl("99999999999999999.99").add(brl("0.01")).toString()).toBe("100000000000000000.00");
  });

  test("é imutável: operações devolvem nova instância", () => {
    const a = brl("10.00");
    const b = a.add(brl("5.00"));
    expect(a.toString()).toBe("10.00");
    expect(b).not.toBe(a);
  });

  test("comparações", () => {
    expect(brl("0.00").isZero()).toBe(true);
    expect(brl("0.01").isPositive()).toBe(true);
    expect(brl("1.00").negate().isNegative()).toBe(true);
    expect(brl("1.00").isLessThan(brl("1.01"))).toBe(true);
    expect(brl("1.00").equals(brl("1.00"))).toBe(true);
    expect(brl("1.00").equals(Money.from({ amount: "1.00", currency: "USD" }))).toBe(false);
  });

  test.each([
    ["NaN"],
    ["Infinity"],
    ["1e3"],
    ["1E+2"],
    [""],
    [" 1.00"],
    ["25"],
    ["25.5"],
    ["25.001"],
    ["-1.00"],
    ["+1.00"],
    ["1,00"],
    ["123456789012345678.00"],
  ])("rejeita amount inválido %p", (amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test("rejeita amount que não é string", () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: "BRL" })).toThrow(InvalidMoneyError);
  });

  test.each([["brl"], ["BR"], ["REAL"], [""]])("rejeita currency inválida %p", (currency) => {
    expect(() => Money.from({ amount: "1.00", currency })).toThrow(InvalidMoneyError);
  });

  test("operações entre moedas diferentes lançam erro de domínio", () => {
    const usd = Money.from({ amount: "1.00", currency: "USD" });
    expect(() => brl("1.00").add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl("1.00").subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl("1.00").isLessThan(usd)).toThrow(CurrencyMismatchError);
  });
});
