/* Local-disk R2 replacement (lib/platform/storage/fs-bucket.js). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsBucket, checkKey, parseRange } from "../lib/platform/storage/fs-bucket.js";

const tmp = () => mkdtempSync(join(tmpdir(), "tc-bucket-"));

test("storage: put/get/head with http + custom metadata, streaming bodies", async () => {
  const dir = tmp();
  try {
    const b = new FsBucket(dir);
    const put = await b.put("media/abc/cover.png", new Uint8Array([1, 2, 3, 4]), { httpMetadata: { contentType: "image/png", cacheControl: "public, max-age=1" }, customMetadata: { media_id: "med_1" } });
    assert.equal(put.size, 4);
    assert.equal(put.etag, "08d6c05a21512a79a1dfeb9d2a8f262f"); // MD5, like R2
    assert.equal(put.httpEtag, `"${put.etag}"`);
    const got = await b.get("media/abc/cover.png");
    assert.deepEqual([...new Uint8Array(await new Response(got.body).arrayBuffer())], [1, 2, 3, 4]);
    assert.equal(got.httpMetadata.contentType, "image/png");
    assert.equal(got.customMetadata.media_id, "med_1");
    const h = new Headers(); got.writeHttpMetadata(h);
    assert.equal(h.get("Content-Type"), "image/png");
    assert.equal(h.get("Cache-Control"), "public, max-age=1");
    assert.equal((await b.head("media/abc/cover.png")).size, 4);
    assert.equal(await b.get("media/nope"), null);
    assert.equal(await b.head("media/nope"), null);
    // string, ReadableStream and Blob values
    await b.put("a.txt", "héllo");
    assert.equal(await (await b.get("a.txt")).text(), "héllo");
    await b.put("s.bin", new Blob(["stream ", "me"]).stream());
    assert.equal(await (await b.get("s.bin")).text(), "stream me");
    await b.put("j.json", new Blob(['{"a":1}']));
    assert.deepEqual(await (await b.get("j.json")).json(), { a: 1 });
    // the file is stored under its key — easy to browse and back up
    assert.ok(existsSync(join(dir, "media", "abc", "cover.png")));
    // overwrite
    await b.put("a.txt", "v2");
    assert.equal(await (await b.get("a.txt")).text(), "v2");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("storage: byte ranges (object, suffix and Range header forms)", async () => {
  const dir = tmp();
  try {
    const b = new FsBucket(dir);
    await b.put("builds/g/b1/game.wasm", "0123456789");
    assert.equal(await (await b.get("builds/g/b1/game.wasm", { range: { offset: 2, length: 3 } })).text(), "234");
    assert.equal(await (await b.get("builds/g/b1/game.wasm", { range: { suffix: 4 } })).text(), "6789");
    const r = await b.get("builds/g/b1/game.wasm", { range: new Headers({ Range: "bytes=5-" }) });
    assert.deepEqual(r.range, { offset: 5, length: 5 });
    assert.equal(await r.text(), "56789");
    assert.equal(r.size, 10);
    assert.deepEqual(parseRange("bytes=0-0", 10), { offset: 0, length: 1 });
    assert.deepEqual(parseRange("bytes=-3", 10), { offset: 7, length: 3 });
    assert.deepEqual(parseRange("bytes=8-100", 10), { offset: 8, length: 2 });
    assert.equal(parseRange("bytes=10-", 10), "invalid");
    assert.equal(parseRange("items=0-1", 10), "invalid");
    assert.equal(parseRange(null, 10), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("storage: list (prefix, limit + cursor, delimiter) and delete (single, many, prunes empty folders)", async () => {
  const dir = tmp();
  try {
    const b = new FsBucket(dir);
    for (const k of ["builds/g/b1/index.html", "builds/g/b1/js/a.js", "builds/g/b1/js/b.js", "builds/g/b2/index.html", "media/x/y.png"]) await b.put(k, k);
    assert.deepEqual((await b.list({ prefix: "builds/g/b1/" })).objects.map((o) => o.key), ["builds/g/b1/index.html", "builds/g/b1/js/a.js", "builds/g/b1/js/b.js"]);
    const p1 = await b.list({ prefix: "builds/", limit: 2 });
    assert.equal(p1.truncated, true);
    const p2 = await b.list({ prefix: "builds/", limit: 2, cursor: p1.cursor });
    assert.deepEqual([...p1.objects, ...p2.objects].map((o) => o.key), ["builds/g/b1/index.html", "builds/g/b1/js/a.js", "builds/g/b1/js/b.js", "builds/g/b2/index.html"]);
    assert.equal(p2.truncated, false);
    assert.equal(p2.cursor, undefined);
    assert.deepEqual((await b.list({ prefix: "builds/g/", delimiter: "/" })).delimitedPrefixes, ["builds/g/b1/", "builds/g/b2/"]);
    const l = await b.list({ prefix: "builds/g/b1/" });
    await b.delete(l.objects.map((o) => o.key));
    assert.equal((await b.list({ prefix: "builds/g/b1/" })).objects.length, 0);
    assert.ok(!existsSync(join(dir, "builds", "g", "b1")), "empty folders are pruned");
    await b.delete("media/x/y.png");
    assert.equal(await b.head("media/x/y.png"), null);
    await b.delete("does/not/exist"); // no-op
    assert.deepEqual((await b.list()).objects.map((o) => o.key), ["builds/g/b2/index.html"], "internal .meta/.tmp folders are not listed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("storage: path traversal and invalid keys are refused", async () => {
  const dir = tmp();
  const outside = join(dir, "..", `tc-outside-${process.pid}.txt`);
  try {
    const b = new FsBucket(join(dir, "media"));
    writeFileSync(outside, "secret");
    for (const k of ["../x", "a/../../x", "/etc/passwd", "a//b", "a/./b", "a\\..\\b", "", "a\u0000b", ".meta/x.json", ".tmp/x", `../${outside.split("/").pop()}`]) {
      assert.throws(() => checkKey(k), /Invalid object key/, k);
      await assert.rejects(b.put(k, "x"), /Invalid object key/, k);
      assert.equal(await b.get(k), null, k);
      assert.equal(await b.head(k), null, k);
    }
    assert.equal(existsSync(join(dir, "media")) ? readdirSync(join(dir, "media")).filter((f) => !f.startsWith(".")).length : 0, 0, "nothing was written");
    assert.equal(checkKey("media/ok/name-1.png"), "media/ok/name-1.png");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(outside, { force: true }); }
});
