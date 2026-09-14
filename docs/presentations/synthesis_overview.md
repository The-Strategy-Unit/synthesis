---
marp: true
theme: default
paginate: false
size: 16:9
style: |
  :root {
    --black: #000000;
    --panel: #1d1d1f;
    --white: #f5f5f7;
    --secondary: #a1a1a6;
    --blue: #2997ff;
    --hairline: #424245;
  }

  section {
    background: var(--black);
    color: var(--white);
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display",
      "Helvetica Neue", "Segoe UI", sans-serif;
    font-size: 34px;
    letter-spacing: -0.015em;
    line-height: 1.23;
    padding: 64px 78px;
  }

  section::before {
    background: url("https://raw.githubusercontent.com/The-Strategy-Unit/su-brand-yml/refs/heads/main/logos/logo_yellow.svg")
      center / contain no-repeat;
    content: "";
    height: 52px;
    position: absolute;
    right: 34px;
    top: 16px;
    width: 112px;
  }

  section.title-slide::before {
    height: 108px;
    right: 58px;
    top: 48px;
    width: 210px;
  }

  h1, h2, h3 {
    color: var(--white);
    font-weight: 700;
    letter-spacing: -0.045em;
    line-height: 1.04;
  }

  h1 { font-size: 2.95em; margin: 0 0 0.2em; }
  h2 { font-size: 1.72em; margin: 0 0 0.62em; }
  h3 {
    color: var(--blue);
    font-size: 0.78em;
    letter-spacing: 0.045em;
    margin: 0 0 0.62em;
    text-transform: uppercase;
  }

  p, li { color: var(--secondary); }
  strong { color: var(--white); font-weight: 650; }
  a { color: var(--blue); text-decoration: none; }
  code { background: transparent; color: var(--white); }
  ul, ol { padding-left: 1.05em; }
  li { margin: 0.3em 0; }

  section.hero, section.brief {
    display: flex;
    flex-direction: column;
    justify-content: center;
  }

  section.hero h2 {
    color: var(--secondary);
    font-size: 1.24em;
    font-weight: 500;
    letter-spacing: -0.035em;
  }

  section.hero p { font-size: 0.82em; margin-top: 1.1em; }
  section.brief p, section.brief li { font-size: 0.9em; }

  .grid { display: grid; gap: 24px; grid-template-columns: 1fr 1fr; width: 100%; }
  .grid.three { grid-template-columns: repeat(3, 1fr); }
  .grid.four { grid-template-columns: repeat(4, 1fr); }
  .card { background: var(--panel); border-radius: 22px; padding: 28px 31px; }
  .card p { color: var(--white); margin-bottom: 0; }
  .boundary { border: 1px solid var(--blue); }

  .metric-number {
    color: var(--white);
    display: block;
    font-size: 2.15em;
    font-weight: 700;
    letter-spacing: -0.055em;
    line-height: 1;
    margin-bottom: 0.18em;
  }

  .metric-label { color: var(--secondary); display: block; font-size: 0.76em; }
  .footnote { color: var(--secondary); font-size: 0.68em !important; margin-top: 0.9em; }
  .takeaway { border-left: 4px solid var(--blue); padding-left: 0.8em; }
  .takeaway, .takeaway strong { color: var(--white); }
  .credit { font-size: 0.76em !important; }
  .definition { color: var(--white); font-size: 0.78em; margin: 0 0 12px; }

  .slide-nav {
    align-items: center;
    bottom: 20px;
    display: flex;
    font-size: 20px;
    gap: 24px;
    left: 78px;
    line-height: 1.3;
    position: absolute;
    right: 78px;
  }
  .slide-nav a { padding: 6px 0; }
  .slide-nav a:hover, .appendix-menu a:hover { text-decoration: underline; }
  .slide-nav a:focus-visible, .appendix-menu a:focus-visible {
    outline: 2px solid var(--blue);
    outline-offset: 4px;
  }
  .slide-nav .nav-topics { margin-left: auto; }
  .appendix-menu { font-size: 0.84em; }
  .appendix-menu a { display: block; padding: 10px 0; }

  section.detail { padding: 48px 78px; }
  section.detail h2 { font-size: 1.48em; margin-bottom: 0.5em; }
  section.detail .card { padding: 24px; }
  section.detail .card p { font-size: 0.9em; margin: 0; }
  section.detail .footnote { margin: 14px 0 0; }
  section.detail .takeaway { margin: 18px 0; }
  /* Crops display unchanged source pixels. Positions are relative to the
     original 1792-pixel-wide screenshots, multiplied by the display scale. */
  .crop {
    background: #20252e;
    border: 1px solid var(--hairline);
    border-radius: 16px;
    box-sizing: border-box;
    overflow: hidden;
    position: relative;
  }
  .crop img {
    display: block;
    height: auto;
    max-width: none;
    position: absolute;
  }
  .discovery-evidence { height: 430px; width: 910px; margin: 16px auto 0; }
  .discovery-evidence img { width: 2508.8px; left: -1043px; top: -1064px; }

  .update-story {
    align-items: stretch;
    display: grid;
    gap: 16px;
    grid-template-columns: 1fr 42px 1fr 42px 1fr;
  }
  .update-story .card { padding: 22px 24px; }
  .update-story .card p { font-size: 0.82em; }
  .update-arrow {
    align-self: center;
    color: var(--blue);
    font-size: 1.2em;
    text-align: center;
  }
  section.graph-shot { padding: 0; }
  section.graph-shot::before { display: none; }
  section.graph-shot .graph-shot-image {
    display: block;
    height: 100%;
    object-fit: cover;
    width: 100%;
  }
  section.graph-shot .graph-prompt,
  section.graph-shot .slide-nav a {
    background: rgba(0, 0, 0, 0.82);
    border: 1px solid var(--hairline);
    border-radius: 12px;
  }
  section.graph-shot .graph-prompt {
    bottom: 18px;
    color: var(--white);
    font-size: 0.7em;
    font-weight: 650;
    left: 18px;
    margin: 0;
    padding: 8px 13px;
    position: absolute;
  }
  section.graph-shot .slide-nav {
    bottom: 18px;
    left: auto;
    right: 18px;
    width: auto;
  }
  section.graph-shot .slide-nav a { padding: 7px 10px; }
  section.graph-shot .slide-nav .nav-topics { margin-left: 0; }

  section.appendix { background: #0b0b0c; font-size: 30px; }
  section.appendix h2 { font-size: 1.48em; }
  section.appendix h2::before {
    color: var(--secondary);
    content: "Q&A DETAIL";
    display: block;
    font-size: 0.28em;
    letter-spacing: 0.14em;
    margin-bottom: 0.75em;
  }
  section.appendix > p > img { display: block; width: 100%; height: 440px; object-fit: contain; }
  section.screenshot::before { display: none; }
  section.appendix.screenshot > p {
    inset: 12px 24px 72px;
    margin: 0;
    position: absolute;
  }
  section.appendix.screenshot > p > img { height: 100%; }
  section.screenshot .slide-nav { left: 24px; right: 24px; }
  table { background: transparent !important; border-collapse: collapse; font-size: 0.75em; width: 100%; }
  table tr, th, td { background: transparent !important; }
  th, td { border: 0; border-bottom: 1px solid var(--hairline); color: var(--white); padding: 0.48em 0.56em; }
  th { color: var(--secondary); font-weight: 550; }
  pre { background: var(--panel); border-radius: 18px; color: var(--white); font-size: 0.68em; padding: 1em; }
---

<!-- _class: hero title-slide -->

# Synthesis ⚗️

## Your sources. A wiki that lasts.

Selected evidence → durable knowledge

Eirini Komninou, PhD - Data Science @ The Strategy Unit

<!--
Timing: 0:30 (cumulative 0:30)

Preparation: Synthesis is the application; the wiki is its output. Use “wiki”,
“wiki page”, “source” and “proposed update”. Present it as a working local-first,
single-user MVP whose wiki, sources and history remain ordinary files.

Evidence: README.md introduction and "Vault and recovery".
-->

---

<!-- _class: brief -->

## Sources persist. Does the understanding?

<div class="grid three">
  <div class="card"><h3>Connections</h3><p>Across sources</p></div>
  <div class="card"><h3>Context</h3><p>Across time</p></div>
  <div class="card"><h3>Evidence</h3><p>Back to origin</p></div>
</div>

<p class="takeaway">Knowledge should compound.</p>

<nav class="slide-nav" aria-label="Appendix navigation">
  <a class="nav-topics" href="#14">Appendix topics</a>
</nav>

<!--
Timing: 0:45 (cumulative 1:15)

Preparation: start with the audience's source collection. The files endure, but
their connections and context are often rebuilt from memory. The question sets
up the LLM Wiki as a way for understanding to accumulate with its evidence.
-->

---

<!-- _class: brief -->

## The LLM Wiki idea

<p class="credit">Inspired by <a href="https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f">Andrej Karpathy’s LLM Wiki pattern</a></p>

<div class="grid three">
  <div class="card"><h3>Pages</h3><p>Give topics a home</p></div>
  <div class="card"><h3>Links</h3><p>Keep context connected</p></div>
  <div class="card"><h3>Updates</h3><p>Build on earlier sources</p></div>
</div>

<p class="takeaway">A synthesised wiki. Durable knowledge.</p>

<!--
Timing: 1:00 (cumulative 2:15)

Preparation: credit Andrej Karpathy. The pattern uses an LLM to maintain a
persistent linked wiki as sources arrive; Synthesis adds a bounded workflow and
review by default. Wiki pages are durable knowledge, while sources remain
separate evidence. The Wikipedia analogy is the lasting page-link-revision
shape, not its infrastructure, governance or authority.

Reference: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
Evidence: README.md introduction; docs/ARCHITECTURE.md "Ingest pipeline".
-->

---

<!-- _class: brief -->

## HACA 2025, in one wiki

<div class="grid three">
  <div class="card"><span class="metric-number">66</span><span class="metric-label">recordings</span></div>
  <div class="card"><span class="metric-number">344</span><span class="metric-label">draft wiki pages</span></div>
  <div class="card boundary"><span class="metric-number">29</span><span class="metric-label">later-source updates</span></div>
</div>

<p class="footnote">Automatic compilation - publication consistency pass</p>

<nav class="slide-nav" aria-label="Appendix navigation">
  <a class="nav-topics" href="#14">Appendix topics</a>
</nav>

<!--
Timing: 0:45 (cumulative 3:00)

Preparation: HACA is the Health and Care Analytics Conference. The demo records
66 sources and 373 changes: 344 new pages, 28 merges and one contradiction.
Twenty-nine updates are not necessarily 29 distinct pages. Compilation was an
automatic batch followed by a consistency pass-not independent verification.
Treat the pages and metrics as a working demonstration, not an outcome claim.

Evidence: origin/docs/haca-2025-synthesis-overview at dfd844a,
demos/haca-2025-vault/history/, notes/ and README.md.
-->

---

<!-- _class: brief -->

## Three talks. One wiki page.

<div class="grid three">
  <div class="card"><h3>Product</h3><p>Users and ownership</p></div>
  <div class="card"><h3>Model</h3><p>Probabilistic demand</p></div>
  <div class="card"><h3>Delivery</h3><p>One trust → seven</p></div>
</div>

<p class="takeaway">Demand and capacity modelling for acute care</p>

<nav class="slide-nav" aria-label="Appendix navigation">
  <a class="nav-topics" href="#14">Appendix topics</a>
</nav>

<!--
Timing: 1:00 (cumulative 4:00)

Preparation: the sources contribute three perspectives-users and ownership,
the modelling method, and delivery and rollout. The first created the page; the
next two updated it. The resulting page retains all three source routes and
still requires domain review.

Evidence: demos/haca-2025-vault/notes/demand-and-capacity-modeling-for-acute-care.md
on the demo branch; source hashes beginning 241007, e591c9 and a8eab1.
-->

---

<!-- _class: appendix screenshot -->

![Full Synthesis reader showing application navigation, a compiled HACA wiki page, and its claim evidence and source links.](assets/synthesis_haca_page_slide.png)

<nav class="slide-nav" aria-label="Appendix navigation">
  <a class="nav-topics" href="#14">Appendix topics</a>
</nav>

<!--
Timing: 2:15 (cumulative 6:15)

Preparation: introduce Synthesis spatially: workspace and page directory on the
left, compiled wiki in the centre, evidence and source routes on the right.
Demonstrate one route from a claim to its source. Association is not proof that
every source supports every statement; the person judges the interpretation.
Reading, source inspection and keyword search work without an AI provider.

Evidence: assets/synthesis_haca_page_slide.png;
src/http/routes/wiki_routes.ts; src/wiki/wiki.ts; web/app.js.
-->

---

<!-- _class: graph-shot -->

<img class="graph-shot-image" src="assets/synthesis_haca_graph_slide.png" alt="Synthesis knowledge connections view focused on demand and capacity modelling, with named pages in the graph and 24 connected pages listed at right." />

<nav class="slide-nav" aria-label="Appendix navigation">
  <a href="#15">Graph key →</a>
  <a class="nav-topics" href="#14">Appendix topics</a>
</nav>

<!--
Timing: 1:15 (cumulative 7:30)

Preparation: move from the Connections tab to the focused graph. One page opens
24 visible neighbours across methods, constraints and related work. Solid lines
are durable wiki links; dashed lines are semantic suggestions. HACA used a
confirmed automatic compilation, so reviewed does not mean individually
reviewed. Layout supports navigation, not proof.

Evidence: assets/synthesis_haca_graph_slide.png; src/wiki/wiki_graph.ts.
-->

---

<!-- _class: detail -->

## Cross-source synthesis

<p class="definition"><strong>Similarity</strong> finds possible neighbours → <strong>LLM comparison</strong> proposes how they may relate → <strong>Human review</strong> decides what becomes a wiki link</p>

<div class="crop discovery-evidence">
  <img src="assets/cross-source_synthesis.png" alt="Enlarged original pending-link review: model-confidence caveat, two supporting wiki pages, source recordings, and Investigate, Reject and Confirm link controls." />
</div>

<nav class="slide-nav" aria-label="Appendix navigation">
  <a href="#16">Full wiki link review →</a>
  <a class="nav-topics" href="#14">Appendix topics</a>
</nav>

<!--
Timing: 1:30 (cumulative 9:00)

Preparation: semantic proximity uses embedding cosine similarity; lexical
overlap can also nominate candidate pairs. Neither is evidence. The LLM compares
pages from different sources and may propose support, contradiction, dependency,
research gap, overlap or another typed hypothesis—or nothing. A person checks
the pages and sources; only confirmation creates a durable wiki link. The 82%
value is model output, not evidence or a calibrated probability.

Evidence: assets/cross-source_synthesis.png; src/wiki/discovery.ts;
src/http/routes/review_routes.ts; web/app.js.
-->

---

<!-- _class: detail -->

## Lower blood pressure. Better outcomes?

<p class="definition">Type 2 diabetes · systolic target &lt;120 vs &lt;140 mm Hg</p>

<div class="update-story">
  <div class="card"><h3>Existing wiki</h3><p>ACCORD BP:<br />No significant reduction in major cardiovascular events.</p></div>
  <div class="update-arrow" aria-hidden="true">→</div>
  <div class="card"><h3>New source</h3><p>BPROAD:<br />Fewer major cardiovascular events.</p></div>
  <div class="update-arrow" aria-hidden="true">→</div>
  <div class="card boundary"><h3>Proposed wiki update</h3><p>Keep both findings.<br />Preserve their trial context.</p></div>
</div>

<p class="takeaway">New evidence can qualify—not overwrite—the wiki.</p>

<p class="footnote">Supported inputs: pasted text · Markdown or text files · text PDFs · YouTube videos or playlists</p>

<nav class="slide-nav" aria-label="Appendix navigation">
  <a class="nav-topics" href="#14">Appendix topics</a>
</nav>

<!--
Timing: 1:00 (cumulative 10:00)

Preparation: a selected source is archived before exact Markdown changes are
proposed. ACCORD BP did not find a significant reduction in its primary
composite; BPROAD did. The proposed update keeps both findings and their trial
context. A non-significant result is not proof of no benefit; do not imply the
trials establish opposite effects. This is a research illustration, not
clinical guidance. YouTube ingestion requires available subtitles; encrypted
and image-only PDFs require preprocessing because Synthesis has no OCR.

Evidence for behaviour: src/ingest/orchestrate.ts;
src/ingest/ingest_proposal.ts; src/vault/ingest_history.ts.
Trial evidence: PubMed 20228401 and 39555827.
-->

---

<!-- _class: appendix screenshot -->

![Illustrated Synthesis proposal review showing BPROAD qualifying the existing ACCORD BP wiki page, with all per-change decision options visible.](assets/synthesis_review_bproad.svg)

<nav class="slide-nav" aria-label="Appendix navigation">
  <a class="nav-topics" href="#14">Appendix topics</a>
</nav>

<!--
Timing: 1:00 (cumulative 11:00)

Preparation: continue the ACCORD BP/BPROAD story from the previous slide. The
new BPROAD source proposes a contradiction update that keeps both trial findings
and their context. Decision required, Include in wiki and Exclude from approval
make review granular; no wiki page changes before approval.

The image is a controlled review-state illustration using current interface
labels and curated trial excerpts, not a clinical or model-performance claim.

Evidence: assets/synthesis_review_bproad.svg; web/index.html; web/app.js;
src/ingest/orchestrate.ts; src/ingest/ingest_proposal.ts.
-->

---

<!-- _class: brief -->

## The wiki is yours to keep

<div class="grid three">
  <div class="card"><h3>Read</h3><p>Ordinary Markdown</p></div>
  <div class="card"><h3>Trace</h3><p>Sources and history</p></div>
  <div class="card"><h3>Recover</h3><p>Export · rebuild · undo</p></div>
</div>

<p class="footnote">Linked, revisable pages have endured at scale: Wikipedia, 2001 → 65 million articles. <a href="https://wikimediafoundation.org/wikipedia25/">Wikimedia Foundation</a></p>

<nav class="slide-nav" aria-label="Appendix navigation">
  <a href="#17">Vault and recovery →</a>
  <a class="nav-topics" href="#14">Appendix topics</a>
</nav>

<!--
Timing: 1:30 (cumulative 12:30)

Preparation: Wikipedia shows that linked, revisable pages can persist and grow;
do not imply that Synthesis shares its infrastructure, governance, collaboration
or proven scale. Here, ownership comes from ordinary Markdown, retained sources
and portable history. SQLite and semantic state are rebuildable. Exports exclude
the derived database and provider credentials.

Evidence: README.md "Vault and recovery"; src/vault/vault_export.ts;
src/vault/vault_rebuild.ts; src/vault/ingest_undo.ts.
Reference: https://wikimediafoundation.org/wikipedia25/
-->

---

<!-- _class: brief -->

## Current scope

<div class="grid three">
  <div class="card"><h3>Single-user</h3><p>Local-first MVP</p></div>
  <div class="card"><h3>Human judgement</h3><p>Check claims and links</p></div>
  <div class="card"><h3>Provider choice</h3><p>Remote AI receives content</p></div>
</div>

<p class="footnote">Research and knowledge work. No clinical decision support.</p>

<nav class="slide-nav" aria-label="Appendix navigation">
  <a class="nav-topics" href="#14">Appendix topics</a>
</nav>

<!--
Timing: 0:45 (cumulative 13:15)

Preparation: this is a single-user MVP, not collaborative or multi-tenant.
Generated text can be wrong, and merged paragraphs can cite several sources.
Local AI is the default; remote AI is an explicit data-transfer choice with no
silent fallback. Synthesis is not clinical decision support or an autonomous
consequential decision tool.

Evidence: README.md; src/provider/provider_runtime.ts;
src/provider/provider_profile.ts; src/wiki/wiki.ts.
-->

---

<!-- _class: hero -->

# Questions

## Where would a maintained wiki improve real work?

[https://github.com/The-Strategy-Unit/synthesis](https://github.com/The-Strategy-Unit/synthesis)

<nav class="slide-nav" aria-label="Appendix navigation">
  <a href="#14">Explore appendix topics →</a>
</nav>

<!--
Timing: 0:45 (cumulative 14:00; 6:00 remains for discussion)

Preparation: invite questions about useful collections, trust and remaining
uncertainty. Use the appendix links for detail. The public project link does not
include the HACA demo vault.

For a live demo, prepare the demo-branch HACA vault before the session and keep
the screenshots as fallback. Do not modify the demo vault during the talk.
-->

---

<!-- _class: appendix -->

## Appendix topics

<div class="grid three appendix-menu">
  <div class="card">
    <h3>Graph</h3>
    <a href="#15">How to read the graph</a>
  </div>
  <div class="card">
    <h3>Review</h3>
    <a href="#16">Full wiki link review</a>
  </div>
  <div class="card">
    <h3>Portability</h3>
    <a href="#17">Vault and recovery</a>
  </div>
</div>

<nav class="slide-nav" aria-label="Presentation navigation">
  <a href="#13">← Questions</a>
</nav>

<!--
Discussion menu, outside the timed talk. Choose a topic; use its footer to
return to the corresponding main slide, this menu or Questions.

Navigation uses Marp's one-based slide anchors. When adding or reordering slides,
update all numeric href targets, including the paired return links.
-->

---

<!-- _class: appendix -->

## How to read the graph

| What you see         | What it means                                         |
| -------------------- | ----------------------------------------------------- |
| Focused page         | A named neighbourhood to explore                      |
| Solid blue line      | Durable wiki link                                     |
| Dashed grey line     | Semantic suggestion; not yet a wiki link              |
| Position or distance | Navigation layout; not importance, proof or certainty |

<p class="takeaway">Connections suggest routes to inspect. Evidence remains the test.</p>

<nav class="slide-nav" aria-label="Presentation navigation">
  <a href="#7">← Knowledge connections</a>
  <a class="nav-topics" href="#14">Appendix topics</a>
  <a href="#13">Questions</a>
</nav>

<!--
Preparation: use only if graph interpretation comes up. Search and focus turn
the graph into a named neighbourhood. Solid links are durable; dashed proximity
edges remain suggestions. Geometry has no analytical meaning. Browsing an
already-built graph works without a provider; creating semantic suggestions
requires embeddings.

Evidence: src/catalogue/search_store.ts; src/wiki/wiki_graph.ts;
web/graph_layout.js; web/app.js.
-->

---

<!-- _class: appendix screenshot -->

![Original pending HACA link proposal with its explanation, source references and decision controls.](assets/cross-source_synthesis.png)

<nav class="slide-nav" aria-label="Presentation navigation">
  <a href="#8">← Cross-source synthesis</a>
  <a class="nav-topics" href="#14">Appendix topics</a>
  <a href="#13">Questions</a>
</nav>

<!--
The full wiki link review.

The filter shows four pending support hypotheses. The selected proposal remains
pending; no decision was made for this capture. The model label records the
provider used to generate the proposal. "Local AI - ready" reports the provider
currently available to the app.

Use cross-source synthesis for the comparison and proposal capability; use wiki
link review for the human decision that can make a relationship durable. The
model-confidence percentage is not a calibrated probability or evidence of
correctness.

Evidence: src/wiki/discovery.ts; src/http/routes/review_routes.ts; web/app.js.
-->

---

<!-- _class: appendix -->

## Portable wiki, rebuildable catalogue

```text
vault.json - schema.md
notes/       wiki pages
sources/     immutable evidence
history/     accepted updates and undo receipts

synthesis.db rebuildable catalogue
```

<p class="footnote">Export excludes the database and keys. Undo is newest-ingest-only.</p>

<nav class="slide-nav" aria-label="Presentation navigation">
  <a href="#11">← The wiki is yours to keep</a>
  <a class="nav-topics" href="#14">Appendix topics</a>
  <a href="#13">Questions</a>
</nav>

<!--
A vault is the storage folder containing the wiki, sources and history.
Retain the exact on-disk names here; "synthesis.db" is a filename, not a second
term for the wiki.

Catalogue rebuild is provider-free. Embeddings and semantic suggestions are
rebuilt separately with a provider. Undo remains hash guarded and can be blocked
by later edits. It does not clean up links from unrelated later pages.
Backups remain an operator responsibility.

Evidence: src/vault/vault_export.ts; src/vault/vault_rebuild.ts;
src/vault/ingest_undo.ts.
-->
