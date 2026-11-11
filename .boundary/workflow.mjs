// Runs the public boundary check from .github/workflows/boundary.yml.
//
// This file, check.mjs and the tests always come from the trusted checkout: for
// a pull request, the base branch. Pull-request content is fetched as Git
// objects into a separate bare repository and read with `git ls-tree` and
// `git cat-file`; it is never checked out, installed or executed.
// Dependency-free; it needs only Node.js and git. Inputs arrive through the
// environment and are validated here. Anything missing, malformed or unexpected
// fails the check.
//
// The rules are data. A pull request that changes the boundary may propose new
// rule data (RULE_DATA_FILES), and its content is checked against that proposal
// only once the private-boundary approval for its exact head SHA is confirmed.
// Whether a change touches the boundary, and whose approval counts, always come
// from the base rules. Without that approval, the base rules apply and the
// check fails.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkTree, compileRules, gitTree, inManifest, isBoundaryFile, linkTargets, loadRules } from './check.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHA = /^[0-9a-f]{40}$/;

/** The rule-data files a boundary pull request may propose, under RULE_DATA_DIR. Never code. */
export const RULE_DATA_DIR = '.boundary';
export const RULE_DATA_FILES = ['rules.json', 'manifest.json', 'exceptions.json', 'approved-links.json'];
export const MAX_RULE_DATA_BYTES = 1024 * 1024;

