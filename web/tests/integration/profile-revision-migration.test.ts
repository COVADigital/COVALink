import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { testSql } from "../support/db";

const migrationUrl = new URL("../../src/db/migrations/0002_profile_revisions.sql", import.meta.url);

describe("profile revision migration", () => {
  it("upgrades representative older profile rows using the real migration", async () => {
    const migration = await readFile(migrationUrl, "utf8");
    const statements = migration
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(Boolean);

    await testSql().begin(async (tx) => {
      await tx.unsafe(`
        create temporary table profiles (
          id text primary key,
          published jsonb,
          is_published boolean not null,
          draft_updated_at timestamptz not null,
          published_at timestamptz
        ) on commit drop
      `);
      await tx.unsafe(`
        insert into profiles (id, published, is_published, draft_updated_at, published_at) values
          ('never', null, false, '2026-01-01T00:00:00Z', null),
          ('live', '{}'::jsonb, true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
          ('offline', '{}'::jsonb, false, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
          ('changed', '{}'::jsonb, true, '2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z'),
          ('inconsistent', null, true, '2026-01-01T00:00:00Z', null)
      `);

      for (const statement of statements) await tx.unsafe(statement);

      const rows = await tx<{
        id: string;
        draft_revision: number;
        published_revision: number | null;
        is_published: boolean;
      }[]>`select id, draft_revision, published_revision, is_published from profiles order by id`;
      expect(rows).toEqual([
        { id: "changed", draft_revision: 1, published_revision: 0, is_published: true },
        { id: "inconsistent", draft_revision: 0, published_revision: null, is_published: false },
        { id: "live", draft_revision: 0, published_revision: 0, is_published: true },
        { id: "never", draft_revision: 0, published_revision: null, is_published: false },
        { id: "offline", draft_revision: 0, published_revision: 0, is_published: false },
      ]);
    });
  });
});
