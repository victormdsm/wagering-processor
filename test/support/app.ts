import type { INestApplication } from "@nestjs/common";
import { Test, type TestingModuleBuilder } from "@nestjs/testing";
import type { Subprocess } from "bun";
import { AppModule } from "../../src/app.module";
import { GlobalExceptionFilter } from "../../src/shared/infrastructure/http/global-exception.filter";
import { TEST_ENV } from "./env";
import { setupInfra } from "./infra";

export interface RunningApp {
  url: string;
  app: INestApplication;
  close(): Promise<void>;
}

export async function startApp(override?: (builder: TestingModuleBuilder) => TestingModuleBuilder): Promise<RunningApp> {
  await setupInfra();
  const builder = Test.createTestingModule({ imports: [AppModule] });
  const moduleRef = await (override ? override(builder) : builder).compile();
  const app = moduleRef.createNestApplication({ logger: process.env.TEST_LOGS ? undefined : false });
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.enableShutdownHooks();
  await app.listen(0, "127.0.0.1");
  const { port } = app.getHttpServer().address();
  return { url: `http://127.0.0.1:${port}`, app, close: () => app.close() };
}

export interface Instance {
  url: string;
  process: Subprocess;
  kill(): Promise<void>;
  stop(): Promise<void>;
  logs(): string;
}

export async function spawnInstance(
  port: number,
  extraEnv: Record<string, string> = {},
  options: { captureLogs?: boolean } = {},
): Promise<Instance> {
  await setupInfra();
  const output = options.captureLogs ? "pipe" : process.env.TEST_LOGS ? "inherit" : "ignore";
  const child = Bun.spawn(["bun", "src/main.ts"], {
    env: { ...process.env, ...TEST_ENV, ...extraEnv, PORT: String(port) },
    stdout: output,
    stderr: output,
  });
  const captured: string[] = [];
  if (options.captureLogs) {
    for (const stream of [child.stdout, child.stderr] as ReadableStream<Uint8Array>[]) {
      void (async () => {
        const decoder = new TextDecoder();
        for await (const chunk of stream) captured.push(decoder.decode(chunk));
      })();
    }
  }
  const url = `http://127.0.0.1:${port}`;
  await waitFor(async () => (await fetch(`${url}/health/ready`).catch(() => null))?.status === 200, 30_000);
  return {
    url,
    process: child,
    kill: async () => {
      child.kill("SIGKILL");
      await child.exited;
    },
    stop: async () => {
      child.kill("SIGTERM");
      await child.exited;
    },
    logs: () => captured.join(""),
  };
}

export async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 20_000, intervalMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(intervalMs);
  }
  throw new Error(`condição não atendida em ${timeoutMs} ms`);
}
