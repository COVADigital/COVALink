// Tests for workflow.mjs against local Git repositories and a fake GitHub API.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { MAX_RULE_DATA_BYTES, RULE_DATA_FILES, loadProposedRuleData, run } from '../workflow.mjs';
import { BOUNDARY, baseTree, email, git, id, minimalRulesDir, tempDir, write } from './helpers.mjs';

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

/**
 * Commits files on a branch from `from`, publishes it as refs/pull/<n>/head, and returns its SHA.
 * `entries` adds raw index entries ({ mode, path, content }) for symlinks and modes the work tree can't express.
 */
function pullRequest(ctx, n, files, from = ctx.base, { force = false, entries = [] } = {}) {
  git(ctx.work, 'checkout', '--quiet', '-B', `pr-${n}`, from);
  write(ctx.work, files);
  git(ctx.work, 'add', '-A', ...(force ? ['--force'] : []));
  for (const e of entries) {
    const blob = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: ctx.work, input: e.content, encoding: 'utf8' }).stdout.trim();
    git(ctx.work, 'update-index', '--add', '--cacheinfo', `${e.mode},${blob},${e.path}`);
  }
  git(ctx.work, 'commit', '--quiet', '-m', `pr ${n}`);
  const sha = git(ctx.work, 'rev-parse', 'HEAD');
  git(ctx.work, 'reset', '--quiet', '--hard');
  git(ctx.work, 'push', '--quiet', '--force', ctx.origin, `HEAD:refs/pull/${n}/head`);
  return sha;
}

/** A fake API. A function value is called on every request, so a test can change answers between calls. */
function fakeApi(map) {
  return async (path) => {
    const key = path.split('?')[0];
    if (!(key in map)) throw new Error(`unexpected API call ${key}`);
    const value = typeof map[key] === 'function' ? map[key]() : map[key];
    if (value instanceof Error) throw value;
    return value;
  };
}

const status = (state, login, context = CONTEXT) => ({ context, state, creator: { login } });
const prEnv = (n, head) => ({ EVENT: 'pull_request_target', REPOSITORY: REPO, PR_NUMBER: String(n), HEAD_SHA: head });

/** The pull request's head and base, as GitHub reports them. */
const prInfo = (ctx, n, head, over = {}) => ({
  head: { sha: over.headSha ?? head, ref: over.headRef ?? `pr-${n}`, repo: { full_name: over.headRepo ?? REPO } },
  base: { sha: over.baseSha ?? ctx.base, ref: over.baseRef ?? 'master', repo: { full_name: over.baseRepo ?? REPO } },
});

/** Answers in turn, repeating the last one. */
const sequence = (...answers) => { let i = 0; return () => answers[Math.min(i++, answers.length - 1)]; };

/** The API for pull request n: its head and base, its changed files, and the statuses on `head`. */
function prApi(ctx, n, head, files, statuses = [], extra = {}) {
  return {
    [`/repos/${REPO}/pulls/${n}`]: prInfo(ctx, n, head),
    [`/repos/${REPO}/pulls/${n}/files`]: files.map((filename) => ({ filename })),
    [`/repos/${REPO}/commits/${head}/statuses`]: statuses,
    ...extra,
  };
}

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
  const result = await check(ctx, prEnv(1, head), prApi(ctx, 1, head, ['src/app.js']));
  assert.equal(result.ok, true, result.lines.join('\n'));
});

test('pull request: a head that moved during the check fails', async () => {
  const ctx = context();
  const first = pullRequest(ctx, 2, { 'src/app.js': 'export const answer = 1;\n' });
  const second = pullRequest(ctx, 2, { 'src/app.js': 'export const answer = 2;\n' }, first);
  // GitHub already reports the new head.
  const reported = await check(ctx, prEnv(2, first), { ...prApi(ctx, 2, first, ['src/app.js']), [`/repos/${REPO}/pulls/2`]: prInfo(ctx, 2, second) });
  assert.equal(reported.ok, false);
  assert.match(reported.lines.join('\n'), /head moved/);
  // GitHub still reports the old head, but the ref has moved.
  const fetched = await check(ctx, prEnv(2, first), prApi(ctx, 2, first, ['src/app.js']));
  assert.equal(fetched.ok, false);
  assert.match(fetched.lines.join('\n'), /head moved/);
});

