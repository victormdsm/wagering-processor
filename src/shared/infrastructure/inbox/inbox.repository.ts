import type { QueryResult } from "@mikro-orm/core";
import { EntityManager } from "@mikro-orm/postgresql";
import { Injectable } from "@nestjs/common";
import { InboxMessageRecord } from "../persistence/inbox-message.record";
import type { InboxMessage } from "./inbox-message";

@Injectable()
export class InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async exists(consumerName: string, messageId: string): Promise<boolean> {
    return (await this.em.count(InboxMessageRecord, { consumerName, messageId })) > 0;
  }

  async add(message: InboxMessage): Promise<void> {
    this.em.create(InboxMessageRecord, {
      consumerName: message.consumerName,
      messageId: message.messageId,
      payloadHash: message.payloadHash,
      receivedAt: message.receivedAt,
      processedAt: message.processedAt ?? null,
    });
  }

  async deleteReceivedBefore(cutoff: Date, limit: number): Promise<number> {
    const result = await this.em.execute<QueryResult>(
      `delete from inbox_messages
        where (consumer_name, message_id) in (
          select consumer_name, message_id from inbox_messages
           where received_at < ? order by received_at limit ? for update skip locked)`,
      [cutoff, limit],
      "run",
    );
    return result.affectedRows;
  }
}
