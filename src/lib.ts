/**
 * Pure, testable logic for the Landsafe GitHub Action.
 * main.ts is thin orchestration over these functions.
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CommentPayload, DigestPr, Snapshot } from '@landsafe/engine';
import { extractPayload, PAYLOAD_PREFIX } from '@landsafe/engine';
import { effectiveFailOn, verifyLicense, type LicensePayload } from '@landsafe/engine/license';
import { matchAny, normalizePath } from './glob.js';

export const DEFAULT_PATTERNS = [
  '**/migrations/**/*.sql',
  '**/migrate/**/*.sql',
  'db/**/*.sql',
  'sql/**/*.sql',
];

/** Patterns that identify non-SQL migration frameworks we note but do not analyze. */
const FRAMEWORK_PATTERNS = [
  '**/db/migrate/**/*.rb', // Rails
  'db/migrate/**/*.rb',
  '**/migrations/**/*.py', // Django / alembic
];

export function parsePatterns(input: string): string[] {
  const patterns = input
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
  return patterns.length > 0 ? patterns : DEFAULT_PATTERNS;
}

export interface ResolvedFiles {
  /** SQL migration files to analyze (relative paths). */
  sqlFiles: string[];
  /** Non-SQL migration framework files (Rails/Django/alembic) — noted, not analyzed. */
  frameworkFiles: string[];
}

/** Filter candidate paths down to SQL migrations + non-SQL framework migrations. */
export function resolveFiles(candidates: string[], patterns: string[]): ResolvedFiles {
  const sqlFiles: string[] = [];
  const frameworkFiles: string[] = [];
  for (const raw of candidates) {
    const path = normalizePath(raw);
    if (matchAny(patterns, path)) {
      sqlFiles.push(path);
    } else if (matchAny(FRAMEWORK_PATTERNS, path)) {
      frameworkFiles.push(path);
    }
  }
  return { sqlFiles, frameworkFiles };
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'vendor']);

/** Walk a directory tree, returning file paths relative to `root` (forward slashes). */
export function walkFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue;
      const abs = join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(abs, relPath);
      else if (st.isFile()) out.push(relPath);
    }
  };
  walk(root, '');
  return out;
}

// ---------------------------------------------------------------------------
// Failure threshold
// ---------------------------------------------------------------------------

export type FailOn = 'critical' | 'warning' | 'never';

export function decideFailure(
  counts: { critical: number; warning: number; info: number },
  failOn: FailOn,
): { failed: boolean; message?: string } {
  if (failOn === 'never') return { failed: false };
  if (counts.critical > 0) {
    return {
      failed: true,
      message: `Landsafe found ${counts.critical} critical issue${counts.critical === 1 ? '' : 's'} — this migration can take your database down. See the report for safe rewrites.`,
    };
  }
  if (failOn === 'warning' && counts.warning > 0) {
    return {
      failed: true,
      message: `Landsafe found ${counts.warning} warning${counts.warning === 1 ? '' : 's'} (fail-on: warning). See the report for details.`,
    };
  }
  return { failed: false };
}

// ---------------------------------------------------------------------------
// Pro URL
// ---------------------------------------------------------------------------

export const DEFAULT_PRO_URL = 'https://landsafe.dev/#pricing';

/** Resolve the `pro-url` input: blank/whitespace falls back to the default. */
export function resolveProUrl(input: string | undefined): string {
  const trimmed = (input ?? '').trim();
  return trimmed === '' ? DEFAULT_PRO_URL : trimmed;
}

// ---------------------------------------------------------------------------
// License
// ---------------------------------------------------------------------------

export interface ResolvedLicense {
  pro: boolean;
  /** The verified payload — only ever set when `pro` is true. Carries tier + orgPolicy. */
  payload?: LicensePayload;
  warning?: string;
}

export function resolveLicense(
  key: string | undefined,
  verify: typeof verifyLicense = verifyLicense,
): ResolvedLicense {
  if (!key || key.trim() === '') return { pro: false };
  const res = verify(key);
  if (res.valid) {
    // Only a *verified* payload is ever handed onward — an unsigned payload must
    // never reach the org-policy or tier checks.
    return res.payload ? { pro: true, payload: res.payload } : { pro: true };
  }
  return {
    pro: false,
    warning: `Landsafe license key was provided but is not valid (${res.reason ?? 'unknown'}). Running in Free mode — detection rules still apply.`,
  };
}

// ---------------------------------------------------------------------------
// Org policy
// ---------------------------------------------------------------------------

export interface ResolvedFailOn {
  failOn: FailOn;
  forcedByOrg: boolean;
  /** core.info() line explaining the tightening. Set only when forcedByOrg. */
  message?: string;
}

/**
 * The threshold this run actually enforces: the stricter of the repo's own
 * `fail-on` and the org policy carried in the signed license. A policy can only
 * tighten — a repo that already fails on warnings is never loosened to critical.
 */
