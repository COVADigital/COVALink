import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { testSql } from "../support/db";

/**
 * Migration 0003 against representative state from before media uploads, using the real SQL.
 * Each case runs in a scratch schema inside a transaction that is always
 * rolled back, with `media_assets` as created by 0000 (including its old
 * index). The migration's foreign key points at the real `public.users`.
 */
const migrationUrl = new URL("../../src/db/migrations/0003_media_uploads.sql", import.meta.url);
const ROLLBACK = new Error("rollback");

async function statements() {
  return (await readFile(migrationUrl, "utf8"))
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Runs `fn` with an older `media_assets` in a scratch schema first on the search path; always rolls back. */
async function withPreM5Schema(fn: (tx: import("postgres").TransactionSql) => Promise<void>) {
  await testSql()
    .begin(async (tx) => {
      await tx.unsafe(`create schema media_migration_test`);
      await tx.unsafe(`set local search_path to media_migration_test, public`);
      await tx.unsafe(`
        create table media_migration_test.media_assets (
          id uuid primary key default gen_random_uuid(),
          owner_id text not null,
          storage_key text not null unique,
          mime_type text not null,
          size_bytes integer not null,
          width integer,
          height integer,
          original_name text,
          created_at timestamptz not null default now()
        )`);
      await tx.unsafe(`create index media_assets_owner_id_idx on media_migration_test.media_assets using btree (owner_id)`);
      await fn(tx);
      throw ROLLBACK;
    })
    .catch((err) => {
      if (err !== ROLLBACK) throw err;
    });
}

describe("media migration 0003", () => {
  it("upgrades an empty media_assets table: kind, required dimensions, constraints and the new index", async () => {
    const sqls = await statements();
    await withPreM5Schema(async (tx) => {
      for (const s of sqls) await tx.unsafe(s);
      const cols = await tx<{ column_name: string; is_nullable: string }[]>`
        select column_name, is_nullable from information_schema.columns
        where table_schema = 'media_migration_test' and table_name = 'media_assets' order by column_name`;
      expect(Object.fromEntries(cols.map((c) => [c.column_name, c.is_nullable]))).toMatchObject({ kind: "NO", width: "NO", height: "NO" });
      const idx = await tx`select indexname from pg_indexes where schemaname = 'media_migration_test' and tablename = 'media_assets' order by 1`;
      expect(idx.map((r) => r.indexname)).toEqual(["media_assets_owner_kind_created_idx", "media_assets_pkey", "media_assets_storage_key_key"]);
      // Constraints are enforced (each insert in its own savepoint).
      const insert = (values: string) =>
        tx.savepoint((sp) => sp.unsafe(`insert into media_migration_test.media_assets (owner_id, kind, storage_key, mime_type, size_bytes, width, height) values (${values})`));
      const key = "'0f8fad5b-d9cb-469f-a165-70867728950e.webp'";
      await expect(insert(`'u', 'avatar', ${key}, 'image/webp', 10, 512, 512`)).resolves.toBeDefined();
      for (const bad of [
        `'u', 'icon', '7c9e6679-7425-40de-944b-e07fc1f90ae7.webp', 'image/webp', 10, 1, 1`,
        `'u', 'avatar', '7c9e6679-7425-40de-944b-e07fc1f90ae7.webp', 'image/png', 10, 1, 1`,
        `'u', 'avatar', '7c9e6679-7425-40de-944b-e07fc1f90ae7.webp', 'image/webp', 10, 513, 1`,
        `'u', 'background', '7c9e6679-7425-40de-944b-e07fc1f90ae7.webp', 'image/webp', 0, 1, 1`,
        `'u', 'avatar', '7c9e6679-7425-40de-944b-e07fc1f90ae7xwebp', 'image/webp', 10, 1, 1`,
        `'u', 'avatar', '../7c9e6679-7425-40de-944b-e07fc1f90ae7.webp', 'image/webp', 10, 1, 1`,
      ]) {
        await expect(insert(bad), bad).rejects.toMatchObject({ code: "23514" });
      }
    });
  });

  it("refuses to run when pre-existing media rows exist, with a clear message and no partial change", async () => {
    const sqls = await statements();
    await withPreM5Schema(async (tx) => {
      await tx.unsafe(`insert into media_migration_test.media_assets (owner_id, storage_key, mime_type, size_bytes, width, height)
        values ('legacy', 'avatars/legacy.png', 'image/png', 1234, null, null)`);
      const err = await tx
        .savepoint(async (sp) => {
          for (const s of sqls) await sp.unsafe(s);
        })
        .catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("media_assets contains 1 pre-existing row(s) that this migration cannot classify");
      expect((err as Error).message).toContain("No changes were made");
      // Rolled back to before the migration: no kind column, old index kept, the row untouched.
      const cols = await tx`select column_name from information_schema.columns where table_schema = 'media_migration_test' and table_name = 'media_assets'`;
      expect(cols.map((c) => c.column_name)).not.toContain("kind");
      const idx = await tx`select indexname from pg_indexes where schemaname = 'media_migration_test' and indexname = 'media_assets_owner_id_idx'`;
      expect(idx).toHaveLength(1);
      expect(await tx`select storage_key from media_migration_test.media_assets`).toEqual([{ storage_key: "avatars/legacy.png" }]);
    });
  });
});
