import { EntityManager } from "@mikro-orm/postgresql";
import { Injectable } from "@nestjs/common";
import { EventOutbox } from "../../application/event-outbox";
import type { IntegrationEvent } from "../../domain/integration-event";
import { OutboxMessageRecord } from "../persistence/outbox-message.record";
import { OutboxMessage } from "./outbox-message";

@Injectable()
export class MikroOrmEventOutbox extends EventOutbox {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async enqueue(events: IntegrationEvent<unknown>[]): Promise<void> {
    for (const event of events) {
      const message = OutboxMessage.enqueue(event);
      this.em.create(OutboxMessageRecord, {
        id: message.id,
        aggregateId: message.aggregateId,
        eventType: message.eventType,
        payload: { ...message.payload },
        occurredAt: message.occurredAt,
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt ?? null,
        publishedAt: message.publishedAt ?? null,
      });
    }
  }
}
