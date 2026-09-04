import assert from "node:assert/strict";
import test from "node:test";
import { loadAdapter, parseToolResult } from "./helpers/adapter-harness.js";

const listingHtml = `<!doctype html><html><body><table>
  <tr class="athing" id="101"><td class="rank">1.</td><td><span class="titleline"><a href="https://example.org/story">Synthetic launch</a><span class="sitebit"><span class="sitestr">example.org</span></span></span></td></tr>
  <tr><td></td><td class="subtext"><span class="score">125 points</span> by <a class="hnuser">author</a> <span class="age">2 hours ago</span> <a href="item?id=101">40 comments</a></td></tr>
</table></body></html>`;

const discussionHtml = `<!doctype html><html><body><table>
  <tr class="athing" id="101"><td><span class="titleline"><a href="https://example.org/story">Synthetic launch</a></span></td></tr>
  <tr><td class="subtext"><span class="score">125 points</span> <a href="item?id=101">40 comments</a></td></tr>
  <tr class="comtr" id="201"><td><table><tr><td class="ind"><img width="0"></td><td><a class="hnuser">first</a><span class="age">1 hour ago</span><div class="commtext">Top-level synthetic comment.</div></td></tr></table></td></tr>
  <tr class="comtr" id="202"><td><table><tr><td class="ind"><img width="40"></td><td><a class="hnuser">reply</a><span class="age">30 minutes ago</span><div class="commtext">Nested synthetic reply.</div></td></tr></table></td></tr>
</table></body></html>`;

test("Hacker News adapter structures ranked stories", async () => {
  const harness = await loadAdapter("../../adapters/hacker-news/adapter.js", listingHtml, {
    url: "https://news.ycombinator.com/",
  });
  const output = parseToolResult(await harness.tools.list_hacker_news_stories.execute({ limit: 10 }, {}));
  assert.equal(output.stories.length, 1);
  assert.equal(output.stories[0].title, "Synthetic launch");
  assert.equal(output.stories[0].score, 125);
  assert.equal(output.stories[0].commentCount, 40);
});

test("Hacker News adapter preserves discussion depth", async () => {
  const harness = await loadAdapter("../../adapters/hacker-news/adapter.js", discussionHtml, {
    url: "https://news.ycombinator.com/item?id=101",
  });
  const output = parseToolResult(await harness.tools.get_hacker_news_discussion.execute({}, {}));
  assert.equal(output.comments.length, 2);
  assert.deepEqual(output.comments.map((comment) => comment.depth), [0, 1]);
  assert.deepEqual(output.comments.map((comment) => comment.author), ["first", "reply"]);
});