test('pull request: private material in the proposed tree fails, even when force-added past .gitignore', async () => {
  const ctx = context();
  const head = pullRequest(ctx, 3, { [['AGENTS', 'md'].join('.')]: 'notes\n' }, ctx.base, { force: true });
  const result = await check(ctx, prEnv(3, head), prApi(ctx, 3, head, ['src/app.js']));
  assert.equal(result.ok, false);
  assert.ok(result.lines.includes(`FAIL ${id(5)} ${['AGENTS', 'md'].join('.')}:0`), result.lines.join(' | '));
});

test('pull request: a boundary change needs the newest matching status, created by the owner', async () => {
  const ctx = context();
  const head = pullRequest(ctx, 4, { 'README.md': '# Example\n\nMore.\n' });
  const cases = [
    { name: 'no status', list: [], ok: false },
    { name: 'newest success by the owner', list: [status('success', OWNER), status('failure', OWNER)], ok: true },
    { name: 'newest is a failure, older success', list: [status('failure', OWNER), status('success', OWNER)], ok: false },
    { name: 'newest success by someone else', list: [status('success', 'someone-else'), status('success', OWNER)], ok: false },
    { name: 'success in another context only', list: [status('success', OWNER, 'ci/other')], ok: false },
    { name: 'malformed entries', list: [null, { context: CONTEXT }], ok: false },
  ];
  for (const c of cases) {
    const result = await check(ctx, prEnv(4, head), prApi(ctx, 4, head, ['README.md'], c.list));
    assert.equal(result.ok, c.ok, `${c.name}: ${result.lines.join(' | ')}`);
  }
});

test('pull request: a boundary file renamed away still counts as a boundary change', async () => {
  const ctx = context();
  const head = pullRequest(ctx, 5, { 'src/other.js': 'x\n' });
  const result = await check(ctx, prEnv(5, head), {
    ...prApi(ctx, 5, head, []),
    [`/repos/${REPO}/pulls/5/files`]: [{ filename: 'src/other.js', previous_filename: '.boundary/rules.json' }],
  });
  assert.equal(result.ok, false);
});

// ---- Proposed rule data

const ADDRESS = email('dev', ['mail', 'corp'].join('.'));

/** The four rule-data files of the minimal rules, as a pull request would propose them. */
function ruleData(ctx, { exceptions = [], rules: rulesOver = {} } = {}) {
  const read = (name) => JSON.parse(readFileSync(join(ctx.rulesDir, name), 'utf8'));
  return {
    '.boundary/rules.json': JSON.stringify({ ...read('rules.json'), ...rulesOver }, null, 2),
    '.boundary/manifest.json': JSON.stringify(read('manifest.json'), null, 2),
    '.boundary/exceptions.json': JSON.stringify(exceptions, null, 2),
    '.boundary/approved-links.json': JSON.stringify(read('approved-links.json'), null, 2),
  };
}

/** A pull request adding a file the base rules reject, with proposed rule data that excuses it. */
function excusingPullRequest(ctx, n, extraFiles = {}, options = {}) {
  const files = {
    'src/contact.js': `export const contact = '${ADDRESS}';\n`,
    ...ruleData(ctx, { exceptions: [{ path: 'src/contact.js', check: id(9), token: ADDRESS, reason: 'test fixture' }] }),
    ...extraFiles,
  };
  const head = pullRequest(ctx, n, files, ctx.base, options);
  return { head, changed: Object.keys(files).concat(options.entries?.map((e) => e.path) ?? []) };
}

// Check labels, assembled at run time so this file passes the check itself.
const LABEL = `${['V', '21'].join('')} public check:`;
const APPROVAL = `${id(11)}:`;
const usedProposed = (result) => result.lines.some((l) => l.startsWith('Checking with the approved rule data'));
const baseFinding = `FAIL ${id(9)} src/contact.js:1`;

test('rule data: an unapproved boundary-data change cannot select its proposed rules', async () => {
  const ctx = context();
  const { head, changed } = excusingPullRequest(ctx, 20);
  const result = await check(ctx, prEnv(20, head), prApi(ctx, 20, head, changed, []));
  assert.equal(result.ok, false);
  assert.equal(usedProposed(result), false);
  assert.ok(result.lines.includes(baseFinding), result.lines.join(' | '));
  assert.ok(result.lines.some((l) => l.startsWith(APPROVAL)));
});

