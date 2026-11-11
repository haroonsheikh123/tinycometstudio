/* Tests for the pure render layer + content. Run: npm test */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as R from "../tools/render/index.mjs";

const load = async (p) => JSON.parse(await readFile(new URL(`../content/${p}`, import.meta.url), "utf8"));

test("content validates", async () => {
  assert.deepEqual(R.validateSettings(await load("settings.json")), []);
  assert.deepEqual(R.validateGames(await load("games.json")), []);
  assert.deepEqual(R.validateTeam(await load("team.json")), []);
});

test("validation catches bad games", () => {
  const errs = R.validateGames([{ id: "News", title: "", status: "soon" }, { id: "api", title: "x", status: "released" }]);
  assert.ok(errs.length >= 4);
});

test("markdown: blocks, inline, escaping and unsafe links", () => {
  const html = R.markdownToHtml("# Hi\n\nSome **bold** and *it* and `x<y`.\n\n- a\n- b\n\n1. one\n\n> quote\n\n```js\nlet a = '<b>';\n```\n\n[ok](https://a.b) [bad](javascript:alert(1)) <script>x</script>\n\n![alt](/i.png)\n\n{{youtube https://youtu.be/abcdefghijk}}\n\n==note==");
  for (const s of ['<h1 id="hi">Hi</h1>', "<strong>bold</strong>", "<em>it</em>", "<code>x&lt;y</code>", "<ul><li>a</li><li>b</li></ul>", "<ol><li>one</li></ol>", "<blockquote><p>quote</p></blockquote>", 'class="language-js"', "&lt;b&gt;", 'href="https://a.b"', 'href="#"', "&lt;script&gt;", '<figure><img src="/i.png"', 'data-yt="abcdefghijk"', '<mark class="ph">note</mark>']) {
    assert.ok(html.includes(s), `missing ${s}\n${html}`);
  }
  assert.ok(!html.includes("javascript:"));
  assert.ok(!html.includes("<script>"));
});

test("front-matter + post parsing", () => {
  const p = R.parsePost("2026-01-02-my-post.md", '---\ntitle: "Devlog #1: hi"\ndate: 2026-01-02\ncategory: Devlog\nplaceholder: true\n---\nHello **world**');
  assert.equal(p.slug, "my-post");
  assert.equal(p.title, "Devlog #1: hi");
  assert.equal(p.category, "Devlog");
  assert.equal(p.placeholder, true);
  assert.match(p.bodyHtml, /<strong>world<\/strong>/);
});

test("store badges follow status rules", () => {
  const C = R.components;
  const released = { id: "g", title: "G", status: "released", platforms: ["android", "ios"], links: { android: "https://play.google.com/x", ios: "" } };
  const html = C.storeBadges(released);
  assert.match(html, /Google Play/);
  assert.doesNotMatch(html, /App Store/); // no link → hidden
  const soon = C.storeBadges({ ...released, status: "coming-soon" });
  assert.match(soon, /Coming soon to/);
  assert.match(soon, /App Store/);
  assert.doesNotMatch(soon, /href=/);
});

test("game page renders with JSON-LD and no web-play URL leak", async () => {
  const settings = await load("settings.json");
  const games = await load("games.json");
  for (const g of games) {
    const html = R.renderGamePage({ settings, game: g });
    assert.match(html, new RegExp(`<title>${g.title}`));
    assert.match(html, /"@type":"(VideoGame|SoftwareApplication)"/);
    if (g.webPlay?.enabled) assert.match(html, new RegExp(`href="/${g.id}/play/"`));
  }
});
