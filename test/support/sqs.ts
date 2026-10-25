import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
} from "@aws-sdk/client-sqs";
import { keyOf, type wagerPayload } from "./api";
import { queueUrl, sqs } from "./infra";

export function wagerMessage(payload: ReturnType<typeof wagerPayload>, messageId = `msg-${crypto.randomUUID()}`) {
  return {
    messageId,
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data: { ...payload, idempotencyKey: keyOf(payload) },
  };
}

export async function sendRaw(body: string, groupId: string, deduplicationId: string = crypto.randomUUID()): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl("main"),
      MessageBody: body,
      MessageGroupId: groupId,
      MessageDeduplicationId: deduplicationId,
    }),
  );
}

export function sendWager(message: ReturnType<typeof wagerMessage>, deduplicationId?: string): Promise<void> {
  return sendRaw(JSON.stringify(message), message.data.walletId, deduplicationId);
}

export async function queueDepth(name: "main" | "dlq" | "events"): Promise<number> {
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl(name),
      AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
    }),
  );
  return Number(Attributes?.ApproximateNumberOfMessages ?? 0) + Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
}

export async function drain(name: "dlq" | "events", idleRounds = 2): Promise<Message[]> {
  const all: Message[] = [];
  let idle = 0;
  while (idle < idleRounds) {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl(name), MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }),
    );
    if (Messages.length === 0) {
      idle++;
      continue;
    }
    idle = 0;
    for (const message of Messages) {
      all.push(message);
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl(name), ReceiptHandle: message.ReceiptHandle }));
    }
  }
  return all;
}
