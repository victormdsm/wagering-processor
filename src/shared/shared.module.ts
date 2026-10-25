import { SQSClient } from "@aws-sdk/client-sqs";
import { Module } from "@nestjs/common";
import { EventOutbox } from "./application/event-outbox";
import { InboxRepository } from "./infrastructure/inbox/inbox.repository";
import { MikroOrmEventOutbox } from "./infrastructure/outbox/mikro-orm-event-outbox";
import { Metrics } from "./infrastructure/observability/metrics";
import { ObservabilityController } from "./infrastructure/observability/observability.controller";
import { OutboxPublisherWorker } from "./infrastructure/outbox/outbox-publisher.worker";
import { TransactionRunner } from "./infrastructure/persistence/transaction-runner";
import { createSqsClient } from "./infrastructure/sqs/sqs.config";

@Module({
  controllers: [ObservabilityController],
  providers: [
    Metrics,
    TransactionRunner,
    InboxRepository,
    OutboxPublisherWorker,
    { provide: EventOutbox, useClass: MikroOrmEventOutbox },
    { provide: SQSClient, useFactory: createSqsClient },
  ],
  exports: [TransactionRunner, InboxRepository, EventOutbox, SQSClient, Metrics],
})
export class SharedModule {}
