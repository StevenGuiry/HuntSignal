# Report bounty and severity

The report reader displays bounty and severity directly below the author/date. Articles and papers do not show these fields. Bounties retain the disclosed currency; zero is distinct from an undisclosed amount. Open reports show **Current severity / Not finalised**. Closed reports show **Final severity**, using the latest checked platform value, with the check date visible.

HackerOne values come from unauthenticated public report JSON, after checking report identity and disclosure visibility. Bugcrowd values come from the public disclosure's labelled Priority, Status and Bounty/Reward fields. P1–P5 map to Critical, High, Medium, Low and Informational; the native priority remains visible. Private feed amounts, points, researcher estimates and program reward ranges are never used. Unsupported sources show **Not available**; a checked source without a value shows **Not disclosed**.

Apply `supabase/migrations/015_report_facts.sql`, then run:

```sh
npm run reports:refresh -- --remote --limit 100
```

The existing four-hour GitHub workflow checks up to 25 due reports per run. Each report becomes due after one day. Checks reuse the public-text fetcher's robots rules, pacing, redirect restrictions and response limits. The job shares the capture lease, pause control and cooldown. An unavailable source keeps its last successful values and check date, and retries after one day. HTTP 429 stops the batch and sets the provider cooldown.

Outcomes and attempt timestamps use service-only `hs_state` records, already covered by encrypted backups. Their updates do not change archived bodies, text revisions, embeddings, publication dates or saved-search alerts. No archive rewrite or backup-format migration is required.

Validation: parser tests cover public visibility, currencies, zero, non-cash rewards and Bugcrowd priorities; UI tests distinguish final/current severity; database tests cover stale-write rejection, source binding, retry backoff, access restrictions and unchanged revisions.

Rollback: restore the preceding Worker version and remove the report-outcome workflow step. Migration 015 is additive and can remain applied; prior clients ignore `report_facts`. Roll back if report detail responses fail or outcome values disagree with the source. Existing bodies and personal libraries are unaffected.
