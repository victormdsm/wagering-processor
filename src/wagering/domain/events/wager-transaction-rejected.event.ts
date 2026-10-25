import { IntegrationEvent, type EventContext, type IntegrationEventProps } from "../../../shared/domain/integration-event";
import type { WagerTransaction } from "../wager-transaction";
import { wagerTransactionData, type WagerTransactionData } from "./wager-transaction-data";

export interface WagerTransactionRejectedData extends WagerTransactionData {
  failureCode: string;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionRejectedData>) {
    super(props);
  }

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected({
      eventId: crypto.randomUUID(),
      aggregateId: transaction.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data: {
        ...wagerTransactionData(transaction),
        failureCode: transaction.failureCode!,
      },
    });
  }
}
