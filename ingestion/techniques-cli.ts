import { ingestionContext } from "./context";
import { indexTechniques } from "./techniques";
const args = process.argv.slice(2),
  i = args.indexOf("--limit"),
  limit = Number(i < 0 ? 500 : args[i + 1]);
if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
  throw Error("--limit must be between 1 and 1000");
const context = await ingestionContext(args.includes("--remote"));
try {
  const result = await indexTechniques(context.rpc, context.read, limit);
  console.log(JSON.stringify(result));
  if (result.failed) process.exitCode = 1;
} finally {
  await context.close();
}
