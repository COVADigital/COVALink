import { describe, expect, it } from "vitest";
import { mailRefused } from "@/lib/mail";

describe("mailRefused", () => {
  it("counts only failures where the server certainly didn't take the message", () => {
    const err = (fields: object) => Object.assign(new Error("x"), fields);
    for (const e of [err({ responseCode: 550 }), err({ responseCode: 452, code: "EMESSAGE" }), err({ code: "EAUTH" }), err({ code: "EDNS" }), err({ code: "EENVELOPE" })]) {
      expect(mailRefused(e), JSON.stringify(e)).toBe(true);
    }
    // After DATA a timeout or dropped connection is ambiguous; a 2xx/3xx code isn't a refusal; junk isn't either.
    for (const e of [err({ code: "ETIMEDOUT" }), err({ code: "ESOCKET" }), err({ code: "ECONNECTION" }), err({ responseCode: 250 }), err({}), null, "550"]) {
      expect(mailRefused(e), JSON.stringify(e)).toBe(false);
    }
  });
});
