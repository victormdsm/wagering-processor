const runId = process.env.TEST_RUN_ID ?? Date.now().toString(36);

export const TEST_ENV: Record<string, string> = {
  TEST_RUN_ID: runId,
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://wagering:wagering@localhost:5433/wagering_test",
  AWS_REGION: "us-east-1",
  AWS_ACCESS_KEY_ID: "test",
  AWS_SECRET_ACCESS_KEY: "test",
  SQS_ENDPOINT: process.env.TEST_SQS_ENDPOINT ?? "http://localhost:4566",
  WAGER_TRANSACTIONS_QUEUE: `test-${runId}-wager-transactions.fifo`,
  WAGER_TRANSACTIONS_DLQ: `test-${runId}-wager-transactions-dlq.fifo`,
  WAGERING_EVENTS_QUEUE: `test-${runId}-wagering-events.fifo`,
  SQS_WAIT_TIME_SECONDS: "1",
};

Object.assign(process.env, TEST_ENV);
