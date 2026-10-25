import { afterAll, beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { brl, createWallet, request, submit, wager, wagerPayload } from "../support/api";
import { spawnInstance, startApp, waitFor, type Instance, type RunningApp } from "../support/app";
import { expectLedgerConsistent, walletState } from "../support/assertions";
import { db } from "../support/infra";
import { queueDepth, sendWager, wagerMessage } from "../support/sqs";

setDefaultTimeout(60_000);

const debits = (entries: { direction: string }[]) => entries.filter((e) => e.direction === "DEBIT").length;

describe("concorrência numa instância (paralelismo real: conexões e transações simultâneas)", () => {
  let api: RunningApp;
  beforeAll(async () => {
    api = await startApp();
  });
  afterAll(async () => {
    await expectLedgerConsistent();
    await api.close();
  });

  test("§13.1: a mesma aposta 50 vezes em paralelo → um único débito", async () => {
    const wallet = await createWallet(api.url, "100.00");
    const payload = wagerPayload(wallet, { kind: "BET", amount: "25.00" });
    const responses = await Promise.all(Array.from({ length: 50 }, () => submit(api.url, payload)));

    expect(responses.map((r) => r.status)).toEqual(Array(50).fill(200));
    expect(new Set(responses.map((r) => r.body.transactionId)).size).toBe(1);
    expect(responses.filter((r) => !r.body.idempotentReplay).length).toBe(1);
    expect(responses.every((r) => r.body.balance.amount === "75.00")).toBe(true);
    const state = await walletState(wallet.id);
    expect(state.balance).toBe("75.00");
    expect(debits(state.entries)).toBe(1);
  });

  test("§13.2 / §8: saldo 100.00, duas apostas de 80.00 simultâneas (10 repetições)", async () => {
    for (let round = 0; round < 10; round++) {
      const wallet = await createWallet(api.url, "100.00");
      const [a, b] = await Promise.all([
        wager(api.url, wallet, { kind: "BET", amount: "80.00" }),
        wager(api.url, wallet, { kind: "BET", amount: "80.00" }),
      ]);
      expect([a.body.status, b.body.status].sort()).toEqual(["PROCESSED", "REJECTED"]);
      const rejected = a.body.status === "REJECTED" ? a : b;
      const [row] = await db()`select failure_code from wager_transactions where id = ${rejected.body.transactionId}`;
      expect(row.failure_code).toBe("INSUFFICIENT_FUNDS");
      const state = await walletState(wallet.id);
      expect(state.balance).toBe("20.00");
      expect(debits(state.entries)).toBe(1);

      await Promise.all([submit(api.url, a.payload), submit(api.url, b.payload)]);
      expect(debits((await walletState(wallet.id)).entries)).toBe(1);
    }
  });

  test("§13.3: wallets distintas processadas em paralelo", async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => createWallet(api.url, "100.00")));
    const started = Date.now();
    await Promise.all(
      wallets.flatMap((wallet) => Array.from({ length: 5 }, () => wager(api.url, wallet, { kind: "BET", amount: "10.00" }))),
    );
    for (const wallet of wallets) {
      const state = await walletState(wallet.id);
      expect(state.balance).toBe("50.00");
      expect(debits(state.entries)).toBe(5);
    }
    expect(Date.now() - started).toBeLessThan(30_000);
  });

  test("hot wallet: rajada concorrente não deixa saldo negativo nem perde atualização", async () => {
    const wallet = await createWallet(api.url, "100.00");
    const responses = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        wager(api.url, wallet, i % 3 === 0 ? { kind: "WIN", amount: "5.00" } : { kind: "BET", amount: "10.00" }),
      ),
    );
    const processed = responses.filter((r) => r.body.status === "PROCESSED");
    expect(responses.every((r) => r.status === 200 || r.status === 422)).toBe(true);
    const expected = processed.reduce((sum, r) => sum + (r.payload.kind === "WIN" ? 500 : -1000), 10_000);
    expect((await walletState(wallet.id)).balance).toBe((expected / 100).toFixed(2));
  });
});

