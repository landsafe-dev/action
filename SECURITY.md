# Security Policy

Landsafe runs inside your CI, reads your migration SQL, and posts a comment. That is a
position of trust, so this document states exactly what the code does — not what a
security page usually promises.

## Reporting a vulnerability

Email **pro@landsafe.dev**. Include a description, affected version, and a reproduction
if you have one. I aim to acknowledge within 72 hours.

Landsafe is maintained by one person. There is no bug bounty and no payout — I'd rather
be honest about that up front than imply a program that doesn't exist. Please don't open
a public issue for a vulnerability; email first and I'll coordinate a fix and disclosure.

## Supported versions

| Version | Supported |
| --- | --- |
| `v1.x` (latest `v1` tag) | ✅ |
| Anything older / unreleased branches | ❌ |

Fixes land on the latest `v1`. If you pin `landsafe-dev/action@v1` you get them; if you
pin a commit SHA (which is the safer supply-chain choice — see below) you must bump it.

## Architecture — what shrinks the attack surface

Each of these is a property of the shipped code, and you can verify all of them yourself
from the source.

- **The analysis engine has zero runtime dependencies.** `packages/engine` imports exactly
  one thing outside its own tree: `node:crypto`, for license signature verification. No
  transitive dependency graph means no transitive supply-chain risk in the part of
  Landsafe that reads your SQL.
- **The Action's only dependencies are GitHub's own.** `@actions/core` and `@actions/github`.
- **Nothing phones home.** There is no telemetry, no analytics, no usage beacon, no error
  reporting service, and no Landsafe server for the Action to talk to. There is no
  Landsafe backend at all.
- **License verification is offline.** Pro keys are Ed25519-signed tokens verified locally
  with `node:crypto` against a public key compiled into the engine. No network call, no
  license server, no activation. The private signing key never ships in the package —
  only the public key does.
- **The analysis is deterministic.** No LLM, no model call, no inference in the analysis
  path. The same SQL produces the same findings, offline, forever.
- **It never connects to your database.** The Action holds no database credentials and
  reads `.sql` files out of the PR diff. (`landsafe snapshot` does connect — but you run
  it yourself, from where you already have access, and it reads catalog statistics only:
  table names, estimated row counts, byte sizes. No rows, no column values, no query text.)

## Network egress — the complete list

In **review mode** (the default), the Action talks to the **GitHub API only**, using the
token you pass it, to list the PR's changed files and post/update the comment. Nothing else.

In **digest mode**, there are two:

1. The GitHub API, to read back PRs and their Landsafe comments across the repos your
   token can see.
2. **If — and only if — you set the `digest-webhook` input**, the digest markdown is
   POSTed to that URL as `{"text": "<markdown>"}`. That URL is yours (typically Slack).
   Landsafe does not supply a default and there is no fallback endpoint. A failed POST is
   a warning, never a failed run. See `postDigestWebhook` in `packages/action/src/lib.ts`.

That is the entire list. If you see Landsafe open a connection to anything else, that's a
vulnerability — email me.

## Scope

**In scope:** code execution or privilege escalation via crafted migration SQL; license
forgery or signature bypass; leaking your SQL, license key, or token to any third party;
the Action writing outside its workspace; a dependency compromise in `@landsafe/*`.

**Out of scope:** a rule that misses a dangerous pattern or fires a false positive (that's
a bug — open a normal issue, and please do); anything requiring an attacker who already
controls your workflow file or your runner; findings against `landsafe.dev` marketing pages.

## Hardening your own workflow

Landsafe is advisory: it reports, a human merges, and it doesn't touch your pipeline
unless you set `fail-on`. Two things worth doing regardless of which Action you're running:

- **Pin to a commit SHA**, not a tag. Tags are mutable. `landsafe-dev/action@<sha>` cannot
  be moved under you — this is the failure mode the `tj-actions/changed-files` compromise
  exploited, and it applies to every Action you use, including this one. Don't take my
  word that I'm trustworthy; pin the SHA so you don't have to.
- **Give it the least token you can.** Review mode needs `contents: read` and
  `pull-requests: write`, and nothing more.
