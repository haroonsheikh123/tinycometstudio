/* SQLite (D1) → MySQL / MariaDB SQL translation for the statements this app actually issues.
   The shared code is written for SQLite; instead of forking every query, the MySQL adapter passes each statement through
   `plan()` once (cached) and `render()` per call. Pure functions, no I/O — tested in tests/mysql-translate.test.mjs.

   Handled:
   - INSERT OR REPLACE → REPLACE · INSERT OR IGNORE / ON CONFLICT … DO NOTHING → INSERT IGNORE
   - ON CONFLICT (…) DO UPDATE SET x = excluded.x → ON DUPLICATE KEY UPDATE x = VALUES(x)
   - … RETURNING cols on an upsert → stripped; the adapter re-selects the row by its conflict key (same transaction)
   - CAST(… AS INTEGER/TEXT/REAL) → SIGNED/CHAR/DOUBLE · integer division `x / 60000` → `x DIV 60000`
   - SELECT … WHERE without FROM → SELECT … FROM DUAL WHERE
   - reserved words used as column names (key, window, before) → backtick-quoted · "ident" → `ident`
   - LIKE is case-insensitive (like SQLite's ASCII LIKE) although columns use a binary collation
   - string literals: SQLite has no backslash escapes, MySQL does → backslashes are doubled
   - parameters are inlined client-side with proper escaping (so `?` inside string literals is never touched) */

const RESERVED = new Set(["key", "window", "before"]);
const MARK = "\u0001";

/** Replace string literals / quoted identifiers by markers so regexes only ever see SQL code. */
export function mask(sql) {
  const lits = [];
  let out = "";
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1, v = "";
      for (; j < sql.length; j++) {
        if (sql[j] === c) { if (sql[j + 1] === c) { v += c; j++; continue; } break; }
        v += sql[j];
      }
      if (j >= sql.length) throw new Error(`Unterminated quote in SQL: ${sql.slice(i, i + 40)}`);
      lits.push(c === "'" ? { t: "str", v } : { t: "id", v });
      out += `${MARK}${lits.length - 1}${MARK}`;
      i = j;
    } else if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl < 0 ? sql.length : nl - 1;
      out += " ";
    } else out += c;
  }
  return { code: out, lits };
}

