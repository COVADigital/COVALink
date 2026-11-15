import { expect } from "vitest";
import { testSql } from "./db";

/**
 * Asserts that a save kept an unfinished draft and changed nothing else: the
 * valid draft and the published snapshot are exactly what they were in
 * `before` (a row read as text before the save), and the unfinished part sits
 * beside the valid draft, where no public reader looks. Returns it.
 */
export async function expectKeptUnfinished(profileId: string, before: Record<string, unknown>, label?: string) {
  const [after] = await testSql()`select draft, published::text as published from profiles where id = ${profileId}`;
  const { incomplete, ...valid } = after.draft as Record<string, unknown>;
  const validBefore = JSON.parse(before.draft as string) as Record<string, unknown>;
  delete validBefore.incomplete; // an earlier unfinished draft, when one save follows another
  expect(incomplete, label).toBeDefined();
  expect(valid, label).toEqual(validBefore);
  expect(after.published, label).toBe(before.published);
  return incomplete as { header: unknown; seo: unknown; blocks?: { id: string; config: Record<string, unknown> }[]; theme?: unknown; issues: unknown };
}
