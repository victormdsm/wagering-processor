import { defineEntity, p } from "@mikro-orm/core";

const InboxMessageSchema = defineEntity({
  name: "InboxMessageRecord",
  tableName: "inbox_messages",
  properties: {
    consumerName: p.string().primary(),
    messageId: p.string().primary(),
    payloadHash: p.string(),
    receivedAt: p.datetime(),
    processedAt: p.datetime().nullable(),
  },
  indexes: [{ properties: ["receivedAt"] }],
});

export class InboxMessageRecord extends InboxMessageSchema.class {}
InboxMessageSchema.setClass(InboxMessageRecord);
