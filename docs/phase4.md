# Phase 4: reliability and release

HuntSignal 0.4 adds durable discovery checkpoints, source and document leases, bounded retry queues, administrator controls, revision comparisons, native request throttling, capacity stops, and encrypted hosted backups. The interface and Supabase schema remain compatible with the existing archive and personal library.

## Operations and discovery

Apply migrations 007, 008 and 009 in order. The operations migration contains this installation's verified GitHub owner ID (`46968144`) for initial admin membership; forks must review that bootstrap before applying it. Administration is stored in `hs_admins` and checked against `auth.uid()`. Editable profile metadata never grants access. All admin mutations are audited. Ordinary accounts cannot read job payloads, audit history, capacity diagnostics or the admin allowlist.

The Sources page shows discovery attempts, successful checks, source publication dates and pending/failed work. The Operations page adds source pause/resume, queued refreshes, failed-job retries and review resolution. Refresh queues work for the next runner invocation; it does not perform crawling inside a web request. The private API also supports an explicit withdrawal with a reason. Withdrawal immediately removes published reader/history/search access and derived lexical/vector/citation rows. Housekeeping then removes unreferenced withdrawn objects from the private archive bucket. Rediscovery cannot republish a withdrawal.

Recent HackerOne polling checks the newest page first and skips completed fingerprints without spending its new-document budget on the overlap window. It maintains a watermark with a 48-hour overlap; initial discovery covers seven days. Historical backfill has a separate page/offset cursor and does not interfere with recent polling. A run is bounded to 20 source pages and the requested number of changed documents. Pentester Land and RSS feeds checkpoint their dataset/offset; ETag and Last-Modified validators become active only after all selected records have been queued. A changing dataset restarts safely through deterministic identities.

Document payloads are stored before discovery checkpoints advance. Completed payloads are cleared. Retries operate independently of rediscovery, use exponential backoff, and move to failed state after five attempts. Each source permits at most 200 pending/failed payloads. Source leases renew each minute and expire after five minutes; document leases last three minutes. Fencing tokens prevent an expired worker from committing over its replacement. Provider Retry-After is honored and bounded to one day. Full-text downgrade attempts preserve the existing capture and open a review.

An individual indexing error opens an embedding review and allows other documents to proceed. Resolving the review makes the document eligible for retry; a newly ingested revision supersedes an old embedding failure. Keyword publication remains independent of semantic readiness. The active model is unchanged.

## Automation

The GitHub workflow polls at minute 17 each hour and explicitly refreshes OWASP at 03:23 UTC on Sundays. Source polling intervals also prevent unnecessary work: HackerOne/RSS hourly, Pentester Land daily, OWASP weekly. Ingestion, model preparation, indexing, alerts and housekeeping have independent step outcomes; a partial ingestion failure does not skip alerts or indexing. Final workflow status still reports partial failures. Models are cached by the pinned model configuration and dependency lockfile; action versions use commit SHAs.

Hosted scheduling is enabled only on the trusted `main` branch with `INGESTION_ENABLED=true`. Production credentials belong in repository Actions secrets, never source files or workflow artifacts. CI jobs receive no ingestion secrets. Standard public-repository Linux runners fit the zero-subscription design. Private-repository CI is disabled unless `CI_ENABLED=true`, because its included minutes are shared and finite. Repository publication requires reviewing `.data/publication-manifest.json` and the visibility choice. The setup helper uses Git Credential Manager and libsodium sealed boxes; it never prints token or secret values.

```powershell
npx tsx scripts/publication-check.ts
npx tsx scripts/github-setup.ts status
# Only after source review, publication approval and pushing the tested commit:
npx tsx scripts/github-setup.ts enable
```

Cloudflare continues to match alerts at minute 47 and independently records source health. Public source health is computed from timestamps even if ingestion stops. A source becomes stale after two polling intervals plus one hour. Operations retains 14 days of detailed runs and 90 days of daily summaries. The seven-day release observation window begins with actual scheduled operation; deploying the code does not satisfy that elapsed-time gate.

For a private-code/local-runner installation, `ops/install-tasks.ps1 -LocalIngestion` installs hourly ingestion and daily backups using Windows Task Scheduler. The existing machine must be available and its Windows user signed in. Tasks run with ordinary user privileges, hidden windows and overlap prevention. Provider credentials remain in the local ignored `.env`.

## Capacity and serving

The planning limits are 500 MB for Postgres and 1 GB for archive storage. Warn at 70%, pause backfill at 80%, and stop new archive writes at 90%; optional vector indexing stops at 400 MB. New personal inserts stop at 480 MB, reserving deletion/recovery capacity. Archive writes reserve object bytes before upload and check capacity again before database activation. Hosted storage metering includes the actual archive bucket and outstanding reservations. Legacy local objects are measured before ingestion. No preserved text is automatically deleted to free quota.

Personal database triggers cap notes at 2,000 documents, bookmarks/read state at 10,000 each, and collection memberships at 20,000. Existing 20 saved-search and 50 collection limits remain. These checks apply to direct authenticated PostgREST writes as well as the app. Provider egress and account-wide usage still need checking in the Supabase/Cloudflare dashboards; the storage meter is not an egress meter.

