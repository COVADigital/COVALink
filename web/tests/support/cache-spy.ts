/**
 * Records public-cache invalidations made by services during integration
 * tests (they run outside a Next.js request, where revalidateTag can't run).
 * Installed by integration-setup.ts.
 */
declare global {
  var __invalidatedTags: string[] | undefined;
}

export function invalidatedTags(): string[] {
  return globalThis.__invalidatedTags ?? [];
}

export function clearInvalidatedTags(): void {
  globalThis.__invalidatedTags = [];
}

export function recordInvalidation(tags: string[]): void {
  (globalThis.__invalidatedTags ??= []).push(...tags);
}
