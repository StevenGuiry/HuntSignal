/** Modern secret keys go on apikey only; legacy JWTs also support Bearer auth. */
export function backendHeaders(key: string): Record<string, string> {
  return {
    apikey: key,
    ...(key.startsWith("sb_secret_") ? {} : { Authorization: `Bearer ${key}` }),
  };
}
export async function readSupabaseObject(
  url: string,
  key: string,
  bucket: string,
  path: string,
) {
  if (!/^[a-f0-9]{64}\.json\.gz$/.test(path))
    throw new Error("Invalid archive object path");
  const response = await fetch(
    `${url.replace(/\/$/, "")}/storage/v1/object/${encodeURIComponent(bucket)}/${path}`,
    { headers: backendHeaders(key), signal: AbortSignal.timeout(15000) },
  );
  if (!response.ok || !response.body) throw new Error("Archive unavailable");
  return new Response(
    response.body.pipeThrough(new DecompressionStream("gzip")),
  ).text();
}
