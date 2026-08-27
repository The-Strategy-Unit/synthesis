import { join } from "node:path";

import { renderWikiPage, type WikiPage } from "./wiki.ts";

interface TrialSourceSeed {
  key: "accord" | "sprint" | "step" | "bproad";
  title: string;
  url: string;
  text: string;
  summary: string;
}

interface WrittenTrialSource extends TrialSourceSeed {
  contentHash: string;
}

interface TrialPageSeed extends WikiPage {
  sourceKeys: TrialSourceSeed["key"][];
  fileName: string;
}

export interface PreparedTrialRun {
  rootDirectory: string;
  vaultDirectory: string;
  port: number;
}

const TRIAL_SOURCES: TrialSourceSeed[] = [
  {
    key: "accord",
    title: "Curated extract: ACCORD BP (2010)",
    url: "https://www.nejm.org/doi/full/10.1056/NEJMoa1001286",
    text:
      `Curated trial extract for demonstration; verify against the linked paper.

ACCORD BP randomly assigned 4,733 adults with type 2 diabetes and elevated cardiovascular risk to a systolic blood-pressure target below 120 mm Hg or below 140 mm Hg. Intensive treatment did not significantly reduce the primary composite of nonfatal myocardial infarction, nonfatal stroke, or cardiovascular death. Stroke was less frequent with intensive treatment, while serious adverse events attributed to antihypertensive treatment were more frequent.

Citation: ACCORD Study Group. Effects of Intensive Blood-Pressure Control in Type 2 Diabetes Mellitus. New England Journal of Medicine. 2010;362:1575-1585. DOI 10.1056/NEJMoa1001286.`,
    summary:
      "In adults with type 2 diabetes, ACCORD BP found no significant reduction in its primary cardiovascular composite, while stroke and treatment-related harm pointed in different directions.",
  },
  {
    key: "sprint",
    title: "Curated extract: SPRINT (2015)",
    url: "https://www.nejm.org/doi/full/10.1056/NEJMoa1511939",
    text:
      `Curated trial extract for demonstration; verify against the linked paper.

SPRINT randomly assigned 9,361 adults at increased cardiovascular risk without diabetes to a systolic blood-pressure target below 120 mm Hg or below 140 mm Hg. Intensive treatment reduced the primary composite outcome and all-cause mortality. Serious adverse events including hypotension, syncope, electrolyte abnormalities, and acute kidney injury or failure were more frequent with intensive treatment.

Citation: SPRINT Research Group. A Randomized Trial of Intensive versus Standard Blood-Pressure Control. New England Journal of Medicine. 2015;373:2103-2116. DOI 10.1056/NEJMoa1511939.`,
    summary:
      "In high-risk adults without diabetes, SPRINT found cardiovascular and mortality benefit from intensive control alongside more selected serious adverse events.",
  },
  {
    key: "step",
    title: "Curated extract: STEP (2021)",
    url: "https://www.nejm.org/doi/full/10.1056/NEJMoa2111437",
    text:
      `Curated trial extract for demonstration; verify against the linked paper.

STEP randomly assigned 8,511 Chinese adults aged 60 to 80 years with hypertension to a systolic blood-pressure target of 110 to below 130 mm Hg or 130 to below 150 mm Hg. Intensive treatment reduced the primary composite cardiovascular outcome. Safety and renal outcomes did not differ significantly except that hypotension was more frequent with intensive treatment.

Citation: STEP Study Group. Trial of Intensive Blood-Pressure Control in Older Patients with Hypertension. New England Journal of Medicine. 2021;385:1268-1279. DOI 10.1056/NEJMoa2111437.`,
    summary:
      "In older Chinese adults with hypertension, including participants with and without diabetes, STEP found fewer composite cardiovascular events with intensive control and more hypotension.",
  },
  {
    key: "bproad",
    title: "Curated extract: BPROAD (2024)",
    url: "https://www.nejm.org/doi/full/10.1056/NEJMoa2412006",
    text:
      `Curated trial extract for demonstration; verify against the linked paper.

BPROAD randomly assigned 12,821 adults aged 50 years or older with type 2 diabetes, elevated systolic blood pressure, and increased cardiovascular risk to a systolic blood-pressure target below 120 mm Hg or below 140 mm Hg. Intensive treatment significantly reduced the primary composite of nonfatal stroke, nonfatal myocardial infarction, treatment or hospitalisation for heart failure, or cardiovascular death. Symptomatic hypotension and hyperkalaemia occurred more often with intensive treatment.

Citation: Bi Y, et al. Intensive Blood-Pressure Control in Patients with Type 2 Diabetes. New England Journal of Medicine. Published online 2024. DOI 10.1056/NEJMoa2412006.`,
    summary:
      "In Chinese adults with type 2 diabetes and increased cardiovascular risk, BPROAD found fewer major cardiovascular events with intensive control and more symptomatic hypotension and hyperkalaemia.",
  },
];

