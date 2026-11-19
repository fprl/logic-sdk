#!/usr/bin/env node
// `npx logic-sdk check`. The CLI itself lives in @logic-sdk/cli, so apps that never use it
// (a Worker, a Next.js app) don't download its parser and loader.
const CLI = "@logic-sdk/cli";

let cli;
try {
  cli = await import(CLI);
} catch (error) {
  if (error?.code !== "ERR_MODULE_NOT_FOUND" || !String(error.message).includes(CLI)) throw error;
  console.error(`The logic-sdk CLI isn't installed in this project. Add it with:\n\n  npm i -D ${CLI}\n`);
  process.exit(1);
}
await cli.main(process.argv.slice(2));
