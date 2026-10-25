import { afterAll, beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { DeleteMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { ConnectionException } from "@mikro-orm/core";
import { EventOutbox } from "../../src/shared/application/event-outbox";
import type { IntegrationEvent } from "../../src/shared/domain/integration-event";
import { MikroOrmEventOutbox } from "../../src/shared/infrastructure/outbox/mikro-orm-event-outbox";
import { ProcessWagerTransactionUseCase } from "../../src/wagering/application/process-wager-transaction.use-case";
import { brl, createWallet, keyOf, submit, wagerPayload } from "../support/api";
import { startApp, waitFor, type RunningApp } from "../support/app";
import { expectLedgerConsistent, transactionByExternalId, walletState } from "../support/assertions";
import { db, sqsConfig } from "../support/infra";
import { drain, queueDepth, sendRaw, sendWager, wagerMessage } from "../support/sqs";

setDefaultTimeout(60_000);

const faults = {
  crashBeforeCommit: false,
  crashes: 0,
  transientOnce: false,
  transientThrown: 0,
  dieBeforeAck: false,
  release: () => {},
};

class FaultyOutbox extends MikroOrmEventOutbox {
  override async enqueue(events: IntegrationEvent<unknown>[]): Promise<void> {
    await super.enqueue(events);
    if (faults.crashBeforeCommit) {
      faults.crashBeforeCommit = false;
      faults.crashes++;
      throw new Error("processo caiu antes do commit");
    }
  }
}

class FaultyUseCase extends ProcessWagerTransactionUseCase {
  override async execute(input: Parameters<ProcessWagerTransactionUseCase["execute"]>[0]) {
    if (faults.transientOnce && input.externalTransactionId.startsWith("flaky-")) {
      faults.transientOnce = false;
      faults.transientThrown++;
      throw new ConnectionException(new Error("connection refused"));
    }
    return super.execute(input);
  }
}

class FaultySqs extends SQSClient {
  override send(command: any, options?: any): any {
    if (command instanceof DeleteMessageCommand && faults.dieBeforeAck) {
      faults.dieBeforeAck = false;
      return new Promise((resolve) => (faults.release = () => resolve({})));
    }
    return super.send(command, options);
  }
}

let api: RunningApp;

beforeAll(async () => {
  api = await startApp((b) =>
    b
      .overrideProvider(EventOutbox)
      .useClass(FaultyOutbox)
      .overrideProvider(ProcessWagerTransactionUseCase)
      .useClass(FaultyUseCase)
      .overrideProvider(SQSClient)
      .useFactory({ factory: () => new FaultySqs(sqsConfig) }),
  );
});

afterAll(async () => {
  await expectLedgerConsistent();
  faults.release();
  await api.close();
});

const inboxCount = async (messageId: string) =>
  (await db()`select count(*)::int as c from inbox_messages where message_id = ${messageId}`)[0].c as number;

const transientRetries = async (url: string) => {
  const match = (await (await fetch(`${url}/metrics`)).text()).match(/wagering_retries_total\{reason="sqs_transient"\} (\d+)/);
  return match ? Number(match[1]) : 0;
};

describe("consumer SQS — mesmo use case do HTTP", () => {
  test("processa a mensagem, grava a inbox e faz ack", async () => {
    const wallet = await createWallet(api.url);
    const payload = wagerPayload(wallet, { kind: "BET", amount: "25.00" });
    const message = wagerMessage(payload);
    await sendWager(message);

    await waitFor(async () => (await transactionByExternalId("provider-a", payload.externalTransactionId))?.status === "PROCESSED");
    expect((await walletState(wallet.id)).balance).toBe("75.00");
    expect(await inboxCount(message.messageId)).toBe(1);
    await waitFor(async () => (await queueDepth("main")) === 0);
  });

  test("inbox e redelivery: a mesma mensagem 5 vezes → um único débito", async () => {
    const wallet = await createWallet(api.url);
    const message = wagerMessage(wagerPayload(wallet, { kind: "BET", amount: "10.00" }));
    for (let i = 0; i < 5; i++) await sendWager(message);

    await waitFor(async () => (await queueDepth("main")) === 0);
    const state = await walletState(wallet.id);
    expect(state.balance).toBe("90.00");
    expect(state.entries.filter((e: { direction: string }) => e.direction === "DEBIT").length).toBe(1);
    expect(await inboxCount(message.messageId)).toBe(1);
    const metrics = await (await fetch(`${api.url}/metrics`)).text();
    expect(metrics).toMatch(/wagering_duplicates_total\{source="inbox"\} [4-9]/);
  });

  test("mesma operação por HTTP e depois pela fila (outro messageId) → um único efeito", async () => {
    const wallet = await createWallet(api.url);
    const payload = wagerPayload(wallet, { kind: "BET", amount: "10.00" });
    await submit(api.url, payload);
    const message = wagerMessage(payload);
    await sendWager(message);
    await waitFor(async () => (await inboxCount(message.messageId)) === 1);
    expect((await walletState(wallet.id)).balance).toBe("90.00");
  });

  test("erro de negócio é terminal: ack sem retry", async () => {
    const wallet = await createWallet(api.url, "1.00");
    const payload = wagerPayload(wallet, { kind: "BET", amount: "10.00" });
    await sendWager(wagerMessage(payload));
    await waitFor(async () => (await transactionByExternalId("provider-a", payload.externalTransactionId))?.status === "REJECTED");
    await waitFor(async () => (await queueDepth("main")) === 0);
  });

  test("Bug 10: replay HTTP de PENDING_REFERENCE que chegou pela fila devolve o saldo atual", async () => {
    const wallet = await createWallet(api.url, "100.00");
    const payload = wagerPayload(wallet, {
      kind: "REFUND",
      referenceExternalTransactionId: `missing-${crypto.randomUUID()}`,
    });
    await sendWager(wagerMessage(payload));
    await waitFor(async () => (await transactionByExternalId("provider-a", payload.externalTransactionId))?.status === "PENDING_REFERENCE");

    const replay = await submit(api.url, payload);
    expect(replay.status).toBe(202);
    expect(replay.body).toMatchObject({ status: "PENDING_REFERENCE", idempotentReplay: true, balance: brl("100.00") });
  });
});

describe("consumer SQS — falhas", () => {
  test("mensagem inválida é permanente: vai para a DLQ após o limite de tentativas", async () => {
    const retriesBefore = await transientRetries(api.url);
    const marker = `lixo-${crypto.randomUUID()}`;
    await sendRaw(marker, "invalid");
    const wallet = await createWallet(api.url);
    const badUuid = wagerMessage({ ...wagerPayload(wallet, { kind: "BET" }), walletId: "not-a-uuid" });
    await sendWager(badUuid);

    const found = new Set<string>();
    await waitFor(async () => {
      for (const m of await drain("dlq", 1)) found.add(m.Body!);
      return found.has(marker) && found.has(JSON.stringify(badUuid));
    }, 30_000);
    expect(await inboxCount(badUuid.messageId)).toBe(0);
    expect(await transientRetries(api.url)).toBe(retriesBefore);
  });

  test("atomicidade: falha antes do commit desfaz inbox, transação, ledger e outbox; o retry aplica uma vez", async () => {
    const wallet = await createWallet(api.url);
    const payload = wagerPayload(wallet, { kind: "BET", amount: "30.00" });
    const message = wagerMessage(payload);
    faults.crashBeforeCommit = true;
    await sendWager(message);

    await waitFor(() => faults.crashes === 1);
    expect(await transactionByExternalId("provider-a", payload.externalTransactionId)).toBeUndefined();
    expect(await inboxCount(message.messageId)).toBe(0);
    const between = await walletState(wallet.id);
    expect(between.balance).toBe("100.00");
    expect(between.entries.length).toBe(1);
    const [{ c }] = await db()`select count(*)::int as c from outbox_messages where payload->'data'->>'walletId' = ${wallet.id}`;
    expect(c).toBe(2);

    await waitFor(async () => (await transactionByExternalId("provider-a", payload.externalTransactionId))?.status === "PROCESSED");
    const tx = await transactionByExternalId("provider-a", payload.externalTransactionId);
    const outbox = await db()`select event_type from outbox_messages
      where payload->'data'->>'transactionId' = ${tx!.id} order by event_type`;
    expect(outbox.map((r: { event_type: string }) => r.event_type)).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
    expect((await walletState(wallet.id)).balance).toBe("70.00");
    expect(await inboxCount(message.messageId)).toBe(1);
  });

  test("falha transitória: retry com backoff e sucesso na entrega seguinte", async () => {
    const retriesBefore = await transientRetries(api.url);
    const wallet = await createWallet(api.url);
    const payload = wagerPayload(wallet, { kind: "BET", amount: "5.00", externalTransactionId: `flaky-${crypto.randomUUID()}` });
    faults.transientOnce = true;
    await sendWager(wagerMessage(payload));

    await waitFor(async () => (await transactionByExternalId("provider-a", payload.externalTransactionId))?.status === "PROCESSED");
    expect(faults.transientThrown).toBe(1);
    expect((await walletState(wallet.id)).balance).toBe("95.00");
    expect(await transientRetries(api.url)).toBe(retriesBefore + 1);
  });

  test("§13 concorrência 5: worker morto depois do commit e antes do ack → redelivery sem duplicar", async () => {
    const wallet = await createWallet(api.url);
    const payload = wagerPayload(wallet, { kind: "BET", amount: "40.00" });
    faults.dieBeforeAck = true;
    await sendWager(wagerMessage(payload));

    await waitFor(async () => (await transactionByExternalId("provider-a", payload.externalTransactionId))?.status === "PROCESSED");
    expect(faults.dieBeforeAck).toBe(false);

    const other = await startApp();
    try {
      await waitFor(async () => (await queueDepth("main")) === 0, 30_000);
      const state = await walletState(wallet.id);
      expect(state.balance).toBe("60.00");
      expect(state.entries.filter((e: { direction: string }) => e.direction === "DEBIT").length).toBe(1);
      const [{ c }] = await db()`select count(*)::int as c from wager_transactions where idempotency_key = ${keyOf(payload)}`;
      expect(c).toBe(1);
    } finally {
      await other.close();
    }
  });
});
