// Keyword rules. They tag single sentences; classify.ts turns the tags into
// per-repo verdicts. Every tag keeps the file and line it came from.

export type Sentence = { line: number; text: string };

export type Tag =
  | "ai_ban" // AI-generated contributions are not accepted
  | "ai_ban_conditional" // a ban with a condition (undisclosed, unreviewed, low effort, ...)
  | "ai_human_text" // PR text, issues or comments must be written by a person
  | "ai_disclose" // AI use must be disclosed
  | "ai_allow" // AI use is allowed or welcome
  | "ai_attest" // a PR-template checkbox like "[ ] No AI tools were used"
  | "ai_mention" // talks about AI tools, but no rule matched
  | "agent_forbid" // autonomous agents / bots may not open PRs
  | "agent_allow"
  | "cla"
  | "cla_negated"
  | "dco"
  | "issue_first"
  | "assignment"
  | "issue_first_negated"
  | "no_outside_prs";

// --- sentence extraction ---------------------------------------------------

const LIST_ITEM = /^\s*([-*+]|\d+[.)]|\[[ xX]\])\s+/;
const HEADING = /^\s*#{1,6}\s/;
const RST_UNDERLINE = /^\s*([=\-~^"'`#*+])\1{2,}\s*$/;
const TABLE_ROW = /^\s*\|/;

/** Strips markup that gets in the way of matching, keeping the words. */
export function clean(s: string): string {
  return s
    .replace(/<!--|-->/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/`_+/g, " ")
    .replace(/:[a-z]+:`([^`<]*)(<[^>]*>)?`/g, "$1")
    .replace(/<[^>\s][^>]*>/g, " ")
    .replace(/[*_`]{1,3}/g, "")
    .replace(/\\([^\w\s])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Splits a text file into sentences with 1-based line numbers. Paragraphs,
 * list items, headings and table rows are separate units; sentences inside a
 * unit may span lines and take the line they start on.
 */
export function sentences(text: string): Sentence[] {
  const lines = text.split(/\r?\n/);
  const out: Sentence[] = [];
  let unit: { line: number; text: string }[] = [];
  let inFence = false;

  const flush = () => {
    if (unit.length === 0) return;
    let joined = "";
    const starts: { offset: number; line: number }[] = [];
    for (const u of unit) {
      starts.push({ offset: joined.length, line: u.line });
      joined += u.text + " ";
    }
    // A sentence ends at . ! ? followed by whitespace; "e.g", "3.14" or "README.md" do not end it.
    const re = /(?:[^.!?]|[.!?]+(?=[^\s.!?]))+(?:[.!?]+(?=\s|$))?|[.!?]+/g;
    let m: RegExpExecArray | null;
    let buf = "";
    let bufStart = -1;
    while ((m = re.exec(joined))) {
      if (bufStart < 0) bufStart = m.index;
      buf += m[0];
      // Do not split on "e.g." / "i.e." / "etc." / "vs." and similar.
      if (/\b(e\.g|i\.e|etc|vs|cf|approx|incl|no|ca)\.$/i.test(buf.trim()) && re.lastIndex < joined.length) continue;
      const t = clean(buf);
      if (t.length > 2) {
        let line = unit[0]!.line;
        for (const s of starts) if (s.offset <= bufStart + (buf.length - buf.trimStart().length)) line = s.line;
        out.push({ line, text: t });
      }
      buf = "";
      bufStart = -1;
    }
    unit = [];
  };

  lines.forEach((raw, i) => {
    const line = i + 1;
    if (/^\s*(```|~~~)/.test(raw)) {
      flush();
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    if (raw.trim() === "" || RST_UNDERLINE.test(raw)) {
      flush();
      return;
    }
    if (HEADING.test(raw) || TABLE_ROW.test(raw)) {
      flush();
      unit.push({ line, text: raw });
      flush();
      return;
    }
    if (LIST_ITEM.test(raw)) flush();
    unit.push({ line, text: raw });
  });
  flush();
  return out;
}

// --- vocabulary --------------------------------------------------------------

// "Cursor", "OpenAI" and "ML models" are left out on purpose: too many false hits
// (text cursors, API docs of AI libraries).
const AI_NAME = String.raw`(?:ai|a\.i\.|llms?|genai|gen-ai|generative[- ]ai|(?:large )?language models?|chat ?gpt|gpt-?[3-5o]\w*|copilot|claude(?: code)?|gemini|codex|devin|windsurf|aider)`;
const AI_PRODUCED = String.raw`(?:generated|assisted|authored|written|created|produced|driven|aided|powered|made|based|crafted)`;

/** AI used as an authoring tool: the trigger for AI-policy rules. */
export const AI_TOOL = new RegExp(
  [
    String.raw`\b${AI_NAME}[- ]?${AI_PRODUCED}\b`,
    String.raw`\b(?:ai|llm|genai|generative ai)[- ](?:tools?|assistants?|agents?|coding|models?|bots?|contributions?|prs?|pull requests?|code|patches|submissions?|content|text|output|usage|use|policy|policies|slop|spam|help|assistance|disclosure|generation)\b`,
    String.raw`\b(?:use|using|used|uses|usage of|use of|with the help of|help from|helped by|assistance (?:of|from)|rely on|relying on|leverag\w+|employ\w*)\s+(?:of\s+)?(?:an?\s+|any\s+|the\s+)?(?:\w+\s+)?${AI_NAME}\b`,
    String.raw`\b(?:generated|written|created|produced|authored)\s+(?:entirely\s+|fully\s+|solely\s+|partially\s+|primarily\s+|mostly\s+|wholly\s+)?(?:by|with|using|via|through)\s+(?:an?\s+|the\s+)?${AI_NAME}\b`,
    String.raw`\b(?:with|without|not with|by) (?:an? |the help of (?:an? )?)?${AI_NAME}\b`,
    String.raw`\b(?:output|outputs|content|text|code|answers?|responses?)\s+(?:of|from|by)\s+(?:an?\s+|the\s+)?${AI_NAME}\b`,
    String.raw`\b(?:coding|software|autonomous|ai) (?:agents?|assistants?)\b`,
    String.raw`\bagentic\b`,
    String.raw`\bvibe[- ]?cod\w*`,
    String.raw`\bmachine[- ]generated\b`,
    String.raw`\b(?:ai|llm)[- ]?slop\b`,
    String.raw`\bslop\b`,
    String.raw`\bno (?:ai|llms?|genai)\b`,
    String.raw`\b(?:if|when) you(?:'re| are) an? (?:ai|llm|language model|bot|agent|coding agent|ai agent|ai assistant|automated)\b`,
    String.raw`\b(?:ai|llms?|chatgpt|copilot|claude|gemini)\b(?=[^.]{0,60}\b(?:pull requests?|prs?|contribut\w*|patch\w*|submi\w+|commits?|issues?|code|descriptions?|comments?)\b)`,
  ].join("|"),
  "i",
);

/** Bare "AI"-ish names, used as a weak trigger with contribution words nearby. */
const AI_ANY = new RegExp(String.raw`\b${AI_NAME}\b`, "i");

const NEG = String.raw`(?:not|never|no longer|cannot|can't|won't|will not|do not|don't|does not|doesn't|did not|didn't|shall not|must not|may not|should not|shouldn't|refuse to|decline to)`;

const BAN_VERBS = new RegExp(
  String.raw`\b${NEG}\s+(?:be\s+|currently\s+|generally\s+|ever\s+|knowingly\s+)?(?:accept\w*|allow\w*|permit\w*|welcom\w*|merg\w*|tolerat\w*|consider\w*|review\w*|take|taking|entertain|support|includ\w*|contain\w*|used|submitted|posted)\b`,
  "i",
);
const BAN_WORDS = /\b((we|maintainers|the project) (will|may|might|reserve the right to) (reject|decline|refuse)|policy is to decline|prohibit\w*|forbid\w*|forbade|bans?|banned|banning|disallow\w*|not (allowed|permitted|accepted|acceptable|welcome|wanted)|unacceptable|unwelcome|zero[- ]tolerance|will be (closed|rejected|banned|blocked|deleted|removed|locked|reported)|(closed|rejected|banned|blocked)\s+(on sight|immediately|without (review|discussion|comment|further))|grounds for (a )?(ban|closure|rejection)|result in (a )?(ban|closure|rejection|block))\b/i;
const BAN_NO = new RegExp(String.raw`\bno\s+(?:ai|llms?|genai|generative ai|machine[- ]generated|${AI_NAME}[- ]${AI_PRODUCED})\b`, "i");
const DO_NOT_USE = new RegExp(
  String.raw`\b(?:do not|don't|never|must not|may not|should not|shouldn't|please don't|please do not|refrain from|avoid)\s+(?:use|using|submit\w*|send\w*|open\w*|contribut\w*|post\w*|creat\w*|generat\w*|rely)\b`,
  "i",
);
const STOP = /\b(stop( now| here| immediately)?|halt|do not (proceed|continue)|don't (proceed|continue)|abort|exit now|go away)\b/i;
/** "Contributions not following the AI policy will be closed": enforcement, not a ban. */
const ENFORCEMENT = /\b(not follow\w*|n't follow\w*|violat\w*|(do not|don't|does not|doesn't|fail to) (follow|comply|adhere|respect)|in breach of|ignor\w*|disregard\w*)\b[^.]{0,40}\b(polic\w*|guidelines?|rules?|requirements?)\b/i;
/** "- [ ] No AI tools were used": a disclosure option in a PR template, not a ban. */
const ATTESTATION = /^\s*[-*]?\s*\[[ xX]?\]\s*/;

/** Conditions that turn a ban into a restriction. */
const CONDITION = /\b(without|unless|undisclosed|not disclosed|non-?disclosed|unreviewed|unverified|not (been )?(reviewed|verified|tested|understood)|unchecked|untested|low[- ](quality|effort|value)|slop|spam|spamm\w*|not substantial|insubstantial|(prohibited|forbidden|not allowed|banned) (for|in|when|on)|purely|fully|entirely|wholly|solely|completely|mostly|primarily|blindly|unedited|copy[- ]?(and[- ])?past\w*|verbatim|raw|you (don't|do not|can't|cannot) (understand|explain|fully understand)|can(not|'t) explain|mass|bulk|drive[- ]by|autonomous\w*|unattended|unsupervised|agentic|hallucinat\w*|on (your|their) behalf|that (you|they) (have not|haven't))\b/i;

const DISCLOSE = /\b(disclos\w*|declar\w*|acknowledg\w*|transparen\w*|indicat\w*|mention\w*|label (it|your|them|this|that|the (pr|pull request|commit))|flag (it|your|this|that)|mark (it|them|your|this|that) (as|with)|tag (it|your|them) (as|with)|attribut\w*|credit\w*|be upfront|be open about|let (us|the reviewers?|maintainers?) know|tell us|(add|leave|include) a note|note (in|on) (the|your)|state (whether|which|if|in|clearly)|specify|clearly (state|mark|indicate|note|say)|assisted-by|generated-by|co-authored-by|ai-assisted:|made-with|check (the|this) box|tick (the|this) box|honest(ly)?|say so|explain (how|which|what) (ai|llm|tools?))\b/i;

const ALLOW = /\b(welcome[ds]?|allowed|permitted|acceptable|accepted|fine|okay|ok|encourag\w*|feel free|free to use|can use|may use|are able to use|is not (banned|prohibited|forbidden)|don't mind|do not mind|no problem|happy to (accept|review|receive)|we accept|accepts|accepting|not against|not opposed|valid tools?|useful tools?|helpful tools?|legitimate tools?)\b/i;

/** Things people write: AI may be fine for code but not for these. */
const COMMS = /\b((pr|pull[- ]request|merge[- ]request)s?\s+(descriptions?|titles?|bod(y|ies)|texts?|summar\w*|messages?)|commit messages?|descriptions?|issues?( reports?)?|bug reports?|comments?|discussions?|communicat\w*|conversations?|replies|reply|responses?|respond\w*|messages?|review (comments|responses|replies)|(what|anything) you (write|post|say)|talk(ing)? to (us|maintainers|reviewers)|interact\w*)\b/i;
const OWN_WORDS = /\b(own words|your words|own writing|your own (writing|thoughts|ideas|explanation)|in your (own )?voice|own voice|human[- ](written|authored|generated|crafted|composed)|(written|authored|composed) by (a |an actual |the )?(human|person|you|yourself)|by yourself|write (it|them|this|these)? ?yourself|yourself,? not|personally (write|written)|real person|not (be )?(written|generated|produced|drafted) (by|with|using) (an? )?(ai|llm|tool|machine))/i;
const CODE_WORDS = /\b(code|patch(es)?|changes?|implementation|commits?|contributions?|pull requests?|prs?)\b/i;

const AGENT = /\b(autonomous(ly)?|agentic|unattended|fully[- ]automated|automated (pull requests|prs|contributions|submissions|tools?|accounts?|agents?|systems?)|(ai|llm|coding|autonomous|software|ai coding) agents?|ai bots?|bots?|claws?|openclaw|devin|swe-agent|agents? (that )?(open|opening|create|creating|submit\w*|file|filing)|without (a |any )?human( (involvement|oversight|review|intervention|in the loop|supervision))?|human[- ]in[- ]the[- ]loop|on (your|their) (own|behalf))\b/i;
const HUMAN_REQUIRED = /\b(must (be|have) (a |been )?(human|person)|(a |the )?human (must|has to|needs to|should|is required)|require[sd]? (a |the )?human|requires? human|human[- ](reviewed|verified|supervised|driven|authored|submitted|operated)|human[- ]in[- ]the[- ]loop|by a (human|person)|a real person|real human|person must|you must (review|understand|verify|be able to explain)|ask (the|your) (user|human)|without (the |explicit )?(user's|user|human)( explicit)? (approval|permission|consent|confirmation))\b/i;
const SELF_ADDRESS = /\b(if|when) you(?:'re| are) an? (ai|llm|language model|bot|agent|coding agent|ai agent|ai assistant|automated (tool|agent|system))\b/i;
const OPEN_PR = /\b(open|opening|create|creating|submit|submitting|file|filing|send|sending|push|pushing|make|making)\s+(a |an |any |the |new |your )*(pull requests?|prs?|issues?|merge requests?)\b/i;

const CLA_WORDS = /\b(contributor('s)? licen[cs]e agreement|cla[- ]assistant|easycla|(individual|corporate|entity) (contributor )?licen[cs]e agreement|sign(ed|ing)? (the |our |a )?(cla|contributor agreement)|contributor agreement|copyright assignment|cla\.developers\.google\.com)\b/i;
const CLA_ABBR = /\bCLAs?\b/;
const CLA_NEG = /\b(no|not|without|don't|do not|doesn't|does not|never)\b[^.]{0,30}\b(cla|contributor licen[cs]e agreement|contributor agreement|sign)\b|\b(cla|contributor licen[cs]e agreement)\b[^.]{0,30}\b(is )?(not (required|needed|necessary)|no longer)\b/i;
const DCO_WORDS = /(\bdeveloper certificate of origin\b|\bsigned-off-by\b|--signoff\b|\bgit commit -\w*s\b|\bcommit -s\b|\bsign[- ]off (your|all|each|every) commits?\b|\bsign (your|all|each|every) commits? off\b)/i;
const DCO_ABBR = /\bDCO\b/;
const DCO_NEG = /\b(no|not|don't|do not|doesn't|does not|without|never)\b[^.]{0,30}\b(dco|sign[- ]?off|signed-off-by)/i;

const ISSUE_FIRST = [
  /\b(open|create|file|start|raise|submit)\s+(an?\s+|the\s+)?(issue|discussion|proposal|rfc|feature request|ticket)s?\b[^.]{0,100}\b(first|before|prior)\b/i,
  /\b(before|prior to)\s+(you\s+)?(start(ing)? (to )?(work|working|coding|on|implement\w*)|begin(ning)? (work|coding|on)|(open(ing)?|submit(ting)?|send(ing)?|creat(e|ing)|mak(e|ing)) (a |your |any )?(new )?(pull requests?|prs?|patch(es)?|merge requests?)|work(ing)? on|writ(e|ing) (any )?(code|a patch)|mak(e|ing) (a |any )?(significant |large |major |non-trivial )?(changes?|contributions?)|implement(ing)?)\b[^.]{0,100}\b(issue|discuss\w*|approv\w*|agree\w*|assign\w*|consensus|go-?ahead)/i,
  /\b(pull requests?|prs?|patches|contributions?|changes)\b[^.]{0,40}\b(without|not linked to|not tied to|not associated with|that (do not|don't) (reference|link|address))\s+(an?\s+|the\s+)?(approved\s+|accepted\s+|existing\s+|linked\s+|associated\s+|corresponding\s+|prior\s+)?(issue|discussion)/i,
  /\bmust\s+(first\s+)?(be\s+)?(reference|link|address|close|fix|resolve|correspond)\w*\s+(to\s+)?(an?\s+|the\s+)?(existing\s+|open\s+|approved\s+|accepted\s+)?issue/i,
  /\b(discuss|propose)\w*\b[^.]{0,60}\b(first|before)\b[^.]{0,60}\b(pull request|pr|patch|implementation|work|code)/i,
  /\bissue[- ]first\b/i,
];
const ASSIGNMENT = /\b((be|get|been|is|are|being)\s+assigned\b|assign(ed)?\s+(it\s+|the issue\s+|an issue\s+)?to (you|yourself)|ask(ing)? (to be|for (the issue|it) to be|for)\s+assign|wait\w*\s+(for|until)[^.]{0,50}\b(assign\w*|approv\w*|triag\w*|accept\w*|maintainers? (to )?(confirm|respond|agree))|only (work on|pick up|take) issues? (that are |which are )?(assigned|labell?ed|marked))/i;
/** "Open an issue first for larger changes": a softer rule than issue-first for everything. */
export const LARGER_CHANGES = /\b(major|large|larger|significant|big|bigger|substantial|non-?trivial|complex|new features?|breaking|api changes?|architectural|anything (more than|beyond)|not (a )?trivial|more than (a )?(small|trivial|minor)|bigger than)\b/i;
const NOT_NEEDED = /\b(no need|not (necessary|required|needed|mandatory)|don't need|do not need|needn't|not have to|don't have to|do not have to|optional|feel free to (open|submit|send))\b/i;

const AGENT_FILE_FORBID = /\b(never|do not|don't|must not|may not|should not|shall not|not (permitted|allowed) to|forbidden to)\s+(\w+\s+){0,4}?(open|create|submit|file|send|make|raise)\w*\s+(a |an |any |the |new |your )*(pull requests?|prs?|issues?|merge requests?)\b(?!\s+(solely|just|only|merely|for|that|which|against|with|from|before|after|when|if)\b)(?!\s+without\s+(?![^.]*\b(approval|permission|consent|confirmation|asking|instructions?|request)\b))/i;
/** "We have paused accepting pull requests from outside the team." */
const PAUSED_PRS = /\b(paused|stopped|suspended|closed) (accepting|taking|reviewing) (outside |external |community |new )?(pull requests|prs|contributions)\b|\bnot (currently )?accepting (outside |external |community |new )?(pull requests|prs|code contributions)\b/i;
const NO_OUTSIDE_PRS = /\b(do not|don't|does not|doesn't|cannot|can't|won't|will not|not|no longer)\s+(currently\s+|generally\s+|usually\s+|actively\s+)?(accept|take|review|look at|merge|consider|use)\w*\s+(any\s+|external\s+|outside\s+|unsolicited\s+|uninvited\s+|third[- ]party\s+|community\s+)?(pull requests|prs|patches|code contributions|contributions)\b(?![^.]{0,40}\b(without|unless|that|which|from (ai|llm)|generated|written|created)\b)/i;
const MIRROR = /\b(this|the) (repository|repo) is (a |only a |just a )?(read[- ]only )?mirror\b|\bread[- ]only mirror\b/i;

// --- tagging ---------------------------------------------------------------

export type SentenceTags = { tags: Set<Tag>; sentence: Sentence };

export type FileContext = {
  /** Agent instruction files (AGENTS.md, CLAUDE.md ...) address agents implicitly. */
  agentFile: boolean;
  /** README and similar: only take AI sentences with contribution words. */
  strict: boolean;
};

const CONTRIB = /\b(contribut\w*|pull requests?|prs?|patch(es)?|submi\w+|commits?|merge requests?|issues?|bug reports?)\b/i;

export function tagSentence(s: Sentence, ctx: FileContext): Set<Tag> {
  const t = s.text;
  const tags = new Set<Tag>();

  // CLA / DCO / issue-first are independent of AI wording.
  if (CLA_WORDS.test(t) || CLA_ABBR.test(t)) tags.add(CLA_NEG.test(t) ? "cla_negated" : "cla");
  if ((DCO_WORDS.test(t) || DCO_ABBR.test(t)) && !DCO_NEG.test(t)) tags.add("dco");
  if (ISSUE_FIRST.some((re) => re.test(t))) tags.add(NOT_NEEDED.test(t) ? "issue_first_negated" : "issue_first");
  if (ASSIGNMENT.test(t) && /\b(issues?|work|tasks?|prs?|pull requests?)\b/i.test(t)) {
    tags.add(NOT_NEEDED.test(t) || /\b(don't|do not|no need to) (wait|ask)\b/i.test(t) ? "issue_first_negated" : "assignment");
  }
  if ((NO_OUTSIDE_PRS.test(t) && !AI_ANY.test(t)) || MIRROR.test(t) || PAUSED_PRS.test(t)) tags.add("no_outside_prs");

  const aiTool = AI_TOOL.test(t);
  const selfAddress = SELF_ADDRESS.test(t);
  if (!aiTool && !selfAddress && !(ctx.agentFile && OPEN_PR.test(t))) return tags;
  if (aiTool && ctx.strict && !CONTRIB.test(t)) return tags;

  const attestation = ATTESTATION.test(t);
  const banned = !ENFORCEMENT.test(t) && (BAN_VERBS.test(t) || BAN_WORDS.test(t) || BAN_NO.test(t) || DO_NOT_USE.test(t));
  const conditional = CONDITION.test(t);
  const disclose = DISCLOSE.test(t) && !/\b(do not|don't|no need to|not required to|not have to|don't have to|not asked to|not need to|not necessary to) (disclose|mention|label|indicate)|\b(disclosure|attribution)\b[^.]{0,30}\b(is )?(not required|optional|not necessary)|\bnot required\b/i.test(t);
  const allow = hasUnnegated(ALLOW, t);
  const comms = COMMS.test(t);
  const ownWords = OWN_WORDS.test(t);

  // Agent rules: sentences about agents or bots, or any PR-opening sentence in an agent file.
  // "Do not open a competing PR" in an agent file is about duplicates, not about agents.
  const aboutDuplicates = /\b(competing|duplicate|another|already|existing|second)\b/i.test(t);
  const agentish = AGENT.test(t) || selfAddress || (ctx.agentFile && OPEN_PR.test(t) && !aboutDuplicates);
  if (agentish) {
    if (selfAddress && (STOP.test(t) || banned)) tags.add("agent_forbid");
    else if ((banned || HUMAN_REQUIRED.test(t)) && AGENT.test(t)) tags.add("agent_forbid");
    // In an agent file, only a prohibition aimed at opening the PR itself counts ("Never create a PR").
    else if (ctx.agentFile && AGENT_FILE_FORBID.test(t)) tags.add("agent_forbid");
    else if (allow && !banned && !/\bbut not\b/i.test(t) && /\b(open|submit|creat|send|file)\w*\b/i.test(t)) tags.add("agent_allow");
  }
  if (!aiTool) return tags;

  // A checkbox such as "[ ] No AI tools were used" is one answer to a disclosure question.
  if (attestation && (banned || BAN_NO.test(t) || /\b(did not|didn't|have not|haven't|not been|without)\b/i.test(t))) {
    tags.add("ai_attest");
    return tags;
  }

  // A rule about written text only: what is left after removing the text nouns says nothing about code.
  const coversCode = CODE_WORDS.test(t.replace(new RegExp(COMMS.source, "gi"), ""));
  if (ownWords && comms) tags.add("ai_human_text");
  else if (banned && comms && !coversCode) tags.add("ai_human_text");
  else if (ownWords && !coversCode) tags.add("ai_human_text");
  else if (banned && !conditional && !allow) tags.add("ai_ban");
  else if (banned) tags.add("ai_ban_conditional");

  if (disclose && !tags.has("ai_ban")) tags.add("ai_disclose");
  if (allow && !banned) tags.add("ai_allow");
  if (tags.size === 0 || ![...tags].some((x) => x.startsWith("ai_"))) tags.add("ai_mention");
  return tags;
}

/** True when `re` matches somewhere that is not just after a negation. */
function hasUnnegated(re: RegExp, text: string): boolean {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let m: RegExpExecArray | null;
  while ((m = g.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 30), m.index);
    if (!/\b(not|never|no|n't|nor|without|hardly)\b[^.,;]*$/i.test(before)) return true;
  }
  return false;
}

// --- workflows, labels, checks ---------------------------------------------

export const KNOWN_ACTIONS: Record<string, string> = {
  "matteogabriele/agentscan-action": "AgentScan (flags accounts that look automated)",
  "scrapy/unattended-pr-guard": "unattended-pr-guard (closes PRs from authors with many cross-repo PRs)",
  "github/ai-moderator": "GitHub AI moderator (spam detection)",
  "contributor-assistant/github-action": "CLA Assistant",
  "cla-assistant/github-action": "CLA Assistant",
  "finos/cla-bot": "CLA bot",
  "peakoss/anti-slop": "anti-slop (scores PRs for signs of AI slop)",
  "mitchellh/vouch": "vouch (only vouched users may open PRs)",
};

const ANTI_AUTOMATION_TEXT = /(agentscan|unattended[-_ ]pr|ai[-_ ]?(policy|slop|spam|moderat\w*|detect\w*|guard|disclosure|generated|check)|llm[-_ ]?(spam|detect\w*|guard|generated)|\bslop\b|vouch(ed)?\b|maybe[-_ ]?ai|possibly[-_ ]?ai|anti[-_ ]?(ai|bot|spam|slop))/i;
const CLA_WORKFLOW = /(contributor-assistant|cla-assistant|easycla|cla-bot|clabot|cla[-_]?check|\bcla\b|license\/cla)/i;
const DCO_WORKFLOW = /(\bdco\b|signed-off-by|signoff|sign-off)/i;
const ISSUE_LINK_WORKFLOW = /(linked[-_ ]issue|issue[-_ ]link|require[sd]?[-_ ]issue|missing[-_ ]issue|no[-_ ]linked[-_ ]issue|close[sd]?[-_ ]?(prs?|pull[-_ ]requests?)[-_ ]without|must (reference|link) an issue)/i;

export type WorkflowHit = { kind: "anti_automation" | "cla" | "dco" | "issue_first"; name: string; line: number };

/** Scans one workflow file for actions and steps of interest. */
export function scanWorkflow(path: string, text: string): WorkflowHit[] {
  const hits: WorkflowHit[] = [];
  const lines = text.split(/\r?\n/);
  const file = path.split("/").pop() ?? path;
  lines.forEach((l, i) => {
    const line = i + 1;
    const uses = /^\s*-?\s*uses:\s*['"]?([\w.-]+\/[\w.\/-]+)/.exec(l);
    if (uses) {
      if (uses[1]!.startsWith(".")) return; // a local action in the same repo
      const action = uses[1]!.toLowerCase().replace(/\/$/, "");
      const base = action.split("/").slice(0, 2).join("/");
      const known = KNOWN_ACTIONS[base];
      if (known) {
        const kind = /cla/i.test(known) ? "cla" : "anti_automation";
        hits.push({ kind, name: base, line });
        return;
      }
      if (ANTI_AUTOMATION_TEXT.test(action)) hits.push({ kind: "anti_automation", name: base, line });
      else if (CLA_WORKFLOW.test(action)) hits.push({ kind: "cla", name: base, line });
      else if (DCO_WORKFLOW.test(action)) hits.push({ kind: "dco", name: base, line });
      return;
    }
    const nameLine = /^\s*name:\s*['"]?(.+?)['"]?\s*$/.exec(l);
    if (nameLine && i < 5) {
      if (ANTI_AUTOMATION_TEXT.test(nameLine[1]!)) hits.push({ kind: "anti_automation", name: `${file}: ${nameLine[1]}`, line });
      else if (/\bCLA\b|contributor licen[cs]e/i.test(nameLine[1]!)) hits.push({ kind: "cla", name: `${file}: ${nameLine[1]}`, line });
      else if (/\bDCO\b/.test(nameLine[1]!)) hits.push({ kind: "dco", name: `${file}: ${nameLine[1]}`, line });
    }
    if (ISSUE_LINK_WORKFLOW.test(l) && !/^\s*#/.test(l)) hits.push({ kind: "issue_first", name: file, line });
  });
  if (!hits.some((h) => h.kind === "anti_automation") && ANTI_AUTOMATION_TEXT.test(file)) {
    hits.push({ kind: "anti_automation", name: file, line: 1 });
  }
  // One hit per kind+name is enough.
  const seen = new Set<string>();
  return hits.filter((h) => {
    const k = `${h.kind}|${h.name}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const ANTI_LABEL = /((maybe|possibly|likely|suspected|probably|potential(ly)?|suspicious)[-_ :]*(ai|llm|automated|bot|spam|slop|generated)|\bai[-_ :]*(generated|slop|spam|assisted|policy|prs?|contributions?|written|authored)\b|llm[-_ :]*(generated|spam|written|pr)|from[-_ ]?(an?[-_ ])?llm|\bslop\b|\bvouch|agent[-_ ]?(generated|authored|pr\b)|bot:ai|automated[-_ ]?(pr|contribution)|unattended|low[-_ ]effort)/i;

export function antiAutomationLabels(labels: string[]): string[] {
  return labels.filter((l) => ANTI_LABEL.test(l));
}

const ANTI_CHECK = /(agentscan|unattended|ai[-_ ]?(policy|slop|disclosure|detect\w*|check)|\bslop\b|vouch)/i;
export const CLA_CHECK = /(\bcla\b|license\/cla|easycla|contributor licen[cs]e|cla-assistant|cla-bot|clabot|google-cla|cla\/)/i;
export const DCO_CHECK = /\bdco\b/i;

export function antiAutomationChecks(checks: string[]): string[] {
  return checks.filter((c) => ANTI_CHECK.test(c));
}

export const CLA_FILE = /(^|\/)(cla|CLA)([-_][\w-]+)?(\.(md|txt|rst|pdf))?$|(^|\/)\.clabot$|(^|\/)cla\.json$/;
export const DCO_FILE = /(^|\/)(\.github\/)?dco\.ya?ml$|(^|\/)DCO(\.(md|txt))?$/;

/** The sentence patterns, exported for tests and debugging. */
export const PATTERNS = { AI_TOOL, BAN_VERBS, BAN_WORDS, BAN_NO, DO_NOT_USE, CONDITION, DISCLOSE, ALLOW, COMMS, OWN_WORDS, CODE_WORDS, AGENT, HUMAN_REQUIRED, SELF_ADDRESS, OPEN_PR, STOP };
