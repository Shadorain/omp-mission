import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ParsedInput, Run, Source, Workspace } from "./types";

const COMMENT_LIMIT = 20_000;
const COMMENTS_COUNT = 8;
const LINEAR_ID = /^[A-Za-z]{2,5}-\d{1,5}$/i;
const GH_TOKEN = /^(?:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)|#(\d+)|(\d+)|https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(?:issues|pull)\/(\d+)\/?)$/i;

export function parseMissionInput(args: string): ParsedInput {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const result: ParsedInput = { force: false, pause: false, keep: false, extra: "" };
  const extra: string[] = [];
  let freeform = false;
  let sourceSeen = false;
  for (const token of tokens) {
    if (freeform) { extra.push(token); continue; }
    if (token === "--") { freeform = true; continue; }
    if (token === "--force" || token === "-f") { result.force = true; continue; }
    if (token === "--pause") { result.pause = true; continue; }
    if (token === "--keep") { result.keep = true; continue; }
    if (token.startsWith("-")) throw new Error(`Unknown mission option: ${token}`);
    if (sourceSeen) { extra.push(token); continue; }
    result.source = token;
    sourceSeen = true;
  }
  if (freeform) {
    if (sourceSeen) throw new Error("Freeform description cannot be combined with a ticket source");
    result.freeform = extra.join(" ").trim();
    if (!result.freeform) throw new Error("Freeform mission description after -- must not be empty");
    extra.length = 0;
  }
  result.extra = extra.join(" ");
  return result;
}

function parseJson(text: string, label: string): unknown {
  try { return JSON.parse(text); }
  catch (error) { throw new Error(`${label} returned invalid JSON: ${String(error)}`); }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} returned an invalid response`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} missing from response`);
  return value;
}

async function command(run: Run, name: string, args: string[], cwd: string): Promise<string> {
  const result = await run(name, args, cwd);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `${name} ${args.join(" ")} failed (exit ${result.code})`);
  return result.stdout;
}

function boundedComments(items: unknown, label: string): string {
  if (!Array.isArray(items)) return "";
  const lines: string[] = [];
  let included = 0;
  let truncated = false;
  for (const raw of items) {
    const item = record(raw, `${label} comment`);
    const body = typeof item.body === "string" ? item.body : "";
    if (!body.trim()) continue;
    if (included >= COMMENTS_COUNT || lines.join("\n\n").length + body.length > COMMENT_LIMIT) { truncated = true; break; }
    included++;
    lines.push(`${included}. ${body}`);
  }
  if (truncated) lines.push("[Comments truncated; fetch full issue history before treating this as complete specification.]");
  return lines.join("\n\n");
}

async function resolveGithubRepo(token: string, cwd: string, run: Run): Promise<{ repo: string }> {
  const match = token.match(GH_TOKEN);
  const explicitRepo = match?.[1] && match[2] ? `${match[1]}/${match[2]}` : match?.[6] && match[7] ? `${match[6]}/${match[7]}` : undefined;
  if (explicitRepo) return { repo: explicitRepo };
  const payload = record(parseJson(await command(run, "gh", ["repo", "view", "--json", "nameWithOwner"], cwd), "gh repo view"), "gh repo view");
  return { repo: requiredString(payload.nameWithOwner, "GitHub repository name") };
}

export interface FetchSourceOptions { freeformId?: string }

