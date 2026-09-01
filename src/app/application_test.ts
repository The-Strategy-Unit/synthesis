import assert from "node:assert/strict";

import { DB } from "../catalogue/db.ts";
import { closeCatalogueOnServerFinish } from "./application.ts";

Deno.test({
  name: "server shutdown closes the catalogue cleanly",
  permissions: "inherit",
  fn: async () => {
    const directory = await Deno.makeTempDir({
      prefix: "synthesis-shutdown-test-",
    });
    try {
      const db = new DB(`${directory}/synthesis.db`);
      db.notes.addNote(
        "Shutdown page",
        `${directory}/notes/shutdown-page.md`,
        null,
        "text",
      );
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      closeCatalogueOnServerFinish({ finished }, db);

      finish();
      await finished;

      assert.throws(() => db.notes.getAllNotes(), /database is not open/i);
      assert.deepEqual(
        [...Deno.readDirSync(directory)].map((entry) => entry.name).sort(),
        ["synthesis.db"],
      );
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  },
});
