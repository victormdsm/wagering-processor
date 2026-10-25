import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { DeleteMessageCommand, ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import { spawnInstance } from "../support/app";
import { queueUrl, sqs } from "../support/infra";
import { sendRaw } from "../support/sqs";

setDefaultTimeout(60_000);

describe("consumer SQS — SIGTERM", () => {
  test("Bug 13: SIGTERM durante o long polling não deixa um receive 'fantasma' pegar a próxima mensagem", async () => {
    const instance = await spawnInstance(3301, { SQS_WAIT_TIME_SECONDS: "20" });
    await Bun.sleep(500);
    await instance.stop();

    const marker = `depois-do-sigterm-${crypto.randomUUID()}`;
    await sendRaw(marker, "shutdown");
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl("main"),
        WaitTimeSeconds: 2,
        MaxNumberOfMessages: 10,
        MessageSystemAttributeNames: ["ApproximateReceiveCount"],
      }),
    );
    const message = Messages.find((m) => m.Body === marker);
    expect(message).toBeDefined();
    expect(message!.Attributes?.ApproximateReceiveCount).toBe("1");
    for (const m of Messages) await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl("main"), ReceiptHandle: m.ReceiptHandle }));
  });
});
