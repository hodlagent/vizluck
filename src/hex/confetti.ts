// Lightweight canvas confetti — spawns a burst of BTC-themed particles that
// fall, spin, and fade out on their own.  The canvas is removed once every
// particle has expired, so there is no persistent overlay.
//
// Deliberately imperative: this is a per-frame draw loop over a canvas, which
// is not something a template can express.  Moved here verbatim.

export function launchConfetti() {
  const canvas = document.createElement("canvas");
  canvas.style.position = "fixed";
  canvas.style.inset = "0";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.pointerEvents = "none";
  canvas.style.zIndex = "9999";
  document.body.appendChild(canvas);

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    canvas.remove();
    return;
  }

  const dpr = window.devicePixelRatio || 1;
  const resize = () => {
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
  };
  resize();

  const colors = ["#f7931a", "#ffd700", "#2ecc71", "#ff6b6b", "#4ecdc4", "#ffffff"];
  const particles: Array<{
    x: number; y: number; vx: number; vy: number;
    size: number; color: string; rot: number; vrot: number; life: number;
  }> = [];

  // Two side cannons + a central burst.
  const spawn = (originX: number, count: number) => {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI; // upward hemisphere
      const speed = 4 + Math.random() * 8;
      particles.push({
        x: originX,
        y: window.innerHeight * 0.9,
        vx: Math.cos(angle) * speed * (originX < window.innerWidth / 2 ? 1 : -1),
        vy: -Math.sin(angle) * speed - 4,
        size: 6 + Math.random() * 6,
        color: colors[Math.floor(Math.random() * colors.length)],
        rot: Math.random() * Math.PI * 2,
        vrot: (Math.random() - 0.5) * 0.3,
        life: 1,
      });
    }
  };
  spawn(window.innerWidth * 0.2, 60);
  spawn(window.innerWidth * 0.8, 60);
  spawn(window.innerWidth * 0.5, 40);

  let lastTime = performance.now();
  let done = false;

  const tick = (now: number) => {
    const dt = Math.min((now - lastTime) / 16.67, 3); // normalize to ~60fps frames
    lastTime = now;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.vy += 0.25 * dt; // gravity
      p.vx *= 0.99; // air drag
      p.x += p.vx * dt * dpr;
      p.y += p.vy * dt * dpr;
      p.rot += p.vrot * dt;
      p.life -= 0.008 * dt; // fade out

      if (p.life <= 0 || p.y > window.innerHeight * dpr + 40) {
        particles.splice(i, 1);
        continue;
      }

      ctx.save();
      ctx.globalAlpha = Math.max(p.life, 0);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size * dpr / 2, -p.size * dpr / 2, p.size * dpr, p.size * dpr * 0.6);
      ctx.restore();
    }

    if (particles.length > 0) {
      requestAnimationFrame(tick);
    } else {
      canvas.remove();
      done = true;
    }
  };
  requestAnimationFrame(tick);

  // Safety net: force-remove after 6s even if some particles linger.
  window.setTimeout(() => {
    if (!done) canvas.remove();
  }, 6000);
}
