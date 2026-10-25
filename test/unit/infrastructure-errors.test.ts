import { describe, expect, test } from "bun:test";
import {
  CheckConstraintViolationException,
  ConnectionException,
  DriverException,
  UniqueConstraintViolationException,
} from "@mikro-orm/core";
import { InvalidMoneyError } from "../../src/shared/domain/domain-error";
import { describeError, describeUnexpectedError } from "../../src/shared/infrastructure/observability/log-safe-error";
import { isTransientInfrastructureError } from "../../src/shared/infrastructure/persistence/transient-error";

const withCode = (message: string, code?: string) => Object.assign(new Error(message), code ? { code } : {});

describe("describeError: nada de valor financeiro nos logs", () => {
  test("violação de CHECK: o detail do Postgres (linha inteira) fica de fora", () => {
    const error = new CheckConstraintViolationException(
      withCode(
        'new row for relation "wallets" violates check constraint\n - detail: Failing row contains (w, p, BRL, -5.00, 3)',
        "23514",
      ),
    );
    const described = JSON.stringify(describeUnexpectedError(error));
    expect(described).toContain("CheckConstraintViolationException");
    expect(described).toContain("23514");
    expect(described).not.toContain("5.00");
    expect(described).not.toContain("Failing row");
  });

  test("erro de domínio: só tipo e código", () => {
    expect(describeError(new InvalidMoneyError('amount "25.5" fora do formato'))).toEqual({
      error: "InvalidMoneyError",
      code: "INVALID_MONEY",
    });
  });
});

describe("isTransientInfrastructureError", () => {
  test.each([
    ["ConnectionException", new ConnectionException(new Error("x"))],
    ["unique esgotada", new UniqueConstraintViolationException(new Error("x"))],
    ["ECONNREFUSED", new DriverException(withCode("connect ECONNREFUSED 127.0.0.1:5432", "ECONNREFUSED"))],
    ["admin_shutdown 57P01", new DriverException(withCode("terminating connection", "57P01"))],
    ["connection_failure 08006", new DriverException(withCode("connection failure", "08006"))],
    ["pg sem código", new Error("Connection terminated unexpectedly")],
  ])("transitório: %s", (_, error) => {
    expect(isTransientInfrastructureError(error)).toBe(true);
  });

  test.each([
    ["check violation", new CheckConstraintViolationException(withCode("x", "23514"))],
    ["erro de domínio", new InvalidMoneyError("x")],
    ["erro de programação", new Error("lançamento inválido")],
  ])("não transitório: %s", (_, error) => {
    expect(isTransientInfrastructureError(error)).toBe(false);
  });
});
