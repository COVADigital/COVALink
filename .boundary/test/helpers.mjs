// Shared helpers for the boundary tests. Sample values that the rules would
// match are assembled at run time, so these files pass the check themselves.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileRules } from '../check.mjs';

export const BOUNDARY = join(dirname(fileURLToPath(import.meta.url)), '..');
export const id = (n) => `P-${n}`;
export const email = (local, domain) => [local, domain].join('@');

const read = (name) => JSON.parse(readFileSync(join(BOUNDARY, name), 'utf8'));

/** The real rule files, with parts replaced. */
export function rawRules(overrides = {}) {
  return {
    ...read('rules.json'),
    manifest: read('manifest.json'),
    exceptions: read('exceptions.json'),
    approvedLinks: read('approved-links.json'),
    ...overrides,
  };
}

export const rules = (overrides) => compileRules(rawRules(overrides));

export function tempDir(prefix = 'boundary-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function write(root, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

export function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=Test', '-c', `user.email=${email('test', 'example.com')}`, '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=master', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A minimal rules folder for workflow tests: one manifest document and no exceptions. */
export function minimalRulesDir() {
  const dir = tempDir('boundary-rules-');
  const base = read('rules.json');
  writeFileSync(join(dir, 'rules.json'), JSON.stringify({ ...base, exemptions: [] }));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ files: ['README.md'], globs: [], mirrors: [] }));
  writeFileSync(join(dir, 'exceptions.json'), '[]');
  writeFileSync(join(dir, 'approved-links.json'), JSON.stringify({ prefixes: ['https://docs.github.com/'] }));
  return dir;
}

/** Files every tree in the workflow tests needs to pass the check. */
export function baseTree() {
  return {
    'README.md': '# Example\n',
    '.gitignore': `${read('rules.json').gitignoreRequired.join('\n')}\n`,
    'src/app.js': 'export const answer = 42;\n',
  };
}
