import { expect, test as base } from "@playwright/test";

/** Every browser test fails if a page logs a CSP violation or an uncaught error. */
export const test = base.extend<{ guard: void }>({
  guard: [
    async ({ page }, use) => {
      const problems: string[] = [];
      page.on("console", (m) => {
        if (m.type() === "error" && /Content Security Policy|Refused to/i.test(m.text())) problems.push(m.text());
      });
      page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
      await use();
      expect(problems, "CSP violations or page errors").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
