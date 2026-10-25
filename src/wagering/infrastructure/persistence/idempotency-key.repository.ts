import type { QueryResult } from "@mikro-orm/core";
import { EntityManager } from "@mikro-orm/postgresql";
import { Injectable } from "@nestjs/common";
import { IdempotencyKeyRecord } from "./idempotency-key.record";

@Injectable()
export class IdempotencyKeyRepository {
  constructor(private readonly em: EntityManager) {}

  find(providerId: string, idempotencyKey: string): Promise<IdempotencyKeyRecord | null> {
    return this.em.findOne(IdempotencyKeyRecord, { providerId, idempotencyKey });
  }

  async start(providerId: string, idempotencyKey: string, payloadHash: string): Promise<IdempotencyKeyRecord> {
    const record = this.em.create(IdempotencyKeyRecord, {
      providerId,
      idempotencyKey,
      payloadHash,
      responseCode: null,
      responseBody: null,
    });
    await this.em.flush();
    return record;
  }

  complete(record: IdempotencyKeyRecord, responseCode: number, responseBody: Record<string, unknown>): void {
    record.responseCode = responseCode;
    record.responseBody = responseBody;
  }

  async deleteCreatedBefore(cutoff: Date, limit: number): Promise<number> {
    const result = await this.em.execute<QueryResult>(
      `delete from idempotency_keys
        where id in (
          select id from idempotency_keys
           where created_at < ? order by created_at limit ? for update skip locked)`,
      [cutoff, limit],
      "run",
    );
    return result.affectedRows;
  }
}
