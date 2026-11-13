/* Node 18 compatibility for the shared (Cloudflare-first) code. Import this before anything else in Node entry points.
   Node 20+ already has all of these, so every shim is a no-op there. */
import { webcrypto } from "node:crypto";
import * as zlib from "node:zlib";
import { Duplex } from "node:stream";
import * as buffer from "node:buffer";

// Web Crypto (crypto.subtle / getRandomValues / randomUUID) is only a global from Node 19 (Node 18 needs a flag).
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true, writable: true, enumerable: false });
}

// File became a global in Node 20 (it exists in node:buffer since 18.13).
if (typeof globalThis.File === "undefined" && buffer.File) globalThis.File = buffer.File;

// DecompressionStream/CompressionStream("deflate-raw") arrived in Node 21.2 / 20.12; the zip reader for game builds needs it.
function supports(Ctor, fmt) { try { new Ctor(fmt); return true; } catch { return false; } }
const make = (factory) => () => { const d = Duplex.toWeb(factory()); return { readable: d.readable, writable: d.writable }; };
if (typeof globalThis.DecompressionStream === "function" && !supports(globalThis.DecompressionStream, "deflate-raw")) {
  const Native = globalThis.DecompressionStream;
  globalThis.DecompressionStream = class DecompressionStream {
    constructor(format) {
      if (format !== "deflate-raw") return new Native(format);
      const { readable, writable } = make(() => zlib.createInflateRaw())();
      this.readable = readable; this.writable = writable;
    }
  };
}
if (typeof globalThis.CompressionStream === "function" && !supports(globalThis.CompressionStream, "deflate-raw")) {
  const Native = globalThis.CompressionStream;
  globalThis.CompressionStream = class CompressionStream {
    constructor(format) {
      if (format !== "deflate-raw") return new Native(format);
      const { readable, writable } = make(() => zlib.createDeflateRaw())();
      this.readable = readable; this.writable = writable;
    }
  };
}

export const NODE_MAJOR = Number(process.versions.node.split(".")[0]);
