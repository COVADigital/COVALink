// Tests for workflow.mjs against local Git repositories and a fake GitHub API.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { run } from '../workflow.mjs';
import { baseTree, git, id, minimalRulesDir, tempDir, write } from './helpers.mjs';

const OWNER = 'COVADigital';
const CONTEXT = 'covalink/private-boundary';
const REPO = 'example/project';

/** An origin repository with master and pull-request refs, and a trusted clone of it. */
function setup() {
  const work = tempDir('boundary-work-');
  git(work, 'init', '--quiet');
  write(work, baseTree());
  git(work, 'add', '-A');
  git(work, 'commit', '--quiet', '-m', 'base');
  const base = git(work, 'rev-parse', 'HEAD');
  const origin = tempDir('boundary-origin-');
  git(origin, 'init', '--bare', '--quiet');
  git(work, 'push', '--quiet', origin, 'HEAD:refs/heads/master');
  return { work, origin, base };
}

/** Commits files on a branch from `from`, publishes it as refs/pull/<n>/head, and returns its SHA. */
function pullRequest(ctx, n, files, from = ctx.base, { force = false } = {}) {
  git(ctx.work, 'checkout', '--quiet', '-B', `pr-${n}`, from);
  write(ctx.work, files);
  git(ctx.work, 'add', '-A', ...(force ? ['--force'] : []));
  git(ctx.work, 'commit', '--quiet', '-m', `pr ${n}`);
  const sha = git(ctx.work, 'rev-parse', 'HEAD');
  git(ctx.work, 'push', '--quiet', '--force', ctx.origin, `HEAD:refs/pull/${n}/head`);
  return sha;
}

function fakeApi(map) {
  return async (path) => {
    const key = path.split('?')[0];
    if (!(key in map)) throw new Error(`unexpected API call ${key}`);
    const value = map[key];
    if (value instanceof Error) throw value;
    return value;
  };
}

const status = (state, login, context = CONTEXT) => ({ context, state, creator: { login } });
const prEnv = (n, head) => ({ EVENT: 'pull_request_target', REPOSITORY: REPO, PR_NUMBER: String(n), HEAD_SHA: head });

async function check(ctx, env, api, extra = {}) {
  return run({ env, api: fakeApi(api), remote: () => ctx.origin, trusted: ctx.trusted ?? ctx.work, rulesDir: ctx.rulesDir, ...extra });
}

function context() {
  const ctx = setup();
  ctx.rulesDir = minimalRulesDir();
  return ctx;
}

test('pull request: a clean change outside the boundary passes without an approval', async () => {
  const ctx = context();
  const head = pullRequest(ctx, 1, { 'src/app.js': 'export const answer = 43;\n' });
  const result = await check(ctx, prEnv(1, head), { [`/repos/${REPO}/pulls/1/files`]: [{ filename: 'src/app.js' }] });
  assert.equal(result.ok, true, result.lines.join('\n'));
});

test('pull request: a head that moved during the check fails', async () => {
  const ctx = context();
  const first = pullRequest(ctx, 2, { 'src/app.js': 'export const answer = 1;\n' });
  pullRequest(ctx, 2, { 'src/app.js': 'export const answer = 2;\n' }, first);
  const result = await check(ctx, prEnv(2, first), { [`/repos/${REPO}/pulls/2/files`]: [{ filename: 'src/app.js' }] });
  assert.equal(result.ok, false);
  assert.match(result.lines.join('\n'), /head moved/);
});

test('pull request: private material in the proposed tree fails, even when force-added past .gitignore', async () => {
  const ctx = context();
  const head = pullRequest(ctx, 3, { [['AGENTS', 'md'].join('.')]: 'notes\n' }, ctx.base, { force: true });
  const result = await check(ctx, prEnv(3, head), { [`/repos/${REPO}/pulls/3/files`]: [{ filename: 'src/app.js' }] });
  assert.equal(result.ok, false);
  assert.ok(result.lines.includes(`FAIL ${id(5)} ${['AGENTS', 'md'].join('.')}:0`), result.lines.join(' | '));
});

test('pull request: a boundary change needs the newest matching status, created by the owner', async () => {
  const ctx = context();
  const head = pullRequest(ctx, 4, { 'README.md': '# Example\n\nMore.\n' });
  const files = { [`/repos/${REPO}/pulls/4/files`]: [{ filename: 'README.md' }] };
  const statuses = `/repos/${REPO}/commits/${head}/statuses`;
  const cases = [
    { name: 'no status', list: [], ok: false },
    { name: 'newest success by the owner', list: [status('success', OWNER), status('failure', OWNER)], ok: true },
    { name: 'newest is a failure, older success', list: [status('failure', OWNER), status('success', OWNER)], ok: false },
    { name: 'newest success by someone else', list: [status('success', 'someone-else'), status('success', OWNER)], ok: false },
    { name: 'success in another context only', list: [status('success', OWNER, 'ci/other')], ok: false },
    { name: 'malformed entries', list: [null, { context: CONTEXT }], ok: false },
  ];
  for (const c of cases) {
    const result = await check(ctx, prEnv(4, head), { ...files, [statuses]: c.list });
    assert.equal(result.ok, c.ok, `${c.name}: ${result.lines.join(' | ')}`);
  }
});

test('pull request: a boundary file renamed away still counts as a boundary change', async () => {
  const ctx = context();
  const head = pullRequest(ctx, 5, { 'src/other.js': 'x\n' });
  const result = await check(ctx, prEnv(5, head), {
    [`/repos/${REPO}/pulls/5/files`]: [{ filename: 'src/other.js', previous_filename: '.boundary/rules.json' }],
    [`/repos/${REPO}/commits/${head}/statuses`]: [],
  });
  assert.equal(result.ok, false);
});

