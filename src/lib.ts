/**
 * Pure, testable logic for the Landsafe GitHub Action.
 * main.ts is thin orchestration over these functions.
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Snapshot } from '@landsafe/engine';
import { verifyLicense } from '@landsafe/engine/license';
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

export function resolveLicense(
  key: string | undefined,
  verify: typeof verifyLicense = verifyLicense,
): { pro: boolean; warning?: string } {
  if (!key || key.trim() === '') return { pro: false };
  const res = verify(key);
  if (res.valid) return { pro: true };
  return {
    pro: false,
    warning: `Landsafe license key was provided but is not valid (${res.reason ?? 'unknown'}). Running in Free mode — detection rules still apply.`,
  };
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
