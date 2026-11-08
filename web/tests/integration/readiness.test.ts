import net from "node:net";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { pgClient } from "@/db";
import { probeDatabase } from "@/lib/health/db-probe";

describe("probeDatabase against real connections", () => {
  const clients: postgres.Sql[] = [];
  const servers: net.Server[] = [];
  afterAll(async () => {
    await Promise.all(clients.map((c) => c.end({ timeout: 1 })));
    servers.forEach((s) => s.close());
  });

  it("reports ok for the reachable test database", async () => {
    await expect(probeDatabase(pgClient)).resolves.toBe("ok");
  });

  it("reports unavailable when nothing listens on the port", async () => {
    const dead = postgres("postgres://probe:secret@127.0.0.1:1/none", { max: 1, connect_timeout: 2 });
    clients.push(dead);
    await expect(probeDatabase(dead, 3000)).resolves.toBe("unavailable");
  });

  it("reports timeout within the bound when the server never answers", async () => {
    const silent = net.createServer(() => {}); // accepts connections, never speaks
    servers.push(silent);
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
    const port = (silent.address() as net.AddressInfo).port;
    const hung = postgres(`postgres://probe:secret@127.0.0.1:${port}/none`, { max: 1, connect_timeout: 30 });
    clients.push(hung);
    const started = performance.now();
    await expect(probeDatabase(hung, 500)).resolves.toBe("timeout");
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
