import { GetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";
import { EntityManager } from "@mikro-orm/postgresql";
import { Injectable } from "@nestjs/common";
import { Counter, Gauge, Histogram, Registry } from "prom-client";
import { OutboxMessageRecord } from "../persistence/outbox-message.record";
import { getQueueUrl } from "../sqs/sqs.config";

@Injectable()
export class Metrics {
  readonly registry = new Registry();

  readonly transactions = new Counter({
    name: "wagering_transactions_total",
    help: "Transações por status e entrada",
    labelNames: ["status", "entry"] as const,
    registers: [this.registry],
  });

  readonly duplicates = new Counter({
    name: "wagering_duplicates_total",
    help: "Duplicatas detectadas",
    labelNames: ["source"] as const,
    registers: [this.registry],
  });

  readonly retries = new Counter({
    name: "wagering_retries_total",
    help: "Novas tentativas",
    labelNames: ["reason"] as const,
    registers: [this.registry],
  });

  readonly lockConflicts = new Counter({
    name: "wagering_lock_conflicts_total",
    help: "Conflitos de lock otimista",
    registers: [this.registry],
  });

  readonly retentionDeleted = new Counter({
    name: "wagering_retention_deleted_total",
    help: "Linhas apagadas pela retenção",
    labelNames: ["table"] as const,
    registers: [this.registry],
  });

  readonly reconciliationDivergences = new Counter({
    name: "wagering_reconciliation_divergences_total",
    help: "Reconciliações com saldo divergente do ledger",
    registers: [this.registry],
  });

  readonly processingDuration = new Histogram({
    name: "wagering_processing_duration_seconds",
    help: "Latência de processamento",
    labelNames: ["entry"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [this.registry],
  });

  constructor(em: EntityManager, sqs: SQSClient) {
    new Gauge({
      name: "wagering_outbox_lag_seconds",
      help: "Idade do evento mais antigo ainda não publicado",
      registers: [this.registry],
      async collect() {
        await ignoreFailure(async () => {
          const oldest = await em
            .fork()
            .findOne(OutboxMessageRecord, { publishedAt: null }, { orderBy: { occurredAt: "asc" } });
          this.set(oldest ? (Date.now() - oldest.occurredAt.getTime()) / 1000 : 0);
        });
      },
    });

    new Gauge({
      name: "wagering_dlq_messages",
      help: "Mensagens na DLQ",
      registers: [this.registry],
      async collect() {
        await ignoreFailure(async () => {
          const url = await getQueueUrl(sqs, process.env.WAGER_TRANSACTIONS_DLQ!);
          const { Attributes } = await sqs.send(
            new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ["ApproximateNumberOfMessages"] }),
          );
          this.set(Number(Attributes?.ApproximateNumberOfMessages ?? 0));
        });
      },
    });
  }
}

async function ignoreFailure(probe: () => Promise<void>): Promise<void> {
  try {
    await probe();
  } catch {
  }
}