export const quoteString = (v) => "'" + String(v).replace(/\\/g, "\\\\").replace(/'/g, "''").replace(/\0/g, "\\0") + "'";
export const quoteId = (v) => "`" + String(v).replace(/`/g, "``") + "`";

export function unmask(code, lits) {
  return code.replace(new RegExp(`${MARK}(\\d+)${MARK}`, "g"), (_, n) => {
    const l = lits[Number(n)];
    return l.t === "str" ? quoteString(l.v) : quoteId(l.v);
  });
}

/** Split `s` on `sep` at parenthesis depth 0. */
export function splitTop(s, sep = ",") {
  const parts = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === sep && depth === 0) { parts.push(s.slice(start, i)); start = i + 1; }
  }
  parts.push(s.slice(start));
  return parts;
}
/** Index of the parenthesis closing the one at `open`. */
function closing(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

/** Add FROM DUAL to every `SELECT … WHERE` that has no FROM at its own nesting level. */
function addFromDual(code) {
  const re = /\bSELECT\b/gi;
  let m, out = code, shift = 0;
  const hits = [];
  while ((m = re.exec(code))) {
    let depth = 0, i = m.index + 6, kind = null, at = -1;
    for (; i < code.length; i++) {
      const c = code[i];
      if (c === "(") depth++;
      else if (c === ")") { if (depth === 0) break; depth--; }
      else if (depth === 0 && /[A-Za-z]/.test(c) && !/[\w$]/.test(code[i - 1] || "")) {
        const w = /^[A-Za-z_]+/.exec(code.slice(i))[0].toUpperCase();
        if (w === "FROM") { kind = "from"; break; }
        if (w === "WHERE") { kind = "where"; at = i; break; }
        if (w === "UNION" || w === "ORDER" || w === "LIMIT" || w === "GROUP") break;
        i += w.length - 1;
      }
    }
    if (kind === "where") hits.push(at);
  }
  for (const at of hits) { out = out.slice(0, at + shift) + "FROM DUAL " + out.slice(at + shift); shift += 10; }
  return out;
}

const countQ = (s) => (s.match(/\?/g) || []).length;

/**
 * Structural translation of one statement (no parameter values involved; cache the result).
 * @returns {{ code:string, lits:object[], returning:null|{table:string, cols:string, where:{col:string, expr:string, paramStart:number}[]}, guard:boolean, table:string|null, kind:string }}
 */
export function plan(sql) {
  let { code, lits } = mask(String(sql).trim().replace(/;\s*$/, ""));
  // quoted identifiers that are reserved words stay quoted by unmask(); bare reserved column names get backticks
  code = code.replace(/(?<![\w$`])([A-Za-z_]+)(?![\w$])/g, (w) => (RESERVED.has(w.toLowerCase()) ? quoteId(w.toLowerCase()) : w));

  code = code.replace(/^\s*INSERT\s+OR\s+REPLACE\s+INTO\b/i, "REPLACE INTO").replace(/^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i, "INSERT IGNORE INTO");

  // RETURNING (only meaningful on INSERT … ON CONFLICT here)
  let returningCols = null;
  const rm = /\s+RETURNING\s+([\s\S]+)$/i.exec(code);
  if (rm) { returningCols = rm[1].trim(); code = code.slice(0, rm.index); }

  // upserts
  let conflictCols = null;
  const cm = /\bON\s+CONFLICT\s*(?:\(([^)]*)\))?\s*DO\s+(NOTHING|UPDATE\s+SET\b)/i.exec(code);
  if (cm) {
    conflictCols = cm[1] ? cm[1].split(",").map((s) => s.trim()) : null;
    if (/^NOTHING$/i.test(cm[2])) {
      code = code.slice(0, cm.index).trimEnd();
      code = code.replace(/^\s*INSERT\s+INTO\b/i, "INSERT IGNORE INTO");
    } else {
      const head = code.slice(0, cm.index);
      let tail = code.slice(cm.index + cm[0].length);
      tail = tail.replace(/\bexcluded\.(`[^`]+`|\w+)/gi, "VALUES($1)");
      code = `${head}ON DUPLICATE KEY UPDATE${tail}`;
    }
  }

  code = code
    .replace(/\bAS\s+INTEGER\s*\)/gi, "AS SIGNED)")
    .replace(/\bAS\s+TEXT\s*\)/gi, "AS CHAR)")
    .replace(/\bAS\s+REAL\s*\)/gi, "AS DOUBLE)")
    .replace(/(?<=[\w)\s])\/\s*(\d+)(?![\d.])/g, " DIV $1")
    .replace(new RegExp(`\\bLIKE\\s+(\\?|${MARK}\\d+${MARK})`, "gi"), "LIKE $1 COLLATE utf8mb4_general_ci");
  code = addFromDual(code);

  const table = (/^\s*(?:INSERT(?:\s+IGNORE)?\s+INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+`?(\w+)`?/i.exec(code) || [])[1] || null;
  const kind = (/^\s*(\w+)/.exec(code) || [, ""])[1].toUpperCase();
  const guard = /^\s*INSERT\s+INTO\s+tx_guard\b/i.test(code);

  let returning = null;
  if (returningCols) {
    const im = /^\s*INSERT(?:\s+IGNORE)?\s+INTO\s+`?(\w+)`?\s*\(([^)]*)\)\s*VALUES\s*\(/i.exec(code);
    if (!im || !conflictCols) throw new Error(`RETURNING is only supported on INSERT … VALUES … ON CONFLICT (cols): ${sql}`);
    const open = im.index + im[0].length - 1, close = closing(code, open);
    const cols = im[2].split(",").map((s) => s.trim());
    const exprs = splitTop(code.slice(open + 1, close));
    let pos = open + 1;
    const where = [];
    exprs.forEach((e, i) => {
      if (conflictCols.includes(cols[i])) where.push({ col: cols[i], expr: e.trim(), paramStart: countQ(code.slice(0, pos)) });
      pos += e.length + 1;
    });
    returning = { table: im[1], cols: returningCols, where };
  }
  return { code, lits, returning, guard, table, kind };
}

