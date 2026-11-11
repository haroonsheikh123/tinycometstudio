/* Placeholder demo game for Project Nova — "catch the stars". Replace with the real build. */
(() => {
  const c = document.getElementById("game"), ctx = c.getContext("2d");
  const scoreEl = document.getElementById("score"), timeEl = document.getElementById("time");
  const overlay = document.getElementById("overlay"), startBtn = document.getElementById("start");
  let W, H, dpr, stars = [], trail = [], score = 0, best = 0, end = 0, running = false, last = 0, spawn = 0;
  const p = { x: 0, y: 0, tx: 0, ty: 0 };
  const resize = () => { dpr = Math.min(devicePixelRatio || 1, 2); W = innerWidth; H = innerHeight; c.width = W * dpr; c.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
  resize(); addEventListener("resize", resize);
  p.x = p.tx = W / 2; p.y = p.ty = H * 0.7;
  const move = (e) => { const t = e.touches ? e.touches[0] : e; p.tx = t.clientX; p.ty = t.clientY; };
  addEventListener("pointermove", move); addEventListener("touchmove", move, { passive: true });
  addEventListener("keydown", (e) => { const k = { ArrowLeft: [-40, 0], ArrowRight: [40, 0], ArrowUp: [0, -40], ArrowDown: [0, 40] }[e.key]; if (k) { p.tx += k[0]; p.ty += k[1]; } });
  const bg = Array.from({ length: 90 }, () => ({ x: Math.random(), y: Math.random(), r: Math.random() * 1.3 + 0.3 }));
  function star(x, y, r, rot, col) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.beginPath();
    for (let i = 0; i < 10; i++) { const a = (i * Math.PI) / 5, rr = i % 2 ? r * 0.45 : r; ctx.lineTo(Math.sin(a) * rr, -Math.cos(a) * rr); }
    ctx.closePath(); ctx.fillStyle = col; ctx.fill(); ctx.restore();
  }
  function frame(t) {
    const dt = Math.min(50, t - (last || t)); last = t;
    p.x += (p.tx - p.x) * 0.18; p.y += (p.ty - p.y) * 0.18;
    trail.push({ x: p.x, y: p.y }); if (trail.length > 18) trail.shift();
    ctx.fillStyle = "#0E0F2C"; ctx.fillRect(0, 0, W, H);
    for (const s of bg) { ctx.fillStyle = "rgba(255,248,236,.6)"; ctx.fillRect(s.x * W, s.y * H, s.r, s.r); }
    if (running) {
      spawn -= dt;
      if (spawn <= 0) { stars.push({ x: 20 + Math.random() * (W - 40), y: -20, v: 0.12 + Math.random() * 0.18 + score * 0.004, rot: 0, r: 10 + Math.random() * 8 }); spawn = 420 - Math.min(250, score * 6); }
      const left = Math.max(0, Math.ceil((end - t) / 1000)); timeEl.textContent = left + "s";
      if (t >= end) finish();
    }
    stars = stars.filter((s) => {
      s.y += s.v * dt; s.rot += 0.002 * dt;
      if (Math.hypot(s.x - p.x, s.y - p.y) < s.r + 22) { if (running) { score++; scoreEl.textContent = "★ " + score; } return false; }
      star(s.x, s.y, s.r, s.rot, "#FFE07A"); return s.y < H + 30;
    });
    for (let i = 0; i < trail.length; i++) { const q = trail[i], k = i / trail.length; ctx.beginPath(); ctx.arc(q.x, q.y, 4 + 14 * k, 0, 7); ctx.fillStyle = `rgba(255,${94 + 60 * k | 0},${110 - 40 * k | 0},${0.05 + 0.25 * k})`; ctx.fill(); }
    const g = ctx.createRadialGradient(p.x - 6, p.y - 6, 2, p.x, p.y, 20); g.addColorStop(0, "#FFE07A"); g.addColorStop(1, "#FF9A3C");
    ctx.beginPath(); ctx.arc(p.x, p.y, 18, 0, 7); ctx.fillStyle = g; ctx.fill();
    ctx.fillStyle = "#17183F"; ctx.beginPath(); ctx.arc(p.x - 6, p.y - 2, 2.4, 0, 7); ctx.arc(p.x + 6, p.y - 4, 2.4, 0, 7); ctx.fill();
    ctx.strokeStyle = "#17183F"; ctx.lineWidth = 2; ctx.lineCap = "round"; ctx.beginPath(); ctx.arc(p.x + 1, p.y + 3, 5, 0.3, 2.6); ctx.stroke();
    requestAnimationFrame(frame);
  }
  function start() { score = 0; scoreEl.textContent = "★ 0"; stars = []; end = performance.now() + 30000; running = true; overlay.hidden = true; }
  function finish() {
    running = false; best = Math.max(best, score);
    document.getElementById("ov-title").textContent = `You caught ${score} star${score === 1 ? "" : "s"}!`;
    document.getElementById("ov-text").textContent = `Best this session: ${best}. This is a tiny placeholder demo — the real game is on its way.`;
    startBtn.textContent = "Play again"; overlay.hidden = false; startBtn.focus();
  }
  startBtn.addEventListener("click", start);
  requestAnimationFrame(frame);
})();
