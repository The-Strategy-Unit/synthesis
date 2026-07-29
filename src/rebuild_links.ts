import { DB } from "./db.ts";
import { computeLinks } from "./embed.ts";
import { config, dbPath } from "./config.ts";

const db = new DB(dbPath());
db.clearLinks();

const count = computeLinks(db, config.link.similarityThreshold);
console.log(
  `Rebuilt ${count} links at threshold ${config.link.similarityThreshold}`,
);

db.close();
