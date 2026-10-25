import { IntegrationEvent, type EventContext, type IntegrationEventProps } from "../../../shared/domain/integration-event";
import type { WagerTransaction } from "../wager-transaction";
import { wagerTransactionData, type WagerTransactionData } from "./wager-transaction-data";

export interface WagerTransactionPendingReferenceData extends WagerTransactionData {
  referenceExternalTransactionId: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionPendingReferenceData>) {
    super(props);
  }

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
      eventId: crypto.randomUUID(),
      aggregateId: transaction.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data: {
        ...wagerTransactionData(transaction),
        referenceExternalTransactionId: transaction.referenceExternalTransactionId!,
      },
    });
  }
}
