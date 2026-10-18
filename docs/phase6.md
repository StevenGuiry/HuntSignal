# Phase 6: research workflow and extraction quality

HuntSignal 0.6 adds exact program, severity and bounty filters; compact report outcome badges; a navigable reader; and extraction checks. It uses the existing Cloudflare, Supabase and GitHub stack with no new paid services.

## Finding reports

Expand **Program, severity & bounty** and apply a combination of filters. Program names match exactly and suggestions come from the published archive. Severity can select one rating or High + Critical. Bounty disclosure distinguishes a disclosed reward (including zero) from a checked source that supplied no reward. Reports whose outcomes have not been fetched do not qualify as undisclosed.

Choose a currency before entering an amount range. Comparisons use numeric disclosed amounts in that currency only, without conversion or symbol-based currency inference. Text-only/non-cash rewards remain visible on cards but cannot satisfy numeric ranges. Filters apply before keyword pagination and semantic ranking, and round-trip through the URL, saved searches and RSS alerts. New supported reports can wait up to seven days for their initial outcome capture before an outcome-filtered alert is skipped; later changes to a bounty do not themselves generate a new publication alert.

**Complete text only** excludes partial captures and current revisions flagged for likely truncation/navigation text. Reader and search cards distinguish Complete report/article/paper, Public summary, Paper abstract and Partial text. Completeness describes the available source capture; attachments and images remain linked rather than preserved.

## Reading

- Contents lists actual rendered Markdown headings, including duplicate headings with unique source-offset anchors.
- Copy code preserves the rendered code/request text and indentation. Clipboard failures show a manual-copy fallback.
- Search cards offer Jump to matching passage. The reader locates the original snippet in the archived body, scrolls and focuses its block, and highlights it. Metadata-only matches explicitly report that no body passage was located.
- Resume reading uses browser storage, separated by account/guest and document revision. It retains up to 100 positions for 90 days; positions do not sync between devices. Clear saved position removes the current document's entry.

## Extraction quality

`public-text-v3` removes navigation/footer elements before extracting HTML, deduplicates identical HackerOne public summaries, rejects navigation-heavy results and marks explicit continuation/truncation endings partial. `quality-v1` audits archived text for identical substantial sections, explicit truncation notices and navigation-heavy line patterns. These are conservative heuristics, not proof that every source is complete.

Run `npm run quality:check -- --remote --limit 500` for an initial audit. The four-hour workflow checks up to 100 unaudited/currently changed revisions after capture and before indexing. Each quality record is bound to its revision in backed-up `hs_state`; suspected problems appear in Operations and in the reader. Identical repeated sections are repaired automatically only in HackerOne/Bugcrowd partial report summaries. The previous immutable object/revision is retained, normal search indexing follows, and a revision comparison is available. Other repeated research examples are flagged without modification. Optimistic revision checks and existing ingestion leases prevent an old audit from overwriting a newer capture.

## Release

Apply `016_research_workflow.sql` after migration 015. It adds shared filter/facet/quality functions and updates search/detail/alert functions, without changing durable table shapes or backup format. Audit the archive, index any repaired revisions, then deploy the Worker. Tests cover keyword/semantic/alert parity, missing/zero/currency amounts, source-preserving cleanup, stale writes, private permissions, rendered code and snippet offsets. Browser verification covers filter submissions, contents, copying, resume and passage navigation.

Rollback the Worker if search or reader interactions regress, and pause the quality workflow step if extraction checks misclassify content. The additive migration and immutable archived revisions can remain; previous clients ignore new card fields. Saved report filters require the new database functions to remain available.
