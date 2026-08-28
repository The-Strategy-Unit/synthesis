import { DB } from "./db.ts";
import { config, dbPath } from "../app/config.ts";

const db = new DB(dbPath());
const status = db.search.semanticIndexStatus();
if (!status.complete) {
  db.close();
  throw new Error(
    `Semantic index is incomplete (${status.embedded}/${status.total} pages); rebuild it before rebuilding links`,
  );
}
const count = db.search.computeLinks(config.link.k);
console.log(
  `Rebuilt ${count} cross-source semantic links using up to ${config.link.k} neighbours per page`,
);

db.close();
