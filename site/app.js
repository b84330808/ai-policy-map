// AI Contribution Policy Map: client-side search and filters over data/policies.json.
"use strict";

const AI_LABELS = {
  banned: "Banned",
  human_text_only: "Human-written text only",
  allowed_with_disclosure: "Allowed with disclosure",
  allowed: "Allowed",
  needs_review: "Needs review",
  not_stated: "Not stated",
};
const AGENT_LABELS = { forbidden: "Forbidden", allowed: "Allowed", needs_review: "Needs review", not_stated: "Not stated" };
const ISSUE_LABELS = { required: "Required", for_larger_changes: "For larger changes", not_required: "Not required", not_stated: "" };
const OUTSIDE_LABELS = { open: "Open", collaborators_only: "Collaborators only", disabled: "PRs disabled", not_accepted: "Not accepted" };
const STATUS_LABELS = { auto: "keyword match", reviewed: "reviewed", review_stale: "source changed" };
const STRICTNESS = { banned: 0, human_text_only: 1, allowed_with_disclosure: 2, needs_review: 3, allowed: 4, not_stated: 5 };

const $ = (id) => document.getElementById(id);
const state = { q: "", ai: "", agent: "", lang: "", sort: "stars", cla: false, dco: false, issue: false, closed: false, anti: false, reviewed: false };
let data = [];
const open = new Set();

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c);
  return n;
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  for (const k of Object.keys(state)) {
    if (!p.has(k)) continue;
    state[k] = typeof state[k] === "boolean" ? p.get(k) === "1" : p.get(k);
  }
}

function writeHash() {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(state)) {
    if (v === "" || v === false || (k === "sort" && v === "stars")) continue;
    p.set(k, v === true ? "1" : v);
  }
  const h = p.toString();
  history.replaceState(null, "", h ? `#${h}` : location.pathname + location.search);
}

function syncControls() {
  $("q").value = state.q;
  $("f-ai").value = state.ai;
  $("f-agent").value = state.agent;
  $("f-lang").value = state.lang;
  $("sort").value = state.sort;
  for (const k of ["cla", "dco", "issue", "closed", "anti", "reviewed"]) $(`f-${k}`).checked = state[k];
}

function matches(r) {
  if (state.q) {
    const q = state.q.toLowerCase();
    if (!r.repo.toLowerCase().includes(q) && !(r.description ?? "").toLowerCase().includes(q) && !(r.language ?? "").toLowerCase().includes(q)) return false;
  }
  if (state.ai && r.ai_policy.value !== state.ai) return false;
  if (state.agent && r.agent_prs.value !== state.agent) return false;
  if (state.lang && (r.language ?? "Other") !== state.lang) return false;
  if (state.cla && r.cla.value !== true) return false;
  if (state.dco && r.dco.value !== true) return false;
  if (state.issue && !["required", "for_larger_changes"].includes(r.issue_first.value) && r.assignment_required.value !== true) return false;
  if (state.closed && r.outside_prs.value === "open") return false;
  if (state.anti && r.anti_automation.length === 0) return false;
  if (state.reviewed && ![r.ai_policy.status, r.agent_prs.status].includes("reviewed")) return false;
  return true;
}

function sorted(rows) {
  const by = {
    stars: (a, b) => b.stars - a.stars,
    name: (a, b) => a.repo.localeCompare(b.repo),
    strict: (a, b) => STRICTNESS[a.ai_policy.value] - STRICTNESS[b.ai_policy.value] || b.stars - a.stars,
  }[state.sort];
  return [...rows].sort(by);
}

