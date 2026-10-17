# Phase 3: personal research library

Version 0.3 adds optional GitHub accounts, bookmarks, collections, private notes, read/unread state, saved searches, notifications, RSS feeds, personal exports and account deletion. Public archive browsing and search still work without an account. The stack remains Cloudflare Workers, Supabase and browser/local inference; no paid inference or email service is introduced.

## Enable accounts

Follow [auth-setup.md](auth-setup.md). Apply migrations 004 (if still pending), 005, then 006. Configure GitHub in Supabase, allow the exact app callback URL, and add `SUPABASE_PUBLISHABLE_KEY` to `.env`. Run `npm run auth:check`, then `npm run auth:publish-config` and `npm run deploy`.

The public configuration endpoint stays disabled until a safe publishable key and schema version 6 are present. Provider readiness is checked with `auth:check`; it cannot enable GitHub itself. The application service-role key cannot apply DDL or change provider configuration. The GitHub OAuth client secret belongs only in Supabase. Never use a service-role/secret key as the publishable key.

## Use the library

- Save a document from a search card. The reader has read/unread controls, collection membership and a private note of up to 5,000 characters. Blank notes remove the saved note.
- Create, rename and delete collections in **My library**; the account limit is 50. Deleting a collection leaves its documents, bookmarks and notes intact. The Unread tab shows bookmarked documents you have not marked read.
- **Save search & alert** captures the submitted query, keyword/meaning mode and active filters. Meaning searches reuse the pinned browser model. **Follow author** in the reader creates an exact author filter; topic follows use the topic filter and Save search. Each account can retain 20 searches.
- **Searches & alerts** lets you reopen or delete searches, pause alerts, opt into historical additions or updates, and choose strict (0.60 cosine) or broad (0.45) semantic matching. These thresholds are defaults, not a calibrated probability of relevance. Deleting a search also deletes its notifications and RSS capability. Updating criteria through the API begins watching from the current event watermark; existing notifications remain until the search is deleted.
- **Account** exports your private library as JSON. Account deletion requires typing `DELETE` and removes that user's Supabase Auth record and cascading private records. It preserves the public archive. Downloaded exports cannot be revoked and should be stored privately.

## Authentication and ownership

The browser uses Supabase's official client with PKCE. Session persistence supports refresh; GitHub provider access/refresh tokens are stripped before storage. The app requests GitHub identity/email scopes, not repository access. Return paths must remain on the app origin. Production CSP permits the exact configured Supabase HTTPS origin; no wildcard project origin is added.

Every `/api/me/*` call verifies the bearer through Supabase Auth, then executes a SECURITY INVOKER RPC with the **publishable API key and that user's bearer**. RLS derives ownership from `auth.uid()`; the browser cannot supply an owner. Composite owner/resource foreign keys protect collection membership, notifications and feed links. Private responses are `no-store`, vary on Authorization, and do not include full auth objects. Signed-in state is cleared when identities change. Public search never joins private notes or bookmarks. The admin key is used for account deletion only after resolving the caller, and for ingestion/alert processing/public catalog operations.

Tables: `hs_bookmarks`, `hs_reading_state`, `hs_collections`, `hs_collection_items`, `hs_notes`, `hs_saved_searches`, `hs_notifications`, `hs_feed_tokens`. Internal tables: `hs_publication_events`, `hs_alert_pending`, `hs_alert_runner_state`. Migrations are additive and preserve archive rows and vectors.

## Alerts and RSS

A document's new current revision creates a publication event. Saving a search starts after the current event watermark, so the existing archive does not flood notifications. First-time imports with an unknown publication date or a date older than seven days are classified as historical. Historical additions and updated revisions are separate opt-ins; an updated revision does not require the history option just because the original report is old. These settings affect future processing, not already-consumed events.

Matching applies filters first, then synonym-aware keyword groups or semantic cosine similarity. Keyword matches can notify immediately. A semantic-only match waits in `hs_alert_pending` until that exact revision/model has been indexed. Superseded or withdrawn revisions are skipped. A unique `(search, document, revision)` key and an advisory lock make retries idempotent.

Each SQL batch processes at most 25 searches, 40 new events and 10 pending events per search. The database persists the search cursor so bounded invocations resume across all users. Ready semantic events receive priority. Malformed searches inserted through direct authenticated table access are disabled and counted, so one account's invalid filter cannot interrupt matching for everyone else. Large backlogs can need several scheduled invocations; hourly is a target cadence, not a guaranteed one-hour delivery SLA.

