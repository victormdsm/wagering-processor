import { afterAll, beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { brl, createWallet, request, submit, wager, wagerPayload } from "../support/api";
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

const status = async (externalId: string) => (await transactionByExternalId("provider-a", externalId))?.status;

describe("§13 concorrência 7: ROLLBACK ou REFUND entregue antes da referência", () => {
  test("REFUND antes da BET (HTTP): fica PENDING_REFERENCE e o worker aplica depois", async () => {
    const wallet = await createWallet(api.url);
    const betId = `bet-${crypto.randomUUID()}`;
    const refund = await wager(api.url, wallet, { kind: "REFUND", amount: "25.00", referenceExternalTransactionId: betId });
    expect(refund.status).toBe(202);
    expect((await walletState(wallet.id)).entries.length).toBe(1);

    const bet = await wager(api.url, wallet, { kind: "BET", amount: "25.00", externalTransactionId: betId });
    expect(bet.body.balance).toEqual(brl("75.00"));

    await waitFor(async () => (await status(refund.payload.externalTransactionId)) === "PROCESSED");
    expect((await walletState(wallet.id)).balance).toBe("100.00");
    const view = await request(api.url, "GET", `/wagering/transactions/${refund.body.transactionId}`);
    expect(view.body).toMatchObject({ status: "PROCESSED", balance: brl("100.00") });
    const [event] = await db()`select count(*)::int as c from outbox_messages
      where aggregate_id = ${refund.body.transactionId} and event_type = 'WagerTransactionPendingReference'`;
    expect(event.c).toBe(1);
  });

  test("ROLLBACK antes da BET (fila): worker aplica quando a BET chega", async () => {
    const wallet = await createWallet(api.url);
    const betId = `bet-${crypto.randomUUID()}`;
    const rollback = wagerPayload(wallet, { kind: "ROLLBACK", amount: "10.00", referenceExternalTransactionId: betId });
    await sendWager(wagerMessage(rollback));
    await waitFor(async () => (await status(rollback.externalTransactionId)) === "PENDING_REFERENCE");

    await sendWager(wagerMessage(wagerPayload(wallet, { kind: "BET", amount: "10.00", externalTransactionId: betId })));
    await waitFor(async () => (await status(rollback.externalTransactionId)) === "PROCESSED");
    expect((await walletState(wallet.id)).balance).toBe("100.00");
  });

  test("referência que chega REJECTED → reversão REJECTED REFERENCE_NOT_PROCESSED", async () => {
    const wallet = await createWallet(api.url, "1.00");
    const betId = `bet-${crypto.randomUUID()}`;
    const refund = await wager(api.url, wallet, { kind: "REFUND", amount: "25.00", referenceExternalTransactionId: betId });
    await wager(api.url, wallet, { kind: "BET", amount: "25.00", externalTransactionId: betId });
    await waitFor(async () => (await status(refund.payload.externalTransactionId)) === "REJECTED");
    const row = await transactionByExternalId("provider-a", refund.payload.externalTransactionId);
    expect(row?.failure_code).toBe("REFERENCE_NOT_PROCESSED");
    expect((await walletState(wallet.id)).balance).toBe("1.00");
  });

  test("tentativas esgotadas → REJECTED REFERENCE_NOT_FOUND e evento publicado na outbox", async () => {
    const wallet = await createWallet(api.url);
    const refund = await wager(api.url, wallet, {
      kind: "REFUND",
      amount: "25.00",
      referenceExternalTransactionId: `never-${crypto.randomUUID()}`,
    });
    await db()`update wager_transactions set attempts = 10, next_attempt_at = now() where id = ${refund.body.transactionId}`;
    await waitFor(async () => (await status(refund.payload.externalTransactionId)) === "REJECTED");
    expect((await transactionByExternalId("provider-a", refund.payload.externalTransactionId))?.failure_code).toBe(
      "REFERENCE_NOT_FOUND",
    );
    const [event] = await db()`select count(*)::int as c from outbox_messages
      where aggregate_id = ${refund.body.transactionId} and event_type = 'WagerTransactionRejected'`;
    expect(event.c).toBe(1);
    const replay = await submit(api.url, refund.payload);
    expect(replay.status).toBe(202);
  });

  test("enquanto pendente, o backoff é exponencial", async () => {
    const wallet = await createWallet(api.url);
    const refund = await wager(api.url, wallet, {
      kind: "REFUND",
      amount: "25.00",
      referenceExternalTransactionId: `never-${crypto.randomUUID()}`,
    });
    await waitFor(async () => ((await transactionByExternalId("provider-a", refund.payload.externalTransactionId))?.attempts ?? 0) >= 2, 10_000);
    const [row] = await db()`select attempts, extract(epoch from next_attempt_at - now()) as wait from wager_transactions where id = ${refund.body.transactionId}`;
    expect(row.attempts).toBeGreaterThanOrEqual(2);
    expect(Number(row.wait)).toBeGreaterThan(0);
  });
});
