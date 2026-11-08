// Runs the public boundary check from .github/workflows/boundary.yml.
//
// This file and the rules always come from the trusted checkout: for a pull
// request, the base branch. Pull-request content is fetched as Git objects into
// a separate bare repository and read with `git ls-tree` and `git cat-file`; it
// is never checked out, installed or executed. Dependency-free; it needs only
// Node.js and git. Inputs arrive through the environment and are validated here.
// Anything missing, malformed or unexpected fails the check.
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkTree, gitTree, inManifest, isBoundaryFile, linkTargets, loadRules } from './check.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHA = /^[0-9a-f]{40}$/;

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, maxBuffer: 1 << 30, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed`);
  return r.stdout.toString('utf8').trim();
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
      const untrusted = mkdtempSync(join(tmpdir(), 'untrusted-'));
      git(untrusted, ['init', '--bare', '--quiet']);
      git(untrusted, ['fetch', '--quiet', '--no-tags', '--depth=1', remote(repo), `+refs/pull/${number}/head:refs/untrusted/head`]);
      if (git(untrusted, ['rev-parse', 'refs/untrusted/head']) !== head) {
        fail('The pull request head moved during the check; it runs again on the new head.');
      } else {
        const tree = gitTree(untrusted, head);
        report(checkTree(rules, tree.paths, tree.readBlob), `pull request #${number} at ${head}`);
        const files = await list(`/repos/${repo}/pulls/${number}/files?per_page=100`);
        const changed = files.flatMap((f) => {
          if (!f || typeof f.filename !== 'string') throw new Error('unexpected pull-request file entry');
          return [f.filename, f.previous_filename].filter((p) => typeof p === 'string');
        });
        const boundary = changed.filter((p) => isBoundaryFile(rules, p));
        if (boundary.length) {
          say(`Boundary change (${boundary.length} file(s)); private approval required on ${head}.`);
          if (!(await approved(repo, head))) fail(`P-11: ${head} has no private-boundary approval. Any new commit needs a new approval.`);
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
