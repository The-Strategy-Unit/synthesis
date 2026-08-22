import { DB } from "./db.ts";
import { config, dbPath } from "./config.ts";

const db = new DB(dbPath());
const count = db.computeLinks(config.link.k);
console.log(
  `Rebuilt ${count} cross-source semantic links using up to ${config.link.k} neighbours per page`,
);

db.close();