test('rule data: an exact-head approved change is checked with its proposed rules', async () => {
  const ctx = context();
  const { head, changed } = excusingPullRequest(ctx, 21);
  const result = await check(ctx, prEnv(21, head), prApi(ctx, 21, head, changed, [status('success', OWNER)]));
  assert.equal(result.ok, true, result.lines.join(' | '));
  assert.equal(usedProposed(result), true);
  assert.ok(!result.lines.includes(baseFinding));
});

test('rule data: stale, foreign, wrong-context and wrong-source statuses cannot select proposed rules', async () => {
  const ctx = context();
  const { head: stale } = excusingPullRequest(ctx, 22);
  const { head, changed } = excusingPullRequest(ctx, 22, { 'src/app.js': 'export const answer = 45;\n' });
  const cases = [
    { name: 'approval only on an earlier head', api: { [`/repos/${REPO}/commits/${stale}/statuses`]: [status('success', OWNER)] }, list: [] },
    { name: 'approval on another repository', api: { [`/repos/other/project/commits/${head}/statuses`]: [status('success', OWNER)] }, list: [] },
    { name: 'created by another account', list: [status('success', 'someone-else')] },
    { name: 'created by an automation account', list: [status('success', 'github-actions[bot]')] },
    { name: 'owner success in another context', list: [status('success', OWNER, 'ci/other')] },
    { name: 'newest owner status is a failure', list: [status('failure', OWNER), status('success', OWNER)] },
    { name: 'newest status in the context is from someone else', list: [status('success', 'someone-else'), status('success', OWNER)] },
    { name: 'pending', list: [status('pending', OWNER)] },
    { name: 'no creator', list: [{ context: CONTEXT, state: 'success' }] },
  ];
  for (const c of cases) {
    const result = await check(ctx, prEnv(22, head), prApi(ctx, 22, head, changed, c.list, c.api));
    assert.equal(result.ok, false, `${c.name}: ${result.lines.join(' | ')}`);
    assert.equal(usedProposed(result), false, c.name);
    assert.ok(result.lines.includes(baseFinding), `${c.name}: ${result.lines.join(' | ')}`);
  }
});

test('rule data: any head or base change during the check fails', async () => {
  const ctx = context();
  const { head, changed } = excusingPullRequest(ctx, 23);
  const other = 'f'.repeat(40);
  const changes = {
    'head SHA': { headSha: other },
    'head ref': { headRef: 'renamed' },
    'head repository': { headRepo: 'fork/project' },
    'base SHA': { baseSha: other },
    'base ref': { baseRef: 'release' },
  };
  for (const [name, over] of Object.entries(changes)) {
    const result = await check(ctx, prEnv(23, head), prApi(ctx, 23, head, changed, [status('success', OWNER)], {
      [`/repos/${REPO}/pulls/23`]: sequence(prInfo(ctx, 23, head), prInfo(ctx, 23, head, over)),
    }));
    assert.equal(result.ok, false, name);
    assert.match(result.lines.join('\n'), /head or base changed/, name);
    assert.ok(!result.lines.some((l) => l.startsWith(`${LABEL} PASS`)), name);
  }
  // A base repository that changes, or isn't this repository, fails closed.
  for (const answers of [[prInfo(ctx, 23, head), prInfo(ctx, 23, head, { baseRepo: 'other/project' })], [prInfo(ctx, 23, head, { baseRepo: 'other/project' })]]) {
    const result = await check(ctx, prEnv(23, head), prApi(ctx, 23, head, changed, [status('success', OWNER)], {
      [`/repos/${REPO}/pulls/23`]: sequence(...answers),
    }));
    assert.equal(result.ok, false);
    assert.match(result.lines.join('\n'), /targets another repository/);
  }
  // An approval withdrawn while the data was read fails.
  const withdrawn = await check(ctx, prEnv(23, head), prApi(ctx, 23, head, changed, [], {
    [`/repos/${REPO}/commits/${head}/statuses`]: sequence([status('success', OWNER)], [status('failure', OWNER)]),
  }));
  assert.equal(withdrawn.ok, false);
  assert.match(withdrawn.lines.join('\n'), /approval for .* changed during the check/);
});

