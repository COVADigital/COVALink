import { describe, expect, it } from "vitest";
import { handleSchema, isReservedHandle, normalizeHandle } from "@/features/profiles/handle";

describe("normalizeHandle", () => {
  it("lowercases, trims, strips a leading @ and accents", () => {
    expect(normalizeHandle("  @Zoë_Smith ")).toBe("zoe_smith");
  });
  it("turns whitespace into hyphens and drops disallowed characters", () => {
    expect(normalizeHandle("My Cool!! Page")).toBe("my-cool-page");
    expect(normalizeHandle("a/../b")).toBe("ab");
  });
});

describe("handleSchema", () => {
  const parse = (v: string) => handleSchema.safeParse(v);

  it("accepts and normalizes valid handles", () => {
    expect(parse("@JoeyB").data).toBe("joeyb");
    expect(parse("a1").success).toBe(true);
    expect(parse("x".repeat(30)).success).toBe(true);
  });

  it("enforces length limits after normalization", () => {
    expect(parse("a").success).toBe(false);
    expect(parse("x".repeat(31)).success).toBe(false);
    expect(parse("@@!!").success).toBe(false);
  });

  it("requires a letter or digit first", () => {
    expect(parse("-abc").success).toBe(false);
    expect(parse("_abc").success).toBe(false);
  });

  it("rejects every reserved application route", () => {
    for (const reserved of ["login", "register", "dashboard", "admin", "api", "setup"]) {
      expect(isReservedHandle(reserved)).toBe(true);
      expect(parse(reserved).success).toBe(false);
    }
    expect(parse("Dashboard").success).toBe(false);
    expect(parse("@ADMIN").success).toBe(false);
  });
});