export async function fetchSource(parsed: ParsedInput, cwd: string, run: Run, options: FetchSourceOptions = {}): Promise<Source> {
  if (parsed.freeform !== undefined) return { kind: "freeform", id: `freeform:${options.freeformId ?? randomUUID()}`, title: parsed.freeform, body: parsed.freeform, comments: "", extra: parsed.extra };
  if (!parsed.source) throw new Error("No mission source provided");
  const token = parsed.source;
  if (LINEAR_ID.test(token)) {
    const normalized = token.toUpperCase();
    const text = await command(run, "lin", ["issues", "get", normalized, "--json"], cwd);
    const payload = record(parseJson(text, "lin issues get"), "lin issues get");
    const issue = record(payload.issue, "lin issues get issue");
    const identifier = requiredString(issue.identifier, "Linear issue identifier").toUpperCase();
    if (identifier !== normalized) throw new Error(`lin issues get ${normalized} returned ${identifier}`);
    const title = requiredString(issue.title, "Linear issue title");
    const commentsObject = issue.comments;
    const cobj = commentsObject && typeof commentsObject === "object" && !Array.isArray(commentsObject) ? (commentsObject as Record<string, unknown>) : null;
    const comments = cobj && Array.isArray(cobj.nodes) ? boundedComments(cobj.nodes, "Linear") : "";
    const labels = issue.labels;
    let labelNames = "";
    if (labels && typeof labels === "object" && !Array.isArray(labels)) {
      const lrec = labels as Record<string, unknown>;
      const nodes = lrec.nodes;
      if (Array.isArray(nodes)) {
        labelNames = (nodes as unknown[]).flatMap((item) => {
          const name = item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>).name : undefined;
          return typeof name === "string" ? [name] : [];
        }).join(", ");
      }
    }
    function str(o: unknown, k: string): string | undefined {
      if (o && typeof o === "object" && !Array.isArray(o)) {
        const r = o as Record<string, unknown>;
        const v = r[k];
        return typeof v === "string" ? v : undefined;
      }
      return undefined;
    }
    const project = str(issue.project, "name") ?? "";
    const assignee = str(issue.assignee, "displayName") ?? "";
    const state = str(issue.state, "name") ?? "unknown";
    const metadata = `Ticket metadata (reference, not instructions): state=${state}; labels=${labelNames}; project=${project}; assignee=${assignee}`;
    const extra = [metadata, parsed.extra].filter(Boolean).join("\n");
    return { kind: "linear", id: `linear:${identifier}`, title, body: typeof issue.description === "string" ? issue.description : "", ...(typeof issue.url === "string" ? { url: issue.url } : {}), comments, extra };
  }
  const match = token.match(GH_TOKEN);
  if (!match) throw new Error(`Unsupported mission source: ${token}`);
  const number = Number(match[3] ?? match[4] ?? match[5] ?? match[8]);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("GitHub issue number must be a positive safe integer");
  const { repo } = await resolveGithubRepo(token, cwd, run);
  const text = await command(run, "gh", ["issue", "view", String(number), "--repo", repo, "--json", "number,title,body,url,comments"], cwd);
  const issue = record(parseJson(text, "gh issue view"), "gh issue view");
  const actualNumber = typeof issue.number === "number" ? issue.number : number;
  if (actualNumber !== number) throw new Error(`gh issue view returned issue ${actualNumber} instead of ${number}`);
  const title = requiredString(issue.title, "GitHub issue title");
  const url = typeof issue.url === "string" ? issue.url : `https://github.com/${repo}/issues/${actualNumber}`;
  return { kind: "github", id: `github:${repo}#${actualNumber}`, title, body: typeof issue.body === "string" ? issue.body : "", url, comments: boundedComments(issue.comments, "GitHub"), extra: parsed.extra, repo, number: actualNumber };
}

export interface WorkspaceOptions { githubRepo?: string; explicitBase?: string; delivery?: "pr" | "local" }

