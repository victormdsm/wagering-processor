import { afterAll, beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { brl, createWallet, request, submit, wager, wagerPayload } from "../support/api";
import { startApp, type RunningApp } from "../support/app";
import { expectLedgerConsistent, walletState } from "../support/assertions";
import { db } from "../support/infra";

setDefaultTimeout(60_000);

let api: RunningApp;
let url: string;

beforeAll(async () => {
  api = await startApp();
  url = api.url;
});

afterAll(async () => {
  await expectLedgerConsistent();
  await api.close();
});

describe("POST /wallets", () => {
  test("cria com version 1 e OPENING + CREDIT na mesma transação", async () => {
    const playerId = crypto.randomUUID();
    const res = await request(url, "POST", "/wallets", { playerId, initialBalance: brl("1000.00") });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: expect.any(String), playerId, balance: brl("1000.00"), version: 1 });

    const [opening] = await db()`select kind, status, amount::text from wager_transactions where wallet_id = ${res.body.id}`;
    expect(opening).toEqual({ kind: "OPENING", status: "PROCESSED", amount: "1000.00" });
    expect((await walletState(res.body.id)).entries).toEqual([{ direction: "CREDIT", amount: "1000.00" }]);
  });

  test("saldo inicial zero não gera OPENING nem lançamento", async () => {
    const wallet = await createWallet(url, "0.00");
    expect((await walletState(wallet.id)).entries).toEqual([]);
    const [{ count }] = await db()`select count(*)::int from wager_transactions where wallet_id = ${wallet.id}`;
    expect(count).toBe(0);
  });

  test("duplicada para o mesmo playerId + currency → 409", async () => {
    const wallet = await createWallet(url);
    const res = await request(url, "POST", "/wallets", { playerId: wallet.playerId, initialBalance: brl("5.00") });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("WALLET_ALREADY_EXISTS");
  });

  test("mesmo player em outra moeda é outra wallet", async () => {
    const wallet = await createWallet(url);
    const res = await request(url, "POST", "/wallets", {
      playerId: wallet.playerId,
      initialBalance: { amount: "5.00", currency: "USD" },
    });
    expect(res.status).toBe(201);
  });

  test("payload inválido → 400", async () => {
    for (const body of [
      {},
      { playerId: crypto.randomUUID() },
      { playerId: crypto.randomUUID(), initialBalance: brl("10") },
      { playerId: crypto.randomUUID(), initialBalance: brl("-1.00") },
      { playerId: "not-a-uuid", initialBalance: brl("10.00") },
    ]) {
      const res = await request(url, "POST", "/wallets", body);
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
    }
  });
});

