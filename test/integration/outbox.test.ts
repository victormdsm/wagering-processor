import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { SendMessageBatchCommand, SQSClient } from "@aws-sdk/client-sqs";
import { createWallet, wager } from "../support/api";
import { startApp, waitFor, type RunningApp } from "../support/app";
import { expectLedgerConsistent } from "../support/assertions";
import { db, sqsConfig } from "../support/infra";
import { drain } from "../support/sqs";

setDefaultTimeout(60_000);

class RecordingSqs extends SQSClient {
  static sent = new Map<string, number>();
  static failNextBatch = false;

  override send(command: any, options?: any): any {
    if (command instanceof SendMessageBatchCommand) {
      if (RecordingSqs.failNextBatch) {
        RecordingSqs.failNextBatch = false;
        return Promise.reject(new Error("SQS indisponível"));
      }
      for (const entry of command.input.Entries ?? []) {
        RecordingSqs.sent.set(entry.MessageDeduplicationId!, (RecordingSqs.sent.get(entry.MessageDeduplicationId!) ?? 0) + 1);
      }
    }
    return super.send(command, options);
  }
}

const withRecordingSqs = () =>
  startApp((b) => b.overrideProvider(SQSClient).useFactory({ factory: () => new RecordingSqs(sqsConfig) }));

const apps: RunningApp[] = [];

afterAll(async () => {
  await expectLedgerConsistent();
  await Promise.all(apps.map((a) => a.close()));
});

const unpublished = async (ids: string[]) =>
  (await db()`select count(*)::int as c from outbox_messages where id in ${db()(ids)} and published_at is null`)[0].c as number;

describe("transactional outbox", () => {
  let committedEventIds: string[] = [];

  test("recuperação: commit confirmado, processo morre antes de publicar, outra instância publica", async () => {
    process.env.OUTBOX_PUBLISHER_ENABLED = "false";
    const a = await startApp();
    delete process.env.OUTBOX_PUBLISHER_ENABLED;
    const wallet = await createWallet(a.url);
    const bet = await wager(a.url, wallet, { kind: "BET", amount: "10.00" });
    committedEventIds = (
      await db()`select id from outbox_messages where payload->'data'->>'walletId' = ${wallet.id}`
    ).map((r: { id: string }) => r.id);
    expect(committedEventIds.length).toBe(4);
    expect(await unpublished(committedEventIds)).toBe(4);
    await a.close();

    const b = await withRecordingSqs();
    apps.push(b);
    await waitFor(async () => (await unpublished(committedEventIds)) === 0);

    const published = await drain("events");
    const bodies = published.map((m) => JSON.parse(m.Body!));
    for (const id of committedEventIds) expect(bodies.some((e) => e.eventId === id)).toBe(true);
    const balanceChanged = bodies.find((e) => e.aggregateId === wallet.id && e.data.transactionId === bet.body.transactionId);
    expect(balanceChanged).toMatchObject({ eventType: "WalletBalanceChanged", version: 1, data: { walletVersion: 2 } });
  });

  test("publicação duplicada é segura: o mesmo eventId chega uma vez ao consumidor", async () => {
    const [id] = committedEventIds;
    await db()`update outbox_messages set published_at = null where id = ${id}`;
    await waitFor(async () => (await unpublished([id])) === 0);
    expect(RecordingSqs.sent.get(id)).toBe(2);
    const received = (await drain("events")).filter((m) => JSON.parse(m.Body!).eventId === id);
    expect(received.length).toBe(0);
  });

  test("§13 concorrência 6: dois publishers sobre a mesma outbox não publicam o mesmo evento duas vezes", async () => {
    apps.push(await withRecordingSqs());
    RecordingSqs.sent.clear();
    const ids = (
      await db()`
        insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts)
        select id, id::text, 'TestEvent', jsonb_build_object('eventId', id), now(), 0
          from (select gen_random_uuid() as id from generate_series(1, 600)) s
        returning id`
    ).map((r: { id: string }) => r.id) as string[];

    await waitFor(async () => (await unpublished(ids)) === 0, 30_000);
    const counts = ids.map((id) => RecordingSqs.sent.get(id));
    expect(counts.every((c) => c === 1)).toBe(true);
    await drain("events");
  });

  test("retry: SQS fora numa chamada → backoff e publicação depois", async () => {
    RecordingSqs.failNextBatch = true;
    const [{ id }] = await db()`
      insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts)
      values (gen_random_uuid(), 'agg', 'TestEvent', '{}'::jsonb, now(), 0) returning id`;
    await waitFor(async () => (await unpublished([id])) === 0);
    const [row] = await db()`select attempts from outbox_messages where id = ${id}`;
    expect(row.attempts).toBe(1);
    await drain("events");
  });
});