/** Escape one bound value as a MySQL literal (mysql2's escaping rules, default sql_mode). */
export function literal(v) {
  if (v === null) return "NULL";
  if (v === undefined) throw new Error("D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'");
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "number") { if (!Number.isFinite(v)) throw new Error(`Cannot bind non-finite number ${v}`); return String(v); }
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Uint8Array || v instanceof ArrayBuffer) return "X'" + Buffer.from(v instanceof ArrayBuffer ? new Uint8Array(v) : v).toString("hex") + "'";
  return "'" + String(v).replace(/[\0\b\t\n\r\x1a"'\\]/g, (c) => ({ "\0": "\\0", "\b": "\\b", "\t": "\\t", "\n": "\\n", "\r": "\\r", "\x1a": "\\Z", '"': '\\"', "'": "\\'", "\\": "\\\\" })[c]) + "'";
}

function fill(code, params, start = 0) {
  let i = start;
  const out = code.replace(/\?/g, () => {
    if (i >= params.length) throw new Error(`Wrong number of SQL parameters: expected more than ${params.length}`);
    return literal(params[i++]);
  });
  return { sql: out, used: i };
}

/** Final SQL for one execution (+ the follow-up SELECT that emulates RETURNING). */
export function render(p, params = []) {
  const { sql, used } = fill(p.code, params);
  if (used !== params.length) throw new Error(`Wrong number of SQL parameters: statement has ${used}, got ${params.length}`);
  let followup = null;
  if (p.returning) {
    const cond = p.returning.where.map((w) => `${w.col} = ${fill(w.expr, params, w.paramStart).sql}`).join(" AND ");
    followup = unmask(`SELECT ${p.returning.cols} FROM ${p.returning.table} WHERE ${cond}`, p.lits);
  }
  return { sql: unmask(sql, p.lits), followup };
}

const cache = new Map();
/** plan() with a bounded cache. */
export function cachedPlan(sql) {
  let p = cache.get(sql);
  if (!p) { p = plan(sql); if (cache.size > 1000) cache.clear(); cache.set(sql, p); }
  return p;
}
export const translate = (sql, params = []) => render(cachedPlan(sql), params);

/** Split a script into statements on top-level `;` (outside quotes and BEGIN … END blocks). */
export function splitStatements(script) {
  const { code, lits } = mask(script);
  const out = [];
  let depth = 0, start = 0;
  const re = /\bBEGIN\b|\bCASE\b|\bEND\b|;/gi;
  let m;
  while ((m = re.exec(code))) {
    const w = m[0].toUpperCase();
    if (w === "BEGIN" && !/^\s*(TRANSACTION|;|$)/i.test(code.slice(m.index + 5))) depth++;
    else if (w === "CASE") depth++;
    else if (w === "END" && depth > 0 && !/^\s*(IF|LOOP|WHILE|CASE)\b/i.test(code.slice(m.index + 3))) depth--;
    else if (w === ";" && depth === 0) { out.push(code.slice(start, m.index)); start = m.index + 1; }
  }
  out.push(code.slice(start));
  // re-insert the original literal text (untranslated — callers translate each statement themselves)
  const raw = (s) => s.replace(new RegExp(`${MARK}(\\d+)${MARK}`, "g"), (_, n) => { const l = lits[Number(n)]; return l.t === "str" ? `'${l.v.replace(/'/g, "''")}'` : `"${l.v.replace(/"/g, '""')}"`; });
  return out.map(raw).map((s) => s.trim()).filter(Boolean);
}