describe("POST /wagering/transactions — regras de negócio (seção 7)", () => {
  test("BET debita e responde 200 com o saldo", async () => {
    const wallet = await createWallet(url, "1000.00");
    const res = await wager(url, wallet, { kind: "BET", amount: "25.00" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transactionId: expect.any(String),
      status: "PROCESSED",
      balance: brl("975.00"),
      idempotentReplay: false,
    });
    const state = await walletState(wallet.id);
    expect(state.version).toBe(2);
    expect(state.entries.at(-1)).toEqual({ direction: "DEBIT", amount: "25.00" });
  });

  test("BET sem saldo → REJECTED INSUFFICIENT_FUNDS (422), sem lançamento e auditável", async () => {
    const wallet = await createWallet(url, "10.00");
    const res = await wager(url, wallet, { kind: "BET", amount: "10.01" });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ status: "REJECTED", balance: brl("10.00") });
    const [row] = await db()`select status, failure_code from wager_transactions where id = ${res.body.transactionId}`;
    expect(row).toEqual({ status: "REJECTED", failure_code: "INSUFFICIENT_FUNDS" });
    const state = await walletState(wallet.id);
    expect(state.entries.length).toBe(1);
    expect(state.version).toBe(1);
  });

  test("WIN credita (com ou sem referência à BET)", async () => {
    const wallet = await createWallet(url);
    const bet = await wager(url, wallet, { kind: "BET", amount: "10.00" });
    const win = await wager(url, wallet, {
      kind: "WIN",
      amount: "30.00",
      referenceExternalTransactionId: bet.payload.externalTransactionId,
    });
    expect(win.status).toBe(200);
    expect(win.body.balance).toEqual(brl("120.00"));
    const free = await wager(url, wallet, { kind: "WIN", amount: "1.00" });
    expect(free.body.balance).toEqual(brl("121.00"));
  });

  test("LOSS registra sem mover saldo, sem lançamento e sem mudar a version", async () => {
    const wallet = await createWallet(url);
    const bet = await wager(url, wallet, { kind: "BET", amount: "10.00" });
    const before = await walletState(wallet.id);
    const loss = await wager(url, wallet, {
      kind: "LOSS",
      amount: "10.00",
      referenceExternalTransactionId: bet.payload.externalTransactionId,
    });
    expect(loss.status).toBe(200);
    expect(loss.body).toMatchObject({ status: "PROCESSED", balance: brl("90.00") });
    const after = await walletState(wallet.id);
    expect(after.entries.length).toBe(before.entries.length);
    expect(after.version).toBe(before.version);
  });

  test("REFUND credita a BET uma única vez", async () => {
    const wallet = await createWallet(url);
    const bet = await wager(url, wallet, { kind: "BET", amount: "40.00" });
    const ref = { referenceExternalTransactionId: bet.payload.externalTransactionId, amount: "40.00" };
    const refund = await wager(url, wallet, { kind: "REFUND", ...ref });
    expect(refund.body).toMatchObject({ status: "PROCESSED", balance: brl("100.00") });
    const again = await wager(url, wallet, { kind: "REFUND", ...ref });
    expect(again.status).toBe(422);
    const [row] = await db()`select failure_code from wager_transactions where id = ${again.body.transactionId}`;
    expect(row.failure_code).toBe("REFERENCE_ALREADY_REVERSED");
    expect((await walletState(wallet.id)).balance).toBe("100.00");
  });

  test("REFUND só referencia BET", async () => {
    const wallet = await createWallet(url);
    const win = await wager(url, wallet, { kind: "WIN", amount: "5.00" });
    const refund = await wager(url, wallet, {
      kind: "REFUND",
      amount: "5.00",
      referenceExternalTransactionId: win.payload.externalTransactionId,
    });
    expect(refund.status).toBe(422);
    const [row] = await db()`select failure_code from wager_transactions where id = ${refund.body.transactionId}`;
    expect(row.failure_code).toBe("INVALID_REFERENCE_KIND");
  });

  test("ROLLBACK de BET credita; ROLLBACK de WIN debita", async () => {
    const wallet = await createWallet(url);
    const bet = await wager(url, wallet, { kind: "BET", amount: "10.00" });
    const win = await wager(url, wallet, { kind: "WIN", amount: "50.00" });
    const rbBet = await wager(url, wallet, {
      kind: "ROLLBACK",
      amount: "10.00",
      referenceExternalTransactionId: bet.payload.externalTransactionId,
    });
    expect(rbBet.body.balance).toEqual(brl("150.00"));
    const rbWin = await wager(url, wallet, {
      kind: "ROLLBACK",
      amount: "50.00",
      referenceExternalTransactionId: win.payload.externalTransactionId,
    });
    expect(rbWin.body.balance).toEqual(brl("100.00"));
    expect((await walletState(wallet.id)).entries.map((e: { direction: string }) => e.direction)).toEqual([
      "CREDIT",
      "DEBIT",
      "CREDIT",
      "CREDIT",
      "DEBIT",
    ]);
  });

  test("ROLLBACK de REFUND desfaz o estorno", async () => {
    const wallet = await createWallet(url);
    const bet = await wager(url, wallet, { kind: "BET", amount: "10.00" });
    const refund = await wager(url, wallet, {
      kind: "REFUND",
      amount: "10.00",
      referenceExternalTransactionId: bet.payload.externalTransactionId,
    });
    const rollback = await wager(url, wallet, {
      kind: "ROLLBACK",
      amount: "10.00",
      referenceExternalTransactionId: refund.payload.externalTransactionId,
    });
    expect(rollback.body).toMatchObject({ status: "PROCESSED", balance: brl("90.00") });
  });

  test("ROLLBACK que deixaria saldo negativo → REVERSAL_WOULD_OVERDRAFT (≠ INSUFFICIENT_FUNDS)", async () => {
    const wallet = await createWallet(url, "0.00");
    const win = await wager(url, wallet, { kind: "WIN", amount: "50.00" });
    await wager(url, wallet, { kind: "BET", amount: "40.00" });
    const rollback = await wager(url, wallet, {
      kind: "ROLLBACK",
      amount: "50.00",
      referenceExternalTransactionId: win.payload.externalTransactionId,
    });
    expect(rollback.status).toBe(422);
    const [row] = await db()`select status, failure_code from wager_transactions where id = ${rollback.body.transactionId}`;
    expect(row).toEqual({ status: "REJECTED", failure_code: "REVERSAL_WOULD_OVERDRAFT" });
    expect((await walletState(wallet.id)).balance).toBe("10.00");
  });

  test("reversão com valor diferente da referência → REVERSAL_AMOUNT_MISMATCH", async () => {
    const wallet = await createWallet(url);
    const bet = await wager(url, wallet, { kind: "BET", amount: "10.00" });
    const refund = await wager(url, wallet, {
      kind: "REFUND",
      amount: "9.99",
      referenceExternalTransactionId: bet.payload.externalTransactionId,
    });
    const [row] = await db()`select failure_code from wager_transactions where id = ${refund.body.transactionId}`;
    expect(row.failure_code).toBe("REVERSAL_AMOUNT_MISMATCH");
  });

  test("referência de outra rodada → REFERENCE_MISMATCH", async () => {
    const wallet = await createWallet(url);
    const bet = await wager(url, wallet, { kind: "BET", amount: "10.00", roundId: "round-a" });
    const refund = await wager(url, wallet, {
      kind: "REFUND",
      amount: "10.00",
      roundId: "round-b",
      referenceExternalTransactionId: bet.payload.externalTransactionId,
    });
    const [row] = await db()`select failure_code from wager_transactions where id = ${refund.body.transactionId}`;
    expect(row.failure_code).toBe("REFERENCE_MISMATCH");
  });

  test("conflito de moeda → REJECTED CURRENCY_MISMATCH", async () => {
    const wallet = await createWallet(url);
    const res = await wager(url, wallet, { kind: "BET", amount: "10.00", currency: "USD" });
    expect(res.status).toBe(422);
    const [row] = await db()`select failure_code from wager_transactions where id = ${res.body.transactionId}`;
    expect(row.failure_code).toBe("CURRENCY_MISMATCH");
    expect((await walletState(wallet.id)).balance).toBe("100.00");
  });

  test("wallet de outro player → REJECTED WALLET_PLAYER_MISMATCH", async () => {
    const wallet = await createWallet(url);
    const res = await wager(url, { ...wallet, playerId: crypto.randomUUID() }, { kind: "BET" });
    expect(res.status).toBe(422);
  });

  test("Bug 5: REFUND e depois ROLLBACK da mesma BET não credita duas vezes", async () => {
    const wallet = await createWallet(url);
    const bet = await wager(url, wallet, { kind: "BET", amount: "25.00" });
    const ref = { referenceExternalTransactionId: bet.payload.externalTransactionId, amount: "25.00" };
    expect((await wager(url, wallet, { kind: "REFUND", ...ref })).body.balance).toEqual(brl("100.00"));

    const rollback = await wager(url, wallet, { kind: "ROLLBACK", ...ref });
    expect(rollback.status).toBe(422);
    const [row] = await db()`select failure_code from wager_transactions where id = ${rollback.body.transactionId}`;
    expect(row.failure_code).toBe("REFERENCE_ALREADY_REVERSED");
    expect((await walletState(wallet.id)).balance).toBe("100.00");
  });

  test("Bug 5 (ordem inversa): ROLLBACK e depois REFUND da mesma BET", async () => {
    const wallet = await createWallet(url);
    const bet = await wager(url, wallet, { kind: "BET", amount: "25.00" });
    const ref = { referenceExternalTransactionId: bet.payload.externalTransactionId, amount: "25.00" };
    await wager(url, wallet, { kind: "ROLLBACK", ...ref });
    const refund = await wager(url, wallet, { kind: "REFUND", ...ref });
    expect(refund.status).toBe(422);
    expect((await walletState(wallet.id)).balance).toBe("100.00");
  });

  test("Bug 6: dois WINs da mesma BET não viram 503", async () => {
    const wallet = await createWallet(url);
    const bet = await wager(url, wallet, { kind: "BET", amount: "10.00" });
    const ref = { referenceExternalTransactionId: bet.payload.externalTransactionId };
    const first = await wager(url, wallet, { kind: "WIN", amount: "5.00", ...ref });
    const second = await wager(url, wallet, { kind: "WIN", amount: "7.00", ...ref });
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(second.body.balance).toEqual(brl("102.00"));
  });
});

