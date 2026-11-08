// V21 public boundary check (local checks P-3 to P-10 and P-12 to P-14).
// Dependency-free. Everything it inspects is treated as untrusted data: files are
// read as bytes and never executed. Findings name the check, path and line only.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export function loadRules(dir = HERE) {
  const read = (name) => JSON.parse(readFileSync(join(dir, name), 'utf8'));
  return compileRules({
    ...read('rules.json'),
    manifest: read('manifest.json'),
    exceptions: read('exceptions.json'),
    approvedLinks: read('approved-links.json'),
  });
}

function globToRegex(glob) {
  const body = glob
    .split('**')
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))
    .join('.*');
  return new RegExp(`^${body}$`);
}

export function compileRules(raw) {
  return {
    raw,
    docExtensions: raw.documentation.extensions.map((e) => e.toLowerCase()),
    docPrefixes: raw.documentation.namePrefixes.map((p) => p.toLowerCase()),
    docDirs: raw.documentation.dirs,
    githubNonDocs: raw.documentation.githubNonDocs,
    manifestFiles: new Set(raw.manifest.files),
    manifestGlobs: raw.manifest.globs.map(globToRegex),
    mirrors: raw.manifest.mirrors,
    privatePaths: raw.privatePaths.map((p) => new RegExp(p, 'i')),
    excludedReferences: raw.excludedReferences.map((r) => r.toLowerCase()),
    identifiers: raw.identifiers.map((i) => ({ id: i.id, re: new RegExp(i.pattern, 'g') })),
    pathIdentifiers: raw.pathIdentifiers.map((p) => new RegExp(p, 'i')),
    genericTerms: raw.genericTerms.map((t) => new RegExp(`(^|[^A-Za-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9])`, 'i')),
    emailRe: new RegExp(raw.email.pattern, 'g'),
    emailAllowDomains: new Set(raw.email.allowDomains.map((d) => d.toLowerCase())),
    emailAllowSuffixes: raw.email.allowSuffixes.map((s) => s.toLowerCase()),
    workstationPaths: raw.workstationPaths.map((p) => new RegExp(p, 'g')),
    exemptions: new Map(raw.exemptions.map((e) => [e.path, e])),
    ruleFiles: new Set(raw.ruleFiles),
    boundaryFiles: new Set(raw.boundaryFiles),
    boundaryDirs: raw.boundaryDirs ?? [],
    gitignoreRequired: raw.gitignoreRequired,
    boundaryWorkflow: raw.boundaryWorkflow,
    workflowsDir: raw.workflowsDir,
    exceptions: raw.exceptions,
    linkPrefixes: raw.approvedLinks.prefixes,
  };
}

const basename = (p) => p.slice(p.lastIndexOf('/') + 1);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const isBinary = (buf) => buf.subarray(0, 8000).includes(0);

export function isDocumentation(rules, path) {
  const name = basename(path).toLowerCase();
  const dot = name.lastIndexOf('.');
  if (dot > 0 && rules.docExtensions.includes(name.slice(dot))) return true;
  if (rules.docPrefixes.some((p) => name.startsWith(p))) return true;
  if (rules.docDirs.some((d) => path.startsWith(d))) return true;
  if (path.startsWith('.github/')) return !rules.githubNonDocs.some((n) => path === n || path.startsWith(n));
  return false;
}

export function inManifest(rules, path) {
  return rules.manifestFiles.has(path) || rules.manifestGlobs.some((re) => re.test(path));
}

export function isBoundaryFile(rules, path) {
  return rules.boundaryFiles.has(path) || rules.boundaryDirs.some((d) => path.startsWith(d)) || inManifest(rules, path);
}

// An absolute link is approved only by an entry with the same scheme, host and
// port, and a path equal to the entry's path or below it at a "/" boundary. A
// link with credentials is never approved.
export function approvedLink(rules, target) {
  let url;
  try { url = new URL(target); } catch { return false; }
  if (url.username || url.password || !/^https?:$/.test(url.protocol)) return false;
  return rules.linkPrefixes.some((entry) => {
    const base = new URL(entry);
    if (base.protocol !== url.protocol || base.host !== url.host) return false;
    const prefix = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
    return url.pathname === base.pathname || url.pathname.startsWith(prefix);
  });
}

function excepted(rules, path, check, token) {
  return rules.exceptions.some((e) => e.path === path && e.check === check && e.token === token);
}

