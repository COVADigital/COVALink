/**
 * Runs once when a server starts, before it handles requests (Next.js
 * `register`). The Node.js production server validates its configuration and
 * prepares for graceful shutdown first; see `instrumentation-node.ts`.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startProductionServer } = await import("./instrumentation-node");
    startProductionServer();
  }
}
