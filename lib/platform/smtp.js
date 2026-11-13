/* Minimal SMTP client (no dependencies) so invites and password resets can be sent from a cPanel mailbox.
   Off unless SMTP_HOST is set. Supports implicit TLS (port 465, SMTP_SECURE=true) and STARTTLS (port 587/25),
   AUTH PLAIN / LOGIN, plain-text UTF-8 messages. The Node host wires it in as env.EMAIL_SENDER (lib/admin/email.js).

   cPanel: Email Accounts → Connect Devices shows the values. Typically
     SMTP_HOST=mail.yourdomain.com  SMTP_PORT=465  SMTP_SECURE=true  SMTP_USER=hello@yourdomain.com  SMTP_PASSWORD=…
     EMAIL_FROM="Tiny Comet Studio <hello@yourdomain.com>" */
import net from "node:net";
import tls from "node:tls";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const addrOf = (s) => { const m = /<([^>]+)>/.exec(String(s)); return (m ? m[1] : String(s)).trim(); };
const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
function encodeFrom(s) {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(String(s));
  return m && m[1] ? `${encodeHeader(m[1].replace(/^"|"$/g, ""))} <${m[2]}>` : String(s);
}

/** Build an RFC 5322 message (text/plain, UTF-8, base64 body). */
export function buildMessage({ from, to, subject, text, replyTo, date = new Date(), messageId }) {
  const domain = addrOf(from).split("@")[1] || "localhost";
  const body = b64(String(text || "").replace(/\r?\n/g, "\r\n")).replace(/.{1,76}/g, "$&\r\n");
  return [
    `From: ${encodeFrom(from)}`, `To: ${[].concat(to).join(", ")}`, `Subject: ${encodeHeader(String(subject || ""))}`,
    `Date: ${date.toUTCString().replace("GMT", "+0000")}`, `Message-ID: ${messageId || `<${randomBytes(12).toString("hex")}@${domain}>`}`,
    ...(replyTo ? [`Reply-To: ${replyTo}`] : []), "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", body
  ].join("\r\n");
}

class Conn {
  constructor(socket, timeoutMs) { this.attach(socket); this.timeoutMs = timeoutMs; }
  attach(socket) {
    this.socket = socket; this.buf = ""; this.waiters = [];
    socket.setEncoding("utf8");
    socket.on("data", (d) => { this.buf += d; this.flush(); });
    socket.on("error", (e) => { this.err = e; this.flush(); });
    socket.on("close", () => { this.err ||= new Error("SMTP connection closed"); this.flush(); });
  }
  flush() {
    while (this.waiters.length) {
      const m = /(?:^|\r\n)(\d{3}) [^\r\n]*\r\n/.exec(this.buf);
      if (!m) { if (this.err) this.waiters.shift().reject(this.err); else return; continue; }
      const end = m.index + m[0].length;
      const text = this.buf.slice(0, end); this.buf = this.buf.slice(end);
      this.waiters.shift().resolve({ code: Number(m[1]), text: text.trim() });
    }
  }
  read() {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("SMTP timeout")), this.timeoutMs);
      this.waiters.push({ resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.flush();
    });
  }
  async cmd(line, expect) {
    if (line != null) this.socket.write(line + "\r\n");
    const r = await this.read();
    if (expect && !expect.includes(r.code)) throw new Error(`SMTP ${line ? line.split(" ")[0] : "greeting"} failed: ${r.text}`);
    return r;
  }
}

/**
 * Send one message. @returns {Promise<{ ok: true, response: string }>}
 * @param {{ host, port?, secure?, user?, password?, from, to, subject, text, replyTo?, timeoutMs?, rejectUnauthorized? }} o
 */
export async function sendMail(o) {
  const port = Number(o.port) || (o.secure ? 465 : 587);
  const secure = o.secure ?? port === 465;
  const timeoutMs = o.timeoutMs || 15_000;
  const tlsOpts = { host: o.host, servername: o.host, rejectUnauthorized: o.rejectUnauthorized !== false };
  const socket = await new Promise((resolve, reject) => {
    const s = secure ? tls.connect({ ...tlsOpts, port }) : net.connect({ host: o.host, port });
    s.setTimeout(timeoutMs, () => s.destroy(new Error("SMTP connect timeout")));
    s.once(secure ? "secureConnect" : "connect", () => resolve(s));
    s.once("error", reject);
  });
  const c = new Conn(socket, timeoutMs);
  try {
    await c.cmd(null, [220]);
    const me = o.clientName || hostname() || "localhost";
    let ehlo = await c.cmd(`EHLO ${me}`, [250]);
    if (!secure && /STARTTLS/i.test(ehlo.text)) {
      await c.cmd("STARTTLS", [220]);
      const up = await new Promise((resolve, reject) => { const t = tls.connect({ ...tlsOpts, socket }); t.once("secureConnect", () => resolve(t)); t.once("error", reject); });
      c.attach(up);
      ehlo = await c.cmd(`EHLO ${me}`, [250]);
    } else if (!secure && o.requireTls !== false && o.user) throw new Error("SMTP server does not offer STARTTLS — refusing to send the password in clear text (set SMTP_SECURE=true and port 465)");
    if (o.user) {
      if (/AUTH[ =][^\r\n]*PLAIN/i.test(ehlo.text)) await c.cmd(`AUTH PLAIN ${b64(`\0${o.user}\0${o.password || ""}`)}`, [235]);
      else { await c.cmd("AUTH LOGIN", [334]); await c.cmd(b64(o.user), [334]); await c.cmd(b64(o.password || ""), [235]); }
    }
    await c.cmd(`MAIL FROM:<${addrOf(o.from)}>`, [250]);
    for (const rcpt of [].concat(o.to)) await c.cmd(`RCPT TO:<${addrOf(rcpt)}>`, [250, 251]);
    await c.cmd("DATA", [354]);
    const msg = buildMessage(o).replace(/^\./gm, "..");
    const done = await c.cmd(`${msg}\r\n.`, [250]);
    await c.cmd("QUIT").catch(() => {});
    return { ok: true, response: done.text };
  } finally { c.socket.destroy(); }
}

/** env.EMAIL_SENDER for lib/admin/email.js, or null when SMTP isn't configured. */
export function smtpSenderFromEnv(vars, log) {
  if (!vars.SMTP_HOST) return null;
  const bool = (v) => /^(1|true|yes|on)$/i.test(String(v || ""));
  const cfg = { host: vars.SMTP_HOST, port: vars.SMTP_PORT, secure: vars.SMTP_SECURE ? bool(vars.SMTP_SECURE) : undefined, user: vars.SMTP_USER, password: vars.SMTP_PASSWORD || vars.SMTP_PASS, rejectUnauthorized: vars.SMTP_TLS_INSECURE ? !bool(vars.SMTP_TLS_INSECURE) : true };
  const from = vars.EMAIL_FROM || vars.SMTP_USER;
  return {
    kind: "smtp",
    async send({ to, subject, text }) {
      try { await sendMail({ ...cfg, from, to, subject, text }); return true; }
      catch (err) { log?.warn?.("email send failed", { err, to }); return false; }
    }
  };
}