// Tree-level checks for one complete tree: P-3, P-4, P-5, P-7 (paths), P-13, P-14.
export function checkPaths(rules, paths, readBlob) {
  const findings = [];
  const have = new Set(paths);
  const add = (check, path) => findings.push({ check, path, line: 0 });
  for (const file of rules.manifestFiles) if (!have.has(file)) add('P-3', file);
  for (const [source, mirror] of rules.mirrors) {
    if (have.has(source) && have.has(mirror) && sha256(readBlob(source)) !== sha256(readBlob(mirror))) add('P-3', mirror);
  }
  for (const path of paths) {
    if (isDocumentation(rules, path) && !inManifest(rules, path)) add('P-4', path);
    if (rules.privatePaths.some((re) => re.test(path))) add('P-5', path);
    if (rules.pathIdentifiers.some((re) => re.test(path)) && !excepted(rules, path, 'P-7', path)) add('P-7', path);
    if (path.startsWith(rules.workflowsDir)) {
      const text = readBlob(path).toString('utf8');
      if (text.includes('pull_request_target') && path !== rules.boundaryWorkflow) add('P-14', path);
      if (text.includes('allow-unsafe-pr-checkout')) add('P-14', path);
    }
  }
  if (!have.has('.gitignore')) add('P-13', '.gitignore');
  else {
    const lines = new Set(readBlob('.gitignore').toString('utf8').split(/\r?\n/).map((l) => l.trim()));
    if (rules.gitignoreRequired.some((r) => !lines.has(r))) add('P-13', '.gitignore');
  }
  return findings;
}

// Line checks shared by file content and commit or tag messages: P-6 to P-9.
function scanLines(rules, path, text, skip) {
  const findings = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const at = (check) => findings.push({ check, path, line: index + 1 });
    const lower = line.toLowerCase();
    if (!skip.has('P-6') && rules.excludedReferences.some((r) => lower.includes(r))) at('P-6');
    if (!skip.has('P-7')) {
      for (const { re } of rules.identifiers) {
        for (const m of line.matchAll(re)) if (!excepted(rules, path, 'P-7', m[0])) { at('P-7'); break; }
      }
    }
    if (!skip.has('P-8') && rules.genericTerms.some((re) => re.test(line))) at('P-8');
    if (!skip.has('P-9')) {
      for (const m of line.matchAll(rules.emailRe)) {
        const domain = m[0].slice(m[0].lastIndexOf('@') + 1).toLowerCase();
        const allowed = rules.emailAllowDomains.has(domain) || rules.emailAllowSuffixes.some((s) => domain.endsWith(s));
        if (!allowed && !excepted(rules, path, 'P-9', m[0])) { at('P-9'); break; }
      }
      if (!skip.has('P-9-paths')) {
        for (const re of rules.workstationPaths) {
          for (const m of line.matchAll(re)) if (!excepted(rules, path, 'P-9', m[0])) { at('P-9'); break; }
        }
      }
    }
  });
  return findings;
}

export function checkText(rules, label, text) {
  return scanLines(rules, label, text, new Set());
}

function slugify(heading) {
  return heading.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
}

function anchors(markdown) {
  const set = new Set();
  let fenced = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (m) set.add(slugify(m[1]));
  }
  return set;
}

// Link targets of a Markdown document, per line: Markdown links and bare URLs.
// Code is not a link: fenced code blocks and inline code spans are skipped.
export function linkTargets(text) {
  const out = [];
  let fenced = false;
  text.split(/\r?\n/).forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return; }
    if (fenced) return;
    const targets = [];
    const withoutLinks = line.replace(/(`+)[^`]*?\1/g, ' ').replace(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, t) => { targets.push(t); return ' '; });
    for (const m of withoutLinks.matchAll(/https?:\/\/[^\s<>()"'`\]]+/g)) targets.push(m[0]);
    if (targets.length) out.push({ line: index + 1, targets });
  });
  return out;
}