const TRIAL_PAGES: TrialPageSeed[] = [
  {
    fileName: "blood-pressure-targets-across-trials.md",
    title: "Blood-pressure targets across trials",
    type: "synthesis",
    body:
      "These four trials do not establish one context-free systolic target. ACCORD BP did not show a significant benefit for its primary composite in adults with type 2 diabetes, although stroke was less frequent. BPROAD later found a significant primary composite benefit in a larger Chinese population with type 2 diabetes and increased cardiovascular risk. SPRINT found benefit in high-risk adults without diabetes, while STEP found benefit among older Chinese adults with hypertension, including people with and without diabetes and using a different target comparison.\n\nThe wiki resolves the apparent conflict by preserving population, comparator, outcome, follow-up, measurement, and adverse-event differences rather than voting for one study or averaging unlike results into a universal target. Intensive treatment also increased selected harms. This demonstration summarises trial-level evidence; it is not clinical guidance.",
    tags: ["blood-pressure", "evidence-conflict", "trial"],
    links: [
      "How the evidence conflict evolved",
      "ACCORD BP",
      "SPRINT",
      "STEP",
      "BPROAD",
      "Intensive-control trade-offs",
    ],
    sourceKeys: ["accord", "sprint", "step", "bproad"],
  },
  {
    fileName: "how-the-evidence-conflict-evolved.md",
    title: "How the evidence conflict evolved",
    type: "synthesis",
    body:
      "**Act I — a cautious baseline.** ACCORD BP enters the wiki first. Its page records that targeting below 120 mm Hg did not significantly reduce the primary composite in its high-risk type 2 diabetes population, while stroke and treatment-related harms moved in different directions. The review must not inflate that result into “intensive control never works in diabetes”.\n\n**Act II — an apparent contradiction.** SPRINT reports cardiovascular and mortality benefit with a similar target comparison. Because SPRINT excluded diabetes, Synthesis should preserve both findings and narrow the claim by population rather than overwrite ACCORD. STEP then adds benefit in older Chinese adults with hypertension, including people with and without diabetes, but its comparator and population differ again.\n\n**Act III — the hard conflict arrives.** BPROAD directly revisits intensive control in type 2 diabetes and reports a significant primary composite benefit. A good ingest proposal should mark this as a contradiction if the existing wiki generalised ACCORD's null primary result. The human reviewer can inspect both sources and accept a rewrite that keeps both results visible.\n\n**Act IV — resolution without false consensus.** The durable page now says that trial results differ across populations and designs; it does not select a winner or invent a causal explanation for the difference. The answer to “Does below 120 mm Hg improve outcomes?” becomes a structured map—population, comparator, outcome definition, follow-up, and harms—not a context-free yes or no. This is a guided reconstruction of review logic, not a clinical recommendation.",
    tags: ["blood-pressure", "conflict-resolution", "provenance"],
    links: [
      "Blood-pressure targets across trials",
      "ACCORD BP",
      "SPRINT",
      "STEP",
      "BPROAD",
    ],
    sourceKeys: ["accord", "sprint", "step", "bproad"],
  },
  {
    fileName: "accord-bp.md",
    title: "ACCORD BP",
    type: "entity",
    body:
      "ACCORD BP studied 4,733 adults with type 2 diabetes and elevated cardiovascular risk. A systolic target below 120 mm Hg did not significantly reduce the trial's primary cardiovascular composite compared with a target below 140 mm Hg. Stroke was less frequent, but serious adverse events attributed to treatment were more frequent with intensive control.",
    tags: ["blood-pressure", "diabetes", "trial"],
    links: [
      "Blood-pressure targets across trials",
      "Intensive-control trade-offs",
    ],
    sourceKeys: ["accord"],
  },
  {
    fileName: "sprint.md",
    title: "SPRINT",
    type: "entity",
    body:
      "SPRINT studied 9,361 adults at increased cardiovascular risk without diabetes. A systolic target below 120 mm Hg reduced the primary composite outcome and all-cause mortality compared with a target below 140 mm Hg. Several serious adverse events were more frequent with intensive control.",
    tags: ["blood-pressure", "cardiovascular-risk", "trial"],
    links: [
      "Blood-pressure targets across trials",
      "Intensive-control trade-offs",
    ],
    sourceKeys: ["sprint"],
  },
  {
    fileName: "step.md",
    title: "STEP",
    type: "entity",
    body:
      "STEP studied 8,511 Chinese adults aged 60 to 80 years with hypertension, including participants with and without diabetes. A systolic target of 110 to below 130 mm Hg reduced the primary composite cardiovascular outcome compared with a target of 130 to below 150 mm Hg. Hypotension was more frequent with intensive control.",
    tags: ["blood-pressure", "older-adults", "trial"],
    links: [
      "Blood-pressure targets across trials",
      "Intensive-control trade-offs",
    ],
    sourceKeys: ["step"],
  },
  {
    fileName: "bproad.md",
    title: "BPROAD",
    type: "entity",
    body:
      "BPROAD studied 12,821 Chinese adults aged 50 years or older with type 2 diabetes and increased cardiovascular risk. A systolic target below 120 mm Hg reduced the primary composite of major cardiovascular events compared with a target below 140 mm Hg. Symptomatic hypotension and hyperkalaemia were more frequent with intensive control.",
    tags: ["blood-pressure", "diabetes", "trial"],
    links: [
      "Blood-pressure targets across trials",
      "How the evidence conflict evolved",
      "Intensive-control trade-offs",
      "ACCORD BP",
    ],
    sourceKeys: ["bproad"],
  },
  {
    fileName: "intensive-control-trade-offs.md",
    title: "Intensive-control trade-offs",
    type: "concept",
    body:
      "A lower systolic target can change cardiovascular outcomes and treatment-related harms at the same time. The balance cannot be inferred from the target number alone: trial population, measurement method, outcome definition, achieved pressure, follow-up, and adverse-event ascertainment all affect interpretation.",
    tags: ["blood-pressure", "benefit-harm", "interpretation"],
    links: [
      "Blood-pressure targets across trials",
      "ACCORD BP",
      "SPRINT",
      "STEP",
      "BPROAD",
    ],
    sourceKeys: ["accord", "sprint", "step", "bproad"],
  },
];

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