test('rule data: missing, malformed, oversized, non-blob or schema-invalid proposed data fails', async () => {
  const ctx = context();
  const valid = ruleData(ctx);
  const cases = [
    { name: 'missing manifest', files: {}, drop: '.boundary/manifest.json' },
    { name: 'malformed JSON', files: { '.boundary/rules.json': '{ "documentation": ' } },
    { name: 'not UTF-8', entries: [{ mode: '100644', path: '.boundary/exceptions.json', content: Buffer.from([0x5b, 0xff, 0x5d]) }], drop: '.boundary/exceptions.json' },
    { name: 'oversized', files: { '.boundary/exceptions.json': `[${' '.repeat(MAX_RULE_DATA_BYTES)}]` } },
    { name: 'symlink', entries: [{ mode: '120000', path: '.boundary/approved-links.json', content: 'manifest.json' }], drop: '.boundary/approved-links.json' },
    { name: 'executable mode', entries: [{ mode: '100755', path: '.boundary/approved-links.json', content: valid['.boundary/approved-links.json'] }], drop: '.boundary/approved-links.json' },
    { name: 'a tree, not a blob', files: { '.boundary/rules.json/inner.json': '{}' }, drop: '.boundary/rules.json' },
    { name: 'exceptions not a list', files: { '.boundary/exceptions.json': '{"exceptions": []}' } },
    { name: 'exception without a reason', files: { '.boundary/exceptions.json': JSON.stringify([{ path: 'a', check: id(9), token: 'b' }]) } },
    { name: 'rules without identifiers', files: { '.boundary/rules.json': JSON.stringify({ ...JSON.parse(valid['.boundary/rules.json']), identifiers: 'x' }) } },
    { name: 'pattern that does not compile', files: { '.boundary/rules.json': JSON.stringify({ ...JSON.parse(valid['.boundary/rules.json']), privatePaths: ['('] }) } },
    { name: 'link prefix with credentials', files: { '.boundary/approved-links.json': JSON.stringify({ prefixes: [['https://user:pw', 'docs.github.com/'].join('@')] }) } },
    { name: 'manifest mirror malformed', files: { '.boundary/manifest.json': JSON.stringify({ files: [], globs: [], mirrors: [['only-one']] }) } },
  ];
  let n = 30;
  for (const c of cases) {
    n += 1;
    const files = { 'src/contact.js': `export const contact = '${ADDRESS}';\n`, ...valid, ...c.files };
    if (c.drop) delete files[c.drop];
    const head = pullRequest(ctx, n, files, ctx.base, { entries: c.entries ?? [] });
    const changed = Object.keys(files).concat(c.drop ? [c.drop] : []);
    const result = await check(ctx, prEnv(n, head), prApi(ctx, n, head, changed, [status('success', OWNER)]));
    assert.equal(result.ok, false, `${c.name}: ${result.lines.join(' | ')}`);
    assert.equal(usedProposed(result), false, c.name);
    assert.ok(result.lines.some((l) => l.startsWith('Proposed rule data rejected:')), `${c.name}: ${result.lines.join(' | ')}`);
    // Rejected data is never replaced by the base rules: no content result is reported at all.
    assert.ok(!result.lines.some((l) => l.startsWith(LABEL)), `${c.name}: ${result.lines.join(' | ')}`);
  }
  // A tree the base rules would pass still fails when its proposed data is rejected.
  const clean = { ...valid, '.boundary/exceptions.json': '{ not json' };
  const head = pullRequest(ctx, 49, clean);
  const result = await check(ctx, prEnv(49, head), prApi(ctx, 49, head, Object.keys(clean), [status('success', OWNER)]));
  assert.equal(result.ok, false, result.lines.join(' | '));
  assert.ok(!result.lines.some((l) => l.startsWith(LABEL)), result.lines.join(' | '));
});