describe("§13.4 e §13.8: três processos da aplicação ao mesmo tempo", () => {
  const ports = [3201, 3202, 3203];
  let instances: Instance[] = [];

  beforeAll(async () => {
    instances = await Promise.all(ports.map((port) => spawnInstance(port)));
  });

  afterAll(async () => {
    await Promise.all(instances.map((i) => i.stop()));
    await expectLedgerConsistent();
  });

  const at = (i: number) => instances[i % instances.length].url;

  const send = async (payload: ReturnType<typeof wagerPayload>, i: number) => {
    for (let attempt = 0; ; attempt++) {
      const res = await submit(at(i + attempt), payload).catch(() => null);
      if (res && res.status < 500) return res;
      await Bun.sleep(20 + Math.random() * 30);
    }
  };

  test("a mesma aposta enviada às 3 instâncias (60×) → um único débito", async () => {
    const wallet = await createWallet(at(0), "100.00");
    const payload = wagerPayload(wallet, { kind: "BET", amount: "25.00" });
    const responses = await Promise.all(Array.from({ length: 60 }, (_, i) => submit(at(i), payload)));
    expect(new Set(responses.map((r) => r.status))).toEqual(new Set([200]));
    expect(new Set(responses.map((r) => r.body.transactionId)).size).toBe(1);
    expect(debits((await walletState(wallet.id)).entries)).toBe(1);
  });

  test("cenário da seção 8 com as apostas em instâncias diferentes", async () => {
    for (let round = 0; round < 5; round++) {
      const wallet = await createWallet(at(round), "100.00");
      const [a, b] = await Promise.all([
        wager(at(round), wallet, { kind: "BET", amount: "80.00" }),
        wager(at(round + 1), wallet, { kind: "BET", amount: "80.00" }),
      ]);
      expect([a.body.status, b.body.status].sort()).toEqual(["PROCESSED", "REJECTED"]);
      expect((await walletState(wallet.id)).balance).toBe("20.00");
    }
  });

  test("hot wallet disputada pelas 3 instâncias: exatamente o saldo disponível é debitado, sem 5xx", async () => {
    const wallet = await createWallet(at(0), "100.00");
    const responses = await Promise.all(
      Array.from({ length: 60 }, (_, i) => wager(at(i), wallet, { kind: "BET", amount: "10.00" })),
    );
    expect(responses.every((r) => r.status === 200 || r.status === 422)).toBe(true);
    expect(responses.filter((r) => r.body.status === "PROCESSED").length).toBe(10);
    expect(responses.filter((r) => r.body.status === "REJECTED").length).toBe(50);
    const state = await walletState(wallet.id);
    expect(state.balance).toBe("0.00");
    expect(debits(state.entries)).toBe(10);
  });

  test("fila consumida pelas 3 instâncias, com mensagens duplicadas → cada efeito uma vez", async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, (_, i) => createWallet(at(i), "100.00")));
    const messages = wallets.flatMap((wallet) =>
      Array.from({ length: 3 }, () => wagerMessage(wagerPayload(wallet, { kind: "BET", amount: "10.00" }))),
    );
    await Promise.all(messages.flatMap((m) => [sendWager(m), sendWager(m)]));
    await waitFor(async () => (await queueDepth("main")) === 0, 30_000);
    for (const wallet of wallets) expect((await walletState(wallet.id)).balance).toBe("70.00");
    const [{ c }] = await db()`select count(*)::int as c from inbox_messages where message_id in ${db()(messages.map((m) => m.messageId))}`;
    expect(c).toBe(messages.length);
  });

  test("§13.8: SIGKILL de uma instância no meio do tráfego, reinício e consistência final", async () => {
    const wallets = await Promise.all(Array.from({ length: 15 }, (_, i) => createWallet(at(i), "500.00")));
    const payloads = wallets.flatMap((wallet) =>
      Array.from({ length: 8 }, (_, i) => wagerPayload(wallet, i % 2 ? { kind: "WIN", amount: "3.00" } : { kind: "BET", amount: "7.00" })),
    );

    const traffic = Promise.all(payloads.map((payload, i) => Bun.sleep(i * 3).then(() => send(payload, i))));
    await Bun.sleep(150);
    await instances[1].kill();
    instances[1] = await spawnInstance(ports[1]);
    const responses = await traffic;

    expect(responses.every((r) => r.status === 200)).toBe(true);
    const [{ c }] = await db()`select count(*)::int as c from wager_transactions
      where idempotency_key in ${db()(payloads.map((p) => `${p.providerId}:${p.externalTransactionId}`))}`;
    expect(c).toBe(payloads.length);
    for (const wallet of wallets) {
      expect((await walletState(wallet.id)).balance).toBe("484.00");
      const recon = await request(at(0), "POST", `/wallets/${wallet.id}/reconciliation`);
      expect(recon.body).toMatchObject({ consistent: true, storedBalance: brl("484.00"), checkedEntries: 9 });
    }
    await waitFor(async () => (await db()`select count(*)::int as c from outbox_messages where published_at is null`)[0].c === 0, 30_000);
  });
});
