// Checks data/policies.json and data/reviews.json before they are published.
import { readFile } from "node:fs/promises";
import { AGENT_VALUES, AI_POLICY_VALUES, ISSUE_FIRST_VALUES, OUTSIDE_PR_VALUES, type PolicyRecord } from "./classify.ts";
import type { Reviews } from "./reviews.ts";

const errors: string[] = [];
const fail = (msg: string) => errors.push(msg);

const records = JSON.parse(await readFile("data/policies.json", "utf8")) as PolicyRecord[];
const reviews = JSON.parse(await readFile("data/reviews.json", "utf8")) as Reviews;
const STATUSES = ["auto", "reviewed", "review_stale"];
const URL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\/|$)/;

if (!Array.isArray(records) || records.length === 0) fail("policies.json is empty");
const seen = new Set<string>();
for (const r of records) {
  const at = r.repo;
  if (seen.has(r.repo.toLowerCase())) fail(`${at}: duplicate`);
  seen.add(r.repo.toLowerCase());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.checked)) fail(`${at}: bad checked date ${r.checked}`);
  const check = (field: string, v: { value: string; status: string; evidence: { url: string }[] }, allowed: readonly string[]) => {
    if (!allowed.includes(v.value)) fail(`${at}: ${field} has unknown value ${v.value}`);
    if (!STATUSES.includes(v.status)) fail(`${at}: ${field} has unknown status ${v.status}`);
    // Every verdict other than "not stated" must point at its source.
    if (v.value !== "not_stated" && v.evidence.length === 0) fail(`${at}: ${field}=${v.value} has no evidence`);
    for (const e of v.evidence) if (!URL_RE.test(e.url)) fail(`${at}: ${field} evidence URL ${e.url}`);
  };
  check("ai_policy", r.ai_policy, AI_POLICY_VALUES);
  check("agent_prs", r.agent_prs, AGENT_VALUES);
  check("issue_first", r.issue_first, ISSUE_FIRST_VALUES);
  if (!OUTSIDE_PR_VALUES.includes(r.outside_prs.value)) fail(`${at}: outside_prs ${r.outside_prs.value}`);
  if (r.ai_policy.quote && r.ai_policy.quote.length > 200) fail(`${at}: quote longer than 200 characters`);
}

const allowedByField: Record<string, readonly string[]> = { ai_policy: AI_POLICY_VALUES, agent_prs: AGENT_VALUES, issue_first: ISSUE_FIRST_VALUES };
for (const [repo, fields] of Object.entries(reviews)) {
  if (!records.some((r) => r.repo === repo)) fail(`reviews.json: ${repo} is not in policies.json`);
  for (const [field, rv] of Object.entries(fields)) {
    if (!allowedByField[field]) fail(`reviews.json: ${repo}.${field} is not a reviewable field`);
    else if (!allowedByField[field]!.includes(rv!.verdict)) fail(`reviews.json: ${repo}.${field} has unknown verdict ${rv!.verdict}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rv!.reviewed)) fail(`reviews.json: ${repo}.${field} needs a reviewed date`);
    if (rv!.verdict !== "not_stated" && !rv!.source) fail(`reviews.json: ${repo}.${field} needs a source`);
    if (!rv!.by) fail(`reviews.json: ${repo}.${field} needs "by"`);
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  console.error(`${errors.length} problem(s)`);
  process.exit(1);
}
console.log(`ok: ${records.length} records, ${Object.keys(reviews).length} reviewed repos`);
