# Landsafe rule reference

Landsafe analyzes Postgres migrations and flags the statements that take production down: full-table rewrites under `ACCESS EXCLUSIVE`, blocking index builds, validation scans, lock-queue pileups, data loss, and the migrations that simply error at deploy time. Postgres only in v1 — every rule below is grounded in Postgres lock semantics and version-specific behavior (PG 11's fast `ADD COLUMN DEFAULT`, PG 12's scan-free `SET NOT NULL`, `REINDEX CONCURRENTLY`, and enum-in-transaction changes).

Every rule is **advisory**: Landsafe warns, a human merges.

**What each tier adds, per finding:**

- **Free** — every rule below fires, with the full explanation, the lock profile (which lock, what it blocks), and the safe pattern in prose. Unlimited repos, unlimited developers. Detection is not the paid part.
- **Pro** ($79/mo, unlimited repos and developers) — findings additionally include the **ready-to-paste zero-downtime rewrite** (multi-step SQL with per-step notes and honest caveats), and, when you provide a schema snapshot, **impact estimates against your real table sizes** (a `SET NOT NULL` validation scan of a 48M-row, 6.2 GB `users` table: "~12 s–62 s for 48.0M rows (6.2 GB)"). Estimates are deliberately conservative ranges, never fake precision.
- **Business** ($299/mo, unlimited repos and developers) — everything in Pro. Doesn't change what a finding says. Adds org-wide policy enforcement (a license-encoded fail-on threshold that individual repos can tighten but never loosen), the weekly cross-repo digest, and the cross-repo dashboard: trends, audit view, and the log of PRs that merged with criticals unresolved.