export function resolveFailOn(local: FailOn, payload: LicensePayload | undefined): ResolvedFailOn {
  const { failOn, forcedByOrg } = effectiveFailOn(local, payload?.orgPolicy);
  if (!forcedByOrg) return { failOn, forcedByOrg: false };
  const org = payload?.org ?? 'unnamed org';
  return {
    failOn,
    forcedByOrg: true,
    message: `Org policy (license: ${org}) requires fail-on=${failOn}; this repo's setting (${local}) was tightened.`,
  };
}

// ---------------------------------------------------------------------------
// Digest mode
// ---------------------------------------------------------------------------

export type Mode = 'review' | 'digest';

export function parseMode(input: string | undefined): Mode {
  const trimmed = (input ?? '').trim().toLowerCase();
  if (trimmed === '' || trimmed === 'review') return 'review';
  if (trimmed === 'digest') return 'digest';
  throw new Error(`Invalid mode "${trimmed}" — use 'review' or 'digest'.`);
}

export const DIGEST_UPSELL = 'Digest requires Landsafe Business — see https://landsafe.dev/#pricing';

/**
 * Digest is an org feature. Tiers 'team' and 'business' are the same product —
 * 'team' is only retained so previously-minted keys keep working. Tier 'repo'
 * (the Pro tier, legacy identifier) does not include it.
 */
export function digestLicensed(license: ResolvedLicense): { ok: boolean; message?: string } {
  const tier = license.payload?.tier;
  if (license.pro && (tier === 'team' || tier === 'business')) return { ok: true };
  return { ok: false, message: DIGEST_UPSELL };
}

