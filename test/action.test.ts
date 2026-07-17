import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { globToRegExp, matchGlob, matchAny, normalizePath } from '../src/glob.js';
import { analyzeFiles, renderMarkdown } from '@landsafe/engine';
import { buildDigest, encodePayload, type CommentPayload } from '@landsafe/engine';
import {
  DEFAULT_PATTERNS,
  DEFAULT_PRO_URL,
  DIGEST_UPSELL,
  parsePatterns,
  resolveFiles,
  decideFailure,
  resolveLicense,
  resolveFailOn,
  parseMode,
  resolveProUrl,
  parseSnapshot,
  upsertComment,
  upsertCommentSafely,
  frameworkNote,
  digestLicensed,
  digestWindow,
  parseDigestRepos,
  resolveDigestRepos,
  findPayload,
  collectRepoPulls,
  collectDigestPrs,
  postDigestWebhook,
  type CommentDeps,
  type DigestDeps,
  type DigestPull,
  type IssueComment,
} from '../src/lib.js';

// ---------------------------------------------------------------------------
// glob matcher
// ---------------------------------------------------------------------------

describe('glob matcher', () => {
  it('matches * within a segment only', () => {
    expect(matchGlob('db/*.sql', 'db/001.sql')).toBe(true);
    expect(matchGlob('db/*.sql', 'db/sub/001.sql')).toBe(false);
    expect(matchGlob('*.sql', 'a.sql')).toBe(true);
    expect(matchGlob('*.sql', 'db/a.sql')).toBe(false);
  });

  it('matches ? as exactly one non-slash char', () => {
    expect(matchGlob('db/00?.sql', 'db/001.sql')).toBe(true);
    expect(matchGlob('db/00?.sql', 'db/0012.sql')).toBe(false);
    expect(matchGlob('db/00?.sql', 'db/00/.sql')).toBe(false);
  });

  it('matches ** across zero or more directories', () => {
    expect(matchGlob('**/migrations/**/*.sql', 'migrations/001_init.sql')).toBe(true);
    expect(matchGlob('**/migrations/**/*.sql', 'apps/api/migrations/2024/001.sql')).toBe(true);
    expect(matchGlob('**/migrations/**/*.sql', 'apps/api/migrations.sql')).toBe(false);
    expect(matchGlob('db/**/*.sql', 'db/001.sql')).toBe(true);
    expect(matchGlob('db/**/*.sql', 'db/a/b/001.sql')).toBe(true);
    expect(matchGlob('db/**/*.sql', 'other/db/001.sql')).toBe(false);
  });

  it('escapes regex specials in literals', () => {
    expect(matchGlob('db/v1.0/*.sql', 'db/v1.0/x.sql')).toBe(true);
    expect(matchGlob('db/v1.0/*.sql', 'db/v1x0/x.sql')).toBe(false);
    expect(globToRegExp('a+b/*.sql').test('a+b/x.sql')).toBe(true);
  });

  it('normalizes paths (backslashes, leading ./)', () => {
    expect(normalizePath('.\\db\\001.sql'.replace(/\\/g, '\\'))).toContain('db');
    expect(matchGlob('db/*.sql', './db/001.sql')).toBe(true);
    expect(matchAny(DEFAULT_PATTERNS, 'sql/schema/patch.sql')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// changed-file filtering
// ---------------------------------------------------------------------------

describe('resolveFiles', () => {
  const patterns = parsePatterns(DEFAULT_PATTERNS.join('\n'));

  it('keeps SQL migrations matching the globs', () => {
    const { sqlFiles } = resolveFiles(
      [
        'db/migrations/001_init.sql',
        'services/billing/migrations/002_add_col.sql',
        'sql/hotfix.sql',
        'README.md',
        'src/index.ts',
        'db/seeds/seed.sql', // matches db/**/*.sql
      ],
      patterns,
    );
    expect(sqlFiles).toEqual([
      'db/migrations/001_init.sql',
      'services/billing/migrations/002_add_col.sql',
      'sql/hotfix.sql',
      'db/seeds/seed.sql',
    ]);
  });

  it('collects non-SQL framework migrations separately (Rails, Django/alembic)', () => {
    const { sqlFiles, frameworkFiles } = resolveFiles(
      [
        'db/migrate/20240101000000_add_users.rb',
        'app/migrations/0002_auto.py',
        'alembic/migrations/versions.py',
        'app/models.py',
      ],
      patterns,
    );
    expect(sqlFiles).toEqual([]);
    expect(frameworkFiles).toContain('db/migrate/20240101000000_add_users.rb');
    expect(frameworkFiles).toContain('app/migrations/0002_auto.py');
    expect(frameworkFiles).not.toContain('app/models.py');
    const note = frameworkNote(frameworkFiles);
    expect(note).toContain('Landsafe v1 analyzes SQL migrations');
  });

  it('returns no note when nothing framework-shaped changed', () => {
    expect(frameworkNote([])).toBeUndefined();
  });

  it('parsePatterns falls back to defaults on empty input', () => {
    expect(parsePatterns('')).toEqual(DEFAULT_PATTERNS);
    expect(parsePatterns('  \n \n')).toEqual(DEFAULT_PATTERNS);
    expect(parsePatterns('db/**/*.sql\n')).toEqual(['db/**/*.sql']);
  });
});

// ---------------------------------------------------------------------------
// sticky comment upsert
// ---------------------------------------------------------------------------

const MARKER = '<!-- landsafe-comment -->';

function fakeDeps(existing: IssueComment[]) {
  const calls: { created: string[]; updated: Array<{ id: number; body: string }> } = {
    created: [],
    updated: [],
  };
  const deps: CommentDeps = {
    async listComments() {
      return existing;
    },
    async createComment(_issue, body) {
      calls.created.push(body);
    },
    async updateComment(id, body) {
      calls.updated.push({ id, body });
    },
  };
  return { deps, calls };
}

describe('upsertComment', () => {
  it('creates when no comment contains the marker', async () => {
    const { deps, calls } = fakeDeps([
      { id: 1, body: 'LGTM' },
      { id: 2, body: undefined },
    ]);
    const outcome = await upsertComment(deps, 7, `${MARKER}\nreport`, MARKER);
    expect(outcome).toBe('created');
    expect(calls.created).toHaveLength(1);
    expect(calls.updated).toHaveLength(0);
  });

  it('updates the existing sticky comment in place', async () => {
    const { deps, calls } = fakeDeps([
      { id: 10, body: 'unrelated' },
      { id: 42, body: `${MARKER}\nold report` },
      { id: 50, body: 'another' },
    ]);
    const outcome = await upsertComment(deps, 7, `${MARKER}\nnew report`, MARKER);
    expect(outcome).toBe('updated');
    expect(calls.created).toHaveLength(0);
    expect(calls.updated).toEqual([{ id: 42, body: `${MARKER}\nnew report` }]);
  });
});

describe('upsertCommentSafely', () => {
  it('passes through the outcome when posting succeeds', async () => {
    const { deps, calls } = fakeDeps([]);
    const warnings: string[] = [];
    const outcome = await upsertCommentSafely(deps, 7, `${MARKER}\nreport`, MARKER, (m) => warnings.push(m));
    expect(outcome).toBe('created');
    expect(calls.created).toHaveLength(1);
    expect(warnings).toHaveLength(0);
  });

  it('warns (never throws) when posting fails — report stays in the job summary', async () => {
    const deps: CommentDeps = {
      async listComments() {
        throw new Error('Resource not accessible by integration');
      },
      async createComment() {},
      async updateComment() {},
    };
    const warnings: string[] = [];
    const outcome = await upsertCommentSafely(deps, 7, 'body', MARKER, (m) => warnings.push(m));
    expect(outcome).toBe('failed');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Could not post PR comment');
    expect(warnings[0]).toContain('Resource not accessible by integration');
    expect(warnings[0]).toContain('The full report is in the job summary.');
  });

  it('warns when create (not just list) fails', async () => {
    const deps: CommentDeps = {
      async listComments() {
        return [];
      },
      async createComment() {
        throw new Error('403 Forbidden');
      },
      async updateComment() {},
    };
    const warnings: string[] = [];
    expect(await upsertCommentSafely(deps, 7, 'body', MARKER, (m) => warnings.push(m))).toBe('failed');
    expect(warnings[0]).toContain('403 Forbidden');
  });
});

// ---------------------------------------------------------------------------
// pro-url plumbing
// ---------------------------------------------------------------------------

describe('resolveProUrl', () => {
  it('defaults to the pricing URL when unset or blank', () => {
    expect(DEFAULT_PRO_URL).toBe('https://landsafe.dev/#pricing');
    expect(resolveProUrl(undefined)).toBe(DEFAULT_PRO_URL);
    expect(resolveProUrl('')).toBe(DEFAULT_PRO_URL);
    expect(resolveProUrl('   ')).toBe(DEFAULT_PRO_URL);
  });

  it('passes a custom URL through (trimmed)', () => {
    expect(resolveProUrl(' https://example.com/upgrade ')).toBe('https://example.com/upgrade');
  });

  it('a custom proUrl reaches the rendered markdown Pro links', () => {
    const report = analyzeFiles(
      [{ path: 'db/migrations/001_bad.sql', content: 'CREATE INDEX idx_users_email ON users (email);' }],
      { pgVersion: 15, assumeTransaction: true, pro: false },
    );
    const custom = renderMarkdown(report, { proUrl: 'https://example.com/upgrade' });
    expect(custom).toContain('https://example.com/upgrade');
    expect(custom).not.toContain('https://landsafe.dev/#pricing');

    const dflt = renderMarkdown(report);
    expect(dflt).toContain('https://landsafe.dev/#pricing');
  });
});

// ---------------------------------------------------------------------------
// fail-on thresholds
// ---------------------------------------------------------------------------

describe('decideFailure', () => {
  it("fails on criticals when fail-on is 'critical'", () => {
    expect(decideFailure({ critical: 2, warning: 0, info: 0 }, 'critical').failed).toBe(true);
    expect(decideFailure({ critical: 0, warning: 5, info: 3 }, 'critical').failed).toBe(false);
    expect(decideFailure({ critical: 0, warning: 0, info: 0 }, 'critical').failed).toBe(false);
  });

  it("fails on warnings too when fail-on is 'warning'", () => {
    expect(decideFailure({ critical: 0, warning: 1, info: 0 }, 'warning').failed).toBe(true);
    expect(decideFailure({ critical: 1, warning: 0, info: 0 }, 'warning').failed).toBe(true);
    expect(decideFailure({ critical: 0, warning: 0, info: 9 }, 'warning').failed).toBe(false);
  });

  it("never fails when fail-on is 'never'", () => {
    expect(decideFailure({ critical: 3, warning: 3, info: 0 }, 'never').failed).toBe(false);
  });

  it('produces a crisp message', () => {
    const res = decideFailure({ critical: 1, warning: 0, info: 0 }, 'critical');
    expect(res.message).toMatch(/1 critical issue /);
  });
});

// ---------------------------------------------------------------------------
// license wiring
// ---------------------------------------------------------------------------

function b64url(b: Buffer): string {
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function mintWith(privatePem: string, payload: object): string {
  const body = Buffer.from(JSON.stringify(payload));
  const sig = sign(null, body, createPrivateKey(privatePem));
  return `LSK1.${b64url(body)}.${b64url(sig)}`;
}

const realKeyPath = join(__dirname, '../../../secrets/landsafe-private.pem');

describe('resolveLicense', () => {
  it('enables pro for a key signed with the real private key', () => {
    const pem = readFileSync(realKeyPath, 'utf8');
    const key = mintWith(pem, { plan: 'pro', email: 'ci@example.com', issuedAt: 1 });
    const res = resolveLicense(key);
    expect(res.pro).toBe(true);
    expect(res.warning).toBeUndefined();
  });

  it('stays free (with a warning, never a failure) for an invalid key', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const forged = mintWith(
      privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      { plan: 'pro' },
    );
    const res = resolveLicense(forged);
    expect(res.pro).toBe(false);
    expect(res.warning).toContain('bad-signature');

    const garbage = resolveLicense('garbage');
    expect(garbage.pro).toBe(false);
    expect(garbage.warning).toContain('malformed');
  });

  it('stays free with no warning when no key is provided', () => {
    expect(resolveLicense(undefined)).toEqual({ pro: false });
    expect(resolveLicense('')).toEqual({ pro: false });
    expect(resolveLicense('   ')).toEqual({ pro: false });
  });
});

function mintReal(payload: object): string {
  return mintWith(readFileSync(realKeyPath, 'utf8'), payload);
}

// ---------------------------------------------------------------------------
// org policy
// ---------------------------------------------------------------------------

describe('resolveFailOn (org policy)', () => {
  it('tightens a repo that is looser than the org requires', () => {
    const license = resolveLicense(
      mintReal({ plan: 'pro', tier: 'business', org: 'acme', orgPolicy: { failOn: 'warning' } }),
    );
    const res = resolveFailOn('critical', license.payload);
    expect(res.failOn).toBe('warning');
    expect(res.forcedByOrg).toBe(true);
    expect(res.message).toBe(
      "Org policy (license: acme) requires fail-on=warning; this repo's setting (critical) was tightened.",
    );
  });

  it('tightens a repo that had opted out entirely', () => {
    const license = resolveLicense(
      mintReal({ plan: 'pro', tier: 'team', org: 'acme', orgPolicy: { failOn: 'critical' } }),
    );
    const res = resolveFailOn('never', license.payload);
    expect(res.failOn).toBe('critical');
    expect(res.forcedByOrg).toBe(true);
  });

  it('cannot loosen a repo that is already stricter than the policy', () => {
    const license = resolveLicense(
      mintReal({ plan: 'pro', tier: 'business', org: 'acme', orgPolicy: { failOn: 'critical' } }),
    );
    const res = resolveFailOn('warning', license.payload);
    expect(res.failOn).toBe('warning');
    expect(res.forcedByOrg).toBe(false);
    expect(res.message).toBeUndefined();
  });

  it("cannot loosen a repo to 'never'", () => {
    const license = resolveLicense(
      mintReal({ plan: 'pro', tier: 'business', org: 'acme', orgPolicy: { failOn: 'never' } }),
    );
    expect(resolveFailOn('critical', license.payload).failOn).toBe('critical');
    expect(resolveFailOn('warning', license.payload).failOn).toBe('warning');
  });

  it('leaves the local setting alone with no license or no policy', () => {
    expect(resolveFailOn('critical', undefined)).toEqual({ failOn: 'critical', forcedByOrg: false });
    const noPolicy = resolveLicense(mintReal({ plan: 'pro', tier: 'business', org: 'acme' }));
    expect(resolveFailOn('never', noPolicy.payload)).toEqual({ failOn: 'never', forcedByOrg: false });
  });

  it('an unsigned policy never reaches the decision — a forged key stays Free', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const forged = resolveLicense(
      mintWith(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), {
        plan: 'pro',
        tier: 'business',
        org: 'evil',
        orgPolicy: { failOn: 'never' },
      }),
    );
    expect(forged.payload).toBeUndefined();
    expect(resolveFailOn('critical', forged.payload).failOn).toBe('critical');
  });

  // The policy is only real if it reaches the exit code.
  it('the tightened threshold drives the real exit decision', () => {
    const counts = { critical: 0, warning: 2, info: 0 };
    // Repo alone: warnings do not fail.
    expect(decideFailure(counts, resolveFailOn('critical', undefined).failOn).failed).toBe(false);

    const license = resolveLicense(
      mintReal({ plan: 'pro', tier: 'business', org: 'acme', orgPolicy: { failOn: 'warning' } }),
    );
    const failure = decideFailure(counts, resolveFailOn('critical', license.payload).failOn);
    expect(failure.failed).toBe(true);
    expect(failure.message).toContain('fail-on: warning');
  });

  it('org policy cannot make a failing repo pass', () => {
    const license = resolveLicense(
      mintReal({ plan: 'pro', tier: 'business', org: 'acme', orgPolicy: { failOn: 'never' } }),
    );
    const counts = { critical: 1, warning: 0, info: 0 };
    expect(decideFailure(counts, resolveFailOn('critical', license.payload).failOn).failed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// digest mode
// ---------------------------------------------------------------------------

describe('parseMode', () => {
  it('defaults to review and accepts digest', () => {
    expect(parseMode(undefined)).toBe('review');
    expect(parseMode('')).toBe('review');
    expect(parseMode(' review ')).toBe('review');
    expect(parseMode('Digest')).toBe('digest');
  });

  it('rejects anything else', () => {
    expect(() => parseMode('report')).toThrow(/Invalid mode/);
  });
});

describe('digestLicensed', () => {
  it("rejects a 'repo'-tier (Pro) license — digest is a Business feature", () => {
    const license = resolveLicense(mintReal({ plan: 'pro', tier: 'repo', org: 'acme' }));
    expect(license.pro).toBe(true);
    expect(digestLicensed(license)).toEqual({ ok: false, message: DIGEST_UPSELL });
    expect(DIGEST_UPSELL).toBe('Digest requires Landsafe Business — see https://landsafe.dev/#pricing');
  });

  it("accepts both 'team' and 'business' — they are the same product", () => {
    expect(digestLicensed(resolveLicense(mintReal({ plan: 'pro', tier: 'team' })))).toEqual({ ok: true });
    expect(digestLicensed(resolveLicense(mintReal({ plan: 'pro', tier: 'business' })))).toEqual({ ok: true });
  });

  it('rejects a tierless legacy key, no key, and a forged Business key', () => {
    expect(digestLicensed(resolveLicense(mintReal({ plan: 'pro' }))).ok).toBe(false);
    expect(digestLicensed(resolveLicense(undefined)).ok).toBe(false);
    const { privateKey } = generateKeyPairSync('ed25519');
    const forged = mintWith(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), {
      plan: 'pro',
      tier: 'business',
    });
    expect(digestLicensed(resolveLicense(forged)).ok).toBe(false);
  });
});

describe('digestWindow', () => {
  const now = new Date('2026-07-15T12:00:00.000Z');

  it('defaults to 7 days back', () => {
    expect(digestWindow(undefined, now)).toEqual({
      since: '2026-07-08T12:00:00.000Z',
      until: '2026-07-15T12:00:00.000Z',
    });
  });

  it('honours a custom window and falls back on nonsense', () => {
    expect(digestWindow('1', now).since).toBe('2026-07-14T12:00:00.000Z');
    expect(digestWindow('abc', now).since).toBe('2026-07-08T12:00:00.000Z');
    expect(digestWindow('0', now).since).toBe('2026-07-08T12:00:00.000Z');
    expect(digestWindow('-3', now).since).toBe('2026-07-08T12:00:00.000Z');
  });
});

// --- fake octokit ---------------------------------------------------------

function payloadFor(counts: { critical: number; warning: number; info: number }, rules: string[] = []): CommentPayload {
  return {
    v: 1,
    ts: '2026-07-14T00:00:00.000Z',
    e: '0.1.0',
    pro: true,
    verdict: counts.critical > 0 ? 'danger' : 'ok',
    counts,
    files: 1,
    stmts: 1,
    findings: rules.map((r) => ({ r, s: 'critical' as const, f: 'db/migrations/001.sql', l: 1 })),
  };
}

function landsafeComment(payload: CommentPayload): IssueComment {
  return { id: 1, body: `## Landsafe\nreport text\n${encodePayload(payload)}` };
}

interface FakeRepoData {
  pages: DigestPull[][];
  comments: Record<number, IssueComment[]>;
}

function fakeDigest(repos: Record<string, FakeRepoData>, orgRepos?: string[] | Error) {
  const calls: { pulls: Array<{ repo: string; page: number }>; comments: Array<{ repo: string; number: number }> } = {
    pulls: [],
    comments: [],
  };
  const deps: DigestDeps = {
    async listPullsPage(repo, page) {
      calls.pulls.push({ repo, page });
      return repos[repo]?.pages[page - 1] ?? [];
    },
    async listIssueComments(repo, number) {
      calls.comments.push({ repo, number });
      return repos[repo]?.comments[number] ?? [];
    },
    async listOrgRepos() {
      if (orgRepos instanceof Error) throw orgRepos;
      return orgRepos ?? [];
    },
  };
  return { deps, calls };
}

function pull(number: number, updatedAt: string, extra: Partial<DigestPull> = {}): DigestPull {
  return {
    number,
    title: `PR ${number}`,
    html_url: `https://github.com/acme/api/pull/${number}`,
    updated_at: updatedAt,
    user: { login: 'dev' },
    ...extra,
  };
}

const SINCE = new Date('2026-07-08T00:00:00.000Z');
const UNTIL = new Date('2026-07-15T00:00:00.000Z');

describe('parseDigestRepos', () => {
  it('cleans blanks and comments', () => {
    expect(parseDigestRepos('acme/api\n\n  acme/web  \n# skip me\n')).toEqual(['acme/api', 'acme/web']);
    expect(parseDigestRepos(undefined)).toEqual([]);
  });
});

describe('resolveDigestRepos', () => {
  it('uses the explicit list when given, without calling the org listing', async () => {
    const { deps } = fakeDigest({}, new Error('must not be called'));
    const warnings: string[] = [];
    const repos = await resolveDigestRepos(deps, 'acme/api\nacme/web', 'acme', 'acme/api', (m) => warnings.push(m));
    expect(repos).toEqual(['acme/api', 'acme/web']);
    expect(warnings).toEqual([]);
  });

  it('lists the org when no repos are named', async () => {
    const { deps } = fakeDigest({}, ['acme/api', 'acme/web']);
    const repos = await resolveDigestRepos(deps, '', 'acme', 'acme/api', () => {});
    expect(repos).toEqual(['acme/api', 'acme/web']);
  });

  it('falls back to the current repo (warning, not failure) when the org listing fails', async () => {
    const { deps } = fakeDigest({}, new Error('Not Found'));
    const warnings: string[] = [];
    const repos = await resolveDigestRepos(deps, '', 'acme', 'acme/api', (m) => warnings.push(m));
    expect(repos).toEqual(['acme/api']);
    expect(warnings[0]).toContain('Could not list repos in "acme"');
    expect(warnings[0]).toContain('Not Found');
  });

  it('falls back to the current repo when the org is empty', async () => {
    const { deps } = fakeDigest({}, []);
    const warnings: string[] = [];
    expect(await resolveDigestRepos(deps, '', 'acme', 'acme/api', (m) => warnings.push(m))).toEqual(['acme/api']);
    expect(warnings[0]).toContain('No repos found');
  });
});

describe('findPayload', () => {
  it('reads the payload out of a Landsafe comment', () => {
    const p = payloadFor({ critical: 1, warning: 0, info: 0 });
    expect(findPayload([{ id: 9, body: 'LGTM' }, landsafeComment(p)])?.counts.critical).toBe(1);
  });

  it('returns undefined for a Landsafe comment written before payloads existed', () => {
    expect(findPayload([{ id: 1, body: '## Landsafe\nold report, no payload' }])).toBeUndefined();
  });

  it('returns undefined when nothing carries a payload', () => {
    expect(findPayload([])).toBeUndefined();
    expect(findPayload([{ id: 1, body: undefined }, { id: 2, body: 'ship it' }])).toBeUndefined();
  });

  it('ignores a corrupt payload and keeps looking at older comments', () => {
    const good = payloadFor({ critical: 2, warning: 0, info: 0 });
    const corrupt: IssueComment = { id: 3, body: '<!-- landsafe-data:@@@not-base64@@@ -->' };
    expect(findPayload([landsafeComment(good), corrupt])?.counts.critical).toBe(2);
  });

  it('the latest payload wins', () => {
    const older = landsafeComment(payloadFor({ critical: 5, warning: 0, info: 0 }));
    const newer = landsafeComment(payloadFor({ critical: 1, warning: 0, info: 0 }));
    expect(findPayload([older, newer])?.counts.critical).toBe(1);
  });
});

describe('collectRepoPulls', () => {
  it('stops paging at the window edge — never walks full history', async () => {
    const { deps, calls } = fakeDigest({
      'acme/api': {
        // A full page (perPage 2) whose second PR predates the window: the walk
        // must stop here rather than requesting page 2.
        pages: [
          [pull(3, '2026-07-14T00:00:00.000Z'), pull(2, '2026-01-01T00:00:00.000Z')],
          [pull(1, '2025-01-01T00:00:00.000Z')],
        ],
        comments: {},
      },
    });
    const pulls = await collectRepoPulls(deps, 'acme/api', SINCE, UNTIL, 2);
    expect(pulls.map((p) => p.number)).toEqual([3]);
    expect(calls.pulls).toEqual([{ repo: 'acme/api', page: 1 }]);
  });

  it('keeps paging while the whole page is inside the window', async () => {
    const { deps, calls } = fakeDigest({
      'acme/api': {
        pages: [
          [pull(4, '2026-07-14T00:00:00.000Z'), pull(3, '2026-07-13T00:00:00.000Z')],
          [pull(2, '2026-07-12T00:00:00.000Z'), pull(1, '2026-02-01T00:00:00.000Z')],
        ],
        comments: {},
      },
    });
    const pulls = await collectRepoPulls(deps, 'acme/api', SINCE, UNTIL, 2);
    expect(pulls.map((p) => p.number)).toEqual([4, 3, 2]);
    expect(calls.pulls).toHaveLength(2);
  });

  it('excludes PRs updated after the window end', async () => {
    const { deps } = fakeDigest({
      'acme/api': { pages: [[pull(2, '2026-07-20T00:00:00.000Z'), pull(1, '2026-07-10T00:00:00.000Z')]], comments: {} },
    });
    const pulls = await collectRepoPulls(deps, 'acme/api', SINCE, UNTIL, 2);
    expect(pulls.map((p) => p.number)).toEqual([1]);
  });
});

describe('collectDigestPrs', () => {
  it('assembles DigestPr[] and skips PRs with no payload to read', async () => {
    const analyzed = payloadFor({ critical: 1, warning: 2, info: 0 }, ['create-index-blocking']);
    const { deps } = fakeDigest({
      'acme/api': {
        pages: [
          [
            pull(10, '2026-07-14T00:00:00.000Z', { merged_at: '2026-07-14T01:00:00.000Z' }),
            pull(11, '2026-07-13T00:00:00.000Z'), // (a) Landsafe comment, no payload
            pull(12, '2026-07-12T00:00:00.000Z'), // (b) no Landsafe comment at all
          ],
        ],
        comments: {
          10: [{ id: 1, body: 'nice' }, landsafeComment(analyzed)],
          11: [{ id: 2, body: '## Landsafe\nreport from an older engine' }],
          12: [{ id: 3, body: 'LGTM' }],
        },
      },
    });
    const warnings: string[] = [];
    const { prs: prs } = await collectDigestPrs(deps, ['acme/api'], SINCE, UNTIL, (m) => warnings.push(m), 100);

    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({
      repo: 'acme/api',
      number: 10,
      title: 'PR 10',
      url: 'https://github.com/acme/api/pull/10',
      author: 'dev',
      mergedAt: '2026-07-14T01:00:00.000Z',
      updatedAt: '2026-07-14T00:00:00.000Z',
    });
    expect(prs[0]?.payload.counts).toEqual({ critical: 1, warning: 2, info: 0 });
    // Skipping is silent — a PR Landsafe never reviewed is not a problem to report.
    expect(warnings).toEqual([]);
  });

  it('omits mergedAt for an open PR', async () => {
    const { deps } = fakeDigest({
      'acme/api': {
        pages: [[pull(1, '2026-07-14T00:00:00.000Z', { merged_at: null })]],
        comments: { 1: [landsafeComment(payloadFor({ critical: 0, warning: 1, info: 0 }))] },
      },
    });
    const { prs: prs } = await collectDigestPrs(deps, ['acme/api'], SINCE, UNTIL, () => {}, 100);
    expect(prs[0]?.mergedAt).toBeUndefined();
  });

  it('spans repos and warns (never crashes) on a repo it cannot read', async () => {
    const p = payloadFor({ critical: 1, warning: 0, info: 0 }, ['drop-column']);
    const deps: DigestDeps = {
      async listPullsPage(repo) {
        if (repo === 'acme/secret') throw new Error('404 Not Found');
        return [pull(1, '2026-07-14T00:00:00.000Z', { merged_at: '2026-07-14T02:00:00.000Z' })];
      },
      async listIssueComments() {
        return [landsafeComment(p)];
      },
      async listOrgRepos() {
        return [];
      },
    };
    const warnings: string[] = [];
    const { prs: prs } = await collectDigestPrs(
      deps,
      ['acme/api', 'acme/secret', 'acme/web'],
      SINCE,
      UNTIL,
      (m) => warnings.push(m),
      100,
    );
    expect(prs.map((x) => x.repo)).toEqual(['acme/api', 'acme/web']);
    expect(warnings).toEqual(['Skipping acme/secret: 404 Not Found']);
  });

  it('feeds buildDigest — merged-with-critical is the number that survives the round trip', async () => {
    const { deps } = fakeDigest({
      'acme/api': {
        pages: [[pull(10, '2026-07-14T00:00:00.000Z', { merged_at: '2026-07-14T01:00:00.000Z' })]],
        comments: { 10: [landsafeComment(payloadFor({ critical: 1, warning: 0, info: 0 }, ['create-index-blocking']))] },
      },
    });
    const { prs: prs } = await collectDigestPrs(deps, ['acme/api'], SINCE, UNTIL, () => {}, 100);
    const report = buildDigest(prs, { since: SINCE.toISOString(), until: UNTIL.toISOString(), org: 'acme' });
    expect(report.prsAnalyzed).toBe(1);
    expect(report.totals.critical).toBe(1);
    expect(report.mergedWithCritical).toHaveLength(1);
    expect(report.mergedWithCritical[0]?.rules).toEqual(['create-index-blocking']);
    expect(report.quiet).toBe(false);
  });
});

describe('postDigestWebhook', () => {
  it('POSTs Slack-compatible JSON', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return { ok: true, status: 200, statusText: 'OK' } as Response;
    }) as unknown as typeof fetch;

    const warnings: string[] = [];
    expect(await postDigestWebhook('https://hooks.example/x', '# Digest', (m) => warnings.push(m), fakeFetch)).toBe(true);
    expect(seen[0]?.url).toBe('https://hooks.example/x');
    expect(seen[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({ text: '# Digest' });
    expect(warnings).toEqual([]);
  });

  // A webhook outage must never turn a report into a red build.
  it('warns (never throws) when the POST rejects', async () => {
    const fakeFetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const warnings: string[] = [];
    expect(await postDigestWebhook('https://hooks.example/x', '# Digest', (m) => warnings.push(m), fakeFetch)).toBe(false);
    expect(warnings[0]).toContain('ECONNREFUSED');
    expect(warnings[0]).toContain('The digest is in the job summary.');
  });

  it('warns on a non-2xx response', async () => {
    const fakeFetch = (async () => ({ ok: false, status: 500, statusText: 'Server Error' }) as Response) as unknown as typeof fetch;
    const warnings: string[] = [];
    expect(await postDigestWebhook('https://hooks.example/x', '# Digest', (m) => warnings.push(m), fakeFetch)).toBe(false);
    expect(warnings[0]).toContain('500 Server Error');
  });
});

// ---------------------------------------------------------------------------
// snapshot parsing
// ---------------------------------------------------------------------------

describe('parseSnapshot', () => {
  it('accepts a plausible snapshot', () => {
    const res = parseSnapshot(
      JSON.stringify({
        version: 1,
        pgVersion: 15,
        collectedAt: '2026-07-01T00:00:00Z',
        tables: { 'public.users': { rows: 1_000_000, bytes: 512_000_000 } },
      }),
    );
    expect(res.snapshot?.tables['public.users']?.rows).toBe(1_000_000);
    expect(res.note).toBeUndefined();
  });

  it('rejects invalid JSON and wrong shapes with a note, not an error', () => {
    expect(parseSnapshot('{nope').note).toMatch(/not valid JSON/);
    expect(parseSnapshot('42').note).toMatch(/does not look like/);
    expect(parseSnapshot('{"version":1}').note).toMatch(/does not look like/);
  });
});
