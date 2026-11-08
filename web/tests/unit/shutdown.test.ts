import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { closeKeepAliveConnectionsOnShutdown } from "@/lib/server/shutdown";

closeKeepAliveConnectionsOnShutdown();

const servers: http.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.closeAllConnections();
});

function start(handler: http.RequestListener) {
  const server = http.createServer(handler);
  servers.push(server);
  return new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

function get(port: number, agent: http.Agent) {
  return new Promise<{ status: number; connection: string | undefined; body: string }>((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: "/", agent }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode!, connection: res.headers.connection, body }));
      })
      .on("error", reject);
  });
}

describe("keep-alive connections on shutdown", () => {
  it("is idempotent", () => {
    const patched = http.Server.prototype.close;
    closeKeepAliveConnectionsOnShutdown();
    expect(http.Server.prototype.close).toBe(patched);
  });

  it("finishes in-flight requests, then closes even a continuously busy keep-alive connection", async () => {
    let release: () => void = () => {};
    const slow = new Promise<void>((r) => (release = r));
    let slowStarted: () => void = () => {};
    const slowSeen = new Promise<void>((r) => (slowStarted = r));
    const port = await start(async (req, res) => {
      if (req.url === "/slow") {
        slowStarted();
        await slow;
      }
      res.end("ok");
    });
    const server = servers[0];
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const other = new http.Agent({ keepAlive: true, maxSockets: 1 });

    expect((await get(port, agent)).connection).toBe("keep-alive");
    // An in-flight request on another connection when shutdown begins.
    const inFlight = new Promise<string>((resolve, reject) =>
      http.get({ host: "127.0.0.1", port, path: "/slow", agent: other }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve(body));
      }).on("error", reject),
    );
    await slowSeen;

    const closed = new Promise<number>((resolve) => {
      const t0 = Date.now();
      server.close(() => resolve(Date.now() - t0));
    });
    // A busy keep-alive client gets its in-flight answer with Connection: close.
    const afterClose = await get(port, agent).catch((e: NodeJS.ErrnoException) => e.code);
    if (typeof afterClose === "object") expect(afterClose.connection).toBe("close");
    // A further attempt can't be served: the listener is closed and the connection is gone.
    await expect(get(port, agent)).rejects.toMatchObject({ code: expect.stringMatching(/ECONNREFUSED|ECONNRESET/) });

    release();
    expect(await inFlight).toBe("ok");
    expect(await closed).toBeLessThan(2000);
    agent.destroy();
    other.destroy();
  });

  it("closes idle keep-alive connections promptly", async () => {
    const port = await start((_req, res) => res.end("ok"));
    const agent = new http.Agent({ keepAlive: true });
    await get(port, agent);
    const t0 = Date.now();
    await new Promise<void>((resolve) => servers[0].close(() => resolve()));
    expect(Date.now() - t0).toBeLessThan(1000);
    agent.destroy();
  });
});
