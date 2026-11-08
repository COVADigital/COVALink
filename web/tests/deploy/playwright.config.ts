import { defineConfig, devices } from "@playwright/test";

/**
 * Browser part of the deployment smoke. Run through `npm run test:deploy`
 * (tests/deploy/smoke.mjs), which starts the production Compose stack and
 * passes SMOKE_BASE_URL, SMOKE_SETUP_TOKEN and SMOKE_STATE_FILE.
 */
export default defineConfig({
  testDir: ".",
  testMatch: "smoke.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "../../test-results/playwright-deploy",
  use: {
    baseURL: process.env.SMOKE_BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "edge",
      use: {
        ...devices["Desktop Edge"],
        channel: process.env.PW_CHANNEL ?? "msedge",
        ...(process.env.PW_DISABLE_GPU === "1" ? { launchOptions: { args: ["--disable-gpu"] } } : {}),
      },
    },
  ],
});