describe("POST /wagering/transactions — idempotência e status HTTP (seção 9)", () => {
  test("requisição idêntica → mesma resposta com idempotentReplay: true", async () => {
    const wallet = await createWallet(url);
    const payload = wagerPayload(wallet, { kind: "BET", amount: "30.00" });
    const first = await submit(url, payload);
    await wager(url, wallet, { kind: "BET", amount: "10.00" });
    const replay = await submit(url, payload);
    expect(replay.status).toBe(first.status);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(replay.body.balance).toEqual(brl("70.00"));
  });

  test("replay de REJECTED devolve o mesmo 422", async () => {
    const wallet = await createWallet(url, "1.00");
    const payload = wagerPayload(wallet, { kind: "BET", amount: "30.00" });
    const first = await submit(url, payload);
    const replay = await submit(url, payload);
    expect([first.status, replay.status]).toEqual([422, 422]);
    expect(replay.body.transactionId).toBe(first.body.transactionId);
  });

  test("mesma key com payload diferente → 409, sem efeito", async () => {
    const wallet = await createWallet(url);
    const payload = wagerPayload(wallet, { kind: "BET", amount: "30.00" });
    await submit(url, payload);
    const conflict = await submit(url, { ...payload, money: brl("31.00") });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("IDEMPOTENCY_CONFLICT");
    expect((await walletState(wallet.id)).balance).toBe("70.00");
  });

  test("mesma operação do provedor com outra key → 409", async () => {
    const wallet = await createWallet(url);
    const payload = wagerPayload(wallet, { kind: "BET" });
    await submit(url, payload);
    const res = await submit(url, payload, "outra-chave");
    expect(res.status).toBe(409);
  });

  test("header Idempotency-Key é obrigatório → 400", async () => {
    const wallet = await createWallet(url);
    const res = await request(url, "POST", "/wagering/transactions", wagerPayload(wallet, { kind: "BET" }));
    expect(res.status).toBe(400);
  });

  test("OPENING não pode ser submetido → 400", async () => {
    const wallet = await createWallet(url);
    expect((await wager(url, wallet, { kind: "OPENING" })).status).toBe(400);
  });

  test("Bug 7: payload inválido sempre → 400 (nunca 500)", async () => {
    const wallet = await createWallet(url);
    const base = wagerPayload(wallet, { kind: "BET" });
    const cases: Record<string, unknown>[] = [
      { ...base, money: brl("25") },
      { ...base, money: brl("1e3") },
      { ...base, money: brl("123456789012345678.00") },
      { ...base, kind: "JACKPOT" },
      { ...base, playerId: "not-a-uuid" },
      { ...base, walletId: "not-a-uuid" },
      { ...base, roundId: "" },
      { ...base, referenceExternalTransactionId: 42 },
      { ...base, kind: "REFUND" },
    ];
    for (const payload of cases) {
      const res = await request(url, "POST", "/wagering/transactions", payload, {
        "idempotency-key": `k-${crypto.randomUUID()}`,
      });
      expect({ payload, status: res.status }).toEqual({ payload, status: 400 });
    }
  });

  test("wallet inexistente → 404", async () => {
    const res = await wager(url, { id: crypto.randomUUID(), playerId: crypto.randomUUID() }, { kind: "BET" });
    expect(res.status).toBe(404);
  });

  test("referência ausente → 202 PENDING_REFERENCE", async () => {
    const wallet = await createWallet(url);
    const res = await wager(url, wallet, { kind: "REFUND", referenceExternalTransactionId: `missing-${crypto.randomUUID()}` });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: "PENDING_REFERENCE", balance: brl("100.00") });
  });
});

