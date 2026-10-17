import {
  loadIngestionEnvironment,
  remoteConfiguration,
} from "../ingestion/config";
import { backendHeaders } from "../packages/supabase";
import { safePublishableKey } from "../apps/api/personal";
loadIngestionEnvironment();
const { url, key } = remoteConfiguration();
const publishable =
  process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
const settings = await fetch(url + "/auth/v1/settings", {
  headers: backendHeaders(key),
  signal: AbortSignal.timeout(15000),
});
const auth = (await settings.json()) as { external?: { github?: boolean } };
const schema = await fetch(url + "/rest/v1/rpc/hs_phase3_status", {
  method: "POST",
  headers: { ...backendHeaders(key), "Content-Type": "application/json" },
  body: "{}",
  signal: AbortSignal.timeout(15000),
});
const state = schema.ok
  ? ((await schema.json()) as { schemaVersion?: number })
  : null;
console.log(
  JSON.stringify(
    {
      publishableKeyReady: safePublishableKey(publishable, key),
      authSettingsStatus: settings.status,
      githubEnabled: auth.external?.github === true,
      schemaVersion: state?.schemaVersion || null,
      phase3SchemaReady: state?.schemaVersion === 6,
    },
    null,
    2,
  ),
);
