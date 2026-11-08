import { describe, expect, it, vi } from "vitest";
import { readinessResponse, runProbe } from "@/lib/health/readiness";

describe("runProbe", () => {
  it("reports ok when the probe resolves", async () => {
    await expect(runProbe(async () => 1)).resolves.toBe("ok");
  });

  it("reports unavailable (never throws) when the probe rejects", async () => {
    await expect(runProbe(async () => Promise.reject(new Error("ECONNREFUSED")))).resolves.toBe("unavailable");
  });

  it("reports timeout within the deadline and invokes onTimeout", async () => {
    const onTimeout = vi.fn();
    const started = performance.now();
    const outcome = await runProbe(() => new Promise(() => {}), { timeoutMs: 100, onTimeout });
    const elapsed = performance.now() - started;
    expect(outcome).toBe("timeout");
    expect(onTimeout).toHaveBeenCalledOnce();
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(1000);
  });
});

describe("readinessResponse", () => {
  it("returns 200 with a fixed body when database and storage are ready", async () => {
    const res = readinessResponse({ database: "ok", storage: "ok" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(await res.json()).toEqual({ status: "ready", checks: { database: "ok", storage: "ok" } });
  });

  it.each(["unavailable", "timeout"] as const)("returns 503 for a database %s, reported separately from storage", async (outcome) => {
    const res = readinessResponse({ database: outcome, storage: "ok" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "not_ready", checks: { database: outcome, storage: "ok" } });
  });

  it.each(["unavailable", "timeout"] as const)("returns 503 for a storage %s, reported separately from the database", async (outcome) => {
    const res = readinessResponse({ database: "ok", storage: outcome });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "not_ready", checks: { database: "ok", storage: outcome } });
  });

  it("never echoes probe error details such as connection strings", async () => {
    const secret = "postgres://covalink:s3cr3t-password@db.internal:5432/covalink";
    const outcome = await runProbe(async () => {
      throw new Error(`connect failed: ${secret}\n    at Socket.stack (node:net:1)`);
    });
    const text = await readinessResponse({ database: outcome, storage: outcome }).text();
    expect(text).not.toContain("s3cr3t");
    expect(text).not.toContain("postgres://");
    expect(text).not.toContain("db.internal");
    expect(text).not.toContain("at Socket");
    expect(Object.keys(JSON.parse(text))).toEqual(["status", "checks"]);
  });
});