describe("consultas", () => {
  test("GET /wallets/:id", async () => {
    const wallet = await createWallet(url, "12.34");
    const res = await request(url, "GET", `/wallets/${wallet.id}`);
    expect(res.body).toEqual({ id: wallet.id, playerId: wallet.playerId, balance: brl("12.34"), version: 1 });
    expect((await request(url, "GET", `/wallets/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await request(url, "GET", "/wallets/not-a-uuid")).status).toBe(404);
  });

  test("GET /wallets/:id/ledger com cursor estável e opaco", async () => {
    const wallet = await createWallet(url, "100.00");
    for (let i = 0; i < 4; i++) await wager(url, wallet, { kind: "BET", amount: "1.00" });

    const page1 = await request(url, "GET", `/wallets/${wallet.id}/ledger?limit=2`);
    expect(page1.body.items.length).toBe(2);
    expect(page1.body.nextCursor).toEqual(expect.any(String));
    await wager(url, wallet, { kind: "BET", amount: "1.00" });
    const page2 = await request(url, "GET", `/wallets/${wallet.id}/ledger?limit=2&cursor=${page1.body.nextCursor}`);
    const page3 = await request(url, "GET", `/wallets/${wallet.id}/ledger?limit=2&cursor=${page2.body.nextCursor}`);
    const ids = [...page1.body.items, ...page2.body.items, ...page3.body.items].map((e: { id: string }) => e.id);
    expect(new Set(ids).size).toBe(6);
    expect(page3.body.nextCursor).toBeNull();
    expect(page1.body.items[0]).toMatchObject({ direction: "CREDIT", money: brl("100.00"), balanceAfter: brl("100.00") });
    expect((await request(url, "GET", `/wallets/${wallet.id}/ledger?cursor=lixo`)).status).toBe(400);
  });

  test("GET de transação por id e por (providerId, externalTransactionId)", async () => {
    const wallet = await createWallet(url);
    const bet = await wager(url, wallet, { kind: "BET", amount: "5.00" });
    const byId = await request(url, "GET", `/wagering/transactions/${bet.body.transactionId}`);
    expect(byId.body).toMatchObject({ status: "PROCESSED", kind: "BET", money: brl("5.00"), balance: brl("95.00") });
    const byExternal = await request(
      url,
      "GET",
      `/providers/provider-a/wagering/transactions/${bet.payload.externalTransactionId}`,
    );
    expect(byExternal.body.transactionId).toBe(bet.body.transactionId);
    expect((await request(url, "GET", `/wagering/transactions/${crypto.randomUUID()}`)).status).toBe(404);
  });
});

describe("POST /wallets/:id/reconciliation", () => {
  test("consistente", async () => {
    const wallet = await createWallet(url, "100.00");
    await wager(url, wallet, { kind: "BET", amount: "25.00" });
    const res = await request(url, "POST", `/wallets/${wallet.id}/reconciliation`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      walletId: wallet.id,
      storedBalance: brl("75.00"),
      calculatedBalance: brl("75.00"),
      difference: brl("0.00"),
      consistent: true,
      checkedEntries: 2,
    });
  });

  test("divergência é sinalizada e contada em métrica, nunca corrigida", async () => {
    const wallet = await createWallet(url, "100.00");
    await db()`update wallets set balance = 90 where id = ${wallet.id}`;
    try {
      const res = await request(url, "POST", `/wallets/${wallet.id}/reconciliation`);
      expect(res.body).toMatchObject({ consistent: false, difference: { amount: "-10.00", currency: "BRL" } });
      const metrics = await (await fetch(`${url}/metrics`)).text();
      expect(metrics).toMatch(/wagering_reconciliation_divergences_total [1-9]/);
      const [{ balance }] = await db()`select balance::text from wallets where id = ${wallet.id}`;
      expect(balance).toBe("90.00");
    } finally {
      await db()`update wallets set balance = 100 where id = ${wallet.id}`;
    }
  });
});
