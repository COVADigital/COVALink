/** Same-origin requests only: the Origin must be the app's, and Fetch Metadata (when sent) must agree. */
export function isSameOrigin(request: Request, appOrigin: string): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return false;
  return request.headers.get("origin") === appOrigin;
}