async function assertEmptyDirectory(directory: string): Promise<void> {
  await Deno.mkdir(directory, { recursive: true });
  for await (const _entry of Deno.readDir(directory)) {
    throw new Error("Trial vault directory must be empty");
  }
}

async function writeSource(
  vaultDirectory: string,
  source: TrialSourceSeed,
): Promise<WrittenTrialSource> {
  const sourceText = source.text + "\n";
  const contentHash = await sha256(sourceText);
  const directory = join(vaultDirectory, "sources", contentHash);
  await Deno.mkdir(directory, { recursive: true });
  await Deno.writeTextFile(join(directory, "source.txt"), sourceText);
  await Deno.writeTextFile(
    join(directory, "summary.md"),
    source.summary + "\n",
  );
  await Deno.writeTextFile(
    join(directory, "meta.json"),
    JSON.stringify(
      {
        contentHash,
        sourceType: "text",
        sourceUrl: source.url,
        title: source.title,
      },
      null,
      2,
    ) + "\n",
  );
  return { ...source, contentHash };
}

export async function seedTrialVault(vaultDirectory: string): Promise<void> {
  await assertEmptyDirectory(vaultDirectory);
  await Deno.mkdir(join(vaultDirectory, "notes"), { recursive: true });
  await Deno.mkdir(join(vaultDirectory, "sources"), { recursive: true });

  const written = new Map<TrialSourceSeed["key"], WrittenTrialSource>();
  for (const source of TRIAL_SOURCES) {
    written.set(source.key, await writeSource(vaultDirectory, source));
  }
  for (const page of TRIAL_PAGES) {
    const sources = page.sourceKeys.map((key) => {
      const source = written.get(key)!;
      return {
        contentHash: source.contentHash,
        title: source.title,
        url: source.url,
      };
    });
    await Deno.writeTextFile(
      join(vaultDirectory, "notes", page.fileName),
      renderWikiPage(page, sources),
    );
  }
}

function availablePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

export async function prepareTrialRun(): Promise<PreparedTrialRun> {
  const rootDirectory = await Deno.makeTempDir({ prefix: "synthesis-trial-" });
  const vaultDirectory = join(rootDirectory, "vault");
  try {
    const configuredPort = Deno.env.get("SYNTHESIS_PORT")?.trim();
    const port = configuredPort ? Number(configuredPort) : availablePort();
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new Error("SYNTHESIS_PORT must be a valid port");
    }
    Deno.env.set("SYNTHESIS_APP_DATA", join(rootDirectory, "app-data"));
    Deno.env.set("SYNTHESIS_HOST", "127.0.0.1");
    Deno.env.set("SYNTHESIS_PORT", String(port));
    Deno.env.set("SYNTHESIS_TRUST_PROXY_AUTH", "false");
    Deno.env.set("SYNTHESIS_VAULT", vaultDirectory);

    await seedTrialVault(vaultDirectory);
    const [{ dbPath }, { DB }, { rebuildVaultCatalogue }] = await Promise.all([
      import("./config.ts"),
      import("./db.ts"),
      import("./vault_rebuild.ts"),
    ]);
    const db = new DB(dbPath());
    try {
      await rebuildVaultCatalogue(db);
    } finally {
      db.close();
    }
    return { rootDirectory, vaultDirectory, port };
  } catch (error) {
    await Deno.remove(rootDirectory, { recursive: true }).catch(() => {});
    throw error;
  }
}

export async function cleanTrialRun(
  trial: PreparedTrialRun | undefined,
): Promise<void> {
  if (!trial) return;
  await Deno.remove(trial.rootDirectory, { recursive: true }).catch(() => {});
}

export function printTrialGuide(url: string): void {
  console.log(`Trial vault ready: ${url}

Guided conflict story (about 60 seconds):
  1. Open "How the evidence conflict evolved" and begin with ACCORD BP.
  2. Follow SPRINT and STEP: apparent disagreement becomes population context.
  3. Open BPROAD: a later diabetes trial creates the harder primary-outcome conflict.
  4. Open "Blood-pressure targets across trials" to see the reviewed, scoped resolution.
  5. Inspect the four immutable Sources, then search for "stroke hypotension hyperkalaemia".

This disposable vault is an evidence-synthesis demonstration, not clinical guidance.
Export it before stopping Synthesis if you want to keep any changes.`);
}
