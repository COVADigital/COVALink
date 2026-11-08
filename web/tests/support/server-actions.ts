/**
 * Calls a Server Action over HTTP the way a forged request would: the action
 * id is read from the client chunks the page loads, and the call is posted
 * directly (E2E suites only).
 */
let ip = 1;
const nextIp = () => `198.18.95.${ip++ % 250}`;

export async function actionId(base: string, page: string, name: string, cookie?: string): Promise<string> {
  const html = await (await fetch(`${base}${page}`, { headers: { "x-forwarded-for": nextIp(), ...(cookie ? { cookie } : {}) } })).text();
  for (const src of new Set([...html.matchAll(/src="(\/_next\/static\/[^"]+\.js)"/g)].map((m) => m[1]))) {
    const js = await (await fetch(`${base}${src}`)).text();
    const m = new RegExp(String.raw`createServerReference\)?\(\s*"([0-9a-f]{40,})"[^()]*?"` + name + `"`).exec(js);
    if (m) return m[1];
  }
  throw new Error(`no action id for ${name} on ${page}`);
}

export async function callAction(base: string, page: string, id: string, args: unknown[], cookie?: string) {
  const res = await fetch(`${base}${page}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "next-action": id,
      "content-type": "text/plain;charset=UTF-8",
      accept: "text/x-component",
      origin: base,
      "x-forwarded-for": nextIp(),
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  const result = /\{"ok":(?:true|false)[^\n]*\}/.exec(text)?.[0];
  const setCookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .filter((c) => !c.endsWith("="))
    .join("; ");
  return { status: res.status, result: result ? (JSON.parse(result) as Record<string, unknown>) : null, cookie: setCookie };
}

/** Deletes the signed-in account through the account page's confirmed Server Action. */
export async function deleteAccountOverHttp(base: string, cookie: string, password: string) {
  const id = await actionId(base, "/dashboard/account", "deleteAccountAction", cookie);
  return callAction(base, "/dashboard/account", id, [{ password, confirmation: "delete my account" }], cookie);
}
