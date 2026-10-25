import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createWallet, keyOf, request, submit, wagerPayload } from "../support/api";
import { spawnInstance, waitFor, type Instance } from "../support/app";
import { expectLedgerConsistent, transactionByExternalId, walletState } from "../support/assertions";
import { db } from "../support/infra";
import { startPgProxy, startSqsProxy } from "../support/proxies";
import { drain, queueDepth, sendWager, wagerMessage } from "../support/sqs";

setDefaultTimeout(90_000);

const debits = (entries: { direction: string }[]) => entries.filter((e) => e.direction === "DEBIT").length;
const running: Instance[] = [];

async function spawn(port: number, env: Record<string, string> = {}, captureLogs = false) {
  const instance = await spawnInstance(port, env, { captureLogs });
  running.push(instance);
  return instance;
}

afterAll(async () => {
  await Promise.all(running.map((i) => i.kill()));
  await expectLedgerConsistent();
});

function expectSafeStructuredLogs(logs: string, forbiddenAmounts: string[]) {
  const lines = logs.split("\n").filter((line) => line.trim() && !line.includes("[migrator]"));
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    expect(() => JSON.parse(line)).not.toThrow();
    expect(line).not.toMatch(/insert into|update "|select |Failing row/i);
    for (const amount of forbiddenAmounts) expect(line).not.toContain(amount);
  }
  return lines.map((line) => JSON.parse(line));
}

describe("processo morto de verdade (SIGKILL)", () => {
  test("§13.5: SIGKILL depois do commit e antes do ack → outra instância recebe de novo e a inbox barra", async () => {
    const proxy = startSqsProxy();
    proxy.hold.add("DeleteMessage");
    try {
      const a = await spawn(3311, { SQS_ENDPOINT: proxy.url });
      const wallet = await createWallet(a.url, "100.00");
      const payload = wagerPayload(wallet, { kind: "BET", amount: "40.00" });
      const message = wagerMessage(payload);
      await sendWager(message);

      await waitFor(() => proxy.held.includes("DeleteMessage"));
      expect((await transactionByExternalId("provider-a", payload.externalTransactionId))?.status).toBe("PROCESSED");
      await a.kill();

      await spawn(3312);
      await waitFor(async () => (await queueDepth("main")) === 0, 30_000);
      const state = await walletState(wallet.id);
      expect(state.balance).toBe("60.00");
      expect(debits(state.entries)).toBe(1);
      const [{ c }] = await db()`select count(*)::int as c from inbox_messages where message_id = ${message.messageId}`;
      expect(c).toBe(1);
    } finally {
      proxy.stop();
    }
  });

  test("§11: commit confirmado, SIGKILL antes de publicar → outra instância publica o evento", async () => {
    const proxy = startSqsProxy();
    proxy.hold.add("SendMessageBatch");
    try {
      for (const instance of running) await instance.kill();
      const a = await spawn(3313, { SQS_ENDPOINT: proxy.url });
      const wallet = await createWallet(a.url, "100.00");
      await waitFor(() => proxy.held.includes("SendMessageBatch"));
      const ids = (await db()`select id from outbox_messages where payload->'data'->>'walletId' = ${wallet.id}`).map(
        (r: { id: string }) => r.id,
      ) as string[];
      expect(ids.length).toBe(2);
      const unpublished = async () =>
        (await db()`select count(*)::int as c from outbox_messages where id in ${db()(ids)} and published_at is null`)[0].c;
      expect(await unpublished()).toBe(2);

      await a.kill();
      await spawn(3314);
      await waitFor(async () => (await unpublished()) === 0, 30_000);
      const events = (await drain("events")).map((m) => JSON.parse(m.Body!).eventId);
      for (const id of ids) expect(events).toContain(id);
    } finally {
      proxy.stop();
    }
  });
});

describe("dependência fora do ar de verdade", () => {
  test("Postgres fora: ready 503, HTTP 503 (não 500), fila em retry; ao voltar, tudo aplicado uma vez e logs seguros", async () => {
    for (const instance of running) await instance.kill();
    const pg = await startPgProxy();
    try {
      const instance = await spawn(3315, { DATABASE_URL: pg.url }, true);
      const wallet = await createWallet(instance.url, "100.00");
      const httpBet = wagerPayload(wallet, { kind: "BET", amount: "13.37" });
      const queuedBet = wagerPayload(wallet, { kind: "BET", amount: "21.21" });

      await pg.down();
      const ready = await request(instance.url, "GET", "/health/ready");
      expect(ready).toEqual({ status: 503, body: { status: "unavailable", postgres: "down", sqs: "up" } });
      expect((await request(instance.url, "GET", "/health/live")).status).toBe(200);

      const duringOutage = await submit(instance.url, httpBet);
      expect(duringOutage.status).toBe(503);
      expect(duringOutage.body.code).toBe("TRANSIENT_FAILURE");
      await sendWager(wagerMessage(queuedBet));
      await Bun.sleep(1_500);

      await pg.up();
      await waitFor(async () => (await request(instance.url, "GET", "/health/ready")).status === 200);
      const retried = await submit(instance.url, httpBet);
      expect(retried.status).toBe(200);
      expect(retried.body.idempotentReplay).toBe(false);
      await waitFor(async () => (await transactionByExternalId("provider-a", queuedBet.externalTransactionId))?.status === "PROCESSED", 30_000);

      const state = await walletState(wallet.id);
      expect(state.balance).toBe("65.42");
      expect(debits(state.entries)).toBe(2);
      await waitFor(async () => (await queueDepth("main")) === 0);

      const logs = expectSafeStructuredLogs(instance.logs(), ["13.37", "21.21", "65.42", "78.63"]);
      const processed = logs.find((l) => l.message === "transação processada" && l.params?.transactionId === retried.body.transactionId);
      expect(processed.params).toMatchObject({
        correlationId: keyOf(httpBet),
        walletId: wallet.id,
        providerId: "provider-a",
      });
      const queued = logs.find((l) => l.message === "transação processada" && l.params?.messageId);
      expect(queued.params).toMatchObject({ walletId: wallet.id, providerId: "provider-a" });
      expect(logs.some((l) => l.message === "falha transitória")).toBe(true);
    } finally {
      await pg.stop();
    }
  });

  test("SQS fora: ready 503, API continua aceitando, outbox acumula e drena quando o SQS volta", async () => {
    for (const instance of running) await instance.kill();
    const proxy = startSqsProxy();
    try {
      const instance = await spawn(3316, { SQS_ENDPOINT: proxy.url }, true);
      const wallet = await createWallet(instance.url, "100.00");

      proxy.down();
      const ready = await request(instance.url, "GET", "/health/ready");
      expect(ready).toEqual({ status: 503, body: { status: "unavailable", postgres: "up", sqs: "down" } });
      expect((await fetch(`${instance.url}/metrics`)).status).toBe(200);

      const bet = await submit(instance.url, wagerPayload(wallet, { kind: "BET", amount: "10.00" }));
      expect(bet.status).toBe(200);
      const pending = async () =>
        (await db()`select count(*)::int as c from outbox_messages
          where payload->'data'->>'walletId' = ${wallet.id} and published_at is null`)[0].c as number;
      await Bun.sleep(2_000);
      expect(await pending()).toBeGreaterThanOrEqual(2);

      proxy.up();
      await waitFor(async () => (await pending()) === 0, 30_000);
      expect((await request(instance.url, "GET", "/health/ready")).status).toBe(200);
      expectSafeStructuredLogs(instance.logs(), ["90.00"]);
      await drain("events");
    } finally {
      proxy.stop();
    }
  });
});
