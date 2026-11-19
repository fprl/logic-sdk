import { run } from "@stricli/core";
import { app } from "./app.ts";

/** Runs the CLI. The `logic-sdk` command (in the logic-sdk package) calls this. */
export async function main(argv: readonly string[]): Promise<void> {
  await run(app, argv, { process, cwd: process.cwd() });
  // Stricli reports bad usage (unknown command, invalid flag) with negative codes; the convention is 2.
  if (typeof process.exitCode === "number" && process.exitCode < 0) process.exitCode = 2;
}