The Worker runs alert processing at minute 47 each hour, up to four batches. The ingestion workflow also runs alerts after enrichment. **This does not enable hourly source ingestion:** GitHub Actions still needs a repository, secrets and `INGESTION_ENABLED=true`. This workspace currently has no Git repository. Local alert processing is manual:

```powershell
npm run alerts
npm run alerts -- --remote
```

Public topic feeds are `/feeds/topics/xss.xml` (use the topic slug). Saved-search feeds are optional bearer capabilities with 256 random bits. Only SHA-256 hashes are stored. Creating/rotating displays the raw URL once; rotation and revocation invalidate the old URL immediately. Feed readers see matching public documents and the saved-search name, never notes or account tokens. Treat the URL as a secret. Private feeds use `no-store`/`no-referrer`, and Worker automatic invocation logs are disabled to avoid recording capability URLs. Manual job logs contain aggregate counts only. Pausing a search makes its feed unavailable until resumed.

## Verification and release status

`npm test` currently passes 58 tests. The Phase 3 suite uses real Postgres RLS in PGlite with independent authenticated roles: cross-user reads/writes, composite ownership, private-note exclusion from public search, quotas, exports, cascading deletion, exact author filters, withdrawn-document cleanup, event deduplication, history/update controls, delayed semantic matches, RSS rotation/revocation, processor cursor continuation and isolation of malformed search filters. API tests check bearer verification/forwarding, rejected owner fields, same-origin writes, safe configuration keys, RSS escaping and verified self-deletion.

```powershell
npm run typecheck
npm test
npm run deploy:check
npm run smoke:phase2
npm run smoke:phase3
```

Set `HUNTSIGNAL_API_URL` to the hosted origin to test a deployment. The ordinary local server serves an independent archive with accounts disabled. `dev:remote` is the account-capable development mode. Automated role tests do not replace a real GitHub OAuth consent and callback check.

Released on 17 October 2026 at [HuntSignal](https://huntsignal.huntsignal.workers.dev), Cloudflare version `52be17ac-534c-4273-885f-eecd900a45f1`. Supabase reports GitHub enabled, a browser-safe key configured, and schema version 6. The production build and hosted Phase 2/3 smoke checks passed; all 510 documents remain indexed. Production dependency auditing reported zero vulnerabilities.

Two disposable accounts were used before deployment and another two through the deployed Worker. All four were removed. Real Supabase/Worker checks passed for bookmark/note/reading isolation, collection ownership, direct PostgREST RLS, private-note exclusion from public search, saved searches, RSS rotation/revocation, exports without credentials, verified self-deletion and public-archive preservation. The reproducible check is `npx tsx scripts/verify-personal-remote.ts`; it creates two marked identities without sending mail and removes only those identities. Add `--predeploy` to use the candidate API handlers with the hosted database. Non-secret cleanup receipts are under `.data/qa/`.

GitHub login completed through the deployed PKCE callback in the browser and returned to My library with the user's existing bookmark. Signed-in library and alert screens rendered successfully with no captured browser warnings/errors. Screenshots are `.data/qa/phase3-signin.png` and `.data/qa/phase3-library.png`. Existing user data was preserved; destructive account checks used disposable identities only. Cloudflare confirmed the `47 * * * *` trigger, and a manual hosted alert pass completed successfully with no pending work. Source ingestion scheduling remains separate as described above.

The previous Phase 2 release is `a838bc28-343a-4c1f-9a18-09792bafa1a0`. It remains a rollback reference if the new application release causes a regression; retain the additive schema and private data when rolling back the application.

## Recovery and operating limits

Roll back the Worker if public search fails or private data crosses account boundaries. Leave additive database tables in place. Disabling GitHub in Supabase stops new GitHub sign-ins; remove the Worker's publishable-key binding to disable the private API as well. Revoke individual RSS links in the app. Account deletion is destructive and is tested only with disposable identities, never with the operator's real account.

`npm run export` remains a portable **public archive** backup. It does not include Supabase Auth identities or everyone's private library. Personal exports belong to their account owners; whole-service recovery would require a separate secured database/Auth backup. Monitor Supabase database size and Cloudflare usage as accounts grow. Notes/notification retention, comprehensive abuse throttling, email delivery and wider source adapters are follow-up work. No free service is assumed to provide unlimited capacity.
