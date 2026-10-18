# HuntSignal

A searchable library of public vulnerability write-ups and security research. Version 0.6 adds [report filters, reading tools and extraction quality checks](docs/phase6.md), building on [bounty and severity in report headers](docs/report-outcomes.md). HuntSignal publishes entries only after substantive text is archived, and captures public reports/articles from their sources. Metadata-only discoveries remain internal candidates. See the [text capture policy](docs/text-capture.md), [Phase 5 source guide](docs/phase5.md) and [Phase 4 operations guide](docs/phase4.md). Optional accounts, private libraries and alerts are documented in [Phase 3](docs/phase3.md); keyword and semantic search are described in [Phase 2](docs/phase2.md).

## Run locally

Requires Node.js 24 and npm. Docker and cloud accounts are not needed for the local pilot.

```powershell
npm ci
npm run models:prepare
npm run pilot
npm run capture -- --limit 25
npm run enrich
npm run dev
```

Open **http://localhost:5173**. The persistent embedded PostgreSQL database lives in `.data/postgres`; immutable compressed content lives in `.data/archive`. These are ignored by Git. **Stop the dev server before running ingestion or exports:** PGlite has one local owner. A process lock prevents two commands from opening it concurrently.

The pilot discovers **100 full-text OWASP research articles and 400 historical write-up/report candidates**. Only entries with substantive archived text appear publicly. Run capture to retrieve accessible original bodies; unavailable or blocked pages stay in the internal retry queue. Every public card and reader shows its preservation status and original source. Re-running discovery/capture is idempotent.

Search `XSS` or `cross-site scripting`: both expand to the same canonical concept. Select **Search by meaning** for natural language such as `account takeover through OAuth mistakes`. Keyword results appear immediately while the local browser model loads, then semantic suggestions are blended in. Filters apply to both retrieval paths. **Keywords & synonyms** keeps complete lexical pagination; semantic results are a bounded ranked set. Accounts require the Supabase/GitHub setup linked above; public browsing remains available without sign-in.

## Commands

```powershell
npm run dev                         # Local API and Vite UI
npm run dev:remote                  # Hosted archive and real Supabase accounts
npm run auth:check                  # Provider/key/schema readiness, no secret output
npm run auth:publish-config         # Publish browser-safe key to existing Worker
npm run alerts -- --remote          # Bounded saved-search notification processing
npm run ops -- status --remote      # Schema, source health and capacity
npm run ops -- housekeeping --remote # Run retention and withdrawal cleanup
npm run ingest -- backfill --remote --source hackerone --limit 100
npm run ingest -- refresh --remote --source bugcrowd --limit 25
npm run ingest -- refresh --remote --source owasp-wstg --limit 150
npm run capture -- --remote --limit 25 # Capture public source text before publication
npx tsx scripts/check-sources.ts     # Three real samples per new source, no archive writes
npm run backup:hosted               # Encrypted hosted snapshot + incremental objects
npm run backup:restore -- --from SNAPSHOT --target NEW_DIRECTORY
npm run config:check                # Validate ingestion settings without revealing keys
npm run pilot                       # 500 real catalog items, bounded requests
npm run models:prepare              # Pinned model + CPU WASM assets
npm run enrich                     # Index pending local documents
npm run enrich -- --remote          # Index pending hosted documents
npm run search:eval                 # 50-query regression evaluation
npm run test:wasm                   # WASM/native embedding agreement
npm run ingest -- pilot --limit 50   # Smaller pilot
npm run ingest -- refresh --limit 100 # Due sources; hourly remains a compatible alias
npm run ingest -- owasp --limit 100  # Refresh licensed research
npm run ingest -- hackerone --limit 100
npm run ingest -- hourly --feeds ingestion/feeds.local.json --limit 50
npm run ingest -- import --file documents.json --limit 500
npm run export                      # Tables + every referenced content object
npm run restore -- --from .data/exports/EXPORT_DIRECTORY --target .data/restored
npm test
npm run build
npm run deploy:check                 # Bundle the Worker without deploying
```

Custom imports must satisfy `packages/contracts.ts`. Text capture requires `canArchive: true`, source/license provenance, attribution and substantive body text. This operator approval is not a copyright license. RSS discovers candidates by default; the capture worker retrieves public article bodies, while permitted feed excerpts remain explicitly partial. Never put account secrets in source-controlled feed configuration.

## Source coverage

| Source                          | Implemented behavior                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| OWASP Cheat Sheet Series / WSTG | Full Markdown under CC BY-SA 4.0, pinned to a Git commit; attribution and license visible in the reader                   |
| Pentester Land                  | Public JSON index, original report/write-up links, authors, dates, tags; no automatic copying of third-party bodies       |
| HackerOne                       | Hacktivity discovery followed by unauthenticated public JSON capture; full reports or explicitly partial public summaries |
| Bugcrowd                        | CrowdStream discovery followed by public summary capture; summaries are marked partial                                    |
| Medium / PortSwigger Research   | Curated feeds followed by public HTML article extraction; blocked or gated pages remain pending                           |
| Intigriti / YesWeHack Research  | Public research article extraction; dedicated platform submission-disclosure adapters remain unimplemented                |
| arXiv                           | Web-security papers with searchable CC0 abstracts marked partial; full papers linked at source                            |

Pentester Land is a historical index. Its last publication date is displayed through actual document data; a successful refresh does not mean it contains today's disclosures. OWASP publication dates remain unknown rather than substituting ingestion time. Newly indexed sorting is separate from newest publication sorting.

