import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { DomainError } from "../../../shared/domain/domain-error";
import { InboxMessage } from "../../../shared/infrastructure/inbox/inbox-message";
import { InboxRepository } from "../../../shared/infrastructure/inbox/inbox.repository";
import { describeError } from "../../../shared/infrastructure/observability/log-safe-error";
import { Metrics } from "../../../shared/infrastructure/observability/metrics";
import { TransactionRunner } from "../../../shared/infrastructure/persistence/transaction-runner";
import { getQueueUrl } from "../../../shared/infrastructure/sqs/sqs.config";
import { hashWagerPayload, type WagerPayload } from "../../application/payload-hash";
import { assertWagerPayload } from "../../application/payload-validation";
import { ProcessWagerTransactionUseCase } from "../../application/process-wager-transaction.use-case";

interface WagerTransactionRequestedMessage {
  messageId: string;
  type: "WagerTransactionRequested";
  occurredAt: string;
  data: WagerPayload & { idempotencyKey: string };
}

class InvalidMessageError extends Error {}

const CONSUMER_NAME = "wager-transactions";
const MAX_BACKOFF_SECONDS = 300;
const WAIT_TIME_SECONDS = Number(process.env.SQS_WAIT_TIME_SECONDS ?? 20);

@Injectable()
export class WagerTransactionsConsumer implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(WagerTransactionsConsumer.name);
  private stopping = false;
  private loop?: Promise<void>;
  private queueUrl!: string;

  constructor(
    private readonly sqs: SQSClient,
    private readonly runner: TransactionRunner,
    private readonly inbox: InboxRepository,
    private readonly processWagerTransaction: ProcessWagerTransactionUseCase,
    private readonly metrics: Metrics,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.queueUrl = await getQueueUrl(this.sqs, process.env.WAGER_TRANSACTIONS_QUEUE!);
    this.loop = this.poll();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    await this.loop;
  }

  private async poll(): Promise<void> {
    while (!this.stopping) {
      let messages: Message[] = [];
      try {
        const response = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: this.queueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: WAIT_TIME_SECONDS,
            MessageSystemAttributeNames: ["ApproximateReceiveCount"],
          }),
        );
        messages = response.Messages ?? [];
      } catch (error) {
        if (this.stopping) break;
        this.logger.error("falha ao receber mensagens", describeError(error));
        await sleep(1_000);
        continue;
      }

      for (const message of messages) {
        if (this.stopping) {
          await this.changeVisibility(message, 0);
          continue;
        }
        await this.handle(message);
      }
    }
  }

  private async handle(message: Message): Promise<void> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
    try {
      const body = parse(message.Body);
      const logContext = {
        correlationId: body.data.idempotencyKey,
        messageId: body.messageId,
        walletId: body.data.walletId,
        providerId: body.data.providerId,
      };
      const stopTimer = this.metrics.processingDuration.startTimer({ entry: "sqs" });

      const output = await this.runner.run(async () => {
        if (await this.inbox.exists(CONSUMER_NAME, body.messageId)) return null;

        const now = new Date();
        const inboxMessage = InboxMessage.receive({
          messageId: body.messageId,
          consumerName: CONSUMER_NAME,
          payloadHash: hashWagerPayload(body.data),
          receivedAt: now,
        });
        inboxMessage.markProcessed(now);
        await this.inbox.add(inboxMessage);

        return this.processWagerTransaction.execute({ ...body.data, causationId: body.messageId });
      });
      stopTimer();

      await this.delete(message);

      if (!output) {
        this.metrics.duplicates.inc({ source: "inbox" });
        this.logger.log("mensagem duplicada ignorada", logContext);
        return;
      }
      if (output.idempotentReplay) this.metrics.duplicates.inc({ source: "replay" });
      this.metrics.transactions.inc({ status: output.status, entry: "sqs" });
      this.logger.log("transação processada", { ...logContext, transactionId: output.transactionId, status: output.status });
    } catch (error) {
      const messageId = message.MessageId;
      if (error instanceof DomainError) {
        this.logger.warn("mensagem rejeitada por regra de negócio", { messageId, code: error.code });
        await this.delete(message);
      } else if (error instanceof InvalidMessageError) {
        this.logger.error("mensagem inválida", { messageId, reason: error.message });
        await this.changeVisibility(message, 0);
      } else {
        this.logger.error("falha transitória", { messageId, receiveCount, ...describeError(error) });
        this.metrics.retries.inc({ reason: "sqs_transient" });
        await this.changeVisibility(message, Math.min(2 ** receiveCount, MAX_BACKOFF_SECONDS));
      }
    }
  }

  private async delete(message: Message): Promise<void> {
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: message.ReceiptHandle }));
  }

  private async changeVisibility(message: Message, seconds: number): Promise<void> {
    await this.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }
}

function parse(raw: string | undefined): WagerTransactionRequestedMessage {
  let body: WagerTransactionRequestedMessage;
  try {
    body = JSON.parse(raw ?? "");
  } catch {
    throw new InvalidMessageError("corpo não é JSON");
  }
  if (body?.type !== "WagerTransactionRequested" || !body.messageId || !body.data?.idempotencyKey) {
    throw new InvalidMessageError("formato WagerTransactionRequested inválido");
  }
  try {
    assertWagerPayload(body.data);
  } catch (error) {
    if (error instanceof DomainError) throw new InvalidMessageError(error.code);
    throw error;
  }
  return body;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