/** Merges pull request `n` into master as a squash commit with the head's exact tree, and pushes it. */
function mergeAsSquash(ctx, head, treeFrom = head) {
  git(ctx.work, 'checkout', '--quiet', '-B', 'master', ctx.base);
  const tree = git(ctx.work, 'rev-parse', `${treeFrom}^{tree}`);
  const commit = git(ctx.work, 'commit-tree', tree, '-p', ctx.base, '-m', 'merge');
  git(ctx.work, 'push', '--quiet', ctx.origin, `${commit}:refs/heads/master`);
  ctx.trusted = tempDir('boundary-trusted-');
  git(ctx.trusted, 'clone', '--quiet', ctx.origin, '.');
  return commit;
}

const pushEnv = (ctx, after) => ({ EVENT: 'push', REPOSITORY: REPO, BEFORE_SHA: ctx.base, AFTER_SHA: after });

test('push: a boundary commit whose tree equals an approved pull-request head passes', async () => {
  const ctx = context();
  const head = pullRequest(ctx, 6, { 'README.md': '# Example\n\nChanged.\n' });
  const commit = mergeAsSquash(ctx, head);
  const result = await check(ctx, pushEnv(ctx, commit), {
    [`/repos/${REPO}/commits/${commit}/pulls`]: [{ number: 6, merged_at: '2026-01-01T00:00:00Z', head: { sha: head } }],
    [`/repos/${REPO}/commits/${head}/statuses`]: [status('success', OWNER)],
  });
  assert.equal(result.ok, true, result.lines.join('\n'));
});

test('push: a boundary commit whose tree differs from the approved head fails', async () => {
  const ctx = context();
  const head = pullRequest(ctx, 7, { 'README.md': '# Example\n\nApproved.\n' });
  const other = pullRequest(ctx, 8, { 'README.md': '# Example\n\nSomething else.\n' });
  const commit = mergeAsSquash(ctx, head, other);
  const result = await check(ctx, pushEnv(ctx, commit), {
    [`/repos/${REPO}/commits/${commit}/pulls`]: [{ number: 7, merged_at: '2026-01-01T00:00:00Z', head: { sha: head } }],
    [`/repos/${REPO}/commits/${head}/statuses`]: [status('success', OWNER)],
  });
  assert.equal(result.ok, false);
  assert.match(result.lines.join('\n'), /matches no approved pull-request head/);
});

test('push: a matching tree whose approval status came from another account fails, as does a commit with no pull request', async () => {
  const ctx = context();
  const head = pullRequest(ctx, 9, { 'README.md': '# Example\n\nUnapproved.\n' });
  const commit = mergeAsSquash(ctx, head);
  const unapproved = await check(ctx, pushEnv(ctx, commit), {
    [`/repos/${REPO}/commits/${commit}/pulls`]: [{ number: 9, merged_at: '2026-01-01T00:00:00Z', head: { sha: head } }],
    [`/repos/${REPO}/commits/${head}/statuses`]: [status('success', 'someone-else')],
  });
  assert.equal(unapproved.ok, false);
  const orphan = await check(ctx, pushEnv(ctx, commit), { [`/repos/${REPO}/commits/${commit}/pulls`]: [] });
  assert.equal(orphan.ok, false);
});

test('missing or malformed inputs and API failures fail closed', async () => {
  const ctx = context();
  const head = pullRequest(ctx, 10, { 'src/app.js': 'export const answer = 44;\n' });
  const files = { [`/repos/${REPO}/pulls/10/files`]: [{ filename: 'src/app.js' }] };
  const cases = [
    { name: 'no event', env: { REPOSITORY: REPO }, api: files },
    { name: 'unknown event', env: { ...prEnv(10, head), EVENT: 'pull_request' }, api: files },
    { name: 'no repository', env: { ...prEnv(10, head), REPOSITORY: '' }, api: files },
    { name: 'malformed head', env: { ...prEnv(10, head), HEAD_SHA: 'not-a-sha' }, api: files },
    { name: 'malformed number', env: { ...prEnv(10, head), PR_NUMBER: '10; rm -rf /' }, api: files },
    { name: 'file list is not a list', env: prEnv(10, head), api: { [`/repos/${REPO}/pulls/10/files`]: { message: 'Not Found' } } },
    { name: 'file entry without a name', env: prEnv(10, head), api: { [`/repos/${REPO}/pulls/10/files`]: [{}] } },
    { name: 'API error', env: prEnv(10, head), api: { [`/repos/${REPO}/pulls/10/files`]: new Error('GitHub API 500') } },
    { name: 'unknown pull request ref', env: prEnv(11, head), api: files },
    { name: 'push without SHAs', env: { EVENT: 'push', REPOSITORY: REPO }, api: {} },
  ];
  for (const c of cases) {
    const result = await check(ctx, c.env, c.api);
    assert.equal(result.ok, false, `${c.name}: ${result.lines.join(' | ')}`);
  }
  const noApproval = minimalRulesDir();
  const rulesPath = join(noApproval, 'rules.json');
  const { readFileSync, writeFileSync } = await import('node:fs');
  const raw = JSON.parse(readFileSync(rulesPath, 'utf8'));
  delete raw.approval;
  writeFileSync(rulesPath, JSON.stringify(raw));
  const result = await check({ ...ctx, rulesDir: noApproval }, prEnv(10, head), files);
  assert.equal(result.ok, false, 'rules without an approval identity');
});
