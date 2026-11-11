// Read-only checks for promote.yml, through the GitHub API with the job's
// GITHUB_TOKEN. Inputs come from the environment; any missing, malformed or
// unreadable value fails.
//
//   node release/promote-checks.mjs environment
//     The "release" environment exists with exactly one required reviewer,
//     the user COVADigital, and prevent_self_review false.
//   node release/promote-checks.mjs candidate <candidate-report.json>
//     The candidate run is candidate.yml on this tag's commit and concluded
//     success, and its report passed and names this digest, tag ref and commit.
import { readFileSync } from "node:fs";

const env = process.env;
const need = (k, re) => { const v = env[k] ?? ""; if (!re.test(v)) throw new Error(`${k} is missing or malformed`); return v; };
const repo = need("GITHUB_REPOSITORY", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
async function api(path) {
  const r = await fetch(`https://api.github.com${path}`, { headers: { authorization: `Bearer ${need("GITHUB_TOKEN", /.+/)}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" } });
  if (!r.ok) throw new Error(`GitHub API ${r.status} for ${path}`);
  return r.json();
}

async function environment() {
  const e = await api(`/repos/${repo}/environments/release`);
  if (e.name !== "release") throw new Error("the release environment doesn't exist");
  const rules = Array.isArray(e.protection_rules) ? e.protection_rules : [];
  const reviewers = rules.filter((r) => r.type === "required_reviewers");
  if (reviewers.length !== 1) throw new Error("the release environment needs exactly one required_reviewers rule");
  const list = reviewers[0].reviewers ?? [];
  if (!list.some((r) => r.type === "User" && r.reviewer?.login === "COVADigital")) throw new Error("COVADigital isn't a required reviewer");
  if (reviewers[0].prevent_self_review !== false) throw new Error("prevent_self_review must be false while there's one maintainer");
  if (e.can_admins_bypass !== false) throw new Error("administrators can bypass the release environment");
  console.log("release environment: COVADigital is the required reviewer; self-review allowed; no administrator bypass");
}

async function candidate(reportFile) {
  const runId = need("CANDIDATE_RUN_ID", /^[0-9]+$/);
  const digest = need("DIGEST", /^sha256:[0-9a-f]{64}$/);
  const sha = need("RUN_SHA", /^[0-9a-f]{40}$/);
  const ref = need("RUN_REF", /^refs\/tags\/v[0-9]+\.[0-9]+\.[0-9]+$/);
  const run = await api(`/repos/${repo}/actions/runs/${runId}`);
  if (run.path !== ".github/workflows/candidate.yml") throw new Error("that run isn't the candidate workflow");
  if (run.conclusion !== "success") throw new Error(`the candidate run concluded ${run.conclusion}`);
  if (run.head_sha !== sha) throw new Error("the candidate run built a different commit");
  const report = JSON.parse(readFileSync(reportFile, "utf8"));
  const problems = [];
  if (report.passed !== true) problems.push("report didn't pass");
  if (report.digest !== digest) problems.push("digest differs");
  if (report.commit !== sha) problems.push("commit differs");
  if (report.tag_ref !== ref) problems.push("tag ref differs");
  if (String(report.run_id) !== runId) problems.push("run id differs");
  if (!/^[a-z0-9./-]+@sha256:[0-9a-f]{64}$/.test(report.source_bundle?.ref ?? "")) problems.push("source bundle missing");
  if (!["new", "reused"].includes(report.source_bundle?.status)) problems.push("source bundle status missing");
  if (problems.length) throw new Error(`candidate report: ${problems.join("; ")}`);
  console.log(`candidate ${digest} from run ${runId}: passed, ${ref} at ${sha}; source bundle ${report.source_bundle.status}`);
}

const [cmd, arg] = process.argv.slice(2);
(cmd === "environment" ? environment() : cmd === "candidate" ? candidate(arg) : Promise.reject(new Error("usage: promote-checks.mjs environment|candidate <report>")))
  .catch((e) => { console.log(`refused: ${e.message}`); process.exitCode = 1; });