Full pricing and the tier table live in the [README](../README.md#pricing).

## Severity levels

| Severity | Meaning |
| --- | --- |
| 🔴 **critical** | Can take production down, destroy data, or fail at deploy time. |
| 🟡 **warning** | Dangerous under common conditions (lock queues, rolling deploys) — review before merging. |
| 🔵 **info** | Cheap schema-quality wins that prevent expensive migrations later. |

## Rule index

| Rule ID | Severity | Lock | Pro rewrite |
| --- | --- | --- | --- |
| [`add-column-default-rewrite`](#add-column-default-rewrite) | critical | ACCESS EXCLUSIVE (rewrite) | ✅ |
| [`add-column-not-null-no-default`](#add-column-not-null-no-default) | critical | ACCESS EXCLUSIVE | ✅ |
| [`set-not-null-scan`](#set-not-null-scan) | critical | ACCESS EXCLUSIVE (scan) | ✅ |
| [`column-type-change-rewrite`](#column-type-change-rewrite) | critical / warning | ACCESS EXCLUSIVE (rewrite) | ✅ |
| [`non-concurrent-index`](#non-concurrent-index) | critical | SHARE (index build) | ✅ |
| [`non-concurrent-index-drop`](#non-concurrent-index-drop) | warning | ACCESS EXCLUSIVE | ✅ |
| [`concurrent-index-in-transaction`](#concurrent-index-in-transaction) | critical | — (fails at deploy) | — |
| [`reindex-non-concurrent`](#reindex-non-concurrent) | critical | SHARE (index build) | — |
| [`fk-without-not-valid`](#fk-without-not-valid) | critical | SHARE ROW EXCLUSIVE (scan, both tables) | ✅ |
| [`check-without-not-valid`](#check-without-not-valid) | critical | ACCESS EXCLUSIVE (scan) | ✅ |
| [`unique-constraint-direct`](#unique-constraint-direct) | critical | ACCESS EXCLUSIVE (index build) | ✅ |
| [`add-primary-key-direct`](#add-primary-key-direct) | critical | ACCESS EXCLUSIVE (index build) | ✅ |
| [`exclude-constraint-blocking`](#exclude-constraint-blocking) | critical | ACCESS EXCLUSIVE (index build) | — |
| [`domain-constraint`](#domain-constraint) | critical / info | database-wide validation scan | — |
| [`create-trigger-lock`](#create-trigger-lock) | warning | SHARE ROW EXCLUSIVE | — |
| [`vacuum-full`](#vacuum-full) | critical | ACCESS EXCLUSIVE (rewrite) | — |
| [`explicit-lock-table`](#explicit-lock-table) | warning | ACCESS EXCLUSIVE | — |
| [`detach-partition-blocking`](#detach-partition-blocking) | critical | ACCESS EXCLUSIVE (parent table) | ✅ (PG 14+) |
| [`set-logged-rewrite`](#set-logged-rewrite) | critical | ACCESS EXCLUSIVE (rewrite) | — |
| [`drop-table`](#drop-table) | critical | ACCESS EXCLUSIVE | — |
| [`drop-column`](#drop-column) | warning | ACCESS EXCLUSIVE (instant) | ✅ |
| [`truncate-table`](#truncate-table) | critical | ACCESS EXCLUSIVE | — |
| [`rename-breaks-code`](#rename-breaks-code) | warning | ACCESS EXCLUSIVE (instant) | ✅ |
| [`unbounded-update-delete`](#unbounded-update-delete) | critical | row locks until commit | ✅ |
| [`drop-database`](#drop-database) | critical | — | — |
| [`drop-not-null`](#drop-not-null) | warning | ACCESS EXCLUSIVE (instant) | — |
| [`drop-constraint-lock`](#drop-constraint-lock) | warning | ACCESS EXCLUSIVE (both tables for FKs) | — |
| [`enum-value-rename`](#enum-value-rename) | warning | — | — |
| [`add-identity-existing-column`](#add-identity-existing-column) | warning | ACCESS EXCLUSIVE (instant) | — |
| [`transaction-nesting`](#transaction-nesting) | warning | — | — |
| [`prefer-robust-statements`](#prefer-robust-statements) | info | — | — |
| [`unrecognized-statement`](#unrecognized-statement) | info | — | — |
| [`no-lock-timeout`](#no-lock-timeout) | warning | — | — |
| [`no-statement-timeout`](#no-statement-timeout) | info | — | — |
| [`enum-add-value-in-transaction`](#enum-add-value-in-transaction) | critical (PG < 12) / info (PG 12+) | — | — |
| [`enum-value-ordering`](#enum-value-ordering) | info | — | — |
| [`identifier-too-long`](#identifier-too-long) | warning | — | — |
| [`unqualified-table-name`](#unqualified-table-name) | info | — | — |
| [`prefer-bigint-pk`](#prefer-bigint-pk) | info | — | — |
| [`prefer-identity-over-serial`](#prefer-identity-over-serial) | info | — | — |
| [`prefer-timestamptz`](#prefer-timestamptz) | info | — | — |
| [`ban-char-n`](#ban-char-n) | info | — | — |
| [`prefer-text`](#prefer-text) | info | — | — |
| [`prefer-jsonb`](#prefer-jsonb) | info | — | — |

Landsafe also runs two **cross-statement checks** over each whole migration file: [`many-exclusive-locks-one-transaction`](#many-exclusive-locks-one-transaction) and [`uncommitted-transaction`](#uncommitted-transaction).

---

## Availability: locks, rewrites, and scans

### `add-column-default-rewrite`

**Severity: 🔴 critical**

**Detects:** `ALTER TABLE ... ADD COLUMN` where the new column forces a physical table rewrite:

- a **volatile** default (`clock_timestamp()`, `random()`, `gen_random_uuid()`, `uuid_generate_v4()`, `nextval()`, …) on **any** Postgres version;
- any default on **PG < 11**;
- a `serial`/`bigserial` column (implicit `DEFAULT nextval(...)` — volatile), an **IDENTITY** column, or a **`GENERATED ... STORED`** column — these rewrite the table on **every** version, including 11+.

**Why it's dangerous:** Postgres must write a value into every existing row, and it holds an **ACCESS EXCLUSIVE** lock for the entire rewrite. Every `SELECT`, `INSERT`, `UPDATE`, and `DELETE` on the table queues behind it until the rewrite finishes. On a large table that's minutes of total downtime for anything touching the table.

**Version nuance:** on PG 11+ a *non-volatile* default is catalog-only and instant — Landsafe stays silent for those. That fast path includes the whole **`now()` / `CURRENT_TIMESTAMP` family** (`now()`, `transaction_timestamp()`, `statement_timestamp()`, `current_date`) — these are **STABLE**, not volatile (`pg_proc.provolatile = 's'`), so `ADD COLUMN ... DEFAULT now()` is instant on PG 11+. Only genuinely volatile expressions (evaluated per row) force the rewrite.

**Safe pattern:** add the column nullable, `SET DEFAULT` for new rows only (instant), then backfill existing rows in short batches.

**Free:** detection + lock profile + the pattern above. **Pro:** the paste-ready add → set-default → batched-`ctid`-backfill rewrite, plus rewrite duration estimated against the table's real size from your snapshot.

---

### `add-column-not-null-no-default`

**Severity: 🔴 critical**

**Detects:** `ALTER TABLE ... ADD COLUMN ... NOT NULL` with no `DEFAULT` — including an inline `PRIMARY KEY` column, which implies `NOT NULL`.

**Why it's dangerous:** existing rows have no value for the new column, so Postgres rejects the statement outright (`column "..." of relation contains null values`) on any non-empty table. This is the migration that passes in dev (empty table) and explodes in production — and if your migration runner retries or half-applies, you're down.

**Safe pattern:** add the column nullable, backfill in batches, then apply `NOT NULL` via the scan-free CHECK-constraint pattern (see `set-not-null-scan`).

**Free:** detection + safe pattern. **Pro:** the full ready-to-paste NOT NULL rewrite, version-aware (PG 12+ scan-free path vs. the PG < 12 windowed path).

---

### `set-not-null-scan`

**Severity: 🔴 critical**

**Detects:** `ALTER TABLE ... ALTER COLUMN ... SET NOT NULL`.

**Why it's dangerous:** `SET NOT NULL` takes **ACCESS EXCLUSIVE** and validates every existing row before releasing it — all reads and writes on the table are blocked for the whole scan.

**Version nuance:** on **PG 12+** there is a scan-free path: if a *valid* `CHECK (col IS NOT NULL)` constraint already exists, `SET NOT NULL` skips the scan entirely and is instant. On **PG < 12** there is no scan-free path — backfill first and plan a window, or upgrade.

**Safe pattern (PG 12+):** `ADD CONSTRAINT ... CHECK (col IS NOT NULL) NOT VALID` (instant) → `VALIDATE CONSTRAINT` (scans under SHARE UPDATE EXCLUSIVE — reads *and* writes keep flowing) → `SET NOT NULL` (now instant) → drop the CHECK.

**Free:** detection + pattern. **Pro:** the paste-ready four-step rewrite plus scan duration against your real table size.

---

### `column-type-change-rewrite`

**Severity: 🔴 critical** (🟡 warning when the target type *may* be a rewrite-free widen)

**Detects:** `ALTER TABLE ... ALTER COLUMN ... TYPE ...`.

**Why it's dangerous:** a type change forces Postgres to rewrite every row **and rebuild every index** on the table while holding **ACCESS EXCLUSIVE** — all reads and writes blocked for the full duration. This is one of the most common causes of migration-induced outages.

**Nuance:** some changes are binary-coercible and rewrite-free — `varchar(50) → varchar(255)`, `varchar → text`, numeric precision increases. Landsafe can't see the *old* type from the migration alone, so those targets get a 🟡 warning ("safe only if it's a pure widen — verify the old type"). Any other target, or any change with a `USING` clause, is a 🔴 full rewrite.

**Safe pattern:** expand/contract — add a new column of the new type, dual-write via trigger, backfill in batches, then cut over with a brief rename inside a short transaction.

**Free:** detection + pattern. **Pro:** the complete expand → dual-write trigger → batched backfill → cutover rewrite, ready to paste, plus rewrite duration from your snapshot.

---

### `non-concurrent-index`

**Severity: 🔴 critical**

**Detects:** `CREATE [UNIQUE] INDEX` without `CONCURRENTLY`.

**Why it's dangerous:** a plain `CREATE INDEX` takes a **SHARE** lock for the entire build: reads continue, but every `INSERT`, `UPDATE`, and `DELETE` blocks until the index is finished. On a big table that's minutes of frozen writes — connection pools fill, requests time out, and the app is effectively down for anything that writes. This is the highest-frequency real-world migration danger.

**Safe pattern:** `CREATE INDEX CONCURRENTLY` — outside a transaction — with `lock_timeout` set, and handle the failed-build case (a failed concurrent build leaves an `INVALID` index that must be dropped and retried).

**Free:** detection + pattern. **Pro:** the rewritten statement with the `INVALID`-index check-and-retry step included, plus build duration against your real table size.

---

### `non-concurrent-index-drop`

**Severity: 🟡 warning**

**Detects:** `DROP INDEX` without `CONCURRENTLY`.

**Why it's dangerous:** `DROP INDEX` takes **ACCESS EXCLUSIVE** on the parent table. The drop itself is fast — but if it queues behind one long-running query, everything else queues behind *it*: the classic lock-queue pileup.

**Safe pattern:** `DROP INDEX CONCURRENTLY` (outside a transaction) with `lock_timeout` set.

**Free:** detection + pattern. **Pro:** the rewritten drop with the lock_timeout preamble.

---

### `concurrent-index-in-transaction`

**Severity: 🔴 critical**

**Detects:** `CREATE INDEX CONCURRENTLY`, `DROP INDEX CONCURRENTLY`, `REINDEX ... CONCURRENTLY`, or `DETACH PARTITION ... CONCURRENTLY` inside a transaction — either an explicit `BEGIN`, or the implicit transaction your migration runner wraps around every file (Landsafe assumes a wrapper by default; configurable).

**Why it's dangerous:** `CONCURRENTLY` refuses to run inside a transaction block. The migration doesn't lock anything — it simply **fails at deploy time** (`CREATE INDEX CONCURRENTLY cannot run inside a transaction block`), which usually means a broken deploy pipeline at the worst moment.

**Safe pattern:** move the statement to its own migration with the transaction wrapper disabled — `disable_ddl_transaction!` (Rails), `atomic = False` (Django), `-- +goose NO TRANSACTION`, or your framework's equivalent.

**Free & Pro:** identical — this is a correctness catch; there's no rewrite to sell, just the fix.

---

### `reindex-non-concurrent`

**Severity: 🔴 critical**

**Detects:** `REINDEX` without `CONCURRENTLY`.

**Why it's dangerous:** `REINDEX` locks the index and blocks writes to the table for the entire rebuild.

**Version nuance:** `REINDEX CONCURRENTLY` exists on **PG 12+** and does the same job without blocking traffic. On PG < 12, build a replacement index with `CREATE INDEX CONCURRENTLY`, drop the old one, and rename.

**Free:** detection + version-appropriate pattern. **Pro:** rebuild duration against your real table size.

---

### `fk-without-not-valid`

**Severity: 🔴 critical**

**Detects:** `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY` without `NOT VALID`.

**Why it's dangerous:** a validating FK takes **SHARE ROW EXCLUSIVE on both tables** — the referencing *and* the referenced table — while it scans every existing row. Writes are blocked on both tables for the whole scan. Two hot tables frozen at once is how one migration takes down two features.

**Safe pattern:** `ADD CONSTRAINT ... NOT VALID` (instant — new rows are checked immediately), then `VALIDATE CONSTRAINT` (scans under SHARE UPDATE EXCLUSIVE — normal reads/writes keep flowing on both tables).

**Free:** detection + pattern. **Pro:** your exact constraint statement rewritten with `NOT VALID` + the validate step, plus scan duration from your snapshot.

---

### `check-without-not-valid`

**Severity: 🔴 critical**

**Detects:** `ALTER TABLE ... ADD CONSTRAINT ... CHECK (...)` without `NOT VALID`.

**Why it's dangerous:** a validating CHECK holds **ACCESS EXCLUSIVE** while it scans every row — all reads and writes queue until the scan completes.

**Safe pattern:** `ADD CONSTRAINT ... CHECK (...) NOT VALID` (instant), then `VALIDATE CONSTRAINT` (non-blocking scan).

**Free:** detection + pattern. **Pro:** your exact statement rewritten, plus scan duration from your snapshot.

---

### `unique-constraint-direct`

**Severity: 🔴 critical**

**Detects:** `ALTER TABLE ... ADD CONSTRAINT ... UNIQUE` without `USING INDEX`.

**Why it's dangerous:** it builds the backing unique index while holding **ACCESS EXCLUSIVE** — all reads and writes are blocked for the entire index build.

**Safe pattern:** `CREATE UNIQUE INDEX CONCURRENTLY` first (writes keep flowing), then `ADD CONSTRAINT ... UNIQUE USING INDEX` — instant adoption of the ready index. Caveat: the concurrent build fails if duplicates exist — deduplicate first.

**Free:** detection + pattern. **Pro:** the two-step rewrite ready to paste, plus build duration from your snapshot.

---

### `add-primary-key-direct`

**Severity: 🔴 critical**

**Detects:** `ALTER TABLE ... ADD PRIMARY KEY` without `USING INDEX`.

**Why it's dangerous:** builds the unique index under **ACCESS EXCLUSIVE** — everything is blocked for the whole build. It may also add NOT NULL validation scans on the key columns.

**Safe pattern:** `CREATE UNIQUE INDEX CONCURRENTLY`, then `ADD CONSTRAINT ... PRIMARY KEY USING INDEX`. Key columns must already be NOT NULL — use the scan-free NOT NULL pattern first if needed.

**Free:** detection + pattern. **Pro:** the paste-ready rewrite plus build duration from your snapshot.

---

### `exclude-constraint-blocking`

**Severity: 🔴 critical**

**Detects:** `ALTER TABLE ... ADD CONSTRAINT ... EXCLUDE`.

**Why it's dangerous:** an exclusion constraint builds its backing (typically GiST) index while holding **ACCESS EXCLUSIVE** — all reads and writes are blocked for the entire build. And unlike every other constraint, Postgres offers **no online escape hatch**: `NOT VALID` is only allowed for foreign key and CHECK constraints, `USING INDEX` adoption only exists for UNIQUE and PRIMARY KEY, and there is no `CONCURRENTLY` variant — on any version.

**Safe pattern:** there isn't one. Plan a maintenance window with `lock_timeout` set. If the exclusion is over plain equality, a unique index (buildable `CONCURRENTLY`) may serve instead.

---

### `domain-constraint`

**Severity: 🔴 critical** (`ALTER DOMAIN ... ADD CONSTRAINT` without `NOT VALID`) **· 🔵 info** (with `NOT VALID`, or `CREATE DOMAIN` with a constraint)

**Detects:** `ALTER DOMAIN ... ADD CONSTRAINT` and `CREATE DOMAIN` with an inline constraint.

**Why it's dangerous:** adding a domain constraint without `NOT VALID` validates **every column of every table using the domain, across the whole database**, before it completes — the cost scales with *all* tables using the domain, not one. A domain used in ten tables means ten validation scans in one statement. `NOT VALID` *is* supported for domain CHECK constraints (then `ALTER DOMAIN ... VALIDATE CONSTRAINT`), with the docs' own caveat that the eager check isn't bulletproof against concurrent writes: commit, wait out older transactions, then validate. `CREATE DOMAIN` with a constraint is instant today but taxes every future migration that touches it — Postgres treats coercion to a constrained domain as requiring a rewrite.

**Safe pattern:** `ADD CONSTRAINT ... NOT VALID` → wait out pre-commit transactions → `VALIDATE CONSTRAINT`. Better: put constraints on columns, not domains.

---

### `create-trigger-lock`

**Severity: 🟡 warning**

**Detects:** `CREATE TRIGGER` / `CREATE CONSTRAINT TRIGGER` on a table not created in the same file.

**Why it's dangerous:** `CREATE TRIGGER` takes **SHARE ROW EXCLUSIVE**: every `INSERT`, `UPDATE`, and `DELETE` blocks until it completes (reads continue). The operation itself is a fast catalog change — the risk is the queue: it must wait behind any long-running write, and every write then queues behind *it*.

**Safe pattern:** `SET lock_timeout = '5s';` first, so a busy table makes it fail fast and retryable instead of freezing writes behind a stuck queue.

---

### `vacuum-full`

**Severity: 🔴 critical**

**Detects:** `VACUUM FULL` or `CLUSTER`.

**Why it's dangerous:** both rewrite the entire table while holding **ACCESS EXCLUSIVE** — nothing can read or write until they finish. They should essentially never appear in a migration.

**Safe pattern:** plain `VACUUM` (no FULL) never blocks. For bloat reclamation, use `pg_repack`, which works online.

**Free:** detection + pattern. **Pro:** rewrite duration from your snapshot (there's no SQL rewrite — the fix is "don't").

---

### `explicit-lock-table`

**Severity: 🟡 warning**

**Detects:** explicit `LOCK TABLE`.

**Why it's dangerous:** `LOCK TABLE` defaults to **ACCESS EXCLUSIVE** and holds it until the transaction ends — everything queues behind the rest of the migration. Occasionally legitimate, usually a sledgehammer.

**Safe pattern:** if you truly need it, take the weakest lock mode that works and keep the transaction as short as possible.

---

### `detach-partition-blocking`

**Severity: 🔴 critical**

**Detects:** `ALTER TABLE ... DETACH PARTITION` without `CONCURRENTLY`.

**Why it's dangerous:** a plain `DETACH PARTITION` takes **ACCESS EXCLUSIVE on the parent partitioned table** — every query against the parent (all partitions) blocks until it completes. Partitioned tables are precisely the large installs where that hurts most.

**Version nuance:** **PG 14+** supports `DETACH PARTITION CONCURRENTLY`, which only takes SHARE UPDATE EXCLUSIVE — queries keep flowing. On PG < 14 there is no concurrent option: plan a window, set `lock_timeout`, and keep the transaction minimal.

**Safe pattern (PG 14+):** `ALTER TABLE ... DETACH PARTITION ... CONCURRENTLY` — outside a transaction; if interrupted, finish with `... DETACH PARTITION ... FINALIZE`.

**Free:** detection + pattern. **Pro:** the paste-ready concurrent detach (lock_timeout preamble + FINALIZE recovery step) on PG 14+.

---

### `set-logged-rewrite`

**Severity: 🔴 critical**

**Detects:** `ALTER TABLE ... SET LOGGED` or `SET UNLOGGED`.

**Why it's dangerous:** either direction rewrites the **entire table** (and its WAL treatment) while holding **ACCESS EXCLUSIVE** — all reads and writes queue for the full rewrite duration.

**Safe pattern:** on a large table, plan a window — or create a new table with the target logging, copy in batches, and swap.

**Free:** detection + pattern. **Pro:** rewrite duration estimated against your real table size from the snapshot.

---

## Data loss and app compatibility

### `drop-table`

**Severity: 🔴 critical**

**Detects:** `DROP TABLE`.

**Why it's dangerous:** irreversible data loss, and it instantly breaks any running code that references the table. In a migration reviewed under time pressure, this deserves an explicit human decision, every time.

**Safe pattern:** if truly intended — verify backups, deploy code that no longer references the table *first*, and consider renaming to `*_deprecated` for a cooling-off period instead.

---

### `drop-column`

**Severity: 🟡 warning**

**Detects:** `ALTER TABLE ... DROP COLUMN`.

**Why it's dangerous:** the drop itself is instant (catalog-only, brief ACCESS EXCLUSIVE) — the danger is app compatibility, not the lock. The data is gone, and any deployed code still reading the column starts erroring immediately (`column does not exist`).

**Safe pattern:** the only safe order is code-first, drop-second: deploy application code that no longer uses the column, then drop it in a later migration.

**Free:** detection + pattern. **Pro:** the ordered transition rewrite (including the optional `DROP NOT NULL` step to stop violations from old writers).

---

### `truncate-table`

**Severity: 🔴 critical**

**Detects:** `TRUNCATE`.

**Why it's dangerous:** removes every row irreversibly (and takes ACCESS EXCLUSIVE while it does). Unlike `DELETE` it cannot be limited by `WHERE` and fires no per-row triggers. In a migration this is almost always a mistake, or deserves a very explicit sign-off.

**Safe pattern:** if intentional, say so loudly in review. If you meant to remove *some* rows, use a batched `DELETE` with a `WHERE` clause.

---

### `rename-breaks-code`

**Severity: 🟡 warning**

**Detects:** `ALTER TABLE ... RENAME COLUMN` / `RENAME TO`.

**Why it's dangerous:** the rename is instant for Postgres, but every already-running app instance still uses the old name — between the migration and the deploy, those queries fail. Under rolling deploys there is *always* a window where both versions run.

**Safe pattern:** expand/contract — add the new name alongside, dual-write, migrate readers, then drop the old one. For table renames, an updatable view under the old name keeps old code working through the transition.

**Free:** detection + pattern. **Pro:** the paste-ready expand/contract rewrite (view-alias variant for tables, dual-write variant for columns).

---

### `unbounded-update-delete`

**Severity: 🔴 critical**

**Detects:** `UPDATE` or `DELETE` without a `WHERE` clause.

**Why it's dangerous:** an unbounded DML statement in a migration locks every row it touches until commit, bloats WAL, can stall replicas, and (for `DELETE`) is irreversible data loss. Inside a migration transaction it holds those row locks for the *entire* migration.

**Safe pattern:** if intended, run it in bounded batches outside the migration transaction so each batch commits independently; if not, add the missing `WHERE`.

**Free:** detection + pattern. **Pro:** the batched CTE rewrite (`ctid`-limited batches, repeat until 0 rows).

---

### `drop-database`

**Severity: 🔴 critical**

**Detects:** `DROP DATABASE`.

**Why it's dangerous:** it deletes an entire database. There is no version of this that belongs in an application migration.

**Safe pattern:** remove it. If decommissioning a database, do it as a deliberate operational runbook, not a migration.

---

### `drop-not-null`

**Severity: 🟡 warning**

**Detects:** `ALTER TABLE ... ALTER COLUMN ... DROP NOT NULL`.

**Why it's dangerous:** the drop itself is instant (catalog-only, brief ACCESS EXCLUSIVE). The damage is delayed: application code, PL/pgSQL, and queries written against a never-NULL guarantee start meeting NULLs and fail in ways no test caught. It's also a one-way door in practice — re-adding `NOT NULL` later requires a full-table scan (or the PG 12+ CHECK-constraint dance).

**Safe pattern:** confirm every reader tolerates NULL first. For a temporary relaxation, prefer a CHECK constraint you can VALIDATE back later.

---

### `drop-constraint-lock`

**Severity: 🟡 warning**

**Detects:** `ALTER TABLE ... DROP CONSTRAINT` (except constraints this same file added — the deliberate temp-constraint pattern).

**Why it's dangerous:** dropping a constraint takes a brief **ACCESS EXCLUSIVE** on the table — and if it's a foreign key, Postgres locks the **referenced** table exclusively too. That's the asymmetric surprise: adding an FK takes SHARE ROW EXCLUSIVE, dropping it freezes both tables outright. The integrity guarantee is also gone the moment it commits.

**Safe pattern:** `SET lock_timeout` first; for FK drops treat *both* tables as briefly frozen; make sure nothing still relies on the guarantee.

---

### `enum-value-rename`

**Severity: 🟡 warning**

**Detects:** `ALTER TYPE ... RENAME VALUE`.

**Why it's dangerous:** the rename is metadata-only and transaction-safe (existing rows store the enum internally, not the label) — but every running app instance still *sends* the old label, and those INSERTs/UPDATEs start erroring the instant the rename commits. Under rolling deploys there is always a window where old code runs.

**Safe pattern:** coordinate with an all-at-once deploy, or expand/contract: add the new value, migrate code to write it, then retire the old one.

---

### `add-identity-existing-column`

**Severity: 🟡 warning**

**Detects:** `ALTER TABLE ... ALTER COLUMN ... ADD GENERATED ... AS IDENTITY` on an existing column.

**Why it's dangerous:** the change is catalog-only (no rewrite, brief ACCESS EXCLUSIVE) and existing rows keep their values — but the new sequence **starts at 1, ignoring them**. The statement also errors outright unless the column is already NOT NULL. If rows exist, future inserts draw already-used numbers and die with duplicate-key errors: a delayed production incident no empty test database will ever show.

**Safe pattern:** right after adding the identity, align the sequence: `SELECT setval(pg_get_serial_sequence('t','id'), (SELECT COALESCE(MAX(id),0)+1 FROM t), false);`

---

## Transaction structure and rerunnability

### `transaction-nesting`

**Severity: 🟡 warning**

**Detects:** `BEGIN` while a transaction is already open, and `COMMIT`/`ROLLBACK` with no open explicit transaction. Balanced `BEGIN ... COMMIT` files are treated as self-managed and never fire.

**Why it's dangerous:** Postgres has no nested transactions — a second `BEGIN` is a no-op WARNING, and the next `COMMIT` ends the *outer* transaction, so everything after it runs non-atomically, each statement committing on its own. A bare `COMMIT` in a runner-wrapped file ends the *runner's* transaction early with the same result. The file's transaction structure no longer means what it says.

**Safe pattern:** balance `BEGIN`/`COMMIT` exactly (use `SAVEPOINT` for partial-rollback points), or drop explicit transaction control and let the runner manage it.

---

### `prefer-robust-statements`

**Severity: 🔵 info**

**Detects:** statements that can't be rerun after a partial failure: named `CREATE INDEX CONCURRENTLY` / `DROP INDEX CONCURRENTLY` without `IF [NOT] EXISTS` (anywhere), and — outside a transaction — unguarded `CREATE TABLE`, `CREATE INDEX`, `DROP TABLE/INDEX/TYPE`, `ADD/DROP COLUMN`, `DROP CONSTRAINT`, and `ADD CONSTRAINT` whose name isn't re-added after a same-file drop.

**Why it matters:** a non-transactional migration that fails partway leaves earlier statements applied; the rerun then dies on `already exists` / `does not exist` and the pipeline wedges. The nastiest case is a failed `CREATE INDEX CONCURRENTLY`, which leaves an INVALID index squatting on the name.

**Safe pattern:** `IF [NOT] EXISTS` on every guardable statement; for `ADD CONSTRAINT` (which has no `IF NOT EXISTS`), precede it with `DROP CONSTRAINT IF EXISTS` of the same name. On a failed concurrent build, drop the INVALID index before retrying.

---

### `unrecognized-statement`

**Severity: 🔵 info**

**Detects:** any statement Landsafe's parser could not read — unusual DDL, a syntax error, or a parser gap.

**Why it matters:** a best-effort parser that *silently* skips what it can't read converts every gap into a false negative — a clean bill of health it didn't earn. Landsafe reports what it didn't analyze instead. Recognized-but-deliberately-unanalyzed statements (`GRANT`, `COMMENT`, `CREATE VIEW`, ...) don't fire this; only the genuinely unreadable does.

**Safe pattern:** review the statement manually. If it's valid SQL Landsafe should understand, open an issue with the statement.

---

## Hygiene and correctness

### `no-lock-timeout`

**Severity: 🟡 warning**

**Detects:** any DDL statement (`ALTER TABLE`, `CREATE/DROP INDEX`, `DROP TABLE`, `TRUNCATE`, `REINDEX`, `CLUSTER`, `LOCK TABLE`) in a file where no `lock_timeout` was set beforehand. Fires once per file.

**Why it's dangerous:** the single most under-appreciated migration fact — even an "instant", catalog-only DDL statement must wait for an ACCESS EXCLUSIVE slot. If any long-running query (a report, a backup, a stuck transaction) holds the table, your migration queues behind it — and every normal query then queues behind *your migration*. The app freezes while the DDL itself was "instant." `lock_timeout` makes the migration fail fast and retryable instead of poisoning the queue.

**Safe pattern:** start the migration with `SET lock_timeout = '5s';` (and consider `SET statement_timeout`). Retry on failure — it errors cleanly.

**Free & Pro: identical.** The one-line `SET lock_timeout` preamble above is the entire fix, so there is nothing to gate behind Pro.

---

### `no-statement-timeout`

**Severity: 🔵 info**

**Detects:** DDL in a file where no `statement_timeout` was set beforehand. Fires once per file.

**Why it matters:** `lock_timeout` bounds how long you *wait* for a lock; `statement_timeout` bounds how long the statement may *run* once it has it. A validation scan or index build that turns out bigger than expected will otherwise hold its locks for as long as it takes.

**Safe pattern:** `SET statement_timeout = '60s';` before the DDL — and keep `lock_timeout` well below it so lock waits still fail first.

---

### `enum-add-value-in-transaction`

**Severity: 🔴 critical on PG < 12 · 🔵 info on PG 12+**

**Detects:** `ALTER TYPE ... ADD VALUE` inside a transaction (explicit `BEGIN` or the runner's implicit wrapper).

**Why it's dangerous:** before PostgreSQL 12, adding an enum value cannot run inside a transaction block at all — the migration errors at deploy time (`ALTER TYPE ... ADD cannot run inside a transaction block`). **PG 12+** allows it, but there's a residual trap: any statement that *uses* the new value before `COMMIT` fails with `unsafe use of new value of enum type` — the classic add-value-then-`UPDATE` mistake. Landsafe flags that case as 🔵 info on PG 12+.

**Safe pattern:** PG < 12 — run it in its own migration with the transaction wrapper disabled, or upgrade. PG 12+ — add the value in one migration; use it (UPDATEs, new defaults) in the next.

---

### `enum-value-ordering`

**Severity: 🔵 info**

**Detects:** `ALTER TYPE ... ADD VALUE` without `BEFORE`/`AFTER`.

**Why it matters:** enum values have a defined order and comparisons like `status < 'approved'` use it. A value appended at the end sorts after everything — if the enum's order is meaningful (workflow stages, severities), order-dependent queries silently change meaning rather than erroring.

**Safe pattern:** state the position explicitly: `ALTER TYPE status ADD VALUE 'pending' BEFORE 'approved';`

---

### `identifier-too-long`

**Severity: 🟡 warning**

**Detects:** any identifier in a statement longer than **63 bytes** (bytes, not characters — Postgres's `NAMEDATALEN - 1` limit).

**Why it matters:** Postgres keeps only the first 63 bytes and says so only in a NOTICE nobody reads in CI. The name you wrote is not the name Postgres uses — later references can miss it, and two long names sharing a 63-byte prefix silently collapse into the *same* object, so DDL hits the wrong one. ORM-generated index and constraint names are the usual culprits.

**Safe pattern:** shorten the name (override your ORM's generated index/constraint names).

---

### `unqualified-table-name`

**Severity: 🔵 info**

**Detects:** `CREATE TABLE`, `ALTER TABLE`, or `DROP TABLE` whose table name has no schema qualifier (TEMP tables exempt). Reported once per file.

**Why it matters:** without an explicit schema, Postgres resolves the name through `search_path` at run time — *which table the statement touches* depends on session configuration, not on the migration text.

**Safe pattern:** write `schema.table` (e.g. `public.users`) in DDL. Teams that standardize on `search_path` instead can mute this: `--ignore unqualified-table-name` (CLI) or `ignore-rules: unqualified-table-name` (Action).

---

### `prefer-bigint-pk`

**Severity: 🔵 info**

**Detects:** `CREATE TABLE` with a 16- or 32-bit primary key (`smallint`, `int2`, `smallserial`, `serial2`, `integer`, `int4`, `serial`, `serial4`), and `ADD COLUMN` with a narrow `serial` type (sequences only count up — total inserts ever, not live rows, is the ceiling).

**Why it matters:** `int4` tops out at ~2.1 billion (`smallint` at 32,767). Busy tables hit it — Basecamp, Sentry, and plenty of others have written the postmortem — and the emergency `int → bigint` migration on a huge table is exactly the rewrite nightmare Landsafe exists to prevent. Starting with `bigint` costs nothing today.

**Safe pattern:** `BIGINT GENERATED ALWAYS AS IDENTITY` (or `bigserial`) for primary keys.

---

### `prefer-identity-over-serial`

**Severity: 🔵 info**

**Detects:** `serial` / `bigserial` columns in `CREATE TABLE`.

**Why it matters:** `serial` is a legacy macro with loose sequence-ownership semantics (grants and drops behave surprisingly). `GENERATED ... AS IDENTITY` is the SQL-standard replacement and behaves correctly.

**Safe pattern:** `INTEGER/BIGINT GENERATED ALWAYS AS IDENTITY`.

---

### `prefer-timestamptz`

**Severity: 🔵 info**

**Detects:** `timestamp` without time zone in `CREATE TABLE` or `ADD COLUMN`.

**Why it matters:** naive timestamps silently reinterpret when the server/client timezone differs — the classic source of off-by-N-hours data bugs. `timestamptz` stores an unambiguous instant.

**Safe pattern:** use `timestamptz` unless you have a specific reason to store wall-clock time.

---

### `ban-char-n`

**Severity: 🔵 info**

**Detects:** `char(n)` / `character(n)` columns in `CREATE TABLE` or `ADD COLUMN`.

**Why it matters:** `char(n)` pads with spaces, surprises on comparison, and has no performance benefit in Postgres.

**Safe pattern:** use `text` (or `varchar(n)` if you need a length cap).

---

### `prefer-text`

**Severity: 🔵 info**

**Detects:** `varchar(n)` / `character varying(n)` columns in `CREATE TABLE`, `ADD COLUMN`, or `ALTER COLUMN TYPE`. Bare `varchar` (no length) is equivalent to `text` and doesn't fire.

**Why it matters:** `varchar(n)` hard-codes a limit into the schema. Raising it later is catalog-only (since PG 9.2) but still takes a brief ACCESS EXCLUSIVE plus a deploy; *shrinking* it rewrites the whole table and its indexes. `text` with a CHECK constraint enforces the same limit and changes online via `NOT VALID` → `VALIDATE`.

**Safe pattern:** `text` plus `CHECK (length(col) <= n)`, added `NOT VALID` then validated.

---

### `prefer-jsonb`

**Severity: 🔵 info**

**Detects:** `json` columns in `CREATE TABLE` or `ADD COLUMN`.

**Why it matters:** `json` stores the exact input text and reparses it on every operation; it can't be GIN-indexed. `jsonb` stores decomposed binary — slightly slower to write, significantly faster to query, and indexable. The Postgres docs themselves recommend `jsonb` for most applications.

**Safe pattern:** `jsonb`, unless you specifically need byte-exact round-tripping (key order, duplicate keys, whitespace).

---

## Cross-statement analysis

### `many-exclusive-locks-one-transaction`

**Severity: 🟡 warning**

**Detects:** a single transaction that takes exclusive locks on **three or more distinct tables** (`ALTER TABLE`, `DROP TABLE`, `TRUNCATE`, `LOCK TABLE` targets). Scoped per transaction: locks isolated in their own `BEGIN`/`COMMIT` (or under autocommit) are never held together and don't count.

**Why it's dangerous:** all locks are held until `COMMIT`. Touching several hot tables in one transaction multiplies the blast radius — everything stays locked while later statements run — and is a classic deadlock recipe against concurrent traffic.

**Safe pattern:** split into one migration per table, each as short as possible, each with `lock_timeout` set.

---

### `uncommitted-transaction`

**Severity: 🟡 warning**

**Detects:** a file that opens `BEGIN` and never commits it. Runs across the whole file; anchored on the dangling `BEGIN`.

**Why it's dangerous:** the migration can report success while the open transaction is rolled back when the session ends — the changes silently vanish, and every lock it took was held for nothing.

**Safe pattern:** end the file with `COMMIT;`, or remove the `BEGIN` and let the runner manage the transaction.

---

## How impact estimates work (Pro)

With a schema snapshot (`{ tables: { "schema.table": { rows, bytes } } }` — schema stats only, never row data), Landsafe converts each finding's duration class (full rewrite, validation scan, index build) into a conservative time range using wide throughput bands for typical production Postgres on network storage. The class is what moves the number, so the same table lands in different places: a 48M-row, 6.2 GB `users` table scans in "~12 s–62 s" for a `SET NOT NULL`, rewrites in "~41 s–3 min" for an `ADD COLUMN ... DEFAULT gen_random_uuid()`, and takes "~52 s–5 min" to build an index over. The point is order-of-magnitude honesty, not fake precision. Without a snapshot, findings say plainly that duration grows with table size.
