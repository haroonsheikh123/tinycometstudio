#!/usr/bin/env node
/* DEV ONLY — print SQL with ~30 days of SYNTHETIC analytics for a local D1, so dashboards have something to draw.
   node tools/dev/demo-analytics.mjs > .wrangler/demo.sql && npx wrangler d1 execute tinycomet --local --file=.wrangler/demo.sql
   Never run this against the production database. */
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const pages = [["/", "", 1], ["/project-nova/", "project-nova", .55], ["/stardust-notes/", "stardust-notes", .35], ["/orbit-garden/", "orbit-garden", .25], ["/news/", "", .3], ["/news/project-nova-devlog-1/", "", .18], ["/press/", "", .06]];
const countries = [["PK", .42], ["US", .2], ["GB", .1], ["DE", .07], ["IN", .08], ["AE", .06], ["CA", .07]];
const devices = [["mobile", "Chrome", "Android", .46], ["mobile", "Safari", "iOS", .22], ["desktop", "Chrome", "Windows", .2], ["desktop", "Safari", "macOS", .08], ["desktop", "Firefox", "Linux", .04]];
const refs = [["", .55], ["google.com", .2], ["x.com", .08], ["itch.io", .07], ["reddit.com", .06], ["youtube.com", .04]];
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = (arr, wi) => { let r = rnd() * arr.reduce((s, a) => s + a[wi], 0); for (const a of arr) { r -= a[wi]; if (r <= 0) return a; } return arr[0]; };
const out = ["DELETE FROM analytics_events; DELETE FROM analytics_daily; DELETE FROM analytics_uniques;"];
const now = Date.now();
for (let d = 29; d >= 0; d--) {
  const ts0 = now - d * 86_400_000, dd = day(ts0);
  const visitors = Math.round(60 + 30 * Math.sin(d / 3) + (29 - d) * 2.2 + rnd() * 20);
  const agg = new Map();
  const add = (k) => agg.set(k, (agg.get(k) || 0) + 1);
  for (let v = 0; v < visitors; v++) {
    const vis = `demo${dd}${v}`;
    out.push(`INSERT OR IGNORE INTO analytics_uniques (day, visitor) VALUES ('${dd}', '${vis}');`);
    const [c] = pick(countries, 1), [dev, br, os] = pick(devices, 3), [ref] = pick(refs, 1);
    const views = 1 + Math.floor(rnd() * 3);
    for (let i = 0; i < views; i++) {
      const [path, game] = pick(pages, 2);
      const evs = [["page_view", ""]];
      if (game && rnd() < .3) evs.push(["store_click", rnd() < .6 ? "android" : "ios"]);
      if (game === "project-nova" && rnd() < .35) { evs.push(["play_click", ""]); if (rnd() < .8) evs.push(["play_unlocked", ""]); }
      if (path.startsWith("/news/") && path !== "/news/" ) evs.push(["news_read", ""]);
      for (const [ev, plat] of evs) {
        const ts = ts0 - Math.floor(rnd() * (d === 0 ? 3_600_000 : 86_000_000));
        if (d <= 1) out.push(`INSERT INTO analytics_events (ts, day, event, path, game, platform, referrer, country, device, browser, os, visitor) VALUES (${d === 0 ? now - Math.floor(rnd() * 1_500_000) : ts}, '${dd}', '${ev}', '${path}', '${game}', '${plat}', '${i ? "" : ref}', '${c}', '${dev}', '${br}', '${os}', '${vis}');`);
        else out.push(`INSERT INTO analytics_events (ts, day, event, path, game, platform, referrer, country, device, browser, os, visitor) VALUES (${ts}, '${dd}', '${ev}', '${path}', '${game}', '${plat}', '${i ? "" : ref}', '${c}', '${dev}', '${br}', '${os}', '${vis}');`);
        add([dd, ev, path, game, plat, i ? "" : ref, c, dev, br, os].join("\u0001"));
      }
    }
  }
  for (const [k, n] of agg) { const f = k.split("\u0001"); out.push(`INSERT INTO analytics_daily (day, event, path, game, platform, referrer, country, device, browser, os, count) VALUES (${f.map((x) => `'${x}'`).join(", ")}, ${n});`); }
}
process.stdout.write(out.join("\n") + "\n");
