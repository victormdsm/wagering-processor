import type { IntegrationEvent } from "../domain/integration-event";

export abstract class EventOutbox {
  abstract enqueue(events: IntegrationEvent<unknown>[]): Promise<void>;
}
