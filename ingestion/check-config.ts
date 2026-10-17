import { loadIngestionEnvironment, remoteConfiguration } from "./config";

try {
  loadIngestionEnvironment();
  remoteConfiguration();
  console.log(
    "Supabase configuration is present and the URL format is valid. No connection attempted; no key values displayed.",
  );
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Configuration failed.",
  );
  process.exitCode = 1;
}
