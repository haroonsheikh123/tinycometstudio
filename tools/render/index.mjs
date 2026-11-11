/* Public API of the render layer — every function here is pure
   (plain objects in → HTML/XML strings out) and uses no Node-only APIs,
   so it can run in Node (tools/build.mjs) or inside a Cloudflare Pages
   Function (e.g. rendering from D1 later). */
export { renderLayout, renderFooter, sectionHead } from "./layout.mjs";
export { renderHomePage, renderFounder, renderTeamGrid } from "./home.mjs";
export { renderGamePage, renderGatePage } from "./game.mjs";
export { renderNewsIndex, renderNewsPost, parsePost, sortPosts, relatedPosts, NEWS_CATEGORIES, NEWS_PAGE_SIZE } from "./news.mjs";
export { renderPressPage, BRAND_COLORS, BRAND_FILES, BRAND_ZIP } from "./press.mjs";
export { renderMarkdownPage, render404Page, renderSitemap, renderRss, renderRobots, renderManifest, interpolate } from "./misc.mjs";
export { markdownToHtml, markdownToText, parseFrontMatter, escapeHtml, safeUrl, youtubeId } from "./markdown.mjs";
export * as components from "./components.mjs";
export { validateGames, validateSettings, validateTeam, RESERVED_SLUGS, SLUG_RE } from "./validate.mjs";
