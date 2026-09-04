import assert from "node:assert/strict";
import test from "node:test";
import { loadAdapter, parseToolResult } from "./helpers/adapter-harness.js";

const html = `<!doctype html><html lang="en"><head>
  <meta name="description" content="A synthetic encyclopedia article.">
  <link rel="canonical" href="https://en.wikipedia.org/wiki/Synthetic_article">
</head><body>
  <h1>Synthetic article</h1>
  <div id="mw-content-text"><div class="mw-parser-output">
    <section><p>This is a sufficiently long introductory paragraph used to verify extraction without copying any live article content into the test fixture.</p></section>
    <section><h2 id="History">History</h2><p>The history section contains synthetic text for a deterministic adapter test.</p></section>
    <section><h2 id="Uses">Uses</h2><h3 id="Testing">Testing</h3><p>Testing is one possible use.</p></section>
  </div></div>
</body></html>`;

test("Wikipedia adapter reads article overview, outline, and section", async () => {
  const harness = await loadAdapter("../../adapters/wikipedia/adapter.js", html, {
    url: "https://en.wikipedia.org/wiki/Synthetic_article",
  });
  assert.deepEqual(Object.keys(harness.tools), [
    "get_wikipedia_article_overview",
    "get_wikipedia_article_outline",
    "get_wikipedia_section",
    "search_wikipedia",
  ]);

  const overview = parseToolResult(await harness.tools.get_wikipedia_article_overview.execute({ paragraphLimit: 2 }, {}));
  assert.equal(overview.title, "Synthetic article");
  assert.equal(overview.paragraphs.length, 1);

  const outline = parseToolResult(await harness.tools.get_wikipedia_article_outline.execute({}, {}));
  assert.deepEqual(outline.sections.map((section) => section.id), ["History", "Uses", "Testing"]);

  const section = parseToolResult(await harness.tools.get_wikipedia_section.execute({ sectionId: "History" }, {}));
  assert.match(section.text, /history section/);
});

test("Wikipedia adapter uses the current language edition search API", async () => {
  let requestedUrl;
  const harness = await loadAdapter("../../adapters/wikipedia/adapter.js", html, {
    url: "https://fr.wikipedia.org/wiki/Article",
    fetch: async (url) => {
      requestedUrl = new URL(url);
      return new Response(JSON.stringify({
        query: { search: [{ title: "Résultat", snippet: "Un <span>résultat</span>", wordcount: 42, timestamp: "2026-09-03T00:00:00Z" }] },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const output = parseToolResult(await harness.tools.search_wikipedia.execute({ query: "navigateur", limit: 3 }, {}));
  assert.equal(requestedUrl.origin, "https://fr.wikipedia.org");
  assert.equal(requestedUrl.searchParams.get("srlimit"), "3");
  assert.equal(output.matches[0].snippet, "Un résultat");
});
