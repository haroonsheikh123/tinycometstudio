/* SMTP sender (lib/platform/smtp.js) against a tiny fake server, and its wiring into lib/admin/email.js. */
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { sendMail, buildMessage, smtpSenderFromEnv } from "../lib/platform/smtp.js";
import { sendEmail } from "../lib/admin/email.js";

function fakeSmtp({ auth = "PLAIN LOGIN", starttls = false } = {}) {
  const sessions = [];
  const server = net.createServer((sock) => {
    const s = { lines: [], data: "" };
    sessions.push(s);
    let inData = false, buf = "";
    sock.write("220 fake ESMTP\r\n");
    sock.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) { if (line === ".") { inData = false; sock.write("250 2.0.0 queued as 42\r\n"); } else s.data += line + "\n"; continue; }
        s.lines.push(line);
        if (/^EHLO/.test(line)) sock.write(`250-fake\r\n${starttls ? "250-STARTTLS\r\n" : ""}250 AUTH ${auth}\r\n`);
        else if (/^AUTH PLAIN/.test(line)) sock.write("235 ok\r\n");
        else if (/^MAIL FROM|^RCPT TO/.test(line)) sock.write("250 ok\r\n");
        else if (line === "DATA") { inData = true; sock.write("354 go\r\n"); }
        else if (line === "QUIT") { sock.write("221 bye\r\n"); sock.end(); }
        else sock.write("500 what\r\n");
      }
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, port: server.address().port, sessions })));
}

test("smtp: AUTH PLAIN, envelope, UTF-8 subject/body, dot-safe DATA", async () => {
  const f = await fakeSmtp();
  try {
    const r = await sendMail({ host: "127.0.0.1", port: f.port, secure: false, requireTls: false, user: "hello@tinycomet.test", password: "pw", from: "Tiny Comet Studio <hello@tinycomet.test>", to: "sana@example.com", subject: "Set up your account ✨", text: "Hi Sana,\n.\nline after a dot" });
    assert.equal(r.ok, true);
    const s = f.sessions[0];
    assert.ok(s.lines.includes(`AUTH PLAIN ${Buffer.from("\0hello@tinycomet.test\0pw").toString("base64")}`));
    assert.ok(s.lines.includes("MAIL FROM:<hello@tinycomet.test>"));
    assert.ok(s.lines.includes("RCPT TO:<sana@example.com>"));
    assert.match(s.data, /Subject: =\?UTF-8\?B\?/);
    const body = s.data.split("\n\n").slice(1).join("").replace(/\n/g, "");
    assert.equal(Buffer.from(body, "base64").toString(), "Hi Sana,\r\n.\r\nline after a dot");
  } finally { f.server.close(); }
});

test("smtp: refuses to send a password without TLS; email.js uses env.EMAIL_SENDER; off by default", async () => {
  const f = await fakeSmtp();
  try {
    await assert.rejects(sendMail({ host: "127.0.0.1", port: f.port, user: "u", password: "p", from: "a@b.c", to: "d@e.f", subject: "x", text: "y" }), /STARTTLS/);
  } finally { f.server.close(); }
  assert.equal(smtpSenderFromEnv({}), null);
  const sent = [];
  assert.equal(await sendEmail({ EMAIL_SENDER: { send: async (m) => { sent.push(m); return true; } } }, { to: "x@y.z", subject: "s", text: "t" }), true);
  assert.equal(sent[0].to, "x@y.z");
  assert.equal(await sendEmail({}, { to: "x@y.z", subject: "s", text: "t" }), false);
  assert.match(buildMessage({ from: "Zoë <z@x.y>", to: "a@b.c", subject: "hi", text: "t" }), /^From: =\?UTF-8\?B\?[^?]+\?= <z@x\.y>/);
});
