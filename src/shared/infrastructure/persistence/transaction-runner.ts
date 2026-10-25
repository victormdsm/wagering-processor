import { DeadlockException, OptimisticLockError, UniqueConstraintViolationException } from "@mikro-orm/core";
import { EntityManager } from "@mikro-orm/postgresql";
import { Injectable } from "@nestjs/common";
import { Metrics } from "../observability/metrics";

const MAX_ATTEMPTS = 5;
const JITTER_STEP_MS = 10;

@Injectable()
export class TransactionRunner {
  constructor(
    private readonly em: EntityManager,
    private readonly metrics: Metrics,
  ) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.em.fork().transactional(() => work());
      } catch (error) {
        if (error instanceof OptimisticLockError) this.metrics.lockConflicts.inc();
        if (attempt < MAX_ATTEMPTS && isRetryable(error)) {
          this.metrics.retries.inc({ reason: "transaction_conflict" });
          await sleep(Math.random() * JITTER_STEP_MS * attempt);
          continue;
        }
        throw error;
      }
    }
  }
}

function isRetryable(error: unknown): boolean {
  return (
    error instanceof OptimisticLockError ||
    error instanceof UniqueConstraintViolationException ||
    error instanceof DeadlockException
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
