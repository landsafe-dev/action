/**
 * Landsafe GitHub Action entrypoint — thin orchestration over lib.ts.
 * Bundled to packages/action/dist/index.cjs by scripts/build.mjs.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as core from '@actions/core';
import * as github from '@actions/github';
import { analyzeFiles, renderMarkdown, COMMENT_MARKER, type FileInput, type Report } from '@landsafe/engine';
import {
  parsePatterns,
  resolveFiles,
  walkFiles,
  decideFailure,
  resolveLicense,
  parseSnapshot,
  resolveProUrl,
  upsertCommentSafely,
  frameworkNote,
  type CommentDeps,
  type FailOn,
} from './lib.js';

type Octokit = ReturnType<typeof github.getOctokit>;

function octokitCommentDeps(octokit: Octokit, owner: string, repo: string): CommentDeps {
  return {
    async listComments(issueNumber) {
      return octokit.paginate(octokit.rest.issues.listComments, {
        owner,
        repo,
        issue_number: issueNumber,
        per_page: 100,
      });
    },
    async createComment(issueNumber, body) {
      await octokit.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body });
    },
    async updateComment(commentId, body) {
      await octokit.rest.issues.updateComment({ owner, repo, comment_id: commentId, body });
    },
  };
}

async function changedFilesFromPR(octokit: Octokit): Promise<string[]> {
  const { owner, repo } = github.context.repo;
  const pullNumber = github.context.issue.number;
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });
  return files
    .filter((f) => f.status === 'added' || f.status === 'modified')
    .map((f) => f.filename);
}

async function run(): Promise<void> {
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const patterns = parsePatterns(core.getInput('paths'));
  const failOn = ((core.getInput('fail-on') || 'critical').trim() as FailOn);
  const pgVersion = Number.parseInt(core.getInput('pg-version') || '15', 10) || 15;
  const assumeTransaction = (core.getInput('assume-transaction') || 'true').trim() !== 'false';
  const snapshotPath = core.getInput('snapshot').trim();
  const licenseKey = core.getInput('license') || process.env.LANDSAFE_LICENSE || '';
  const wantComment = (core.getInput('comment') || 'true').trim() !== 'false';
  const proUrl = resolveProUrl(core.getInput('pro-url'));
  const token = core.getInput('github-token') || process.env.GITHUB_TOKEN || '';

  if (!['critical', 'warning', 'never'].includes(failOn)) {
    throw new Error(`Invalid fail-on value "${failOn}" — use 'critical', 'warning', or 'never'.`);
  }

  // --- License (Pro) ---
  const license = resolveLicense(licenseKey || undefined);
  if (license.warning) core.warning(license.warning);
  if (license.pro) core.info('Landsafe Pro license verified.');

  // --- Snapshot (Pro impact numbers) ---
  let snapshot;
  if (snapshotPath) {
    const abs = join(workspace, snapshotPath);
    const candidate = existsSync(abs) ? abs : existsSync(snapshotPath) ? snapshotPath : undefined;
    if (!candidate) {
      core.info(`Snapshot file not found at "${snapshotPath}" — impact estimates will be qualitative.`);
    } else {
      const parsed = parseSnapshot(readFileSync(candidate, 'utf8'));
      if (parsed.note) core.info(parsed.note);
      snapshot = parsed.snapshot;
    }
  }

  // --- Changed files ---
  const eventName = github.context.eventName;
  const isPR = eventName === 'pull_request' || eventName === 'pull_request_target';
  const octokit = token ? github.getOctokit(token) : undefined;

  let candidates: string[];
  if (isPR && octokit) {
    candidates = await changedFilesFromPR(octokit);
    core.info(`Pull request: ${candidates.length} changed file(s) (added/modified).`);
  } else {
    if (isPR && !octokit) {
      core.warning('No github-token available — falling back to scanning the whole workspace.');
    }
    candidates = walkFiles(workspace);
    core.info(`Scanning workspace: ${candidates.length} file(s) considered.`);
  }

  const { sqlFiles, frameworkFiles } = resolveFiles(candidates, patterns);
  core.info(`Matched ${sqlFiles.length} SQL migration file(s).`);

  // Read contents from the checked-out workspace (actions/checkout is a prerequisite).
  const files: FileInput[] = [];
  for (const rel of sqlFiles) {
    const abs = join(workspace, rel);
    if (!existsSync(abs)) {
      core.debug(`Skipping ${rel} — not present in workspace (was actions/checkout run?).`);
      continue;
    }
    files.push({ path: rel, content: readFileSync(abs, 'utf8') });
  }
  if (sqlFiles.length > 0 && files.length === 0) {
    core.warning('Matched SQL files were not found on disk. Add an actions/checkout step before Landsafe.');
  }

  // --- Analyze ---
  const report: Report = analyzeFiles(files, {
    pgVersion,
    assumeTransaction,
    snapshot,
    pro: license.pro,
  });

  let markdown = renderMarkdown(report, { proUrl });
  const note = frameworkNote(frameworkFiles);
  if (note) markdown += `\n\n${note}\n`;

  // --- Sticky PR comment ---
  if (isPR && wantComment) {
    if (!octokit) {
      core.warning('Cannot post the PR comment without a github-token.');
    } else {
      const { owner, repo } = github.context.repo;
      const issueNumber = github.context.issue.number;
      // A comment-post failure must never fail the run — the job summary below
      // is always written regardless.
      const outcome = await upsertCommentSafely(
        octokitCommentDeps(octokit, owner, repo),
        issueNumber,
        markdown,
        COMMENT_MARKER,
        (msg) => core.warning(msg),
      );
      if (outcome !== 'failed') core.info(`PR comment ${outcome}.`);
    }
  }

  // --- Job summary ---
  try {
    await core.summary.addRaw(markdown).write();
  } catch (err) {
    core.debug(`Could not write job summary: ${err instanceof Error ? err.message : String(err)}`);
  }

  // --- Outputs ---
  core.setOutput('critical', String(report.counts.critical));
  core.setOutput('warning', String(report.counts.warning));
  core.setOutput('info', String(report.counts.info));
  core.setOutput('verdict', report.verdict);

  // --- Verdict → exit code ---
  const failure = decideFailure(report.counts, failOn);
  if (failure.failed) {
    core.setFailed(failure.message ?? 'Landsafe found blocking issues.');
  } else {
    core.info(`Landsafe verdict: ${report.verdict} (${report.statementsAnalyzed} statement(s) across ${report.filesAnalyzed} file(s)).`);
  }
}

run().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  core.setFailed(`Landsafe action failed: ${msg}`);
});
