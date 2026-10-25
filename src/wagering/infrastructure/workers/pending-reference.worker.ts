import { OptimisticLockError } from "@mikro-orm/core";
import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { describeError } from "../../../shared/infrastructure/observability/log-safe-error";
import { TransactionRunner } from "../../../shared/infrastructure/persistence/transaction-runner";
import { RetryPendingReferencesUseCase } from "../../application/retry-pending-references.use-case";

const IDLE_INTERVAL_MS = 1_000;
const BATCH_SIZE = 200;

@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopping = false;

  constructor(
    private readonly runner: TransactionRunner,
    private readonly retryPendingReferences: RetryPendingReferencesUseCase,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = this.drain().finally(() => (this.running = undefined));
    }, IDLE_INTERVAL_MS);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    clearInterval(this.timer);
    await this.running;
  }

  private async drain(): Promise<void> {
    while (!this.stopping) {
      let handled = 0;
      while (handled < BATCH_SIZE && !this.stopping && (await this.processOne())) handled++;
      if (handled > 0) this.logger.log("PENDING_REFERENCE reprocessadas", { handled });
      if (handled < BATCH_SIZE) return;
    }
  }

  private async processOne(): Promise<boolean> {
    try {
      return await this.runner.run(() => this.retryPendingReferences.processNext(new Date()));
    } catch (error) {
      if (error instanceof OptimisticLockError) {
        this.logger.warn("conflito ao reprocessar PENDING_REFERENCE", describeError(error));
        return true;
      }
      this.logger.error("falha ao reprocessar PENDING_REFERENCE", describeError(error));
      return false;
    }
  }
}
