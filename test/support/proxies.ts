import net from "node:net";
import { TEST_ENV } from "./env";

export interface SqsProxy {
  url: string;
  hold: Set<string>;
  held: string[];
  down(): void;
  up(): void;
  stop(): void;
}

export function startSqsProxy(): SqsProxy {
  const upstream = new URL(TEST_ENV.SQS_ENDPOINT);
  const hold = new Set<string>();
  const held: string[] = [];
  const serve = (port: number) =>
    Bun.serve({
      hostname: "127.0.0.1",
      port,
      idleTimeout: 0,
      async fetch(request) {
        const action = (request.headers.get("x-amz-target") ?? "").replace("AmazonSQS.", "");
        if (hold.has(action)) {
          held.push(action);
          return new Promise<Response>(() => undefined);
        }
        const target = new URL(request.url);
        target.protocol = upstream.protocol;
        target.host = upstream.host;
        const headers = new Headers(request.headers);
        headers.delete("host");
        const response = await fetch(target, { method: request.method, headers, body: await request.arrayBuffer() });
        const out = new Headers(response.headers);
        out.delete("content-encoding");
        out.delete("content-length");
        return new Response(await response.arrayBuffer(), { status: response.status, headers: out });
      },
    });
  let server = serve(0);
  const port = server.port!;
  return {
    url: `http://127.0.0.1:${port}`,
    hold,
    held,
    down: () => server.stop(true),
    up: () => {
      server = serve(port);
    },
    stop: () => server.stop(true),
  };
}

export interface PgProxy {
  url: string;
  down(): Promise<void>;
  up(): Promise<void>;
  stop(): Promise<void>;
}

export async function startPgProxy(): Promise<PgProxy> {
  const upstream = new URL(TEST_ENV.DATABASE_URL);
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const db = net.connect(Number(upstream.port), upstream.hostname);
    const close = () => {
      client.destroy();
      db.destroy();
      sockets.delete(client);
      sockets.delete(db);
    };
    sockets.add(client);
    sockets.add(db);
    client.pipe(db);
    db.pipe(client);
    for (const socket of [client, db]) {
      socket.on("close", close);
      socket.on("error", close);
    }
  });
  const listen = (port: number) => new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  await listen(0);
  const port = (server.address() as net.AddressInfo).port;
  const url = new URL(TEST_ENV.DATABASE_URL);
  url.hostname = "127.0.0.1";
  url.port = String(port);
  return {
    url: url.toString(),
    down: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      });
    },
    up: () => listen(port),
    stop: async () => {
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
