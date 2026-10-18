import { ingestionContext } from "./context";
import { fetchReportFacts } from "./report-facts";
import { CaptureUnavailable } from "./capture";
import { SourceFetchError } from "./fetch";
import { safeError } from "./operations";

const args = process.argv.slice(2),
  index = args.indexOf("--limit");
const limit = Number(index < 0 ? 25 : args[index + 1]);
if (!Number.isInteger(limit) || limit < 1 || limit > 100)
  throw new Error("--limit must be between 1 and 100");
const context = await ingestionContext(args.includes("--remote"));
try {
  // Share the capture lease: operator pauses and provider cooldowns apply to both jobs.
  const claim = await context.rpc<{
    claimed: boolean;
    token: string;
    status: string;
  }>("hs_ops_source", {
    action: "claim",
    sourceId: "fulltext-capture",
    force: true,
  });
  if (!claim.claimed) console.log(JSON.stringify({ status: claim.status }));
  else {
    const control = (action: string, extra = {}) =>
      context.rpc("hs_ops_source", {
        action,
        sourceId: "fulltext-capture",
        token: claim.token,
        ...extra,
      });
    let lost = false,
      refreshed = 0,
      unavailable = 0,
      error = "",
      retrySeconds = 0;
    const timer = setInterval(() => {
      void control("heartbeat").catch(() => {
        lost = true;
      });
    }, 60000);
    timer.unref();
    try {
      const candidates = await context.rpc<{ id: string; url: string }[]>(
        "hs_report_facts_candidates",
        { limit },
      );
      for (const candidate of candidates) {
        if (lost) throw new Error("Source lease lost");
        let facts;
        try {
          facts = await fetchReportFacts(candidate.url);
        } catch (e) {
          if (!(
            e instanceof CaptureUnavailable || e instanceof SourceFetchError
          ))
            throw e;
          await context.rpc("hs_report_facts_put", { id: candidate.id });
          unavailable++;
          console.log(
            JSON.stringify({
              id: candidate.id,
              state: "retry",
              reason: safeError(e),
            }),
          );
          if (e instanceof SourceFetchError && e.status === 429) throw e;
          continue;
        }
        if (lost) throw new Error("Source lease lost");
        await context.rpc("hs_report_facts_put", { id: candidate.id, facts });
        refreshed++;
      }
    } catch (e) {
      error = safeError(e);
      if (e instanceof SourceFetchError) retrySeconds = e.retrySeconds;
      process.exitCode = 1;
    } finally {
      clearInterval(timer);
      if (!lost)
        await control("release", {
          ok: !error,
          error,
          retrySeconds,
          processed: refreshed,
        });
    }
    console.log(JSON.stringify({ refreshed, unavailable, error }));
  }
} finally {
  await context.close();
}
