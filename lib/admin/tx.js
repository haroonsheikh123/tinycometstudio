/* Tx — the ONLY way handlers write to D1.
   Collects statements, optimistic-concurrency guards, audit entries, webhook events and after-commit work,
   then commits everything in ONE D1 batch (a SQL transaction): data + audit entries + webhook deliveries land together
   or not at all. A Tx with writes but no audit entry refuses to commit, so nothing can bypass the audit log.
   In dry-run mode nothing is written except a single "dry_run" audit entry describing what would have happened. */
import { makeEntry, chainHead, chainEntries, isChainCollision, CHAIN_RETRIES, backoff } from "./audit.js";
import { ApiError } from "./http.js";
import { bumpContentVersionStmt } from "./state.js";
import { randomId } from "./crypto.js";

export class Tx {
  constructor(ctx) {
    this.ctx = ctx;
    this.db = ctx.env.DB;
    this.stmts = [];
    this.guards = [];
    this.audits = [];
    this.events = [];
    this.after = [];
    this.contentChanged = false;
    this.purgePaths = new Set();
    ctx.txs?.push(this);
  }
  /** Queue a write statement. */
  run(sql, ...params) { this.stmts.push(this.db.prepare(sql).bind(...params)); return this; }
  /** Abort the whole batch with 412 unless `existsSql` (a SELECT returning a row) matches at commit time. */
  guard(existsSql, params, message = "The resource was changed by someone else — reload and try again") {
    this.guards.push({ stmt: this.db.prepare(`INSERT INTO tx_guard (ok) SELECT 0 WHERE NOT EXISTS (${existsSql})`).bind(...params), message });
    return this;
  }
  /** Add an audit entry (see makeEntry for fields). Returns the entry id (for parent/child links). */
  audit(e) { const entry = makeEntry(this.ctx, e); this.audits.push(entry); return entry.id; }
  /** Emit a webhook event (delivered only if the transaction commits). */
  event(name, data) { this.events.push({ name, data }); return this; }
  /** Mark public content as changed → bump content version (cache key) and purge paths after commit. */
  content(...paths) { this.contentChanged = true; paths.flat().forEach((p) => p && this.purgePaths.add(p)); return this; }
  /** Work to run only after a successful commit (R2 cleanup, cache purge…). */
  afterCommit(fn) { this.after.push(fn); return this; }

  get hasWrites() { return this.stmts.length > 0; }

  async commit() {
    const ctx = this.ctx;
    if (this.hasWrites && !this.audits.length) throw new Error("Tx.commit: refusing to write without an audit entry");
    if (ctx.dryRun) {
      // Record the preview itself (one entry per would-be entry), mark as dry_run.
      const entries = this.audits.map((a) => ({ ...a, result: "dry_run", meta: { ...(a.meta || {}), dry_run: true } }));
      if (entries.length && ctx.auditDryRuns !== false) await this._writeAuditOnly(entries);
      return { dryRun: true, audits: this.audits, events: this.events.map((e) => e.name) };
    }
    const extra = [];
    if (this.contentChanged) extra.push(bumpContentVersionStmt(this.db, ctx.now));
    if (this.events.length) extra.push(...(await this._deliveryStatements()));
    for (let attempt = 0; attempt < CHAIN_RETRIES; attempt++) {
      const head = await chainHead(this.db);
      const { rows, statements } = await chainEntries(ctx.env, this.db, this.audits, head);
      try {
        await this.db.batch([...this.guards.map((g) => g.stmt), ...this.stmts, ...extra, ...statements]);
        this.committed = rows;
        break;
      } catch (e) {
        const msg = String(e?.message || e);
        if (/CHECK constraint failed/i.test(msg) && /tx_guard|ok = 1/i.test(msg)) throw new ApiError(412, "precondition_failed", this.guards[0]?.message || "Precondition failed");
        if (/UNIQUE constraint failed/i.test(msg) && !isChainCollision(e)) throw new ApiError(409, "conflict", "A resource with this id already exists");
        if (!isChainCollision(e) || attempt === CHAIN_RETRIES - 1) throw e;
        await backoff(attempt);
      }
    }
    if (this.contentChanged && ctx.onContentChanged) await ctx.onContentChanged([...this.purgePaths]);
    for (const fn of this.after) await fn();
    if (this.deliveryIds?.length && ctx.onDeliveries) ctx.onDeliveries(this.deliveryIds);
    return { dryRun: false, audits: this.committed };
  }

  async _writeAuditOnly(entries) {
    for (let attempt = 0; attempt < CHAIN_RETRIES; attempt++) {
      const head = await chainHead(this.db);
      const { statements } = await chainEntries(this.ctx.env, this.db, entries, head);
      try { await this.db.batch(statements); return; } catch (e) { if (!isChainCollision(e) || attempt === CHAIN_RETRIES - 1) throw e; await backoff(attempt); }
    }
  }

  async _deliveryStatements() {
    const { results } = await this.db.prepare("SELECT id, events FROM webhooks WHERE enabled = 1").all();
    const out = [];
    this.deliveryIds = [];
    const a = this.ctx.actor || {};
    for (const ev of this.events) {
      for (const h of results) {
        const events = JSON.parse(h.events || "[]");
        if (!events.includes("*") && !events.includes(ev.name) && !events.includes(ev.name.split(".")[0] + ".*")) continue;
        const id = randomId("dlv_", 16);
        const payload = {
          id, event: ev.name, created_at: new Date(this.ctx.now).toISOString(), data: ev.data,
          actor: { type: a.type, id: a.id ?? null, name: a.name ?? null, api_key_id: a.apiKeyId ?? null }, request_id: this.ctx.reqId
        };
        out.push(this.db.prepare("INSERT INTO webhook_deliveries (id, webhook_id, event, payload, status, attempts, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)")
          .bind(id, h.id, ev.name, JSON.stringify(payload), this.ctx.now, this.ctx.now, this.ctx.now));
        this.deliveryIds.push(id);
      }
    }
    return out;
  }
}
