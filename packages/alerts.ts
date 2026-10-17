import type { Rpc } from "./repository";
export async function processAlerts(rpc: Rpc, maxBatches = 20) {
  let afterSearchId: string | null = null,
    created = 0,
    checked = 0,
    searches = 0,
    batches = 0,
    invalidSearches = 0;
  do {
    const r: {
      busy?: boolean;
      created: number;
      checkedEvents: number;
      processedSearches: number;
      afterSearchId: string | null;
      invalidSearches?: number;
    } = await rpc("hs_alert_run");
    if (r.busy) return { busy: true, created, checked, searches };
    created += r.created;
    checked += r.checkedEvents;
    searches += r.processedSearches;
    invalidSearches += r.invalidSearches || 0;
    afterSearchId = r.afterSearchId;
    batches++;
  } while (afterSearchId && batches < maxBatches);
  return { created, checked, searches, invalidSearches, more: !!afterSearchId };
}
