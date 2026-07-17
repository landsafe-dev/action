# Landsafe

Catches the Postgres migration that takes production down — in the PR, before it merges.

Here are two migrations. One is instant. One rewrites all 48 million rows and every index on the table, under a lock that blocks every read and every write until it finishes.

```sql
ALTER TABLE users ADD COLUMN plan text DEFAULT 'free';
ALTER TABLE users ADD COLUMN api_key uuid DEFAULT gen_random_uuid();
```

Since PG 11 a constant default is catalog-only, so the first one is free. A *volatile* default has to be evaluated per row, so the second one rewrites the table. Nothing in the diff tells you which is which. Both pass CI against your empty test database. One of them finds out about your production table size in production.

That distinction — per statement, per Postgres version — is the whole product.

## Quickstart

```yaml
# .github/workflows/landsafe.yml
name: Landsafe
on: pull_request

permissions:
  contents: read
  pull-requests: write

jobs:
  landsafe:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: landsafe-dev/action@v1
        with:
          license: ${{ secrets.LANDSAFE_LICENSE }} # optional — Pro
```

That's it. The Action never connects to your database. It holds no credentials, installs no agent, and needs no schema-as-code migration — it reads the `.sql` files out of the PR diff and nothing else.

## What lands on the PR

One sticky comment, updated in place, never spammed:

> **🛬 Landsafe — migration safety review**
>
> 🔴 **1 critical issue** — this migration can take production down
>
> #### 🔴 CREATE INDEX without CONCURRENTLY blocks all writes
>
> Line 1 — `CREATE INDEX idx_users_plan ON users (plan)`
>
> A plain CREATE INDEX takes a SHARE lock on users for the entire build: reads continue, but every INSERT, UPDATE and DELETE blocks until the index is finished.
>
> **Lock:** `SHARE` — blocks all writes (reads continue) · **Est. duration:** ~52 s–5 min for 48.0M rows (6.2 GB)
>
> **Safe path:** Use CREATE INDEX CONCURRENTLY (outside a transaction), and handle the failed-build INVALID-index case.

28 rules covering blocking index builds, full-table rewrites, validation scans under exclusive locks, lock-queue pileups, data loss, rolling-deploy breakage, and migrations that simply error at deploy time. Every one is version-aware: PG 11's fast defaults, PG 12's scan-free `SET NOT NULL`, `REINDEX CONCURRENTLY`, `DETACH PARTITION CONCURRENTLY` in 14. [Full rule reference →](https://github.com/landsafe-dev/action/blob/main/docs/RULES.md)

**It's advisory about merging, honest about signalling.** By default the check goes red on a critical finding — you'll see a failing check, and you can merge straight through it. Landsafe never holds a required status, never blocks a merge, and never touches your database. Want it purely informational? `fail-on: never`.

## Why you should trust an Action you've never heard of

You shouldn't, on my say-so. So here's what's checkable:

- **The engine has zero dependencies.** No transitive supply chain to audit. Its only import anywhere is `node:crypto`, for verifying license signatures.
- **It makes no network calls except to the GitHub API**, with the token you hand it. No telemetry, no analytics, no phone-home. (One exception, stated plainly: `mode: digest` POSTs the report to a webhook URL *you* supply.)
- **License verification is offline.** Ed25519, against a public key compiled into the engine. No licensing server exists, so there's nothing to call and nothing to leak.
- **Deterministic.** No LLM anywhere in the analysis path — explicit versioned rules over documented Postgres lock semantics. Same migration in, same answer out, every time.
- **The source is right here**, including the tests. `src/` is published alongside `dist/` so you can read what runs.
- **Pin a commit SHA rather than trusting me**, as you should with any third-party Action: `uses: landsafe-dev/action@<sha>`. See [SECURITY.md](SECURITY.md).

## Pricing

| | Free | Pro | Business |
| --- | --- | --- | --- |
| | **$0** | **$79/mo** | **$299/mo** |
| All 28 rules, PR comment, CLI | ✅ | ✅ | ✅ |
| Unlimited repos and developers | ✅ | ✅ | ✅ |
| Ready-to-paste zero-downtime rewrites | — | ✅ | ✅ |
| Impact estimates against your real table sizes | — | ✅ | ✅ |
| Org policy, weekly cross-repo digest, dashboard | — | — | ✅ |

One flat price per organization — no per-repo pricing, no seats to count, no arithmetic to know what you'd pay. The free tier is the whole detection engine on unlimited repos; Pro buys the rewrite and the number, not the detection. [landsafe.dev](https://landsafe.dev) · 14-day refund, no questions.

Pro unlocks with an offline license key in `secrets.LANDSAFE_LICENSE`.

## The weekly digest (Business)

A PR comment tells you if *one* migration is safe. It can't tell you **what merged last week with criticals unresolved** — which is the question an engineering manager actually has.

Every comment Landsafe posts carries a small machine-readable payload. The digest reads those back out of your own PRs, through your own token, and rolls them up across every repo. There's no backend in that loop: Landsafe has no server and stores nothing.

```yaml
on:
  schedule:
    - cron: '0 14 * * 1' # Mondays
jobs:
  digest:
    runs-on: ubuntu-latest
    steps:
      - uses: landsafe-dev/action@v1
        with:
          mode: digest
          license: ${{ secrets.LANDSAFE_LICENSE }}
          github-token: ${{ secrets.LANDSAFE_DIGEST_TOKEN }} # needs read on the repos you want covered
          digest-webhook: ${{ secrets.SLACK_WEBHOOK_URL }}
```

If it can't read a repo it says so at the top of the digest, and marks the counts a lower bound — a digest that quietly omits repos is worse than no digest.

## If an AI agent writes your migrations

Increasingly they do — and the thing that checks a migration shouldn't be another model with the same blind spots. Landsafe is a rule engine; it doesn't share weights with whatever wrote your SQL.

```sh
npx landsafe init     # adds a Landsafe stanza to your AGENTS.md
```

Agents then run `npx landsafe check <files> --json --fail-on critical` before proposing a migration. `landsafe rules --json` lists everything it can report.

## Limits, stated plainly

- **Postgres only.** I'd rather be right about one database than vague about five. No MySQL, no SQLite.
- **It reads SQL.** Rails/Django/Prisma migrations written in Ruby/Python/TypeScript aren't analyzed — only the `.sql` they generate.
- **It's new.** No pretending otherwise.

## About this repo

This is the published Action. `dist/index.cjs` is what actually runs — a single bundled file, no `node_modules` at runtime. `src/` is here so you can read it, but it builds as part of the Landsafe monorepo alongside the engine and CLI, and is synced here on release.

Licensed under the [Elastic License 2.0](LICENSE): read it, audit it, run the free tier anywhere. You may not circumvent the license key or resell it as a hosted service.