function gitRaw(cwd, args) {
  const r = spawnSync('git', args, { cwd, maxBuffer: 1 << 30, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed`);
  return r.stdout;
}

function git(cwd, args) {
  return gitRaw(cwd, args).toString('utf8').trim();
}

// ---- Proposed rule data: untrusted bytes, validated before use.

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isString = (v) => typeof v === 'string' && v.length > 0;
const strings = (v) => Array.isArray(v) && v.every(isString);

/**
 * Throws unless the four parsed rule-data files have the shape check.mjs and this workflow read
 * (including rules.json `approval`, with non-empty `context` and `creator`). Extra keys are inert and allowed.
 */
export function validateRuleData({ rules, manifest, exceptions, approvedLinks }) {
  const bad = (what) => { throw new Error(`proposed rule data is invalid: ${what}`); };
  if (!isObject(rules)) bad('rules.json is not an object');
  const doc = rules.documentation;
  if (!isObject(doc) || !['extensions', 'namePrefixes', 'dirs', 'githubNonDocs'].every((k) => strings(doc[k]))) bad('rules.json documentation');
  for (const k of ['privatePaths', 'excludedReferences', 'pathIdentifiers', 'genericTerms', 'workstationPaths', 'ruleFiles', 'boundaryFiles', 'gitignoreRequired']) {
    if (!strings(rules[k])) bad(`rules.json ${k}`);
  }
  if (rules.boundaryDirs !== undefined && !strings(rules.boundaryDirs)) bad('rules.json boundaryDirs');
  if (!Array.isArray(rules.identifiers) || !rules.identifiers.every((i) => isObject(i) && isString(i.id) && isString(i.pattern))) bad('rules.json identifiers');
  const email = rules.email;
  if (!isObject(email) || !isString(email.pattern) || !strings(email.allowDomains) || !strings(email.allowSuffixes)) bad('rules.json email');
  if (!Array.isArray(rules.exemptions) || !rules.exemptions.every((e) => isObject(e) && isString(e.path)
    && (e.sha256 === null || (typeof e.sha256 === 'string' && /^[0-9a-f]{64}$/.test(e.sha256))))) bad('rules.json exemptions');
  if (!isString(rules.boundaryWorkflow) || !isString(rules.workflowsDir)) bad('rules.json workflow paths');
  // Not used for this check (approval always comes from the base rules), but required by this
  // workflow once the data is merged, so a proposal must not remove or corrupt it.
  if (!isObject(rules.approval) || !isString(rules.approval.context) || !isString(rules.approval.creator)) bad('rules.json approval');
  if (!isObject(manifest) || !strings(manifest.files) || !Array.isArray(manifest.globs) || !manifest.globs.every(isString)
    || !Array.isArray(manifest.mirrors) || !manifest.mirrors.every((m) => Array.isArray(m) && m.length === 2 && m.every(isString))) bad('manifest.json');
  if (!Array.isArray(exceptions) || !exceptions.every((e) => isObject(e) && ['path', 'check', 'token', 'reason'].every((k) => isString(e[k])))) bad('exceptions.json');
  if (!isObject(approvedLinks) || !strings(approvedLinks.prefixes)) bad('approved-links.json');
  for (const p of approvedLinks.prefixes) {
    let url;
    try { url = new URL(p); } catch { bad('approved-links.json prefix is not a URL'); }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) bad('approved-links.json prefix');
  }
}

/**
 * Reads the proposed rule data from `head` in the untrusted bare repository. Each file must be
 * a regular blob (mode 100644, no symlink, tree or submodule) of at most MAX_RULE_DATA_BYTES,
 * valid UTF-8 and valid JSON. The bytes are copied into a new, separate data directory, which
 * holds nothing else, and compiled with the trusted check.mjs. Throws on any problem.
 */
export function loadProposedRuleData(untrusted, head) {
  const dir = mkdtempSync(join(tmpdir(), 'proposed-rule-data-'));
  const parsed = {};
  for (const name of RULE_DATA_FILES) {
    const path = `${RULE_DATA_DIR}/${name}`;
    const listing = gitRaw(untrusted, ['ls-tree', '-z', head, '--', path]).toString('utf8').split('\0').filter(Boolean);
    if (listing.length === 0) throw new Error(`proposed rule data is missing ${path}`);
    const m = /^(\d{6}) (\w+) ([0-9a-f]{40})\t(.+)$/s.exec(listing[0]);
    if (listing.length !== 1 || !m || m[4] !== path) throw new Error(`proposed rule data has an unexpected entry for ${path}`);
    if (m[2] !== 'blob' || m[1] !== '100644') throw new Error(`proposed rule data ${path} is not a regular file`);
    const size = Number(git(untrusted, ['cat-file', '-s', m[3]]));
    if (!Number.isSafeInteger(size) || size > MAX_RULE_DATA_BYTES) throw new Error(`proposed rule data ${path} is too large`);
    const bytes = gitRaw(untrusted, ['cat-file', 'blob', m[3]]);
    if (bytes.length !== size) throw new Error(`proposed rule data ${path} could not be read`);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error(`proposed rule data ${path} is not UTF-8`); }
    try { parsed[name] = JSON.parse(text); } catch { throw new Error(`proposed rule data ${path} is not valid JSON`); }
    writeFileSync(join(dir, name), bytes);
  }
  const raw = { rules: parsed['rules.json'], manifest: parsed['manifest.json'], exceptions: parsed['exceptions.json'], approvedLinks: parsed['approved-links.json'] };
  validateRuleData(raw);
  try {
    return { dir, rules: compileRules({ ...raw.rules, manifest: raw.manifest, exceptions: raw.exceptions, approvedLinks: raw.approvedLinks }) };
  } catch {
    throw new Error('proposed rule data is invalid: a pattern does not compile');
  }
}

/** The GitHub REST API, read-only, following pagination. */
export function githubApi(token) {
  return async (path) => {
    const results = [];
    let url = `https://api.github.com${path}`;
    while (url) {
      const res = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' } });
      if (!res.ok) throw new Error(`GitHub API ${res.status} for ${path}`);
      const body = await res.json();
      if (!Array.isArray(body)) return body;
      results.push(...body);
      url = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1];
    }
    return results;
  };
}

/**
 * Runs the check for one workflow event. Returns { ok, lines }.
 *   env      EVENT, REPOSITORY and the event's own variables (see boundary.yml)
 *   api      async (path) => parsed JSON from the GitHub REST API
 *   remote   (repository) => Git URL to fetch pull-request refs from
 *   trusted  the trusted checkout (a Git work tree)
 */
