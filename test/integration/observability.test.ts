import { afterAll, beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { Metrics } from "../../src/shared/infrastructure/observability/metrics";
import config from "../../src/shared/infrastructure/persistence/mikro-orm.config";
import { request } from "../support/api";
import { startApp, type RunningApp } from "../support/app";
import { setupInfra, sqsConfig } from "../support/infra";

setDefaultTimeout(60_000);

class SwitchableSqs extends SQSClient {
  static down = false;
  override send(command: any, options?: any): any {
    if (SwitchableSqs.down) return Promise.reject(new Error("ECONNREFUSED"));
    return super.send(command, options);
  }
}

let api: RunningApp;

beforeAll(async () => {
  api = await startApp((b) => b.overrideProvider(SQSClient).useFactory({ factory: () => new SwitchableSqs(sqsConfig) }));
});

afterAll(async () => {
  SwitchableSqs.down = false;
  await api.close();
});

describe("health checks (sem autenticação)", () => {
  test("live e ready com dependências de pé", async () => {
    expect(await request(api.url, "GET", "/health/live")).toEqual({ status: 200, body: { status: "ok" } });
    expect(await request(api.url, "GET", "/health/ready")).toEqual({
      status: 200,
      body: { status: "ok", postgres: "up", sqs: "up" },
    });
  });

  test("ready → 503 com o SQS fora; live continua 200", async () => {
    SwitchableSqs.down = true;
    try {
      const ready = await request(api.url, "GET", "/health/ready");
      expect(ready).toEqual({ status: 503, body: { status: "unavailable", postgres: "up", sqs: "down" } });
      expect((await request(api.url, "GET", "/health/live")).status).toBe(200);
    } finally {
      SwitchableSqs.down = false;
    }
  });
});

describe("métricas", () => {
  test("expõe as métricas mínimas da seção 12", async () => {
    const text = await (await fetch(`${api.url}/metrics`)).text();
    for (const name of [
      "wagering_transactions_total",
      "wagering_duplicates_total",
      "wagering_retries_total",
      "wagering_dlq_messages",
      "wagering_lock_conflicts_total",
      "wagering_outbox_lag_seconds",
      "wagering_processing_duration_seconds",
    ]) {
      expect(text).toContain(`# TYPE ${name}`);
    }
  });

  test("Bug 11: /metrics continua respondendo com o SQS fora do ar", async () => {
    SwitchableSqs.down = true;
    try {
      const res = await fetch(`${api.url}/metrics`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("wagering_outbox_lag_seconds");
    } finally {
      SwitchableSqs.down = false;
    }
  });

  test("Bug 11: o registry não rejeita quando uma dependência falha", async () => {
    await setupInfra();
    const orm = await MikroORM.init(config);
    try {
      const deadSqs = new SQSClient({ region: "us-east-1", endpoint: "http://127.0.0.1:1", maxAttempts: 1 });
      const metrics = new Metrics(orm.em, deadSqs);
      expect(await metrics.registry.metrics()).toContain("wagering_dlq_messages");
    } finally {
      await orm.close();
    }
  });
});
