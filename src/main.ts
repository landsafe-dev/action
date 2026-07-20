/**
 * Landsafe GitHub Action entrypoint — thin orchestration over lib.ts.
 * Bundled to packages/action/dist/index.cjs by scripts/build.mjs.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  analyzeFiles,
  buildDigest,
  renderDigestMarkdown,
  renderMarkdown,
  COMMENT_MARKER,
  type FileInput,
  type Report,
} from '@landsafe/engine';
import {
  parsePatterns,
  resolveFiles,
  walkFiles,
  decideFailure,
  resolveLicense,
  resolveFailOn,
  parseMode,
  parseSnapshot,
  resolveProUrl,
  upsertCommentSafely,
  frameworkNote,
  digestLicensed,
  digestWindow,
  resolveDigestRepos,
  collectDigestPrs,
  postDigestWebhook,
  type CommentDeps,
  type DigestDeps,
  type DigestPull,
  type FailOn,
  type ResolvedLicense,
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

function splitRepo(full: string): { owner: string; repo: string } {
  const [owner = '', repo = ''] = full.split('/');
  return { owner, repo };
}

function octokitDigestDeps(octokit: Octokit): DigestDeps {
  return {
    // One page at a time — collectRepoPulls stops at the window edge, so we must
    // not hand it an eager paginate() that would walk the repo's full history.
    async listPullsPage(full, page, perPage) {
      const { owner, repo } = splitRepo(full);
      const res = await octokit.rest.pulls.list({
        owner,
        repo,
        state: 'all',
        sort: 'updated',
        direction: 'desc',
        per_page: perPage,
        page,
      });
      return res.data as DigestPull[];
    },
    async listIssueComments(full, issueNumber) {
      const { owner, repo } = splitRepo(full);
      return octokit.paginate(octokit.rest.issues.listComments, {
        owner,
        repo,
        issue_number: issueNumber,
        per_page: 100,
      });
    },
    async listOrgRepos(org) {
      const repos = await octokit.paginate(octokit.rest.repos.listForOrg, { org, per_page: 100 });
      return repos.map((r) => r.full_name);
    },
  };
}

/**
 * Digest mode: aggregate the payloads Landsafe already wrote into the customer's
 * own PR comments, read with the customer's own token. Never fails the run on
 * findings — it is a report, not a gate.
 */
async function runDigest(octokit: Octokit | undefined, license: ResolvedLicense): Promise<void> {
  const licensed = digestLicensed(license);
  if (!licensed.ok) {
    core.setFailed(licensed.message ?? 'Digest requires Landsafe Business.');
    return;
  }
  if (!octokit) {
    core.setFailed('Digest mode needs a github-token with read access to your repos and their pull requests.');
    return;
  }

  const { owner, repo } = github.context.repo;
  const currentRepo = `${owner}/${repo}`;
  const { since, until } = digestWindow(core.getInput('digest-since-days'));
  const dashboardUrl = core.getInput('digest-dashboard-url').trim();
  const webhook = core.getInput('digest-webhook').trim();

  const deps = octokitDigestDeps(octokit);
  const repos = await resolveDigestRepos(deps, core.getInput('digest-repos'), owner, currentRepo, (m) => core.warning(m));
  core.info(`Digest window ${since} → ${until} across ${repos.length} repo(s).`);

  const { prs, unreadable } = await collectDigestPrs(deps, repos, new Date(since), new Date(until), (m) => core.warning(m));
  core.info(`Found ${prs.length} PR(s) carrying a Landsafe report.`);

  const report = buildDigest(prs, { since, until, org: owner, unreadable });
  const markdown = renderDigestMarkdown(report, dashboardUrl ? { dashboardUrl } : {});

  try {
    await core.summary.addRaw(markdown).write();
  } catch (err) {
    core.debug(`Could not write job summary: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (webhook) {
    const ok = await postDigestWebhook(webhook, markdown, (m) => core.warning(m));
    if (ok) core.info('Digest posted to the webhook.');
  }

  core.setOutput('critical', String(report.totals.critical));
  core.setOutput('warning', String(report.totals.warning));
  core.setOutput('info', String(report.totals.info));
  core.setOutput('prs-analyzed', String(report.prsAnalyzed));
  core.setOutput('repos-covered', String(report.reposCovered));
  core.info(
    `Digest: ${report.prsAnalyzed} PR(s), ${report.reposCovered} repo(s), ${report.mergedWithCritical.length} merged with unresolved criticals.`,
  );
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
  const mode = parseMode(core.getInput('mode'));
  const patterns = parsePatterns(core.getInput('paths'));
  const localFailOn = ((core.getInput('fail-on') || 'critical').trim() as FailOn);
  const pgVersion = Number.parseInt(core.getInput('pg-version') || '15', 10) || 15;
  const assumeTransaction = (core.getInput('assume-transaction') || 'true').trim() !== 'false';
  const snapshotPath = core.getInput('snapshot').trim();
  const licenseKey = core.getInput('license') || process.env.LANDSAFE_LICENSE || '';
  const wantComment = (core.getInput('comment') || 'true').trim() !== 'false';
  const proUrl = resolveProUrl(core.getInput('pro-url'));
  const token = core.getInput('github-token') || process.env.GITHUB_TOKEN || '';
  const ignoreRules = core
    .getInput('ignore-rules')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (!['critical', 'warning', 'never'].includes(localFailOn)) {
    throw new Error(`Invalid fail-on value "${localFailOn}" — use 'critical', 'warning', or 'never'.`);
  }

  // --- License (Pro) ---
  const license = resolveLicense(licenseKey || undefined);
  if (license.warning) core.warning(license.warning);
  if (license.pro) core.info('Landsafe Pro license verified.');

  const octokitEarly = token ? github.getOctokit(token) : undefined;
  if (mode === 'digest') {
    await runDigest(octokitEarly, license);
    return;
  }

  // --- Org policy: a signed policy can tighten this repo's threshold, never loosen it. ---
  const { failOn, message: policyNote } = resolveFailOn(localFailOn, license.payload);
  if (policyNote) core.info(policyNote);

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
  const octokit = octokitEarly;

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
    ignoreRules,
  });
  if (ignoreRules.length > 0) core.info(`Ignoring rule(s): ${ignoreRules.join(', ')}`);

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
