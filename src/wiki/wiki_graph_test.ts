import assert from "node:assert/strict";

import { DB } from "../catalogue/db.ts";
import { renderWikiPage } from "./wiki.ts";
import { buildWikiGraph, getRelatedWikiPages } from "./wiki_graph.ts";

Deno.test({
  name: "explicit wiki links override semantic graph edges",
  permissions: "inherit",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "synthesis-graph-test-" });
    const db = new DB(`${dir}/synthesis.db`);
    try {
      const addPage = async (
        title: string,
        links: string[],
      ): Promise<number> => {
        const filePath = `${dir}/${
          title.toLowerCase().replaceAll(" ", "-")
        }.md`;
        await Deno.writeTextFile(
          filePath,
          renderWikiPage({
            title,
            type: "concept",
            body: `Durable knowledge about ${title}.`,
            tags: ["graph"],
            links,
          }, []),
        );
        return db.notes.addNote(title, filePath, null, "text");
      };

      const first = await addPage("First", ["Second", "Missing"]);
      const second = await addPage("Second", []);
      const third = await addPage("Third", []);
      db.search.upsertLink(first, second, 0.98);
      db.search.upsertLink(second, third, 0.83);

      const graph = await buildWikiGraph(db);
      assert.deepEqual(graph.links, [
        { source: first, target: second, kind: "explicit" },
        {
          source: second,
          target: third,
          kind: "semantic",
          similarity: 0.83,
        },
      ]);
      assert.equal(graph.links.some((link) => link.target === 99_999), false);

      assert.deepEqual(await getRelatedWikiPages(db, second), [
        { id: first, title: "First", kind: "explicit" },
        { id: third, title: "Third", kind: "semantic", similarity: 0.83 },
      ]);
    } finally {
      db.close();
      await Deno.remove(dir, { recursive: true });
    }
  },
});
