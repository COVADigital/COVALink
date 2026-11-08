import { describe, expect, it } from "vitest";
import { databaseUrlSecrets, describeError } from "../../scripts/error-summary.mjs";

const URL_WITH_SECRET = "postgresql://covalink:p%40ss-w0rd-SECRET@db.internal:5432/covalink";

describe("bounded migration error logging", () => {
  it("scrubs the connection string, both password encodings and any other URL", () => {
    const secrets = databaseUrlSecrets(URL_WITH_SECRET);
    const err = Object.assign(new Error(`connect failed for ${URL_WITH_SECRET} (password p@ss-w0rd-SECRET, raw p%40ss-w0rd-SECRET) see https://example.com/x`), { code: "ECONNREFUSED" });
    const line = describeError(err, secrets);
    expect(line.startsWith("ECONNREFUSED: ")).toBe(true);
    expect(line).not.toMatch(/SECRET|p@ss|p%40ss|db\.internal|postgresql:|https:/);
    expect(line).toContain("[redacted]");
  });

  it("truncates long messages, flattens whitespace and reports causes by code only", () => {
    const err = Object.assign(new Error(`Failed query: ${"x".repeat(5000)}\nparams: secret-value`), { cause: { code: "42P07", message: "relation exists: secret-value" } });
    const line = describeError(err);
    expect(line.length).toBeLessThan(400);
    expect(line).not.toContain("\n");
    expect(line).toMatch(/ \(cause 42P07\)$/);
    expect(line).not.toContain("relation exists");
  });

  it("never trusts an unusual code as output", () => {
    expect(describeError(Object.assign(new Error("boom"), { code: "postgresql://u:p@h/db" }))).toBe("Error: boom");
    expect(describeError("plain string")).toBe("Error: plain string");
    expect(describeError(undefined)).toBe("Error: undefined");
  });

  it("keeps an unparseable URL whole as a secret", () => {
    expect(databaseUrlSecrets("not a url")).toEqual(["not a url"]);
    expect(databaseUrlSecrets(undefined)).toEqual([]);
  });
});
