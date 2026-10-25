import { GetQueueUrlCommand, SQSClient } from "@aws-sdk/client-sqs";

export function createSqsClient(): SQSClient {
  return new SQSClient({
    region: process.env.AWS_REGION,
    endpoint: process.env.SQS_ENDPOINT,
  });
}

export async function getQueueUrl(client: SQSClient, queueName: string): Promise<string> {
  const { QueueUrl } = await client.send(new GetQueueUrlCommand({ QueueName: queueName }));
  if (!QueueUrl) throw new Error(`fila ${queueName} não encontrada`);
  return QueueUrl;
}
