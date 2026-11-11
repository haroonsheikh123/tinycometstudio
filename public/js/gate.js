/* Web-play gate: loads Cloudflare Turnstile (only on this page), sends the
   token to /api/verify, which sets a signed HttpOnly cookie, then reloads
   /<slug>/play/ — now unlocked by functions/[slug]/play/_middleware.js. */

const card = document.querySelector("[data-gate]");
const statusEl = document.getElementById("gate-status");
const retry = document.getElementById("gate-retry");
const box = document.getElementById("turnstile-widget");
const slug = card?.dataset.slug;
const sitekey = card?.dataset.sitekey;
const TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=tcTurnstileReady";
let widgetId = null;

const track = (e, p) => window.tcTrack?.(e, p);
function setState(state, message) {
  card.dataset.state = state;
  statusEl.textContent = message || "";
  retry.hidden = !["error", "unavailable", "expired"].includes(state);
}

const MESSAGES = {
  loading: "Loading the security check…",
  ready: "Tick the box (if asked) and we'll launch the game.",
  verifying: "Checking… one moment.",
  launching: "You're in! Launching the game…",
  loadFailed: "We couldn't load the security check. Check your connection or disable content blockers for this page, then try again.",
  captcha_failed: "The security check didn't pass. Please try again.",
  expired: "The check expired — please try again.",
  unavailable: "Our launch pad isn't reachable right now. Please try again in a moment.",
  not_enabled: "This game isn't playable in the browser yet.",
  misconfigured: "Web play isn't fully set up yet. Please check back soon."
};

async function onToken(token) {
  setState("verifying", MESSAGES.verifying);
  let res, data;
  try {
    res = await fetch("/api/verify", {
      method: "POST",
      headers: { Accept: "application/json" },
      body: new URLSearchParams({ slug, "cf-turnstile-response": token }),
      credentials: "same-origin"
    });
    data = await res.json();
  } catch {
    setState("unavailable", MESSAGES.unavailable);
    return;
  }
  if (res.ok && data.ok) {
    setState("launching", MESSAGES.launching);
    track("play_unlocked", { game: slug });
    location.replace(data.redirect || `/${slug}/play/`);
    return;
  }
  const code = data?.error;
  if (code === "not_enabled") { setState("not_enabled", MESSAGES.not_enabled); retry.hidden = true; return; }
  setState(code === "misconfigured" ? "unavailable" : "error", MESSAGES[code] || MESSAGES.captcha_failed);
}

function render() {
  if (!window.turnstile) return;
  box.replaceChildren();
  widgetId = window.turnstile.render(box, {
    sitekey,
    action: "play",
    cData: slug,
    theme: "dark",
    callback: onToken,
    "error-callback": () => { setState("error", MESSAGES.captcha_failed); return true; },
    "expired-callback": () => setState("expired", MESSAGES.expired),
    "timeout-callback": () => setState("expired", MESSAGES.expired)
  });
  setState("ready", MESSAGES.ready);
}

function load() {
  setState("loading", MESSAGES.loading);
  if (window.turnstile) { render(); return; }
  window.tcTurnstileReady = render;
  const s = document.createElement("script");
  s.src = TURNSTILE_SRC;
  s.async = true;
  s.onerror = () => setState("unavailable", MESSAGES.loadFailed);
  document.head.append(s);
  setTimeout(() => { if (!window.turnstile) setState("unavailable", MESSAGES.loadFailed); }, 15000);
}

retry?.addEventListener("click", () => {
  if (window.turnstile && widgetId !== null) { window.turnstile.reset(widgetId); setState("ready", MESSAGES.ready); }
  else location.reload();
});

if (card && slug) {
  if (!sitekey) setState("unavailable", MESSAGES.misconfigured);
  else load();
}