function fmtStars(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

function badge(value, labels) {
  return el("span", { class: `badge v-${value}`, text: labels[value] ?? value });
}

function statusTag(v) {
  if (v.value === "not_stated" && v.status === "auto") return null;
  return el("span", { class: `status ${v.status}`, title: { auto: "Found by keyword rules; not reviewed", reviewed: "Set by hand after reading the cited text", review_stale: "Reviewed, but the cited file has changed since" }[v.status] ?? "", text: STATUS_LABELS[v.status] ?? v.status });
}

function sourceLink(v) {
  const e = v.evidence?.[0];
  if (!e) return null;
  const where = e.line ? `${e.path}#L${e.line}` : e.path || "source";
  return el("div", { class: "sub" }, el("a", { href: e.url, target: "_blank", rel: "noopener", text: where, onclick: "event.stopPropagation()" }));
}

function renderRow(r) {
  const tr = el("tr", { class: "row", tabindex: "0", "aria-expanded": open.has(r.repo) ? "true" : "false" });
  const claDco = [r.cla.value ? "CLA" : null, r.dco.value ? "DCO" : null].filter(Boolean);
  const issue = ISSUE_LABELS[r.issue_first.value];
  tr.append(
    el("td", { class: "repo", "data-label": "Repository" },
      el("a", { href: r.url, target: "_blank", rel: "noopener", text: r.repo, onclick: "event.stopPropagation()" }),
      el("div", { class: "sub", text: [r.language, `★ ${fmtStars(r.stars)}`, r.archived ? "archived" : null].filter(Boolean).join(" · ") })),
    el("td", { "data-label": "AI-assisted contributions" }, badge(r.ai_policy.value, AI_LABELS), statusTag(r.ai_policy), sourceLink(r.ai_policy)),
    el("td", { "data-label": "Agents opening PRs" }, badge(r.agent_prs.value, AGENT_LABELS), statusTag(r.agent_prs), sourceLink(r.agent_prs)),
    el("td", { "data-label": "CLA / DCO" }, claDco.length ? claDco.join(" + ") : el("span", { class: "dash", text: "—" })),
    el("td", { "data-label": "Issue first" }, issue ? issue : el("span", { class: "dash", text: "—" }), r.assignment_required.value ? el("div", { class: "sub", text: "assignment asked" }) : null),
    el("td", { "data-label": "Outside PRs" }, r.outside_prs.value === "open" ? el("span", { class: "dash", text: "Open" }) : el("strong", { text: OUTSIDE_LABELS[r.outside_prs.value] })),
    el("td", { "data-label": "Anti-automation" }, r.anti_automation.length ? r.anti_automation.slice(0, 3).map((s) => el("span", { class: "chip", text: s.name })) : el("span", { class: "dash", text: "—" }),
      r.anti_automation.length > 3 ? el("span", { class: "chip", text: `+${r.anti_automation.length - 3}` }) : null),
  );
  const toggle = () => {
    if (open.has(r.repo)) open.delete(r.repo);
    else open.add(r.repo);
    render();
  };
  tr.addEventListener("click", toggle);
  tr.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  });
  return tr;
}

function evidenceList(v, repo) {
  if (!v.evidence?.length) return el("p", { class: "note", text: "No matching text found in the files read." });
  return el("ul", {}, v.evidence.map((e) => {
    const file = e.repo && e.repo !== repo ? `${e.repo}/${e.path}` : e.path;
    return el("li", {},
      el("a", { href: e.url, target: "_blank", rel: "noopener", text: e.line ? `${file}:${e.line}` : file || e.quote }),
      e.quote && e.line ? el("blockquote", { text: e.quote }) : null);
  }));
}

function verdictBlock(title, v, labels, repo) {
  return el("div", {},
    el("h3", { text: title }),
    el("div", {}, badge(v.value, labels), statusTag(v)),
    v.note ? el("p", { class: "note", text: v.note }) : null,
    v.review ? el("p", { class: "note", text: `Reviewed by ${v.review.by} on ${v.review.date}.` }) : null,
    evidenceList(v, repo));
}

function flagBlock(title, f) {
  return el("div", {},
    el("h3", { text: title }),
    el("div", { text: f.value === true ? "Required" : f.value === false ? "Not required" : "Not found" }),
    f.evidence?.length ? el("ul", {}, f.evidence.map((e) => el("li", {}, el("a", { href: e.url, target: "_blank", rel: "noopener", text: e.line ? `${e.path}:${e.line}` : e.quote || e.path }), e.line && e.quote ? el("blockquote", { text: e.quote }) : null))) : null);
}

