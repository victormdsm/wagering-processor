import type { MoneyProps } from "../../../shared/domain/money";
import { IntegrationEvent, type EventContext, type IntegrationEventProps } from "../../../shared/domain/integration-event";
import type { WagerTransaction } from "../wager-transaction";
import { wagerTransactionData, type WagerTransactionData } from "./wager-transaction-data";

export interface WagerTransactionProcessedData extends WagerTransactionData {
  observedBalance: MoneyProps;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionProcessedData>) {
    super(props);
  }

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      eventId: crypto.randomUUID(),
      aggregateId: transaction.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data: {
        ...wagerTransactionData(transaction),
        observedBalance: transaction.observedBalance!.toJSON(),
      },
    });
  }
}
