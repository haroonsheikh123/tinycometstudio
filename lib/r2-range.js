/* Byte-range (HTTP 206) support for objects read from R2 — or the Node host's R2-compatible FsBucket.
   Big game builds (.wasm/.data/.pck) and videos are often fetched in ranges. Works the same on both hosts. */

/** Options for MEDIA.get(): ask for a range only when the client sent a valid single "bytes=" range. */
export function rangeOption(request) {
  const r = request.headers.get("Range");
  return r && /^bytes=\d*-\d*$/.test(r.trim()) && r.trim() !== "bytes=-" ? { range: request.headers } : undefined;
}

/** Status + headers for an object returned by MEDIA.get(key, rangeOption(request)). */
export function rangeResult(obj, headers) {
  headers.set("Accept-Ranges", "bytes");
  const r = obj.range;
  if (!r || (r.offset == null && r.suffix == null)) { headers.set("Content-Length", String(obj.size)); return 200; }
  const offset = r.suffix != null ? Math.max(0, obj.size - r.suffix) : r.offset || 0;
  const length = r.suffix != null ? obj.size - offset : r.length != null ? r.length : obj.size - offset;
  if (offset === 0 && length === obj.size) { headers.set("Content-Length", String(obj.size)); return 200; }
  headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${obj.size}`);
  headers.set("Content-Length", String(length));
  return 206;
}