function renderDetail(r) {
  const signals = r.anti_automation.length
    ? el("ul", {}, r.anti_automation.map((s) => el("li", {}, `${s.kind}: `, s.url ? el("a", { href: s.url, target: "_blank", rel: "noopener", text: s.name }) : s.name)))
    : el("p", { class: "note", text: "None found." });
  const sources = r.sources.length
    ? el("ul", {}, r.sources.map((s) => el("li", {}, el("a", { href: s.url, target: "_blank", rel: "noopener", text: s.repo === r.repo ? s.path : `${s.repo}/${s.path}` }), s.scope !== "repo" ? ` (${s.scope})` : "")))
    : el("p", { class: "note", text: "No policy files found." });
  const td = el("td", { colspan: "7" },
    el("div", { class: "detail detail-grid" },
      verdictBlock("AI-assisted contributions", r.ai_policy, AI_LABELS, r.repo),
      verdictBlock("Agents opening PRs on their own", r.agent_prs, AGENT_LABELS, r.repo),
      verdictBlock("Issue or discussion first", r.issue_first, { ...ISSUE_LABELS, not_stated: "Not stated" }, r.repo),
      flagBlock("CLA", r.cla),
      flagBlock("DCO sign-off", r.dco),
      el("div", {}, el("h3", { text: "Anti-automation signals" }), signals),
      el("div", {}, el("h3", { text: "Files read" }), sources,
        r.agent_files.length ? el("p", { class: "note", text: `Agent instruction files: ${r.agent_files.join(", ")}` }) : null,
        el("p", { class: "note" }, `Checked ${r.checked}`, r.commit ? ` at ${r.commit.slice(0, 7)}` : "", ". ",
          el("a", { href: correctionUrl(r), target: "_blank", rel: "noopener", text: "Report a wrong verdict" })))));
  return el("tr", { class: "detail" }, td);
}

function correctionUrl(r) {
  const p = new URLSearchParams({ template: "correction.yml", title: `Correction: ${r.repo}`, repo: r.repo });
  return `https://github.com/b84330808/ai-policy-map/issues/new?${p}`;
}

function renderSummary(rows) {
  const counts = {};
  for (const r of rows) counts[r.ai_policy.value] = (counts[r.ai_policy.value] ?? 0) + 1;
  const box = $("summary");
  box.replaceChildren(...Object.keys(AI_LABELS).map((k) => {
    const b = el("button", { type: "button", class: `v-${k}`, "aria-pressed": state.ai === k ? "true" : "false" }, AI_LABELS[k], el("b", { text: String(counts[k] ?? 0) }));
    b.addEventListener("click", () => {
      state.ai = state.ai === k ? "" : k;
      syncControls();
      render();
    });
    return b;
  }));
}

function render() {
  writeHash();
  const rows = sorted(data.filter(matches));
  renderSummary(data);
  const body = $("rows");
  const frag = document.createDocumentFragment();
  for (const r of rows) {
    frag.append(renderRow(r));
    if (open.has(r.repo)) frag.append(renderDetail(r));
  }
  body.replaceChildren(frag);
  $("empty").hidden = rows.length > 0;
  $("result-count").textContent = `Showing ${rows.length} of ${data.length} repositories. Click a row for sources.`;
}

function fillSelect(id, labels, values) {
  const s = $(id);
  for (const v of values) s.append(el("option", { value: v, text: labels[v] ?? v }));
}

async function main() {
  const [policies, meta] = await Promise.all([
    fetch("data/policies.json").then((r) => r.json()),
    fetch("data/meta.json").then((r) => r.json()).catch(() => ({})),
  ]);
  data = policies;
  $("repo-count").textContent = String(data.length);
  $("generated").textContent = meta.generated ?? "unknown";
  fillSelect("f-ai", AI_LABELS, Object.keys(AI_LABELS));
  fillSelect("f-agent", AGENT_LABELS, Object.keys(AGENT_LABELS));
  const langs = [...new Set(data.map((r) => r.language ?? "Other"))].sort((a, b) => a.localeCompare(b));
  fillSelect("f-lang", {}, langs);
  readHash();
  syncControls();

  let t;
  $("q").addEventListener("input", (e) => {
    clearTimeout(t);
    t = setTimeout(() => {
      state.q = e.target.value.trim();
      render();
    }, 120);
  });
  for (const [id, key] of [["f-ai", "ai"], ["f-agent", "agent"], ["f-lang", "lang"], ["sort", "sort"]]) {
    $(id).addEventListener("change", (e) => {
      state[key] = e.target.value;
      render();
    });
  }
  for (const k of ["cla", "dco", "issue", "closed", "anti", "reviewed"]) {
    $(`f-${k}`).addEventListener("change", (e) => {
      state[k] = e.target.checked;
      render();
    });
  }
  window.addEventListener("hashchange", () => {
    readHash();
    syncControls();
    render();
  });
  render();
}

main().catch((err) => {
  $("result-count").textContent = `Could not load the data: ${err.message}`;
});
