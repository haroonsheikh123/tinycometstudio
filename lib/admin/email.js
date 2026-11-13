/* Optional, pluggable email. The site has no mail service by default, so invite/reset links are shown to the
   admin who created them (once) and can be shared any way they like. Senders, first match wins:
   1. env.EMAIL_SENDER — injected by the host. The Node/cPanel host provides an SMTP sender when SMTP_HOST is set
      (lib/platform/smtp.js: send through your cPanel mailbox, e.g. hello@yourdomain.com).
   2. EMAIL_WEBHOOK_URL — any HTTPS endpoint (your own Worker, Zapier/Make hook, a MailChannels/Resend relay…) that
      accepts POST { to, subject, text } — optionally authenticated with EMAIL_WEBHOOK_TOKEN (sent as a Bearer token). */
export async function sendEmail(env, { to, subject, text }) {
  if (env?.EMAIL_SENDER?.send) {
    try { return Boolean(await env.EMAIL_SENDER.send({ to, subject, text })); } catch { return false; }
  }
  if (!env?.EMAIL_WEBHOOK_URL) return false;
  try {
    const res = await fetch(env.EMAIL_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(env.EMAIL_WEBHOOK_TOKEN ? { Authorization: `Bearer ${env.EMAIL_WEBHOOK_TOKEN}` } : {}) },
      body: JSON.stringify({ to, subject, text, from: env.EMAIL_FROM || undefined }),
      signal: AbortSignal.timeout(8000)
    });
    return res.ok;
  } catch { return false; }
}
