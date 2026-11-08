import { defineConfig, devices } from "@playwright/test";

/**
 * Browser workflow suite. Run through `npm run test:browser`, which starts the
 * production server on the guarded E2E database (scripts/run-e2e.mjs).
 * Uses the locally installed Microsoft Edge (`channel: "msedge"`) so no
 * Playwright browser download is needed; override with PW_CHANNEL (e.g. "chrome").
 */
const browser = {
  ...devices["Desktop Edge"],
  channel: process.env.PW_CHANNEL ?? "msedge",
  // Opt-in workaround (PW_DISABLE_GPU=1): on some Windows hosts, while the
  // display is idle, GPU vsync stalls requestAnimationFrame to about one
  // frame every 2–3 s, which stalls React's Suspense reveal and
  // Playwright's stability checks. Software rendering keeps ~60 fps.
  // See docs/DEVELOPMENT.md.
  ...(process.env.PW_DISABLE_GPU === "1" ? { launchOptions: { args: ["--disable-gpu"] } } : {}),
};

// The setup workflow needs the freshly reset database, before any other spec
// completes setup, so it runs first as its own project.
const SETUP_SPEC = /setup-and-sign-in\.spec\.ts$/;

export default defineConfig({
  testDir: "tests/browser",
  globalSetup: "./tests/browser/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "test-results/playwright",
  use: {
    baseURL: process.env.E2E_BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "setup", testMatch: SETUP_SPEC, use: browser },
    { name: "edge", testIgnore: SETUP_SPEC, dependencies: ["setup"], use: browser },
  ],
});
