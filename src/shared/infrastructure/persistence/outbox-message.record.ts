import { defineEntity, p } from "@mikro-orm/core";

const OutboxMessageSchema = defineEntity({
  name: "OutboxMessageRecord",
  tableName: "outbox_messages",
  properties: {
    id: p.uuid().primary(),
    aggregateId: p.string(),
    eventType: p.string(),
    payload: p.json<Record<string, unknown>>(),
    occurredAt: p.datetime(),
    attempts: p.integer(),
    nextAttemptAt: p.datetime().nullable(),
    publishedAt: p.datetime().nullable(),
  },
  checks: [{ name: "outbox_messages_attempts_non_negative", expression: "attempts >= 0" }],
  indexes: [{ properties: ["occurredAt"], where: "published_at is null" }],
});

export class OutboxMessageRecord extends OutboxMessageSchema.class {}
OutboxMessageSchema.setClass(OutboxMessageRecord);
