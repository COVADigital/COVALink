// Test-only SMTP sink for the E2E runner. It speaks just enough SMTP for
// nodemailer (EHLO/HELO, MAIL, RCPT, DATA, RSET, NOOP, QUIT; no STARTTLS, no
// AUTH), keeps every accepted message in memory, and exposes a small HTTP
// control API on loopback:
//   GET    /messages  -> [{ from, to: [...], raw, text }]   (text = decoded body)
//   DELETE /messages  -> clears the list
//   PUT    /mode      -> { delayMs?: number, fail?: boolean } for later deliveries
// A delay holds the reply to DATA; `fail` answers 550, as a rejecting relay would.
import http from "node:http";
import net from "node:net";

/** Decodes quoted-printable soft breaks/escapes and base64 MIME parts, enough to read links. */
export function decodeMessage(raw) {
  const parts = [raw];
  for (const m of raw.matchAll(/Content-Transfer-Encoding:\s*base64\r?\n(?:[^\r\n]+\r?\n)*\r?\n([A-Za-z0-9+/=\r\n]+)/gi)) {
    parts.push(Buffer.from(m[1].replace(/\s+/g, ""), "base64").toString("utf8"));
  }
  return parts
    .join("\n")
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

export async function startSmtpSink({ host = "127.0.0.1" } = {}) {
  const messages = [];
  let mode = { delayMs: 0, fail: false };

  const smtp = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    let inData = false;
    let data = [];
    let envelope = { from: "", to: [] };
    const reply = (line) => socket.writable && socket.write(`${line}\r\n`);
    reply("220 covalink-e2e-sink ESMTP");
    socket.on("error", () => {});
    socket.on("data", async (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            const raw = data.join("\r\n");
            data = [];
            const { delayMs, fail } = mode;
            const accepted = { from: envelope.from, to: envelope.to, raw, text: decodeMessage(raw) };
            envelope = { from: "", to: [] };
            if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
            if (fail) reply("550 5.7.1 Message rejected by the E2E sink");
            else {
              messages.push(accepted);
              reply("250 2.0.0 Queued");
            }
          } else data.push(line.startsWith("..") ? line.slice(1) : line);
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === "EHLO") reply("250-covalink-e2e-sink\r\n250-8BITMIME\r\n250 SMTPUTF8");
        else if (verb === "HELO") reply("250 covalink-e2e-sink");
        else if (verb === "MAIL") {
          envelope.from = /<([^>]*)>/.exec(line)?.[1] ?? "";
          reply("250 2.1.0 OK");
        } else if (verb === "RCPT") {
          envelope.to.push(/<([^>]*)>/.exec(line)?.[1] ?? "");
          reply("250 2.1.5 OK");
        } else if (verb === "DATA") {
          inData = true;
          reply("354 End data with <CR><LF>.<CR><LF>");
        } else if (verb === "RSET") {
          envelope = { from: "", to: [] };
          reply("250 OK");
        } else if (verb === "NOOP") reply("250 OK");
        else if (verb === "QUIT") {
          reply("221 Bye");
          socket.end();
        } else reply("502 5.5.2 Command not implemented");
      }
    });
  });
  await new Promise((r) => smtp.listen(0, host, r));

  const control = http.createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/messages" && req.method === "GET") return send(200, messages);
    if (req.url === "/messages" && req.method === "DELETE") {
      messages.length = 0;
      return send(200, { ok: true });
    }
    if (req.url === "/mode" && req.method === "PUT") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const next = JSON.parse(body || "{}");
          mode = { delayMs: Number(next.delayMs) || 0, fail: next.fail === true };
          send(200, mode);
        } catch {
          send(400, { error: "bad json" });
        }
      });
      return;
    }
    send(404, { error: "not found" });
  });
  await new Promise((r) => control.listen(0, "127.0.0.1", r));

  return {
    smtpPort: smtp.address().port,
    controlUrl: `http://127.0.0.1:${control.address().port}`,
    close() {
      smtp.close();
      control.close();
    },
  };
}
