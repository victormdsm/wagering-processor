import { defineEntity, p } from "@mikro-orm/core";

const IdempotencyKeySchema = defineEntity({
  name: "IdempotencyKeyRecord",
  tableName: "idempotency_keys",
  properties: {
    id: p.bigint().primary().autoincrement(),
    createdAt: p.datetime().defaultRaw("now()"),
    idempotencyKey: p.string().length(100),
    providerId: p.string(),
    payloadHash: p.string(),
    responseCode: p.integer().nullable(),
    responseBody: p.json<Record<string, unknown>>().nullable(),
  },
  uniques: [{ properties: ["providerId", "idempotencyKey"] }],
  indexes: [{ properties: ["createdAt"] }],
});

export class IdempotencyKeyRecord extends IdempotencyKeySchema.class {}
IdempotencyKeySchema.setClass(IdempotencyKeyRecord);