export async function run({ env, api, remote = (repo) => `https://github.com/${repo}.git`, trusted = join(HERE, '..'), rulesDir = HERE }) {
  const lines = [];
  let ok = true;
  const say = (line) => lines.push(line);
  const fail = (line) => { ok = false; say(line); };
  const need = (name, pattern) => {
    const value = env[name] ?? '';
    if (!pattern.test(value)) throw new Error(`${name} is missing or malformed`);
    return value;
  };
  const list = async (path) => {
    const body = await api(path);
    if (!Array.isArray(body)) throw new Error(`unexpected API response for ${path}`);
    return body;
  };
  const report = (findings, label) => {
    for (const f of findings) say(`FAIL ${f.check} ${f.path}:${f.line}`);
    if (findings.length) fail(`V21 public check: FAIL (${findings.length}) on ${label}`);
    else say(`V21 public check: PASS on ${label}`);
  };

  try {
    const rules = loadRules(rulesDir);
    const { context, creator } = rules.raw.approval ?? {};
    if (!context || !creator) throw new Error('rules.json has no approval context and creator');

    // P-11: the newest status in the approval context must be success, created by the approver.
    const approved = async (repo, sha) => {
      const statuses = await list(`/repos/${repo}/commits/${sha}/statuses?per_page=100`);
      const newest = statuses.find((s) => s && s.context === context);
      return Boolean(newest && newest.state === 'success' && newest.creator?.login === creator);
    };

    const repo = need('REPOSITORY', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
    const event = need('EVENT', /^(pull_request_target|push|workflow_dispatch)$/);

    if (event === 'pull_request_target') {
      const number = need('PR_NUMBER', /^[0-9]+$/);
      const head = need('HEAD_SHA', SHA);
      // The pull request's head and base, read before and after the content is fetched.
      const prContext = async () => {
        const pr = await api(`/repos/${repo}/pulls/${number}`);
        const c = {
          headSha: pr?.head?.sha, headRef: pr?.head?.ref, headRepo: pr?.head?.repo?.full_name,
          baseSha: pr?.base?.sha, baseRef: pr?.base?.ref, baseRepo: pr?.base?.repo?.full_name,
        };
        if (!SHA.test(c.headSha ?? '') || !SHA.test(c.baseSha ?? '') || ![c.headRef, c.headRepo, c.baseRef, c.baseRepo].every(isString)) {
          throw new Error('unexpected pull-request head or base');
        }
        if (c.baseRepo.toLowerCase() !== repo.toLowerCase()) throw new Error('the pull request targets another repository');
        return c;
      };
      const sameContext = (a, b) => Object.keys(a).every((k) => a[k] === b[k]);
      const before = await prContext();
      const untrusted = mkdtempSync(join(tmpdir(), 'untrusted-'));
      git(untrusted, ['init', '--bare', '--quiet']);
      let moved = before.headSha !== head;
      if (!moved) {
        git(untrusted, ['fetch', '--quiet', '--no-tags', '--depth=1', remote(repo), `+refs/pull/${number}/head:refs/untrusted/head`]);
        moved = git(untrusted, ['rev-parse', 'refs/untrusted/head']) !== head;
      }
      if (moved) {
        fail('The pull request head moved during the check; it runs again on the new head.');
      } else {
        const files = await list(`/repos/${repo}/pulls/${number}/files?per_page=100`);
        const changed = files.flatMap((f) => {
          if (!f || typeof f.filename !== 'string') throw new Error('unexpected pull-request file entry');
          return [f.filename, f.previous_filename].filter((p) => typeof p === 'string');
        });
        // Boundary membership and the approval identity always come from the base rules.
        const boundary = changed.filter((p) => isBoundaryFile(rules, p));
        const ruleDataPaths = new Set(RULE_DATA_FILES.map((name) => `${RULE_DATA_DIR}/${name}`));
        let checkRules = rules;
        let proposed = false;
        if (boundary.length) {
          say(`Boundary change (${boundary.length} file(s)); private approval required on ${head}.`);
          if (!(await approved(repo, head))) {
            fail(`P-11: ${head} has no private-boundary approval. Any new commit needs a new approval.`);
          } else if (changed.some((p) => ruleDataPaths.has(p))) {
            try {
              checkRules = loadProposedRuleData(untrusted, head).rules;
              proposed = true;
            } catch (err) {
              checkRules = null;
              fail(`Proposed rule data rejected: ${err.message}. The base rules are not substituted.`);
            }
          }
        }
        // Nothing about the pull request may have changed while it was fetched and read.
        const after = await prContext();
        if (!sameContext(before, after)) {
          fail('The pull request head or base changed during the check; it runs again on the new state.');
        } else if (proposed && !(await approved(repo, head))) {
          fail(`P-11: the private-boundary approval for ${head} changed during the check.`);
        } else if (checkRules) {
          if (proposed) say(`Checking with the approved rule data proposed at ${head}; the validator code is the base branch's.`);
          const tree = gitTree(untrusted, head);
          report(checkTree(checkRules, tree.paths, tree.readBlob), `pull request #${number} at ${head}`);
        }
      }
    } else if (event === 'push') {
      const before = need('BEFORE_SHA', SHA);
      const after = need('AFTER_SHA', SHA);
      const tree = gitTree(trusted, after);
      report(checkTree(rules, tree.paths, tree.readBlob), `master at ${after}`);
      // P-11a: every pushed commit that changes a boundary file must have the tree of an approved pull-request head.
      if (git(trusted, ['rev-parse', '--is-shallow-repository']) === 'true') git(trusted, ['fetch', '--quiet', '--no-tags', '--unshallow', 'origin', 'master']);
      const range = /^0+$/.test(before) ? [after] : git(trusted, ['rev-list', `${before}..${after}`]).split('\n').filter(Boolean);
      for (const commit of range) {
        const paths = git(trusted, ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', commit]).split('\n').filter(Boolean);
        if (!paths.some((p) => isBoundaryFile(rules, p))) continue;
        const commitTree = git(trusted, ['rev-parse', `${commit}^{tree}`]);
        let matched = false;
        for (const pr of await list(`/repos/${repo}/commits/${commit}/pulls`)) {
          if (!pr?.merged_at || !Number.isInteger(pr.number) || !SHA.test(pr.head?.sha ?? '')) continue;
          git(trusted, ['fetch', '--quiet', '--no-tags', 'origin', `+refs/pull/${pr.number}/head:refs/approved/${pr.number}`]);
          const prHead = git(trusted, ['rev-parse', `refs/approved/${pr.number}`]);
          if (prHead !== pr.head.sha) continue;
          if (git(trusted, ['rev-parse', `${prHead}^{tree}`]) === commitTree && (await approved(repo, prHead))) { matched = true; break; }
        }
        if (!matched) fail(`P-11a: ${commit} changes a boundary file but its tree matches no approved pull-request head. Treat this as an incident.`);
      }
    } else {
      const sha = git(trusted, ['rev-parse', 'HEAD']);
      const tree = gitTree(trusted, sha);
      report(checkTree(rules, tree.paths, tree.readBlob), `${sha} (manual run)`);
      if (env.FETCH_LINKS === 'true') {
        // P-10, manual run: every external link in the manifest documents must answer.
        const links = new Set();
        for (const path of tree.paths.filter((p) => inManifest(rules, p) && /\.md$/i.test(p))) {
          for (const { targets } of linkTargets(tree.readBlob(path).toString('utf8'))) for (const t of targets) if (/^https?:\/\//i.test(t)) links.add(t.split('#')[0]);
        }
        for (const link of [...links].sort()) {
          let status = 0;
          for (const method of ['HEAD', 'GET']) {
            try { status = (await fetch(link, { method, redirect: 'follow', signal: AbortSignal.timeout(20000) })).status; } catch { status = 0; }
            if (status >= 200 && status < 400) break;
          }
          if (status >= 200 && status < 400) say(`link ok ${status} ${link}`);
          else fail(`P-10: ${link} answered ${status || 'no response'}`);
        }
      }
    }
  } catch (err) {
    fail(`Boundary check error: ${err.message}`);
  }
  return { ok, lines };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const result = await run({ env: process.env, api: githubApi(process.env.GITHUB_TOKEN) });
  for (const line of result.lines) process.stdout.write(`${line}\n`);
  process.exitCode = result.ok ? 0 : 1;
}
