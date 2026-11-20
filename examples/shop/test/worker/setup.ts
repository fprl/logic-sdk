import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

/** A throwaway Postgres for the Workers tests, speaking the wire protocol on 127.0.0.1:5443. */
export default async function setup() {
  const db = await PGlite.create();
  await db.exec(await readFile("src/db/migrate.sql", "utf8"));
  const server = new PGLiteSocketServer({ db, port: 5443, maxConnections: 10 });
  await server.start();
  return async () => {
    await server.stop();
    await db.close();
  };
}
