# Archived text is required for publication

Version 0.5.1 implements the operator's request to remove metadata-only entries from the public collection and capture substantive content from the original public sources.

Discovery and publication are separate. Discovery stores candidate metadata in the existing catalog with `status=pending`; it does not publish a card, search result, topic count, reader, public feed item or alert. A successful text capture activates a revision on the same document ID and publishes it. Existing bookmarks/notes and canonical identities remain intact. Full reports/articles and substantial public summaries/abstracts have distinct completeness labels.

## Capture paths

- HackerOne: fetch the unauthenticated public report JSON. Require the requested report ID, `public=true`, a disclosure date and permission to view the report in that public response. Preserve `vulnerability_information` only for full disclosures. Limited disclosures can contribute an explicitly partial public summary. No account cookies, hacker API tokens or private report endpoints are used for body capture.
- Bugcrowd: extract the public disclosure summary from its own page and label it partial. Never label that summary a full submission report.
- Research blogs and independent write-ups: fetch public HTML, remove active/navigation content with Readability, then convert the article to Markdown while preserving headings, links, lists and code blocks. Images become textual references; media and attachments are not fetched.
- Already archived OWASP guides and arXiv abstracts remain unchanged. PDF extraction is not part of this worker.

The worker checks robots.txt, uses its own HuntSignal user agent, limits source responses to 5 MB, validates public DNS destinations on requests/redirects, and spaces requests by at least 1.1 seconds per host. HTML authentication/challenge pages, declared paywalls, trivial bodies and unsupported binary formats are rejected. HTTP 401/403 is not bypassed. A 429 stops the capture run and carries the provider cooldown into the existing lease controls. Failed captures remain pending with exponential retry spacing capped at seven days. Completed public captures become eligible for a weekly recheck; new pending pages have priority.

Public-source capture is an explicit operator archival policy, **not a reuse license**. Captures retain original-author rights, attribution and source provenance; the app does not label them Creative Commons unless the source actually supplies that license. The original source remains clickable.

## Pipeline and scheduling

`npm run capture -- --remote --limit 25` runs one bounded queue pass. `--source hackerone` or another configured source ID narrows a manual pass; the maximum is 100 candidates. It uses the existing source lease, durable job payloads, atomic activation fencing and capacity controls. Job keys include source identity to avoid collisions between unrelated publishers' external IDs.

The four-hour GitHub workflow runs discovery, capture, indexing, alerts and housekeeping as independent stages. A failed source cannot silently become a metadata-only public result. Operations shows the pending capture count and an Archive text capture control. Source-health cards omit that internal processor from the public provider list.

Migration `014_text_publication.sql` adds the pending state and enforces the publication rule with a database trigger, so every public SQL view/query that already filters `status=published` observes it. It preserves old data rather than deleting it. A metadata-to-text transition emits a first-publication event; updates to existing published reports retain the historical/updated alert distinction.

Encrypted snapshot schema 14 records the new pending-state semantics. Updated recovery code reads snapshots through schema 14 and still supports earlier snapshots. The publication trigger also prevents an old restored metadata record from being republished. Candidate metadata lives in the encrypted table snapshot; object manifests retain the revisions belonging to published documents.

## Validation

Tests cover public-disclosure checks, limited summaries, HTML/Markdown fidelity, paywall and robots rejection, pending-record invisibility, canonical-ID preservation, first-publication alerts, capture retry spacing, private RPC permissions and per-source job keys. Live checks demonstrated full HackerOne report text and extractable PortSwigger/Intigriti/YesWeHack articles; the tested Medium page returned 403 and was kept pending.

Use `npm run smoke:phase5` after deployment to verify zero metadata-only public entries, searchable abstracts and licensed guide text. Inspect queue outcomes and source readers before increasing capture batch sizes. Rollback should retain the publication gate and candidate records, even if a specific extractor is paused.