## Production on the proposed free stack

1. Create a Supabase Free project. Apply the numbered SQL migrations in order, from `001_archive.sql` through `016_research_workflow.sql`. Existing installations only need unapplied migrations. These create the archive/search, personal library, operations and text-publication controls. Migration 007 has an installation-specific GitHub admin bootstrap: forks must replace or remove that owner ID before applying it.
2. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in an ignored `.env` file in this workspace, or in the same terminal that runs ingestion. The CLI loads `.env` automatically; existing terminal/CI variables take precedence. `SUPABASE_URL` is the HTTPS project URL, not a Postgres connection string. The key setting accepts a legacy `service_role` JWT or a modern `sb_secret_` backend key. Keep it out of chat and browser code.

   ```powershell
   # Create the file only if it does not already exist.
   if (-not (Test-Path -LiteralPath '.env')) { Copy-Item -LiteralPath '.env.example' -Destination '.env' }
   notepad .env
   npm run config:check
   ```

   Fill in the two values and save the file before checking. The check validates presence and URL format without displaying secrets or connecting to Supabase. PowerShell environment variables apply only to that session and its children; a new terminal needs them set again unless `.env` supplies them. The CLI uses Supabase only with `--remote`:

   ```powershell
   npm run ingest -- pilot --remote --limit 500
   npm run models:prepare
   npm run enrich -- --remote --limit 1000
   ```

3. Authenticate Wrangler with your Cloudflare account, then store server-side secrets:

   ```powershell
   npx wrangler login
   npx wrangler secret put SUPABASE_URL
   npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
   npm run deploy
   ```

4. For GitHub Actions, configure the same repository secrets. HackerOne discovery uses `HACKERONE_USERNAME` and `HACKERONE_API_TOKEN`. Manually run `Refresh archive` once, then set repository variable `INGESTION_ENABLED=true` to request scheduling every four hours at minute 17. GitHub may delay starts. The workflow runs enrichment after ingestion; individual sources also enforce their daily/weekly intervals. Public repository standard Linux runners fit the planned free model; private repositories have limited minutes. Source code can be public; archives, `.data`, credentials, and user data remain private.

The hosted installation is at [huntsignal.huntsignal.workers.dev](https://huntsignal.huntsignal.workers.dev). It uses Supabase; `npm run dev` uses the local database. Creating workflow files alone does not activate hourly source ingestion. Cloudflare runs separate hourly alert matching and a source-health check; the ingestion runner fetches and indexes material. See [Phase 4](docs/phase4.md) for GitHub Actions activation, the private-code/local-runner alternative, capacity thresholds and recovery. Cloud deployment has no local-data fallback.

## Data and search

`hs_documents` stores metadata and the active revision. `hs_revisions` records immutable content objects and hashes. `hs_chunks` indexes current approved text using PostgreSQL GIN/tsvector. Search ORs aliases inside a concept, ANDs distinct concepts at document level, weights metadata, returns total counts, and provides stable ordering. Every lexical match is accessible through pagination. See [implementation notes](docs/implementation.md).

Initial ingestion is implemented in TypeScript instead of the proposed Python CLI so normalization, contracts, and taxonomy are shared with the app and the project runs with the installed Node runtime. Specialized Python/PDF extraction can be added without changing the database or archive contract. PGlite is only the local backend; the deployed Worker uses Supabase HTTP RPCs and Storage.

## Validation and security

```powershell
npm test
npm run build
npm audit
```

Tests execute the actual SQL against embedded PostgreSQL. They cover synonym recall, cross-chunk queries, pagination, revision history, failed writes, rights validation, retry leases, database access restrictions, SSRF guards, XML entity rejection, and inert Markdown/code rendering.

Phase 2 tests also cover independent semantic retrieval, filtered vector ranking, duplicate grouping, citations, stale model/revision rejection, bounded API requests, and graceful keyword fallback. The 50-query reference set and raw evaluation results are described in [Phase 2](docs/phase2.md).

External content is never executed. Raw HTML is disabled in the reader; code payloads are escaped, unsafe links are discarded, and remote images are links instead of tracking pixels. Fetchers use explicit host lists and validated DNS addresses on every connection/redirect. All ingestion mutations require a server credential in hosted mode; no public import endpoint exists.

## Preservation and backup

`npm run export` creates `.data/exports/<timestamp>/` with JSON tables, a checksum manifest, and compressed archive objects. Copy that directory to another disk. `npm run restore -- --from <export-directory> --target <new-data-directory>` verifies archive checksums, restores metadata/history and rebuilds current search indexes. It refuses to overwrite an existing target. Set `HUNTSIGNAL_DATA_DIR` to the restored directory to use it. An export on the same disk is not disaster recovery, and a hosted database dump alone does not contain Storage objects.

The initial 500-item export was restored successfully into `.data/restore-verification`. See [verification results](docs/verification.md) for the tested scope and limits.

After restoring, rebuild derived vector/citation indexes with `npm run enrich`. Archive objects and original metadata remain the durable source of truth.

Content remains licensed by its original authors. OWASP content is CC BY-SA 4.0, with source revision and license evidence stored per item. Report metadata is credited to Pentester Land and the named researcher. Third-party content is not covered by any future application code license.

The original blueprint is [HuntSignal Application Architecture and Implementation Plan](https://chatgpt.com/space/page_c44ef1c0c3688191a6534a0642888230).
