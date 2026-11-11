/* Security headers for pages rendered by Pages Functions. Cloudflare does NOT apply public/_headers to Function
   responses, so the public CSP etc. are mirrored here (tests/admin-site.test.mjs keeps the two in sync). */
export const PUBLIC_CSP = "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com https://www.youtube-nocookie.com; connect-src 'self' https://challenges.cloudflare.com; img-src 'self' data: https://i.ytimg.com; style-src 'self' 'unsafe-inline'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests";
export const PUBLIC_HEADERS = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": PUBLIC_CSP
};
/* The admin panel: same-origin only, Turnstile allowed on the sign-in screen, no inline script or style. */
export const ADMIN_CSP = "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self'; img-src 'self' data: blob:; style-src 'self'; font-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
export const ADMIN_HEADERS = {
  ...PUBLIC_HEADERS,
  "Content-Security-Policy": ADMIN_CSP,
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Referrer-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cache-Control": "no-store"
};
