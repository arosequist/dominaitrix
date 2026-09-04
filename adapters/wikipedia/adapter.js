DOMinAItrix.defineAdapter({
  meta: {
    id: "wikipedia",
    version: "0.1.0",
    route: "article",
  },
  tools: [
    {
      name: "get_wikipedia_article_overview",
      description: "Return the current Wikipedia article's title, description, lead paragraphs, language, and canonical URL.",
      inputSchema: {
        type: "object",
        properties: {
          paragraphLimit: {
            type: "integer",
            minimum: 1,
            maximum: 5,
            description: "Maximum number of lead paragraphs to return. Defaults to 3.",
          },
        },
      },
      annotations: { readOnlyHint: true, destructiveHint: false, untrustedContentHint: true },
      execute: async ({ paragraphLimit = 3 }, { ctx }) => {
        const root = contentRoot(ctx);
        const limit = clampInteger(paragraphLimit, 1, 5, 3);
        const paragraphs = ctx.dom.all("p", root)
          .map((paragraph) => cleanText(paragraph.textContent))
          .filter((text) => text.length >= 80)
          .slice(0, limit);

        return result({
          title: cleanText(ctx.dom.required("h1").textContent),
          description: document.querySelector('meta[name="description"]')?.content ?? "",
          paragraphs,
          language: document.documentElement.lang,
          canonicalUrl: document.querySelector('link[rel="canonical"]')?.href ?? location.href,
        });
      },
    },
    {
      name: "get_wikipedia_article_outline",
      description: "Return the current Wikipedia article's section hierarchy and stable section IDs.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true, destructiveHint: false, untrustedContentHint: true },
      execute: async (_args, { ctx }) => {
        const root = contentRoot(ctx);
        const sections = ctx.dom.all("h2, h3, h4", root).map((heading) => ({
          level: Number(heading.tagName.slice(1)),
          id: heading.id || heading.querySelector("[id]")?.id || "",
          title: cleanText(heading.textContent),
        })).filter((section) => section.id && section.title);
        return result({ title: cleanText(ctx.dom.required("h1").textContent), sections });
      },
    },
    {
      name: "get_wikipedia_section",
      description: "Return the visible text for a section ID from the current Wikipedia article outline.",
      inputSchema: {
        type: "object",
        properties: {
          sectionId: { type: "string", description: "A section ID returned by get_wikipedia_article_outline." },
          characterLimit: { type: "integer", minimum: 500, maximum: 20000, description: "Maximum returned characters. Defaults to 6000." },
        },
        required: ["sectionId"],
      },
      annotations: { readOnlyHint: true, destructiveHint: false, untrustedContentHint: true },
      execute: async ({ sectionId, characterLimit = 6000 }, { ctx }) => {
        if (typeof sectionId !== "string" || !sectionId || sectionId.length > 200) {
          throw ctx.error("input", "invalid_section_id", "The section ID is invalid");
        }
        const root = contentRoot(ctx);
        const heading = [...root.querySelectorAll("h2, h3, h4")]
          .find((node) => node.id === sectionId || node.querySelector("[id]")?.id === sectionId);
        if (!heading) throw ctx.error("dom", "section_missing", "The requested section is not present on this article");
        const text = extractSectionText(heading);
        const limit = clampInteger(characterLimit, 500, 20000, 6000);
        return result({
          id: sectionId,
          title: cleanText(heading.textContent),
          text: text.slice(0, limit),
          truncated: text.length > limit,
        });
      },
    },
    {
      name: "search_wikipedia",
      description: "Search the current Wikipedia language edition and return matching article titles, snippets, and URLs.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Wikipedia search terms." },
          limit: { type: "integer", minimum: 1, maximum: 10, description: "Maximum results. Defaults to 5." },
        },
        required: ["query"],
      },
      annotations: { readOnlyHint: true, destructiveHint: false, untrustedContentHint: true },
      execute: async ({ query, limit = 5 }, { signal, ctx }) => {
        const normalized = typeof query === "string" ? query.trim() : "";
        if (normalized.length < 2 || normalized.length > 300) {
          throw ctx.error("input", "invalid_query", "Search terms must contain between 2 and 300 characters");
        }
        const resultLimit = clampInteger(limit, 1, 10, 5);
        const url = new URL("/w/api.php", location.origin);
        url.search = new URLSearchParams({
          action: "query",
          list: "search",
          srsearch: normalized,
          srlimit: String(resultLimit),
          format: "json",
          formatversion: "2",
        }).toString();
        const payload = await ctx.http.json(url.href, { signal });
        const matches = (payload.query?.search ?? []).map((item) => ({
          title: item.title,
          snippet: htmlToText(item.snippet),
          wordCount: item.wordcount,
          lastEdited: item.timestamp,
          url: `${location.origin}/wiki/${encodeURIComponent(item.title.replaceAll(" ", "_"))}`,
        }));
        return result({ query: normalized, matches });
      },
    },
  ],
});

function contentRoot(ctx) {
  return ctx.dom.required("#mw-content-text .mw-parser-output");
}

function extractSectionText(heading) {
  const section = heading.closest("section");
  if (section && section.querySelector("h2, h3, h4") === heading) {
    const copy = section.cloneNode(true);
    copy.querySelector("h2, h3, h4")?.remove();
    return cleanText(copy.textContent);
  }

  const level = Number(heading.tagName.slice(1));
  const parts = [];
  for (let node = heading.nextElementSibling; node; node = node.nextElementSibling) {
    if (/^H[2-4]$/.test(node.tagName) && Number(node.tagName.slice(1)) <= level) break;
    parts.push(node.textContent);
  }
  return cleanText(parts.join("\n"));
}

function htmlToText(html) {
  const container = document.createElement("div");
  container.innerHTML = html ?? "";
  return cleanText(container.textContent);
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function clampInteger(value, minimum, maximum, fallback) {
  return Number.isInteger(value) ? Math.min(Math.max(value, minimum), maximum) : fallback;
}

function result(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}
