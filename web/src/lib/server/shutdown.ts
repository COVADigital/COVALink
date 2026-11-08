import http from "node:http";

const PATCHED = Symbol.for("covalink.closeKeepAliveOnShutdown");
export const IDLE_SWEEP_MS = 100;

/**
 * Next's standalone server answers SIGTERM with `server.close()`, which stops
 * new connections but keeps serving a keep-alive connection for as long as
 * its client keeps it busy (measured: a keep-alive client was still
 * served 3 s after SIGTERM, and the process exited only after that connection
 * went idle). Behind a reverse proxy that pools connections, shutdown could
 * last until the SIGKILL at the end of the grace period and cut whatever was
 * in flight.
 *
 * Once a server is closing, every further response asks its client to close
 * the connection (`Connection: close`) and idle connections are closed every
 * 100 ms, so shutdown ends as soon as the in-flight requests finish. Requests
 * already in flight are never interrupted.
 */
export function closeKeepAliveConnectionsOnShutdown(): void {
  const proto = http.Server.prototype as http.Server & { [PATCHED]?: true };
  if (proto[PATCHED]) return;
  proto[PATCHED] = true;
  const close = proto.close;
  proto.close = function (this: http.Server, ...args: Parameters<http.Server["close"]>) {
    this.prependListener("request", (_req: http.IncomingMessage, res: http.ServerResponse) => {
      if (!res.headersSent) res.setHeader("connection", "close");
    });
    const sweep = setInterval(() => this.closeIdleConnections(), IDLE_SWEEP_MS);
    sweep.unref();
    this.once("close", () => clearInterval(sweep));
    return close.apply(this, args);
  };
}
