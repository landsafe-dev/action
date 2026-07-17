import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { globToRegExp, matchGlob, matchAny, normalizePath } from '../src/glob.js';
import { analyzeFiles, renderMarkdown } from '@landsafe/engine';
import {
  DEFAULT_PATTERNS,
  DEFAULT_PRO_URL,
  parsePatterns,
  resolveFiles,
  decideFailure,
  resolveLicense,
  resolveProUrl,
  parseSnapshot,
  upsertComment,
  upsertCommentSafely,
  frameworkNote,
  type CommentDeps,
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
