import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { brl, createWallet, keyOf, submit, wagerPayload } from "../support/api";
import { startApp, waitFor, type RunningApp } from "../support/app";
import { expectLedgerConsistent, transactionByExternalId, walletState } from "../support/assertions";
import { db } from "../support/infra";
import { sendWager, wagerMessage } from "../support/sqs";

setDefaultTimeout(60_000);

let api: RunningApp;

beforeAll(async () => {
  api = await startApp();
});

afterAll(async () => {
  await expectLedgerConsistent();
  await api.close();
});

const expiredRows = async () =>
  (await db()`select
      (select count(*) from inbox_messages where received_at < now() - interval '7 days') +
      (select count(*) from idempotency_keys where created_at < now() - interval '24 hours') as c`)[0].c as number;

type Table = "inbox_messages" | "idempotency_keys";
const scrape = async (app: RunningApp) => (await fetch(`${app.url}/metrics`)).text();
const deletedIn = (metrics: string, table: Table) =>
  Number(metrics.match(new RegExp(`wagering_retention_deleted_total\\{table="${table}"\\} (\\d+)`))?.[1] ?? 0);

async function runRetention(before: string, instances = 1): Promise<Record<Table, number>> {
  const apps = await Promise.all(Array.from({ length: instances }, () => startApp()));
  await waitFor(async () => Number(await expiredRows()) === 0);
  await Bun.sleep(200);
  const metrics = [...(await Promise.all(apps.map(scrape))), await scrape(api)];
  await Promise.all(apps.map((app) => app.close()));
  const total = (table: Table) => metrics.reduce((sum, m) => sum + deletedIn(m, table), 0) - deletedIn(before, table);
  return { inbox_messages: total("inbox_messages"), idempotency_keys: total("idempotency_keys") };
}

const inboxExists = async (messageId: string) =>
  (await db()`select count(*)::int as c from inbox_messages where message_id = ${messageId}`)[0].c === 1;
const keyExists = async (idempotencyKey: string) =>
  (await db()`select count(*)::int as c from idempotency_keys where idempotency_key = ${idempotencyKey}`)[0].c === 1;

describe("retenção da inbox e das idempotency keys", () => {
  test("apaga o que venceu e mantém o recente", async () => {
    const before = await scrape(api);
    const tag = crypto.randomUUID();
    await db()`insert into inbox_messages (consumer_name, message_id, payload_hash, received_at)
      values ('c', ${"old-1-" + tag}, 'h', now() - interval '8 days'), ('c', ${"old-2-" + tag}, 'h', now() - interval '7 days 1 minute'),
             ('c', ${"new-" + tag}, 'h', now() - interval '6 days')`;
    await db()`insert into idempotency_keys (provider_id, idempotency_key, payload_hash, created_at)
      values ('p', ${"old-" + tag}, 'h', now() - interval '25 hours'), ('p', ${"new-" + tag}, 'h', now() - interval '23 hours')`;

    const deleted = await runRetention(before);
    expect(await inboxExists(`old-1-${tag}`)).toBe(false);
    expect(await inboxExists(`old-2-${tag}`)).toBe(false);
    expect(await inboxExists(`new-${tag}`)).toBe(true);
    expect(await keyExists(`old-${tag}`)).toBe(false);
    expect(await keyExists(`new-${tag}`)).toBe(true);
    expect(deleted.inbox_messages).toBeGreaterThanOrEqual(2);
    expect(deleted.idempotency_keys).toBeGreaterThanOrEqual(1);
  });

  test("depois de apagar a idempotency key: replay continua idempotente e payload diferente continua 409", async () => {
    const wallet = await createWallet(api.url, "100.00");
    const payload = wagerPayload(wallet, { kind: "BET", amount: "25.00" });
    const first = await submit(api.url, payload);
    await db()`update idempotency_keys set created_at = now() - interval '2 days' where idempotency_key = ${keyOf(payload)}`;
    await runRetention(await scrape(api));
    expect(await keyExists(keyOf(payload))).toBe(false);

    const replay = await submit(api.url, payload);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    const conflict = await submit(api.url, { ...payload, money: brl("26.00") });
    expect(conflict.status).toBe(409);
    const state = await walletState(wallet.id);
    expect(state.balance).toBe("75.00");
    expect(state.entries.filter((e: { direction: string }) => e.direction === "DEBIT").length).toBe(1);
  });

  test("depois de apagar a inbox: reentrega da mesma mensagem não duplica o efeito", async () => {
    const wallet = await createWallet(api.url, "100.00");
    const payload = wagerPayload(wallet, { kind: "BET", amount: "10.00" });
    const message = wagerMessage(payload);
    await sendWager(message);
    await waitFor(async () => (await transactionByExternalId("provider-a", payload.externalTransactionId))?.status === "PROCESSED");
    await waitFor(() => inboxExists(message.messageId));

    await db()`update inbox_messages set received_at = now() - interval '8 days' where message_id = ${message.messageId}`;
    await runRetention(await scrape(api));
    expect(await inboxExists(message.messageId)).toBe(false);

    await sendWager(message);
    await waitFor(() => inboxExists(message.messageId));
    const state = await walletState(wallet.id);
    expect(state.balance).toBe("90.00");
    expect(state.entries.filter((e: { direction: string }) => e.direction === "DEBIT").length).toBe(1);
  });

  test("duas instâncias limpando ao mesmo tempo: tudo apagado uma vez, sem erro", async () => {
    const before = await scrape(api);
    const tag = crypto.randomUUID();
    await db()`insert into inbox_messages (consumer_name, message_id, payload_hash, received_at)
      select 'bulk', ${tag} || '-' || g, 'h', now() - interval '10 days' from generate_series(1, 3500) g`;
    await db()`insert into idempotency_keys (provider_id, idempotency_key, payload_hash, created_at)
      select 'bulk', ${tag} || '-' || g, 'h', now() - interval '3 days' from generate_series(1, 3500) g`;

    const deleted = await runRetention(before, 2);
    expect(deleted).toEqual({ inbox_messages: 3500, idempotency_keys: 3500 });
    const [{ c }] = await db()`select count(*)::int as c from inbox_messages where consumer_name = 'bulk'`;
    expect(c).toBe(0);
  });
});