test('rule data: proposed rules must keep a well-formed approval context and creator', async () => {
  const ctx = context();
  const base = JSON.parse(ruleData(ctx)['.boundary/rules.json']);
  const withApproval = (approval) => ({ rules: { approval } });
  const rejected = [
    ['approval removed', withApproval(undefined)],
    ['approval null', withApproval(null)],
    ['approval not an object', withApproval('context')],
    ['approval a list', withApproval([CONTEXT, OWNER])],
    ['context missing', withApproval({ creator: OWNER })],
    ['creator missing', withApproval({ context: CONTEXT })],
    ['context empty', withApproval({ context: '', creator: OWNER })],
    ['creator empty', withApproval({ context: CONTEXT, creator: '' })],
    ['context not a string', withApproval({ context: 7, creator: OWNER })],
    ['creator not a string', withApproval({ context: CONTEXT, creator: [OWNER] })],
  ];
  let n = 60;
  for (const [name, over] of rejected) {
    n += 1;
    const files = { 'src/contact.js': `export const contact = '${ADDRESS}';\n`, ...ruleData(ctx, over) };
    const head = pullRequest(ctx, n, files);
    const result = await check(ctx, prEnv(n, head), prApi(ctx, n, head, Object.keys(files), [status('success', OWNER)]));
    assert.equal(result.ok, false, `${name}: ${result.lines.join(' | ')}`);
    assert.equal(usedProposed(result), false, name);
    assert.ok(result.lines.some((l) => l.startsWith('Proposed rule data rejected:') && l.includes('rules.json approval')), `${name}: ${result.lines.join(' | ')}`);
    assert.ok(!result.lines.some((l) => l.startsWith(LABEL)), `${name}: ${result.lines.join(' | ')}`);
  }
  // A valid, changed approval is allowed after exact-head approval; this check still uses the base approval.
  const changedApproval = { ...base.approval, context: 'ci/new-approval', creator: 'new-approver' };
  const files = { 'src/app.js': 'export const answer = 46;\n', ...ruleData(ctx, withApproval(changedApproval)) };
  const head = pullRequest(ctx, 79, files);
  const result = await check(ctx, prEnv(79, head), prApi(ctx, 79, head, Object.keys(files), [status('success', OWNER)]));
  assert.equal(result.ok, true, result.lines.join(' | '));
  assert.equal(usedProposed(result), true);
  // Under the proposed identity alone, the change would not be approved.
  const other = await check(ctx, prEnv(79, head), prApi(ctx, 79, head, Object.keys(files), [status('success', 'new-approver', 'ci/new-approval')]));
  assert.equal(other.ok, false, other.lines.join(' | '));
  assert.equal(usedProposed(other), false);
});

