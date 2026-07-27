/**
 * hud.js — the diegetic-ish overlay: one meter, one prompt line, a row of pips
 * that flash with the player's cadence, and the perf readout.
 *
 * Kept as plain DOM rather than drawn into the canvas: it's crisp at any DPI,
 * costs no GPU time, and the letterboxing means it never overlaps the frame.
 */

const PIP_COUNT = 14;

export function createHUD() {
  const el = {
    prompt: document.getElementById('prompt'),
    sub: document.getElementById('sub'),
    meter: document.getElementById('meter'),
    fill: document.querySelector('#meter .fill'),
    track: document.querySelector('#meter .track'),
    name: document.getElementById('meterName'),
    val: document.getElementById('meterVal'),
    pips: document.getElementById('pips'),
    stats: document.getElementById('stats'),
    title: document.getElementById('title'),
    begin: document.getElementById('begin'),
    flash: document.getElementById('flash'),
    controls: document.getElementById('controls'),
    btnNotes: document.getElementById('btnNotes'),
    btnPluck: document.getElementById('btnPluck'),
    btnMute: document.getElementById('btnMute'),
    btnRestart: document.getElementById('btnRestart'),
    btnStats: document.getElementById('btnStats'),
    hearth: document.getElementById('hearth'),
    embers: document.getElementById('embers'),
    heading: document.querySelector('#title h1'),
    keys: document.getElementById('keys'),
    brace: document.getElementById('brace'),
  };

  // The controls only make sense once the title card is out of the way.
  el.controls.style.display = 'none';

  /* ---- title card: assemble the letters ------------------------------
   * Each word is a nowrap span holding per-letter spans, so the heading can
   * assemble letter by letter without ever breaking inside a word.
   * -------------------------------------------------------------------- */
  if (el.heading) {
    const text = el.heading.dataset.text || el.heading.textContent;
    el.heading.textContent = '';
    let n = 0;
    const words = text.split(' ');
    words.forEach((word, wi) => {
      const w = document.createElement('span');
      w.className = 'w';
      for (const ch of word) {
        const l = document.createElement('span');
        l.className = 'l';
        l.textContent = ch;
        // Short stagger, eased so the line lands rather than marches. The whole
        // heading is in place well under a second.
        l.style.animationDelay = `${0.05 + Math.pow(n / text.length, 0.85) * 0.42}s`;
        w.appendChild(l);
        n++;
      }
      el.heading.appendChild(w);
      if (wi < words.length - 1) {
        el.heading.appendChild(document.createTextNode(' '));
        n++;
      }
    });
  }

  /* ---- title card: embers -------------------------------------------
   * Pure CSS animations with per-instance timing, so they cost nothing on the
   * main thread while the WebGL scene is warming up behind the card.
   * -------------------------------------------------------------------- */
  const EMBER_COUNT = 46;
  if (el.embers) {
    for (let i = 0; i < EMBER_COUNT; i++) {
      const e = document.createElement('i');
      const size = 1.4 + Math.pow(Math.random(), 2.2) * 4.2;
      const dur = 7 + Math.random() * 11;
      e.style.left = `${Math.random() * 100}%`;
      e.style.width = `${size}px`;
      e.style.height = `${size}px`;
      e.style.animationDuration = `${dur}s`;
      // Negative delays start them mid-flight, so the screen is already alive.
      e.style.animationDelay = `${-Math.random() * dur}s`;
      e.style.setProperty('--dx', `${(Math.random() - 0.5) * 22}vw`);
      e.style.setProperty('--peak', (0.35 + Math.random() * 0.6).toFixed(2));
      e.style.filter = `blur(${(Math.random() * 0.9).toFixed(2)}px)`;
      e.style.boxShadow = `0 0 ${(size * 2.4).toFixed(1)}px ${(size * 0.5).toFixed(1)}px rgba(255,140,50,.28)`;
      el.embers.appendChild(e);
    }
  }

  /* ---- piano tiles ----------------------------------------------------
   * Built here rather than in markup so the letter and note labels stay in one
   * place alongside the press handling.
   * ---------------------------------------------------------------------- */
  const KEY_LABELS = [['A', 'C'], ['S', 'F'], ['D', 'A']];
  const keyNodes = [];
  const keyTimers = [];
  const keyListeners = [];

  KEY_LABELS.forEach(([letter, note], i) => {
    const b = document.createElement('button');
    b.className = 'key';
    b.type = 'button';
    b.innerHTML = `<span class="ltr">${letter}</span><span class="nte">${note}</span>`;
    b.addEventListener('click', () => { for (const fn of keyListeners) fn(i); });
    el.keys.appendChild(b);
    keyNodes.push(b);
    keyTimers.push(0);
  });

  /* ---- title card: hearth flicker ------------------------------------
   * Three decorrelated sines rather than random(): fire flickers, it doesn't
   * strobe, and uncorrelated noise per frame reads as a broken monitor.
   * -------------------------------------------------------------------- */
  let flickerT = Math.random() * 100;
  let titleActive = true;

  // Cadence pips.
  const pips = [];
  for (let i = 0; i < PIP_COUNT; i++) {
    const pip = document.createElement('i');
    el.pips.appendChild(pip);
    pips.push({ node: pip, heat: 0 });
  }
  let pipCursor = 0;

  // The band the rhythm has to stay inside, marked on the meter track.
  const notchLo = document.createElement('div');
  notchLo.className = 'notch';
  const notchHi = document.createElement('div');
  notchHi.className = 'notch';
  el.track.append(notchLo, notchHi);

  let currentPrompt = '';
  let flashAmount = 0;
  let wideState = false;
  let braceTimer = 0;

  return {
    el,

    /** Mark the tap-rate band on the meter, as a fraction of the meter width. */
    setBand(lo, hi) {
      notchLo.style.left = `${lo * 100}%`;
      notchHi.style.left = `${hi * 100}%`;
    },

    setPrompt(html, subtitle = '') {
      if (html === currentPrompt) return;
      currentPrompt = html;
      if (!html) {
        el.prompt.classList.remove('show');
        el.sub.classList.remove('show');
        return;
      }
      el.prompt.innerHTML = html;
      el.prompt.classList.add('show');
      if (subtitle) {
        el.sub.textContent = subtitle;
        el.sub.classList.add('show');
      } else {
        el.sub.classList.remove('show');
      }
    },

    setMeter(label, value, visible = true) {
      el.meter.classList.toggle('show', visible);
      el.name.textContent = label;
      el.fill.style.width = `${Math.max(0, Math.min(1, value)) * 100}%`;
      el.val.textContent = `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
    },

    showPips(visible) {
      el.pips.classList.toggle('show', visible);
    },

    /**
     * Show the brace button. Gated on coarse-pointer (touch) at the call site,
     * not here — this just obeys whatever the caller decides.
     */
    showBrace(visible) {
      el.brace.classList.toggle('show', visible);
    },

    /** Brief press feedback, independent of whatever fired the tap. */
    pulseBrace() {
      el.brace.classList.add('hit');
      clearTimeout(braceTimer);
      braceTimer = setTimeout(() => el.brace.classList.remove('hit'), 90);
    },

    /**
     * How close the cadence is to the target band, 0..1. The pip row dims when
     * the player drifts out of rhythm — it's the only feedback that teaches the
     * tempo, so it has to be legible before the tension meter reacts.
     */
    setPipQuality(q) {
      el.pips.style.opacity = String(0.3 + Math.max(0, Math.min(1, q)) * 0.7);
    },

    /** Light the next pip; they fade on their own in update(). */
    pulsePip() {
      const p = pips[pipCursor];
      p.heat = 1;
      p.node.classList.add('hot');
      pipCursor = (pipCursor + 1) % PIP_COUNT;
    },

    /** Full-frame white flash for the release beat. */
    flash(amount = 0.5) {
      flashAmount = amount;
    },

    /**
     * Widen the letterbox for the pulled-back framing.
     *
     * Takes the raw 0..1 draw and applies hysteresis rather than a bare
     * threshold. The draw wobbles constantly — it rises with the gesture and
     * decays when idle — so a single cut point at 0.5 gets crossed over and
     * over, and each crossing restarts a 1.2s animation on the bars. The result
     * is the frame visibly pumping. Separate up and down thresholds mean it
     * only ever commits once per direction.
     */
    /** Fires with 0/1/2 when a tile is clicked. */
    onKeyPress(fn) { keyListeners.push(fn); },

    /** Depress a tile. Called for keyboard, clicks, and automatic strikes. */
    pressKey(i) {
      const node = keyNodes[i];
      if (!node) return;
      node.classList.add('down');
      clearTimeout(keyTimers[i]);
      keyTimers[i] = setTimeout(() => node.classList.remove('down'), 130);
    },

    showKeys(visible) {
      el.keys.classList.toggle('show', visible);
    },

    setWide(amount) {
      if (!wideState && amount > 0.62) wideState = true;
      else if (wideState && amount < 0.38) wideState = false;
      else return;
      document.body.classList.toggle('wide', wideState);
    },

    hideTitle() {
      el.title.classList.add('gone');
      el.controls.style.display = 'flex';
      setTimeout(() => {
        el.title.style.display = 'none';
        titleActive = false;      // stop paying for the flicker once it's gone
      }, 1700);
    },

    get titleVisible() { return titleActive; },

    toggleStats() {
      el.stats.classList.toggle('show');
      return el.stats.classList.contains('show');
    },

    setStats(text) {
      if (el.stats.classList.contains('show')) el.stats.textContent = text;
    },

    update(dt) {
      // Hearth flicker on the title card.
      if (titleActive && el.hearth) {
        flickerT += dt;
        const f =
          Math.sin(flickerT * 2.7) * 0.32 +
          Math.sin(flickerT * 6.1 + 1.7) * 0.20 +
          Math.sin(flickerT * 11.3 + 4.2) * 0.11;
        el.hearth.style.opacity = (0.78 + f * 0.26).toFixed(3);
        // A little vertical breath, as if the flames are drawing air.
        el.hearth.style.transform = `translateY(${(f * 1.6).toFixed(2)}%) scaleY(${(1 + f * 0.035).toFixed(4)})`;
      }

      for (const p of pips) {
        if (p.heat > 0) {
          p.heat -= dt * 3.6;
          if (p.heat <= 0) {
            p.heat = 0;
            p.node.classList.remove('hot');
          }
        }
      }
      if (flashAmount > 0) {
        flashAmount = Math.max(0, flashAmount - dt * 3.4);
        el.flash.style.opacity = String(flashAmount);
      }
    },
  };
}
