/** Uses Git Credential Manager for this repository. Credentials never reach stdout or arguments. */
import { execFileSync } from "node:child_process";
import sodium from "libsodium-wrappers";
import { loadIngestionEnvironment } from "../ingestion/config";
loadIngestionEnvironment();
const repository = "StevenGuiry/HuntSignal",
  owner = "StevenGuiry";
let credential: string;
try {
  credential = execFileSync("git", ["credential", "fill"], {
    input: `protocol=https\nhost=github.com\nusername=${owner}\n\n`,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
} catch {
  throw new Error(
    "GitHub authentication is unavailable. Sign in with Git Credential Manager first.",
  );
}
const token = credential
  .split(/\r?\n/)
  .find((line) => line.startsWith("password="))
  ?.slice(9);
credential = "";
if (!token) throw new Error("GitHub credential was not available");
async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch("https://api.github.com" + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10",
      "User-Agent": "HuntSignal-operations",
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok)
    throw new Error(`GitHub ${method} ${path} returned ${response.status}`);
  return response.status === 204 ? null : response.json();
}
const account = await api("/user");
if (account.login !== owner)
  throw new Error("GitHub identity does not match the repository owner");
const repo = await api("/repos/" + repository);
if (!repo.permissions?.admin)
  throw new Error("Repository administration is required");
const mode = process.argv[2] || "status";
if (mode === "status") {
  const secrets = await api(`/repos/${repository}/actions/secrets`);
  const variables = await api(`/repos/${repository}/actions/variables`);
  const runs = await api(`/repos/${repository}/actions/runs?per_page=10`);
  console.log(
    JSON.stringify(
      {
        repository,
        visibility: repo.visibility,
        defaultBranch: repo.default_branch,
        secrets: secrets.secrets.map((s: { name: string }) => s.name),
        variables: variables.variables.filter(
          (v: { name: string }) => v.name === "INGESTION_ENABLED",
        ),
        runs: runs.workflow_runs.map((r: any) => ({
          id: r.id,
          name: r.name,
          event: r.event,
          status: r.status,
          conclusion: r.conclusion,
          url: r.html_url,
          createdAt: r.created_at,
        })),
      },
      null,
      2,
    ),
  );
} else if (mode === "make-public") {
  if (!process.argv.includes("--confirmed"))
    throw new Error(
      "Confirm publication of the reviewed source before changing repository visibility",
    );
  await api("/repos/" + repository, "PATCH", { private: false });
  console.log(JSON.stringify({ repository, visibility: "public" }));
} else if (mode === "enable") {
  if (repo.private)
    throw new Error(
      "Hosted scheduling requires the approved public repository to preserve the zero-subscription design",
    );
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const remote = await api(
    `/repos/${repository}/commits/${repo.default_branch}`,
  );
  if (remote.sha !== commit)
    throw new Error(
      "Push the reviewed local commit before enabling scheduling",
    );
  await sodium.ready;
  const pub = await api(`/repos/${repository}/actions/secrets/public-key`);
  let configured = 0;
  for (const name of [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "HACKERONE_USERNAME",
    "HACKERONE_API_TOKEN",
  ]) {
    const value = process.env[name];
    if (!value) throw new Error(`Missing ${name}`);
    const encrypted = sodium.to_base64(
      sodium.crypto_box_seal(
        sodium.from_string(value),
        sodium.from_base64(pub.key, sodium.base64_variants.ORIGINAL),
      ),
      sodium.base64_variants.ORIGINAL,
    );
    await api(`/repos/${repository}/actions/secrets/${name}`, "PUT", {
      encrypted_value: encrypted,
      key_id: pub.key_id,
    });
    configured++;
  }
  const vars = await api(`/repos/${repository}/actions/variables`);
  const exists = vars.variables.some(
    (v: { name: string }) => v.name === "INGESTION_ENABLED",
  );
  await api(
    `/repos/${repository}/actions/variables${exists ? "/INGESTION_ENABLED" : ""}`,
    exists ? "PATCH" : "POST",
    { name: "INGESTION_ENABLED", value: "true" },
  );
  await api(
    `/repos/${repository}/actions/workflows/ingest.yml/dispatches`,
    "POST",
    { ref: repo.default_branch, inputs: { mode: "hackerone", limit: "25" } },
  );
  console.log(
    JSON.stringify({
      repository,
      configuredSecrets: configured,
      ingestionEnabled: true,
      initialRun: "dispatched",
    }),
  );
} else throw new Error("Use status, make-public --confirmed, or enable");
