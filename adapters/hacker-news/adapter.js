DOMinAItrix.defineAdapter({
  meta: {
    id: "hacker-news",
    version: "0.1.0",
    route: () => document.querySelector("tr.comtr") ? "discussion" : document.querySelector("tr.athing") ? "listing" : "other",
  },
  tools: [
    {
      name: "list_hacker_news_stories",
      description: "Return structured stories from the current Hacker News listing or discussion page, including scores and discussion links when visible.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 30, description: "Maximum stories to return. Defaults to 15." },
        },
      },
      annotations: { readOnlyHint: true, destructiveHint: false, untrustedContentHint: true },
      execute: async ({ limit = 15 }, { ctx }) => {
        const rows = ctx.dom.all("tr.athing");
        if (!rows.length) throw ctx.error("state", "story_list_missing", "This Hacker News page does not contain a story listing");
        const boundedLimit = clampInteger(limit, 1, 30, 15);
        return result({
          page: location.pathname,
          stories: rows.slice(0, boundedLimit).map(readStory).filter(Boolean),
        });
      },
    },
    {
      name: "get_hacker_news_discussion",
      description: "Return a bounded flat representation of the current Hacker News discussion, preserving each visible comment's nesting depth.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 100, description: "Maximum visible comments to return. Defaults to 40." },
          charactersPerComment: { type: "integer", minimum: 200, maximum: 4000, description: "Maximum characters per comment. Defaults to 1600." },
        },
      },
      annotations: { readOnlyHint: true, destructiveHint: false, untrustedContentHint: true },
      execute: async ({ limit = 40, charactersPerComment = 1600 }, { ctx }) => {
        const rows = ctx.dom.all("tr.comtr");
        if (!rows.length) throw ctx.error("state", "discussion_missing", "Open a Hacker News item page with a visible discussion");
        const commentLimit = clampInteger(limit, 1, 100, 40);
        const characterLimit = clampInteger(charactersPerComment, 200, 4000, 1600);
        const story = readStory(document.querySelector("tr.athing"));
        const comments = rows.filter((row) => !row.classList.contains("coll")).slice(0, commentLimit).map((row) => {
          const fullText = cleanText(row.querySelector(".commtext")?.textContent);
          const width = Number(row.querySelector(".ind img")?.getAttribute("width") ?? 0);
          return {
            id: row.id,
            depth: Number.isFinite(width) ? Math.round(width / 40) : 0,
            author: cleanText(row.querySelector(".hnuser")?.textContent) || null,
            age: cleanText(row.querySelector(".age")?.textContent) || null,
            text: fullText.slice(0, characterLimit),
            truncated: fullText.length > characterLimit,
          };
        });
        return result({ story, visibleCommentCount: rows.length, comments });
      },
    },
  ],
});

function readStory(row) {
  if (!row) return null;
  const link = row.querySelector(".titleline > a");
  if (!link) return null;
  const subtext = row.nextElementSibling?.querySelector(".subtext");
  const itemLinks = [...(subtext?.querySelectorAll('a[href^="item?id="]') ?? [])];
  const discussion = itemLinks.at(-1);
  return {
    id: row.id || null,
    rank: parseInteger(row.querySelector(".rank")?.textContent),
    title: cleanText(link.textContent),
    url: link.href,
    site: cleanText(row.querySelector(".sitestr")?.textContent) || null,
    score: parseInteger(subtext?.querySelector(".score")?.textContent),
    author: cleanText(subtext?.querySelector(".hnuser")?.textContent) || null,
    age: cleanText(subtext?.querySelector(".age")?.textContent) || null,
    commentCount: parseInteger(discussion?.textContent) ?? 0,
    discussionUrl: discussion?.href ?? null,
  };
}

function parseInteger(value) {
  const match = String(value ?? "").match(/\d+/);
  return match ? Number(match[0]) : null;
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
