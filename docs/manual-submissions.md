# Add a report or article

Administrators can open **Operations → Add a report or article**, paste a public HTTPS URL, select report/article and request a preview. HackerOne report and Bugcrowd disclosure URLs are classified as reports automatically. Existing canonical archive entries open directly without another capture. Discovery-only candidates can still be previewed and upgraded.

The background runner fetches the source, extracts its title, author/date where supplied and substantive text, and checks current published entries for the same URL, identical indexed text or an identical title. Possible matches remain separate entries for the administrator to inspect. The preview shows completeness, extraction warnings and up to 12,000 characters; the reviewed capture is limited to 200,000 characters.

Select **Approve and queue ingestion** to publish that exact captured text. Approval is not a request to fetch a different revision later. Both preview and publication normally run in the existing four-hour GitHub workflow; delays in GitHub scheduling still apply. To process queued work immediately from the configured workspace:

```sh
npm run submissions -- --remote --limit 10
```

After publication, the existing outcomes, quality, embedding and alert stages run. Preview-only requests do not enter public search or create archive publication alerts. Failed captures can be retried, which requires a fresh preview and approval. Discard is available before publication begins. Withdrawn URLs cannot be resubmitted. The Operations source control can pause **Manual source submissions**.

## Storage and boundaries

Requests and bounded draft bodies are stored in service-only `hs_state`, covered by the existing encrypted backup. Only administrator-checked SECURITY DEFINER RPCs can list or mutate them. Ordinary accounts cannot access the queue, even through direct RPC calls. Browser requests never supply extracted text, content hashes, ownership or worker tokens. The list API omits full draft bodies and lease tokens.

There are at most 20 active requests, including failures, and 20 request/retry actions per administrator per rolling day. Previews expire after seven days; the runner removes expired draft bodies. Cancellation and successful publication also remove the draft body. Compact operational records remain. Queue creation pauses before the database's existing free-tier capacity limit.

The crawler uses the existing DNS-pinned public-address checks, HTTPS restrictions, same-host/www redirects, robots rules, pacing, byte limits and timeouts. URLs containing credentials, local addresses, alternate ports or common signed access parameters are rejected. No login cookies or source account credentials are sent. Paywalls, access gates, PDFs and other unsupported binaries remain unpublished.

Source leases and per-request tokens guard processing. Publication rechecks administrator approval, the reviewed content hash, the live source lease and request state within the database activation transaction. A cancelled or stale worker cannot activate a revision. A crash after publication is safe to retry against the canonical document.

## Deployment and rollback

Apply `017_manual_submissions.sql`, then deploy. It adds functions and a source-control row; durable table shapes and backup schema version remain unchanged. The trusted-main GitHub workflow processes up to ten requests before capture/enrichment. No new credential, hosting provider or paid service is required.

Tests cover URL normalization, source extraction, unauthorized direct RPCs, approval-before-publication, duplicate checks, cancellation fencing and expiration. To roll back, pause the Manual source submissions control, remove its workflow step and restore the prior Worker. Keep the additive migration and already published documents.