Native Cloudflare bindings allow 120 requests/minute per connecting IP and 60 private API requests/minute per verified user. Responses use 429 and Retry-After. These are permissive per-location abuse controls, not a global accounting guarantee. Only anonymous statistics and topic-directory responses use a 60-second edge cache. Personal routes, exports, admin data and capability feeds stay `no-store`. Public topic RSS can retain its existing 60-second HTTP cache; reader/history access is checked against current publication state on every request.

## History and preservation

Latest reports can be ordered by publication, first indexing, or updates. The updated feed contains only documents with multiple revisions. The reader shows the latest 50 revisions and a bounded comparison of changed text regions. Comparisons preserve code indentation and render as escaped text. Long regions are visibly truncated; archival content is retained. Historical revisions created before this release have no precomputed comparison.

## Encrypted backup and recovery

Set `HUNTSIGNAL_BACKUP_DIR` to the backup destination and `HUNTSIGNAL_BACKUP_KEY_FILE` to a separate protected key file. A new installation generates a random 256-bit key; an existing backup directory requires its original key. Preserve a separate recovery copy of the key. Backups use AES-256-GCM with unique nonces and authenticated object/snapshot identities. Each immutable compressed object is downloaded once, encrypted, and reused by subsequent snapshots. Credentials, private data and raw key contents are never printed.

```powershell
npm run backup:hosted
npm run backup:hosted -- --ledger-only
npm run backup:restore -- --from PATH_TO_SNAPSHOT --target NEW_LOCAL_DIRECTORY
```

The hosted snapshot includes catalog/revisions, source cursors, job state, policies/withdrawals, private tables, model configuration, and Auth users/identities. It excludes live sessions, refresh tokens and RSS capabilities. Postgres captures the table snapshot consistently; Storage objects are exported separately and checked against SHA-256 manifests. A backup is marked complete only after all required objects and the encrypted snapshot verify. A missing withdrawn object or connection failure leaves previous snapshots intact.

Restore defaults to the public catalog. To restore personal data, add `--include-personal --privacy-ledger PATH_TO_FRESH_LEDGER`. The ledger must come from the same project, postdate the snapshot and have been refreshed within the preceding hour. It filters deleted owners and applies content suppressions, so an old backup does not silently resurrect known deletions. If a fresh privacy ledger cannot be obtained, recover the catalog first and reconcile deletion records before restoring personal data.

The automated restore targets a new **local PGlite database**, refuses existing targets, rebuilds lexical indexes, resets outstanding leases, and preserves ownership IDs. It validates private-table recovery/RLS without recreating live OAuth sessions. Vector and citation indexes are derived: rebuild with `HUNTSIGNAL_DATA_DIR` pointing at the restored directory and `npm run enrich`. Restoring into a replacement Supabase project additionally requires its managed Auth schema/configuration, bucket setup, provider redirects and credential rotation to be validated; the local restore is not an unattended cloud-project replacement.

`ops/install-tasks.ps1` installs the daily 03:35 local-time encrypted backup task. It catches missed starts when the signed-in machine becomes available; logs go to ignored `.data/logs/backup-latest.log`. A sibling directory on the same physical disk protects against checkout loss but does not provide disk-failure recovery. Daily backup reliability depends on that machine and the key remaining available.

## Runbooks

**Source failure:** inspect Operations and the failed workflow step; honor provider cooldowns; correct credentials or the versioned adapter; retry the job or queue the source. Resolve its review after validating the fix. Do not advance cursors manually to hide errors.

**Capacity warning:** inspect database/object counts and provider egress. Pause historical backfill first. Measure growth before expanding from 510 to 1,000 and then 2,000 items. Retain original archives; remove only proven unreferenced staging files or explicitly withdrawn content. No paid upgrade is automatic.

**Withdrawal:** submit the admin withdrawal action with a reason, verify public search/detail/history are unavailable, run `npm run ops -- housekeeping --remote`, and export a fresh privacy ledger. Historical encrypted backups retain their original bytes until their retention window ends; every recovery must apply the newer suppression/deletion journal.

**Restore:** stop ingestion, preserve the existing database, obtain the freshest privacy ledger, verify/decrypt into a new local directory, check catalog counts and two-user ownership, rebuild derived indexes, and validate the target runtime before switching any production connection.

**Rollback:** roll back the Worker to the prior known version while retaining the additive schema. Pause ingestion before reverting pipeline code that does not understand Phase 4 controls. Backups, user data and withdrawal records must remain intact.

## Validation record

The pre-release suite includes real SQL lease/cursor/retry tests, admin isolation, capacity stops, withdrawal non-resurrection, revision comparisons, authenticated encryption tamper checks, privacy-journal recovery, edge-cache isolation and throttling. An encrypted fixture is restored through the actual CLI and its recovered RLS is tested.

The first hosted backup exported all 510 objects (841,721 compressed bytes) on 17 October 2026 and was successfully restored into a separate local directory with personal data. Live migration verification reported schema version 9, approximately 37.3 MB database usage and 0.84 MB archive storage. Release/version, scheduler activation and browser verification are recorded after deployment. The week-long observation gate remains open until seven actual days have elapsed.
