// Tests for check.mjs behavior: folder enumeration, exception scope, code in
// Markdown, and approved-link boundaries.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { approvedLink, checkContent, checkPaths, dirPaths } from '../check.mjs';
import { email, git, id, rules, tempDir, write } from './helpers.mjs';

const content = (r, path, text, extra) => checkContent(r, path, Buffer.from(text), extra);
const checks = (findings) => findings.map((f) => f.check);

test('folder mode: tracked files (even if later ignored) and non-ignored untracked files, never ignored ones', () => {
  const root = tempDir();
  git(root, 'init', '--quiet');
  write(root, { 'tracked.txt': 'kept\n' });
  git(root, 'add', 'tracked.txt');
  const agents = ['AGENTS', 'md'].join('.');
  write(root, {
    '.gitignore': 'tracked.txt\n.env\nbuild/\ntest-results/\n',
    '.env': `SECRET=${email('owner', 'mail.invalid-domain.com')}\n`,
    'build/out.js': 'x\n',
    'test-results/run.log': 'x\n',
    'src/new.js': 'y\n',
    [agents]: 'private\n',
  });
  const paths = dirPaths(root);
  assert.ok(paths.includes('tracked.txt'), 'tracked file that is now ignored');
  assert.ok(paths.includes('src/new.js'), 'untracked, not ignored');
  assert.ok(paths.includes('.gitignore'));
  assert.ok(!paths.includes('.env'), 'ignored secret file');
  assert.ok(!paths.includes('build/out.js') && !paths.includes('test-results/run.log'), 'ignored build output and test artifacts');
  const findings = checkPaths(rules(), paths, (p) => readFileSync(join(root, p)));
  assert.ok(findings.some((f) => f.check === id(5) && f.path === agents), 'untracked private file is caught');
});

test('folder mode outside a Git work tree includes every file (fails closed)', () => {
  const root = tempDir();
  write(root, { '.env': 'x\n', 'node_modules/a/index.js': 'x\n', 'src/a.js': 'x\n' });
  assert.deepEqual(dirPaths(root), ['.env', 'node_modules/a/index.js', 'src/a.js']);
});

test('an email-shaped exception exempts only its exact token in its exact file', () => {
  const token = email('svc', 'db.internal');
  const other = email('svc', 'cache.internal');
  const r = rules({ exceptions: [{ path: 'src/a.js', check: id(9), token, reason: 'test' }] });
  assert.deepEqual(content(r, 'src/a.js', `const url = "${token}";\n`), []);
  assert.deepEqual(checks(content(r, 'src/b.js', `const url = "${token}";\n`)), [id(9)], 'same token, other file');
  assert.deepEqual(checks(content(r, 'src/a.js', `const url = "${other}";\n`)), [id(9)], 'other token, same file');
});

test('exceptions.json: only a "token" line holding a recorded token is exempt', () => {
  const token = email('svc', 'db.internal');
  const stray = email('person', 'mail.internal');
  const r = rules({ exceptions: [{ path: 'src/a.js', check: id(9), token, reason: 'test' }] });
  const path = '.boundary/exceptions.json';
  assert.deepEqual(content(r, path, `[\n  {\n    "token": "${token}",\n    "reason": "test"\n  }\n]\n`), []);
  assert.deepEqual(checks(content(r, path, `[\n  {\n    "token": "${token}",\n    "reason": "see ${stray}"\n  }\n]\n`)), [id(9)], 'address in another field');
  assert.deepEqual(checks(content(r, path, `[\n  {\n    "token": "${stray}"\n  }\n]\n`)), [id(9)], 'unrecorded token');
});

test('Markdown links: code is skipped, live links are still checked', () => {
  const r = rules();
  const doc = 'docs/USAGE.md';
  const opts = { paths: [doc], readBlob: () => Buffer.alloc(0) };
  const unapproved = 'https://unapproved.example.org/page';
  assert.deepEqual(content(r, doc, `Run \`curl ${unapproved}\` to try it.\n`, opts), []);
  assert.deepEqual(content(r, doc, `\`\`\`sh\ncurl ${unapproved}\n\`\`\`\n`, opts), []);
  assert.deepEqual(content(r, doc, `~~~\n${unapproved}\n~~~\n`, opts), []);
  assert.deepEqual(checks(content(r, doc, `See ${unapproved}.\n`, opts)), [id(10)], 'bare URL in prose');
  assert.deepEqual(checks(content(r, doc, `See [the page](${unapproved}).\n`, opts)), [id(10)], 'Markdown link');
  assert.deepEqual(checks(content(r, doc, `\`\`\`sh\nok\n\`\`\`\nSee ${unapproved}.\n`, opts)), [id(10)], 'link after a closed fence');
  assert.deepEqual(content(r, doc, 'See [the guide](https://docs.github.com/en/actions).\n', opts), []);
});

test('approved links: host, port and path boundaries are enforced', () => {
  const r = rules({ approvedLinks: { prefixes: ['https://github.com/COVADigital/COVALink', 'https://coolify.io/docs', 'https://docs.github.com/'] } });
  const archive = `https://github.com/COVADigital/COVALink${'-private-archive'}`;
  for (const ok of [
    'https://github.com/COVADigital/COVALink',
    'https://github.com/COVADigital/COVALink/',
    'https://github.com/COVADigital/COVALink/blob/master/README.md',
    'https://github.com/COVADigital/COVALink#readme',
    'https://coolify.io/docs/knowledge-base',
    'https://docs.github.com/en/actions',
  ]) assert.equal(approvedLink(r, ok), true, ok);
  for (const bad of [
    archive,
    `${archive}/issues`,
    'https://github.com/COVADigital/COVALinkX',
    'https://github.com/COVADigital/COVALink@evil.example',
    'https://github.com.evil.example/COVADigital/COVALink',
    `https://${email('user', 'github.com')}/COVADigital/COVALink`,
    'https://github.com:8443/COVADigital/COVALink',
    'http://github.com/COVADigital/COVALink',
    'https://coolify.io/docsevil',
    'https://coolify.io/doc',
    'https://evil.example/https://docs.github.com/',
    'not a url',
  ]) assert.equal(approvedLink(r, bad), false, bad);
});
