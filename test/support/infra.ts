import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { SQL } from "bun";
import config from "../../src/shared/infrastructure/persistence/mikro-orm.config";
import { TEST_ENV } from "./env";

export const TEST_VISIBILITY_TIMEOUT_SECONDS = 2;
export const TEST_MAX_RECEIVE_COUNT = 4;

export const sqsConfig = { region: TEST_ENV.AWS_REGION, endpoint: TEST_ENV.SQS_ENDPOINT };
export const sqs = new SQSClient(sqsConfig);

let ready: Promise<void> | undefined;
let sqlClient: SQL | undefined;
const queueUrls: Record<string, string> = {};

export function setupInfra(): Promise<void> {
  ready ??= (async () => {
    await recreateDatabase(TEST_ENV.DATABASE_URL);
    await migrateUp(TEST_ENV.DATABASE_URL);
    await createQueues();
  })();
  return ready;
}

export async function teardownInfra(): Promise<void> {
  await sqlClient?.close();
  for (const url of Object.values(queueUrls)) {
    await sqs.send(new DeleteQueueCommand({ QueueUrl: url })).catch(() => undefined);
  }
}

export function db(): SQL {
  sqlClient ??= new SQL(TEST_ENV.DATABASE_URL);
  return sqlClient;
}

export function queueUrl(name: "main" | "dlq" | "events"): string {
  return queueUrls[name];
}

export async function recreateDatabase(url: string): Promise<void> {
  const target = new URL(url);
  const name = target.pathname.slice(1);
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const sql = new SQL(admin.toString());
  await sql.unsafe(`drop database if exists "${name}" with (force)`);
  await sql.unsafe(`create database "${name}"`);
  await sql.close();
}

export async function migrateUp(url: string): Promise<void> {
  const orm = await MikroORM.init({ ...config, clientUrl: url });
  await orm.migrator.up();
  await orm.close();
}

async function createQueues(): Promise<void> {
  const dlq = await sqs.send(
    new CreateQueueCommand({ QueueName: TEST_ENV.WAGER_TRANSACTIONS_DLQ, Attributes: { FifoQueue: "true" } }),
  );
  queueUrls.dlq = dlq.QueueUrl!;
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: queueUrls.dlq, AttributeNames: ["QueueArn"] }),
  );
  const main = await sqs.send(
    new CreateQueueCommand({
      QueueName: TEST_ENV.WAGER_TRANSACTIONS_QUEUE,
      Attributes: {
        FifoQueue: "true",
        VisibilityTimeout: String(TEST_VISIBILITY_TIMEOUT_SECONDS),
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: Attributes!.QueueArn,
          maxReceiveCount: String(TEST_MAX_RECEIVE_COUNT),
        }),
      },
    }),
  );
  queueUrls.main = main.QueueUrl!;
  const events = await sqs.send(
    new CreateQueueCommand({ QueueName: TEST_ENV.WAGERING_EVENTS_QUEUE, Attributes: { FifoQueue: "true" } }),
  );
  queueUrls.events = events.QueueUrl!;
}