// P-10 for one Markdown manifest document against the tree it belongs to.
function checkLinks(rules, path, text, paths, readBlob) {
  const findings = [];
  const have = new Set(paths);
  const own = anchors(text);
  for (const { line, targets } of linkTargets(text)) {
    for (const target of targets) {
      let ok;
      if (/^https?:\/\//i.test(target)) ok = approvedLink(rules, target);
      else if (/^[a-z][a-z0-9+.-]*:/i.test(target)) ok = false;
      else if (target.startsWith('#')) ok = own.has(target.slice(1));
      else {
        const [file, anchor] = target.split('#');
        const resolved = posix.normalize(posix.join(posix.dirname(path), decodeURIComponent(file)));
        const isDir = paths.some((p) => p.startsWith(`${resolved.replace(/\/$/, '')}/`));
        ok = have.has(resolved) || isDir;
        if (ok && anchor && have.has(resolved) && /\.md$/i.test(resolved)) ok = anchors(readBlob(resolved).toString('utf8')).has(anchor);
      }
      if (!ok) { findings.push({ check: 'P-10', path, line }); break; }
    }
  }
  return findings;
}

// Content checks for one file at one path: P-6 to P-10 and P-12.
export function checkContent(rules, path, buf, { paths = [], readBlob = () => Buffer.alloc(0) } = {}) {
  if (isBinary(buf)) return [];
  const findings = [];
  const skip = new Set();
  const exemption = rules.exemptions.get(path);
  if (exemption) {
    if (exemption.sha256 && exemption.sha256 === sha256(buf)) ['P-7', 'P-8', 'P-9'].forEach((c) => skip.add(c));
    else findings.push({ check: 'P-12', path, line: 0 });
  }
  // Rule files define the patterns, so they're exempt from those patterns; email addresses are still checked.
  if (rules.ruleFiles.has(path)) ['P-6', 'P-7', 'P-8', 'P-9-paths'].forEach((c) => skip.add(c));
  const text = buf.toString('utf8');
  let lineFindings = scanLines(rules, path, text, skip);
  if (path === '.gitignore') {
    // The required ignore rules necessarily name private paths; only those exact lines are exempt.
    const lines = text.split(/\r?\n/);
    const required = new Set(rules.gitignoreRequired);
    lineFindings = lineFindings.filter((f) => !(['P-6', 'P-8'].includes(f.check) && required.has(lines[f.line - 1].trim())));
  }
  if (path === '.boundary/exceptions.json') {
    // A P-9 exception records the matched text itself; only a "token" line holding a recorded P-9 token is exempt.
    const lines = text.split(/\r?\n/);
    const tokens = new Set(rules.exceptions.filter((e) => e.check === 'P-9').map((e) => e.token));
    const recorded = (line) => {
      const m = /^\s*"token":\s*("(?:[^"\\]|\\.)*"),?\s*$/.exec(line);
      if (!m) return false;
      try { return tokens.has(JSON.parse(m[1])); } catch { return false; }
    };
    lineFindings = lineFindings.filter((f) => !(f.check === 'P-9' && recorded(lines[f.line - 1])));
  }
  findings.push(...lineFindings);
  if (inManifest(rules, path) && /\.md$/i.test(path)) findings.push(...checkLinks(rules, path, text, paths, readBlob));
  return findings;
}

export function checkTree(rules, paths, readBlob) {
  const findings = checkPaths(rules, paths, readBlob);
  for (const path of paths) findings.push(...checkContent(rules, path, readBlob(path), { paths, readBlob }));
  return findings;
}

// ---- Command line: node check.mjs (--dir <folder> | --repo <git dir> --sha <rev>) [--rules <dir>]

function walk(root, skipDirs) {
  const out = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { if (!skipDirs.has(name)) visit(full); }
      else out.push(relative(root, full).split(sep).join('/'));
    }
  };
  visit(root);
  return out.sort();
}

// The files a folder would publish. In a Git work tree: tracked files (even if
// later ignored) plus untracked files that aren't ignored, so ignored secrets,
// build output and test artifacts stay out while an untracked private file is
// still caught. Outside a work tree, every file except .git (fails closed).
export function dirPaths(root) {
  const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root });
  if (inside.status !== 0 || inside.stdout.toString().trim() !== 'true') return walk(root, new Set(['.git']));
  const r = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error('git ls-files failed');
  const paths = new Set(r.stdout.toString('utf8').split('\0').filter(Boolean));
  return [...paths].filter((p) => existsSync(join(root, p)) && statSync(join(root, p)).isFile()).sort();
}

export function gitTree(repo, sha) {
  const run = (args, input) => {
    const r = spawnSync('git', args, { cwd: repo, input, maxBuffer: 1 << 30 });
    if (r.status !== 0) throw new Error(`git ${args[0]} failed`);
    return r.stdout;
  };
  const entries = new Map();
  for (const rec of run(['ls-tree', '-r', '-z', '--full-tree', sha]).toString('utf8').split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    const [, type, oid] = rec.slice(0, tab).split(' ');
    if (type === 'blob') entries.set(rec.slice(tab + 1), oid);
  }
  return { paths: [...entries.keys()], readBlob: (p) => run(['cat-file', 'blob', entries.get(p)]) };
}

function main(argv) {
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const rules = loadRules(arg('--rules') ?? HERE);
  let tree;
  if (arg('--dir')) {
    const root = arg('--dir');
    const paths = dirPaths(root);
    tree = { paths, readBlob: (p) => readFileSync(join(root, p)) };
  } else if (arg('--repo') && arg('--sha')) {
    tree = gitTree(arg('--repo'), arg('--sha'));
  } else {
    process.stderr.write('usage: check.mjs (--dir <folder> | --repo <path> --sha <rev>) [--rules <dir>]\n');
    return 2;
  }
  const findings = checkTree(rules, tree.paths, tree.readBlob);
  for (const f of findings) process.stdout.write(`FAIL ${f.check} ${f.path}:${f.line}\n`);
  process.stdout.write(findings.length ? `V21 public check: FAIL (${findings.length})\n` : `V21 public check: PASS (${tree.paths.length} files)\n`);
  return findings.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main(process.argv.slice(2));