test('rule data: executable code always comes from the base; only the four data files are read', async () => {
  const ctx = context();
  const marker = join(tempDir('boundary-marker-'), 'executed');
  const hostile = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\nexport const checkTree = () => [];\n`;
  const { head, changed } = excusingPullRequest(ctx, 50, {
    '.boundary/check.mjs': hostile,
    '.boundary/workflow.mjs': hostile,
    '.boundary/test/workflow.test.mjs': hostile,
    'src/other.js': `export const other = '${ADDRESS.replace('dev', 'ops')}';\n`,
  });
  const result = await check(ctx, prEnv(50, head), prApi(ctx, 50, head, changed, [status('success', OWNER)]));
  assert.equal(existsSync(marker), false, 'pull-request code must never run');
  // The base check.mjs ran with the proposed data: the excused address passes, the other one doesn't.
  assert.equal(usedProposed(result), true);
  assert.equal(result.ok, false);
  assert.ok(result.lines.includes(`FAIL ${id(9)} src/other.js:1`), result.lines.join(' | '));
  assert.ok(!result.lines.includes(baseFinding));
  // The data directory holds exactly the four data files, byte for byte.
  const untrusted = tempDir('boundary-untrusted-');
  git(untrusted, 'init', '--bare', '--quiet');
  git(untrusted, 'fetch', '--quiet', ctx.origin, `+refs/pull/50/head:refs/untrusted/head`);
  const { dir } = loadProposedRuleData(untrusted, head);
  assert.deepEqual(readdirSync(dir).sort(), [...RULE_DATA_FILES].sort());
  for (const name of RULE_DATA_FILES) assert.equal(readFileSync(join(dir, name), 'utf8'), git(ctx.work, 'show', `${head}:.boundary/${name}`));
});

// ---- The release-pipeline pull request, by its exact commit, when its objects are available locally.

const RELEASE_HEAD = '3bde85c06e4eb0f6db5421fde50c304ff1c3b7ea';
const RELEASE_BASE = '0baa73ebd0515e8f23c424caa33e1b367daa8aa0';

test('rule data: the release-pipeline tree passes with its approved data and fails without approval', async (t) => {
  const root = join(BOUNDARY, '..');
  const present = (sha) => spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: root }).status === 0;
  if (!present(RELEASE_HEAD) || !present(RELEASE_BASE)) { t.skip('the release-pipeline commit is not in this clone'); return; }
  const ctx = { base: RELEASE_BASE, origin: tempDir('boundary-origin-'), rulesDir: BOUNDARY };
  git(ctx.origin, 'init', '--bare', '--quiet');
  git(root, 'push', '--quiet', '--no-verify', ctx.origin, `${RELEASE_HEAD}:refs/pull/2/head`);
  const changed = git(root, 'diff', '--name-only', RELEASE_BASE, RELEASE_HEAD).split('\n').filter(Boolean);
  const env = prEnv(2, RELEASE_HEAD);
  const unapproved = await check(ctx, env, prApi(ctx, 2, RELEASE_HEAD, changed, []), { trusted: root });
  assert.equal(unapproved.ok, false);
  assert.equal(usedProposed(unapproved), false);
  assert.ok(unapproved.lines.some((l) => l.startsWith(`${LABEL} FAIL (`)), unapproved.lines.slice(-3).join(' | '));
  assert.ok(unapproved.lines.some((l) => l.startsWith(APPROVAL)));
  const approved = await check(ctx, env, prApi(ctx, 2, RELEASE_HEAD, changed, [status('success', OWNER)]), { trusted: root });
  assert.equal(approved.ok, true, approved.lines.join(' | '));
  assert.equal(usedProposed(approved), true);
  assert.ok(approved.lines.includes(`${LABEL} PASS on pull request #2 at ${RELEASE_HEAD}`));
});

// ---- Push events

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
  const files = prApi(ctx, 10, head, ['src/app.js']);
  const cases = [
    { name: 'no event', env: { REPOSITORY: REPO }, api: files },
    { name: 'unknown event', env: { ...prEnv(10, head), EVENT: 'pull_request' }, api: files },
    { name: 'no repository', env: { ...prEnv(10, head), REPOSITORY: '' }, api: files },
    { name: 'malformed head', env: { ...prEnv(10, head), HEAD_SHA: 'not-a-sha' }, api: files },
    { name: 'malformed number', env: { ...prEnv(10, head), PR_NUMBER: '10; rm -rf /' }, api: files },
    { name: 'file list is not a list', env: prEnv(10, head), api: { ...files, [`/repos/${REPO}/pulls/10/files`]: { message: 'Not Found' } } },
    { name: 'file entry without a name', env: prEnv(10, head), api: { ...files, [`/repos/${REPO}/pulls/10/files`]: [{}] } },
    { name: 'API error', env: prEnv(10, head), api: { ...files, [`/repos/${REPO}/pulls/10/files`]: new Error('GitHub API 500') } },
    { name: 'pull request lookup fails', env: prEnv(10, head), api: { ...files, [`/repos/${REPO}/pulls/10`]: new Error('GitHub API 404') } },
    { name: 'pull request without a head repository', env: prEnv(10, head), api: { ...files, [`/repos/${REPO}/pulls/10`]: { ...prInfo(ctx, 10, head), head: { sha: head, ref: 'pr-10', repo: null } } } },
    { name: 'pull request with a malformed base SHA', env: prEnv(10, head), api: { ...files, [`/repos/${REPO}/pulls/10`]: prInfo(ctx, 10, head, { baseSha: 'main' }) } },
    { name: 'unknown pull request ref', env: prEnv(11, head), api: { ...prApi(ctx, 11, head, ['src/app.js']) } },
    { name: 'push without SHAs', env: { EVENT: 'push', REPOSITORY: REPO }, api: {} },
  ];
  for (const c of cases) {
    const result = await check(ctx, c.env, c.api);
    assert.equal(result.ok, false, `${c.name}: ${result.lines.join(' | ')}`);
  }
  const noApproval = minimalRulesDir();
  const rulesPath = join(noApproval, 'rules.json');
  const raw = JSON.parse(readFileSync(rulesPath, 'utf8'));
  delete raw.approval;
  writeFileSync(rulesPath, JSON.stringify(raw));
  const result = await check({ ...ctx, rulesDir: noApproval }, prEnv(10, head), files);
  assert.equal(result.ok, false, 'rules without an approval identity');
});
