import { Module } from "@nestjs/common";
import { SharedModule } from "../shared/shared.module";
import { WalletModule } from "../wallet/wallet.module";
import { ProcessWagerTransactionUseCase } from "./application/process-wager-transaction.use-case";
import { RetryPendingReferencesUseCase } from "./application/retry-pending-references.use-case";
import { WagerTransactionApplier } from "./application/wager-transaction-applier";
import { WagerTransactionRepository } from "./domain/wager-transaction.repository";
import { WageringController } from "./infrastructure/http/wagering.controller";
import { IdempotencyKeyRepository } from "./infrastructure/persistence/idempotency-key.repository";
import { MikroOrmWagerTransactionRepository } from "./infrastructure/persistence/mikro-orm-wager-transaction.repository";
import { WagerTransactionQueries } from "./infrastructure/persistence/wager-transaction.queries";
import { WagerTransactionsConsumer } from "./infrastructure/sqs/wager-transactions.consumer";
import { PendingReferenceWorker } from "./infrastructure/workers/pending-reference.worker";
import { RetentionWorker } from "./infrastructure/workers/retention.worker";

@Module({
  imports: [SharedModule, WalletModule],
  controllers: [WageringController],
  providers: [
    { provide: WagerTransactionRepository, useClass: MikroOrmWagerTransactionRepository },
    IdempotencyKeyRepository,
    WagerTransactionQueries,
    WagerTransactionApplier,
    ProcessWagerTransactionUseCase,
    RetryPendingReferencesUseCase,
    WagerTransactionsConsumer,
    PendingReferenceWorker,
    RetentionWorker,
  ],
  exports: [WagerTransactionRepository],
})
export class WageringModule {}
