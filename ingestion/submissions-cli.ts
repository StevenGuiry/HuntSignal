import { ingestionContext } from "./context";
import { processSubmissions } from "./submissions";
const args = process.argv.slice(2),
  i = args.indexOf("--limit"),
  limit = Number(i < 0 ? 10 : args[i + 1]);
if (!Number.isInteger(limit) || limit < 1 || limit > 20)
  throw Error("--limit must be between 1 and 20");
const context = await ingestionContext(args.includes("--remote"));
try {
  const result = await processSubmissions(
    context.rpc,
    context.write,
    context.read,
    limit,
  );
  console.log(JSON.stringify(result));
  if (result.failed) process.exitCode = 1;
} finally {
  await context.close();
}
