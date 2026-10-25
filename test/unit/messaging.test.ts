import { describe, expect, test } from "bun:test";
import { InboxMessage } from "../../src/shared/infrastructure/inbox/inbox-message";
import { OutboxMessage } from "../../src/shared/infrastructure/outbox/outbox-message";
import { Money } from "../../src/shared/domain/money";
import { Wallet } from "../../src/wallet/domain/wallet";
import { WalletBalanceChanged } from "../../src/wallet/domain/events/wallet-balance-changed.event";

function event() {
  const wallet = Wallet.open({
    id: "w",
    playerId: "p",
    initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
  });
  const entry = wallet.debit({
    entryId: "e",
    transactionId: "t",
    money: Money.from({ amount: "25.00", currency: "BRL" }),
    at: new Date("2026-01-01T00:00:00.000Z"),
  });
  return WalletBalanceChanged.from(wallet, entry, { correlationId: "c", occurredAt: new Date("2026-01-01T00:00:00.000Z") });
}

describe("IntegrationEvent", () => {
  test("envelope serializado com eventType e version do tipo e MoneyProps no data", () => {
    const json = event().toJSON();
    expect(json.eventType).toBe("WalletBalanceChanged");
    expect(json.version).toBe(1);
    expect(json.occurredAt).toBe("2026-01-01T00:00:00.000Z");
    expect(json.data.money).toEqual({ amount: "25.00", currency: "BRL" });
    expect(json.data.balanceAfter).toEqual({ amount: "75.00", currency: "BRL" });
    expect(json.data.walletVersion).toBe(2);
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });
});

describe("OutboxMessage", () => {
  test("nasce pendente e devida", () => {
    const message = OutboxMessage.enqueue(event());
    expect(message.isPending()).toBe(true);
    expect(message.isDue(new Date())).toBe(true);
    expect(message.payload.eventType).toBe("WalletBalanceChanged");
  });

  test("scheduleRetry: backoff exponencial com teto", () => {
    const message = OutboxMessage.enqueue(event());
    const now = new Date(0);
    message.scheduleRetry(now);
    expect(message.attempts).toBe(1);
    expect(message.nextAttemptAt!.getTime()).toBe(1_000);
    expect(message.isDue(new Date(999))).toBe(false);
    expect(message.isDue(new Date(1_000))).toBe(true);
    for (let i = 0; i < 20; i++) message.scheduleRetry(now);
    expect(message.nextAttemptAt!.getTime()).toBe(5 * 60_000);
  });

  test("markPublished é idempotente", () => {
    const message = OutboxMessage.enqueue(event());
    message.markPublished(new Date(1));
    message.markPublished(new Date(2));
    expect(message.publishedAt!.getTime()).toBe(1);
    expect(message.isDue(new Date())).toBe(false);
  });
});

describe("InboxMessage", () => {
  test("receive nasce não processada; markProcessed mantém a primeira data", () => {
    const message = InboxMessage.receive({ messageId: "m", consumerName: "c", payloadHash: "h", receivedAt: new Date() });
    expect(message.isProcessed()).toBe(false);
    message.markProcessed(new Date(1));
    message.markProcessed(new Date(2));
    expect(message.processedAt!.getTime()).toBe(1);
  });

  test("exige messageId e consumerName", () => {
    expect(() => InboxMessage.receive({ messageId: "", consumerName: "c", payloadHash: "h", receivedAt: new Date() })).toThrow();
  });
});
