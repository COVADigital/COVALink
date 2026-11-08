// Container health probe (no curl in the image). Usage:
//   node scripts/healthcheck.mjs          liveness:  GET /api/health
//   node scripts/healthcheck.mjs ready    readiness: GET /api/ready
// Exits 0 only for HTTP 200 within the deadline; prints nothing on success
// and only the status or error code otherwise (never response bodies).
import http from "node:http";

const TIMEOUT_MS = 4000;
const target = process.argv[2] === "ready" ? "/api/ready" : "/api/health";
const port = Number(process.env.PORT || 3000);

const fail = (reason) => {
  console.error(`[healthcheck] ${target} ${reason}`);
  process.exit(1);
};
// Hard stop even if the socket never settles.
setTimeout(() => fail("timed out"), TIMEOUT_MS + 500).unref();

const req = http.get({ host: "127.0.0.1", port, path: target, timeout: TIMEOUT_MS }, (res) => {
  res.resume();
  if (res.statusCode === 200) process.exit(0);
  fail(`returned ${res.statusCode}`);
});
req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
req.on("error", (err) => fail(`failed (${err.code ?? err.name})`));
