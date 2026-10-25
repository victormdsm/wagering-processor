import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { InboxRepository } from "../../../shared/infrastructure/inbox/inbox.repository";
import { describeError } from "../../../shared/infrastructure/observability/log-safe-error";
import { Metrics } from "../../../shared/infrastructure/observability/metrics";
import { TransactionRunner } from "../../../shared/infrastructure/persistence/transaction-runner";
import { IdempotencyKeyRepository } from "../persistence/idempotency-key.repository";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

export const INBOX_RETENTION_MS = 7 * DAY_MS;
export const IDEMPOTENCY_KEY_RETENTION_MS = DAY_MS;
const INTERVAL_MS = HOUR_MS;
const BATCH_SIZE = 1_000;

@Injectable()
export class RetentionWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RetentionWorker.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopping = false;

  constructor(
    private readonly runner: TransactionRunner,
    private readonly inbox: InboxRepository,
    private readonly idempotencyKeys: IdempotencyKeyRepository,
    private readonly metrics: Metrics,
  ) {}

  onApplicationBootstrap(): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), INTERVAL_MS);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    clearInterval(this.timer);
    await this.running;
  }

  private tick(): void {
    if (this.running) return;
    this.running = this.purge()
      .catch((error) => this.logger.error("falha na retenção", describeError(error)))
      .finally(() => (this.running = undefined));
  }

  private async purge(): Promise<void> {
    const now = Date.now();
    await this.purgeTable("inbox_messages", (limit) =>
      this.inbox.deleteReceivedBefore(new Date(now - INBOX_RETENTION_MS), limit),
    );
    await this.purgeTable("idempotency_keys", (limit) =>
      this.idempotencyKeys.deleteCreatedBefore(new Date(now - IDEMPOTENCY_KEY_RETENTION_MS), limit),
    );
  }

  private async purgeTable(table: string, deleteBatch: (limit: number) => Promise<number>): Promise<void> {
    let total = 0;
    while (!this.stopping) {
      const deleted = await this.runner.run(() => deleteBatch(BATCH_SIZE));
      total += deleted;
      if (deleted < BATCH_SIZE) break;
    }
    if (total > 0) {
      this.metrics.retentionDeleted.inc({ table }, total);
      this.logger.log("retenção aplicada", { table, deleted: total });
    }
  }
}
