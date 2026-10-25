import { SendMessageBatchCommand, SQSClient } from "@aws-sdk/client-sqs";
import { LockMode } from "@mikro-orm/core";
import { EntityManager } from "@mikro-orm/postgresql";
import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { describeError } from "../observability/log-safe-error";
import { Metrics } from "../observability/metrics";
import { TransactionRunner } from "../persistence/transaction-runner";
import { OutboxMessageRecord } from "../persistence/outbox-message.record";
import { getQueueUrl } from "../sqs/sqs.config";
import { OutboxMessage } from "./outbox-message";

const IDLE_INTERVAL_MS = 1_000;
const BATCH_SIZE = 200;
const SQS_BATCH_LIMIT = 10;

@Injectable()
export class OutboxPublisherWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisherWorker.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopping = false;
  private queueUrl!: string;

  constructor(
    private readonly em: EntityManager,
    private readonly runner: TransactionRunner,
    private readonly sqs: SQSClient,
    private readonly metrics: Metrics,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.OUTBOX_PUBLISHER_ENABLED === "false") {
      this.logger.log("publicador do outbox desligado nesta instância");
      return;
    }
    this.queueUrl = await getQueueUrl(this.sqs, process.env.WAGERING_EVENTS_QUEUE!);
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = this.drain()
        .catch((error) => this.logger.error("falha no ciclo do outbox", describeError(error)))
        .finally(() => (this.running = undefined));
    }, IDLE_INTERVAL_MS);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    clearInterval(this.timer);
    await this.running;
  }

  private async drain(): Promise<void> {
    while (!this.stopping) {
      const { handled, sqsUnavailable } = await this.publishBatch();
      if (sqsUnavailable) {
        this.logger.warn("SQS indisponível: ciclo do outbox interrompido, nova tentativa no próximo tique");
        return;
      }
      if (handled < BATCH_SIZE) return;
    }
  }

  private async publishBatch(): Promise<{ handled: number; sqsUnavailable: boolean }> {
    const now = new Date();
    return this.runner.run(async () => {
      const records = await this.em.find(
        OutboxMessageRecord,
        {
          publishedAt: null,
          $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
        },
        { orderBy: { occurredAt: "asc" }, limit: BATCH_SIZE, lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE },
      );

      const messages = records.map((record) =>
        OutboxMessage.rehydrate({
          ...record,
          nextAttemptAt: record.nextAttemptAt ?? undefined,
          publishedAt: record.publishedAt ?? undefined,
        }),
      );

      let sqsUnavailable = false;
      for (let start = 0; start < messages.length; start += SQS_BATCH_LIMIT) {
        const ok = await this.publishChunk(messages.slice(start, start + SQS_BATCH_LIMIT));
        if (!ok) {
          sqsUnavailable = true;
          break;
        }
      }

      records.forEach((record, i) => {
        record.attempts = messages[i].attempts;
        record.nextAttemptAt = messages[i].nextAttemptAt ?? null;
        record.publishedAt = messages[i].publishedAt ?? null;
      });
      return { handled: records.length, sqsUnavailable };
    });
  }

  private async publishChunk(chunk: OutboxMessage[]): Promise<boolean> {
    const failedIds = new Set<string>();
    let callSucceeded = true;
    try {
      const result = await this.sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: this.queueUrl,
          Entries: chunk.map((message, i) => ({
            Id: String(i),
            MessageBody: JSON.stringify(message.payload),
            MessageGroupId: message.aggregateId,
            MessageDeduplicationId: message.id,
          })),
        }),
      );
      for (const failed of result.Failed ?? []) if (failed.Id) failedIds.add(failed.Id);
    } catch (error) {
      this.logger.warn("falha ao publicar lote de eventos", { size: chunk.length, ...describeError(error) });
      chunk.forEach((_, i) => failedIds.add(String(i)));
      callSucceeded = false;
    }

    const at = new Date();
    chunk.forEach((message, i) => {
      if (failedIds.has(String(i))) {
        this.metrics.retries.inc({ reason: "outbox_publish" });
        message.scheduleRetry(at);
      } else {
        message.markPublished(at);
      }
    });
    return callSucceeded;
  }
}
