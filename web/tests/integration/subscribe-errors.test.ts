import { describe, expect, it, vi } from "vitest";

// The database is down for these lookups.
vi.mock("@/features/audience/service", async (importOriginal) => {
  const down = async () => {
    throw new Error("connection refused");
  };
  return { ...(await importOriginal<typeof import("@/features/audience/service")>()), confirmSignup: down, removeSignup: down, previewSignup: down };
});

import { handleSubscribeToken } from "@/features/audience/subscribe";
import { TEST_APP_URL } from "../support/test-env";

const post = (path: string, body: object) =>
  new Request(`${TEST_APP_URL}${path}`, {
    method: "POST",
    headers: { origin: TEST_APP_URL, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("subscribe links while the database fails", () => {
  it("answer 503, which the page offers to retry, not 410, which it treats as final", async () => {
    const token = "A".repeat(43);
    expect((await handleSubscribeToken(post("/api/subscribe/confirm", { token, preview: true }), "confirm")).status).toBe(503);
    expect((await handleSubscribeToken(post("/api/subscribe/confirm", { token }), "confirm")).status).toBe(503);
    expect((await handleSubscribeToken(post("/api/subscribe/remove", { token }), "remove")).status).toBe(503);
  });
});