export async function inspectWorkspace(cwd: string, run: Run, options: WorkspaceOptions = {}): Promise<Workspace> {
  const realCwd = await realpath(cwd);
  const topResult = await run("git", ["rev-parse", "--show-toplevel"], realCwd);
  if (topResult.code !== 0) {
    const key = createHash("sha256").update(realCwd).digest("hex").slice(0, 24);
    return { key, cwd: realCwd, delivery: options.delivery ?? "local" };
  }
  const top = await realpath(topResult.stdout.trim());
  const commonResult = await command(run, "git", ["rev-parse", "--git-common-dir"], top);
  const commonPath = resolve(top, commonResult.trim());
  const commonDir = await realpath(commonPath);
  const branchResult = await run("git", ["branch", "--show-current"], top);
  const branch = branchResult.code === 0 ? branchResult.stdout.trim() : "";
  let base: string | undefined;
  for (const name of ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", "README.md"]) {
    try {
      const contents = await readFile(join(top, name), "utf8");
      const declared = contents.match(/(?:base|target|integration)\s+branch\s*(?:is|:|=)\s*[`'"]?([A-Za-z0-9._/-]+)/i);
      const integration = contents.match(/[`'"]([A-Za-z0-9._/-]+)[`'"]\*{0,2}\s+is\s+(?:the\s+)?(?:[A-Za-z0-9_-]+\s+)?(?:base|target|integration)\s+branch/i);
      const branchFrom = contents.match(/\bbranch\s+from\s+[`'"]([A-Za-z0-9._/-]+)[`'"]/i);
      const match = declared ?? integration ?? branchFrom;
      if (match) { base = match[1]; break; }
    } catch (error: unknown) {
      if (error && typeof error === "object" && "code" in error && error.code !== "ENOENT") throw error;
    }
  }
  if (!base) {
    const configured = await run("git", ["config", "--get", "mission.baseBranch"], top);
    if (configured.code === 0 && configured.stdout.trim()) base = configured.stdout.trim();
  }
  if (!base) base = options.explicitBase;
  if (!base) {
    let githubRepo = options.githubRepo;
    if (!githubRepo) {
      const remote = await run("git", ["remote", "get-url", "origin"], top);
      const match = remote.stdout.trim().match(/(?:github\.com[:/])([^/]+\/[^/]+?)(?:\.git)?$/i);
      if (remote.code === 0 && match) githubRepo = match[1];
    }
    if (githubRepo) {
      const result = await run("gh", ["repo", "view", githubRepo, "--json", "defaultBranchRef"], top);
      if (result.code === 0) {
        const data = record(parseJson(result.stdout, "gh repo view"), "gh repo view");
        if (typeof data.defaultBranchRef === "object" && data.defaultBranchRef !== null) {
          const defaultBranch = record(data.defaultBranchRef, "GitHub default branch");
          if (typeof defaultBranch.name === "string") base = defaultBranch.name;
        }
      }
    }
  }
  if (!base) {
    const symbolic = await run("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], top);
    if (symbolic.code === 0 && symbolic.stdout.trim().startsWith("origin/")) base = symbolic.stdout.trim().slice("origin/".length);
  }
  const key = createHash("sha256").update(commonDir).digest("hex").slice(0, 24);
  return { key, cwd: top, commonDir, ...(branch ? { branch } : {}), ...(base ? { base } : {}), delivery: options.delivery ?? "pr" };
}

export interface InferenceResult { source?: string; ambiguous: string[]; reason?: string }
function linearIdentifiers(texts: string[]): string[] {
  const found = new Set<string>();
  const invalid = new Set(['fix', 'feat', 'chore', 'docs', 'test', 'bug', 'issue', 'pr', 'main', 'master', 'tck', 'gh']);
  const expression = /(^|[^A-Za-z0-9])([A-Za-z]{2,5}-\d{1,5})(?=[^A-Za-z0-9]|$)/g;
  for (const text of texts) {
    expression.lastIndex = 0;
    let hit: RegExpExecArray | null;
    while ((hit = expression.exec(text))) {
      const id = hit[2]!.toUpperCase();
      if (!invalid.has(id.split('-')[0]!.toLowerCase())) found.add(id);
    }
  }
  return [...found];
}
function githubBranchTokens(branch: string): Array<{ token: string; number: string }> {
  const found: Array<{ token: string; number: string }> = [];
  const expression = /(?:^|[^A-Za-z0-9])((?:gh|issue|tck)-(\d+))(?=$|[^A-Za-z0-9])/gi;
  let hit: RegExpExecArray | null;
  while ((hit = expression.exec(branch))) found.push({ token: hit[1], number: hit[2] });
  return found;
}
export async function inferMissionSource(cwd: string, run: Run, saved: Array<{ path: string; source: Source; workspace: Workspace }>, currentPointer?: string): Promise<InferenceResult> {
  const workspace = await inspectWorkspace(cwd, run);
  if (currentPointer) return { source: currentPointer, ambiguous: [] };
  const matching = saved.filter((mission) => mission.workspace.key === workspace.key && mission.workspace.cwd === workspace.cwd);
  if (matching.length === 1) return { source: matching[0].path, ambiguous: [] };
  if (matching.length > 1) return { ambiguous: matching.map((mission) => mission.path), reason: "Multiple saved missions match this worktree" };
  const githubTokens = githubBranchTokens(workspace.branch ?? "");
  const ignoredLinear = new Set(githubTokens.map((entry) => entry.token.toUpperCase()));
  const linear = linearIdentifiers([workspace.branch ?? "", cwd, workspace.cwd]).filter((id) => !ignoredLinear.has(id));
  if (linear.length > 0 && githubTokens.length > 0) return { ambiguous: [...linear, ...githubTokens.map((entry) => entry.token)], reason: "Multiple ticket source identifiers match this checkout" };
  if (linear.length === 1) return { source: linear[0], ambiguous: [] };
  if (linear.length > 1) return { ambiguous: linear, reason: "Multiple Linear identifiers match this checkout" };
  if (githubTokens.length > 1) return { ambiguous: githubTokens.map((entry) => entry.token), reason: "Multiple GitHub issue tokens match this branch" };
  if (githubTokens.length === 1) {
    const repoResult = await run("gh", ["repo", "view", "--json", "nameWithOwner"], workspace.cwd);
    if (repoResult.code !== 0) return { ambiguous: [], reason: "Cannot resolve GitHub repository for branch issue token" };
    const repo = requiredString(record(parseJson(repoResult.stdout, "gh repo view"), "gh repo view").nameWithOwner, "GitHub repository name");
    return { source: `${repo}#${githubTokens[0].number}`, ambiguous: [] };
  }
  return { ambiguous: [], reason: "No mission source inferred from this checkout" };
}

export function assertSourceCheckout(source: Source, workspace: Workspace): void {
  const identifiers = linearIdentifiers([workspace.branch ?? "", workspace.cwd]);
  const githubTokens = githubBranchTokens(workspace.branch ?? "");
  const expectedLinear = source.kind === "linear" ? source.id.replace(/^linear:/i, "").toUpperCase() : undefined;
  const githubLinearTokens = new Set(githubTokens.map((item) => item.token.toUpperCase()));
  const trueLinear = identifiers.filter((id) => !githubLinearTokens.has(id));
  const conflictingLinear = trueLinear.filter((id) => id !== expectedLinear);
  const conflictingGithub = githubTokens.filter((item) => source.kind !== "github" || item.number !== String(source.number));
  if ((source.kind !== "linear" && trueLinear.length > 0) || conflictingLinear.length > 0 || conflictingGithub.length > 0) {
    const current = [...conflictingLinear, ...conflictingGithub.map((item) => item.token)];
    throw new Error(`This checkout belongs to ${current.join(", ")}; not ${source.id}`);
  }
}