/** Multiline "owner/repo" input → cleaned list. Blanks and # comments dropped. */
export function parseDigestRepos(input: string | undefined): string[] {
  return (input ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

export function digestWindow(sinceDaysInput: string | undefined, now: Date = new Date()): { since: string; until: string } {
  const parsed = Number.parseInt((sinceDaysInput ?? '').trim() || '7', 10);
  const days = Number.isFinite(parsed) && parsed > 0 ? parsed : 7;
  return {
    since: new Date(now.getTime() - days * 86_400_000).toISOString(),
    until: now.toISOString(),
  };
}

/** The shape we need off a GitHub pull — deliberately looser than octokit's own type. */
export interface DigestPull {
  number: number;
  title: string;
  html_url: string;
  updated_at: string;
  merged_at?: string | null;
  user?: { login?: string } | null;
}

/**
 * Minimal GitHub surface the digest needs, so the whole walk is testable with a
 * fake octokit and zero network. Mirrors the CommentDeps pattern above.
 */
export interface DigestDeps {
  /** One page of pulls for `repo`, state=all, sorted by updated desc. */
  listPullsPage(repo: string, page: number, perPage: number): Promise<DigestPull[]>;
  listIssueComments(repo: string, issueNumber: number): Promise<IssueComment[]>;
  /** Every "owner/repo" in `org` the token can see. */
  listOrgRepos(org: string): Promise<string[]>;
}

const PER_PAGE = 100;
/** Bound the walk so a busy monorepo can't spin forever on a 7-day window. */
const MAX_PR_PAGES = 10;

/**
 * The repos to cover: the explicit input if given, else every repo in the org.
 * If the org listing fails (token scope, user account, not an org) we fall back
 * to the current repo rather than failing the run.
 */
export async function resolveDigestRepos(
  deps: DigestDeps,
  input: string | undefined,
  org: string,
  currentRepo: string,
  warn: (message: string) => void,
): Promise<string[]> {
  const explicit = parseDigestRepos(input);
  if (explicit.length > 0) return explicit;
  try {
    const repos = await deps.listOrgRepos(org);
    if (repos.length > 0) return repos;
    warn(`No repos found in "${org}" — digesting ${currentRepo} only.`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    warn(`Could not list repos in "${org}" (${reason}) — digesting ${currentRepo} only. Set 'digest-repos' to name them explicitly.`);
  }
  return [currentRepo];
}

/** The Landsafe payload on a PR, if any comment carries one. Latest comment wins. */
export function findPayload(comments: IssueComment[]): CommentPayload | undefined {
  for (let i = comments.length - 1; i >= 0; i--) {
    const body = comments[i]?.body;
    if (!body || !body.includes(PAYLOAD_PREFIX)) continue;
    // A Landsafe comment written by an older engine has no payload — skip it and
    // keep looking rather than treating the PR as unanalyzable.
    const payload = extractPayload(body);
    if (payload) return payload;
  }
  return undefined;
}

/**
 * Pulls updated within [since, until) for one repo. The list is sorted by
 * updated desc, so the first PR older than the window ends the walk — we never
 * page through a repo's full history.
 */
export async function collectRepoPulls(
  deps: DigestDeps,
  repo: string,
  since: Date,
  until: Date,
  perPage: number = PER_PAGE,
): Promise<DigestPull[]> {
  const sinceMs = since.getTime();
  const untilMs = until.getTime();
  const out: DigestPull[] = [];

  for (let page = 1; page <= MAX_PR_PAGES; page++) {
    const pulls = await deps.listPullsPage(repo, page, perPage);
    if (pulls.length === 0) break;

    let pastWindow = false;
    for (const p of pulls) {
      const t = Date.parse(p.updated_at);
      if (!Number.isFinite(t)) continue;
      if (t < sinceMs) {
        pastWindow = true;
        break;
      }
      if (t < untilMs) out.push(p);
    }
    if (pastWindow || pulls.length < perPage) break;
  }
  return out;
}

/**
 * Assemble the DigestPr[] the engine aggregates. PRs Landsafe never commented
 * on, and PRs whose comment predates payloads, are skipped silently — they are
 * simply not part of the record. A repo that errors is warned about, not fatal.
 */
export interface DigestCollection {
  prs: DigestPr[];
  /**
   * Repos we were asked to cover but couldn't read. These are surfaced IN the digest,
   * not just the CI log — a digest that silently omits repos is a wrong answer, and
   * "nothing merged with criticals" is only true if we saw everything.
   */
  unreadable: Array<{ repo: string; reason: string }>;
}

export async function collectDigestPrs(
  deps: DigestDeps,
  repos: string[],
  since: Date,
  until: Date,
  warn: (message: string) => void,
  perPage: number = PER_PAGE,
): Promise<DigestCollection> {
  const prs: DigestPr[] = [];
  const unreadable: Array<{ repo: string; reason: string }> = [];
  for (const repo of repos) {
    let pulls: DigestPull[];
    try {
      pulls = await collectRepoPulls(deps, repo, since, until, perPage);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      warn(`Skipping ${repo}: ${reason}`);
      unreadable.push({ repo, reason });
      continue;
    }
    for (const p of pulls) {
      let payload: CommentPayload | undefined;
      try {
        payload = findPayload(await deps.listIssueComments(repo, p.number));
      } catch (err) {
        warn(`Skipping ${repo}#${p.number}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (!payload) continue;
      const pr: DigestPr = {
        repo,
        number: p.number,
        title: p.title,
        url: p.html_url,
        updatedAt: p.updated_at,
        payload,
      };
      if (p.user?.login) pr.author = p.user.login;
      if (p.merged_at) pr.mergedAt = p.merged_at;
      prs.push(pr);
    }
  }
  return { prs, unreadable };
}

/**
 * POST the digest to a Slack-compatible webhook. A webhook that is down must
 * never fail the run — the digest is already in the job summary either way.
 */
export async function postDigestWebhook(
  url: string,
  markdown: string,
  warn: (message: string) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: markdown }),
    });
    if (!res.ok) {
      warn(`Digest webhook returned ${res.status} ${res.statusText}. The digest is in the job summary.`);
      return false;
    }
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    warn(`Could not POST the digest webhook (${reason}). The digest is in the job summary.`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export function parseSnapshot(json: string): { snapshot?: Snapshot; note?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { note: 'Snapshot file is not valid JSON — ignoring it.' };
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { tables?: unknown }).tables !== 'object' ||
    (parsed as { tables?: unknown }).tables === null
  ) {
    return { note: 'Snapshot file does not look like a landsafe.snapshot.json (missing "tables") — ignoring it.' };
  }
  return { snapshot: parsed as Snapshot };
}

// ---------------------------------------------------------------------------
// Sticky PR comment
// ---------------------------------------------------------------------------

export interface IssueComment {
  id: number;
  body?: string | undefined;
}

/** Minimal comment API so upsert logic is testable without network. */
export interface CommentDeps {
  listComments(issueNumber: number): Promise<IssueComment[]>;
  createComment(issueNumber: number, body: string): Promise<void>;
  updateComment(commentId: number, body: string): Promise<void>;
}

/**
 * Upsert the sticky comment, but never let a comment-post failure fail the run:
 * the job summary is always written regardless. Failures surface via `warn`.
 */
export async function upsertCommentSafely(
  deps: CommentDeps,
  issueNumber: number,
  body: string,
  marker: string,
  warn: (message: string) => void,
): Promise<'updated' | 'created' | 'failed'> {
  try {
    return await upsertComment(deps, issueNumber, body, marker);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    warn(`Could not post PR comment (${reason}). The full report is in the job summary.`);
    return 'failed';
  }
}

/** Find the sticky Landsafe comment (contains `marker`) and update it, else create one. */
export async function upsertComment(
  deps: CommentDeps,
  issueNumber: number,
  body: string,
  marker: string,
): Promise<'updated' | 'created'> {
  const comments = await deps.listComments(issueNumber);
  const existing = comments.find((c) => typeof c.body === 'string' && c.body.includes(marker));
  if (existing) {
    await deps.updateComment(existing.id, body);
    return 'updated';
  }
  await deps.createComment(issueNumber, body);
  return 'created';
}

// ---------------------------------------------------------------------------
// Framework note
// ---------------------------------------------------------------------------

export function frameworkNote(frameworkFiles: string[]): string | undefined {
  if (frameworkFiles.length === 0) return undefined;
  const shown = frameworkFiles.slice(0, 5).map((f) => `\`${f}\``).join(', ');
  const more = frameworkFiles.length > 5 ? ` (+${frameworkFiles.length - 5} more)` : '';
  return `> ℹ️ Landsafe v1 analyzes SQL migrations (Postgres-only). Skipped non-SQL migration files: ${shown}${more}.`;
}
