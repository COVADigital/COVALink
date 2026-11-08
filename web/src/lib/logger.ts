import "server-only";
import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "covalink" },
  redact: {
    paths: ["password", "*.password", "token", "*.token", "headers.cookie", "headers.authorization"],
    censor: "[redacted]",
  },
});
