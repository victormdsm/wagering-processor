import { GetQueueUrlCommand, SQSClient } from "@aws-sdk/client-sqs";
import { EntityManager } from "@mikro-orm/postgresql";
import { Controller, Get, Header, HttpStatus, Res } from "@nestjs/common";
import type { Response } from "express";
import { Metrics } from "./metrics";

@Controller()
export class ObservabilityController {
  constructor(
    private readonly em: EntityManager,
    private readonly sqs: SQSClient,
    private readonly metrics: Metrics,
  ) {}

  @Get("health/live")
  live() {
    return { status: "ok" };
  }

  @Get("health/ready")
  async ready(@Res({ passthrough: true }) res: Response) {
    const [postgres, sqs] = await Promise.all([
      check(() => this.em.fork().getConnection().execute("select 1")),
      check(() => this.sqs.send(new GetQueueUrlCommand({ QueueName: process.env.WAGER_TRANSACTIONS_QUEUE! }))),
    ]);
    const ok = postgres && sqs;
    res.status(ok ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ok ? "ok" : "unavailable", postgres: postgres ? "up" : "down", sqs: sqs ? "up" : "down" };
  }

  @Get("metrics")
  @Header("Content-Type", "text/plain; version=0.0.4")
  scrape() {
    return this.metrics.registry.metrics();
  }
}

async function check(probe: () => Promise<unknown>): Promise<boolean> {
  try {
    await probe();
    return true;
  } catch {
    return false;
  }
}
