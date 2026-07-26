/**
 * audio.js — sample-based sound, built on the palette Christopher Nolan and
 * Ludwig Göransson actually used for The Odyssey (2026).
 *
 * The research that shaped this:
 *
 *   - Nolan banned the orchestra. The score is bronze gongs (35 of them, in
 *     various sizes), struck scrap metal, railings and walls, plus lyre and
 *     aulos. So: no synth pads, no sustained oscillators, nothing that sounds
 *     like a plugin. Every source here is a recording of a physical object.
 *
 *   - Nolan's idea was that "the sound of the lyre IS the pluck of Odysseus'
 *     bow" — which comes straight from Homer, who describes Odysseus stringing
 *     the bow as easily as a musician strings a lyre. So the string, when you
 *     pluck it, sounds a musical note rather than a bowstring thwack. Here that
 *     note is one low plucked piano string: a long steel string at high tension
 *     over a wooden soundboard, which is what a heavy bowstring most resembles.
 *
 *   - A four-note motif recurs through the film, its final cutting note played
 *     by the bow itself. That shaped an earlier version, but the piano is now
 *     reserved entirely for the player's three tiles — nothing in the piece
 *     sounds them on its own. The draw and the shot speak in bronze.
 *
 * Samples come from Freesound (credited in the README). Most are CC0; two are
 * CC-BY and are attributed there.
 *
 * Crucially these are NOT played as static clips. Every voice gets randomised
 * pitch and level, a random pick from its slot, a state-reactive filter, and a
 * convolution reverb whose wet mix tracks how far the camera has pulled back.
 * The pluck has only one source file, so all of its variation comes from
 * mapping playback rate and brightness to how far the string was pulled.
 *
 * The AudioContext is built on the first user gesture; buffers are fetched
 * before that and decoded once it exists, so there's no stall on the first tap.
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);

const ASSET_BASE = './assets/audio/';

export function createAudio() {
  let ctx = null;
  let ready = false;
  let started = false;
  let muted = false;
  let volume = 0.9;

  // Buses
  let master, dry, wet, convolver, comp;
  // Continuous bed: a real creak recording, slowed and filtered
  let bedSource = null, bedGain, bedFilter;
  // The hall's hearth, burning under everything
  let fireSource = null, fireGain, fireFilter;
  let fireTarget = 0;

  const raw = {};        // slot -> [ArrayBuffer]
  const buffers = {};    // slot -> [AudioBuffer]
  let fetchPromise = null;

  let creakTimer = 0;
  let creakRate = 0;

  /* ---------------------------------------------------------------- *
   * Loading
   * ---------------------------------------------------------------- */

  /**
   * Fetch every sample as an ArrayBuffer. Runs at boot — no AudioContext
   * required yet, so the network round-trip overlaps with the title card.
   */
  async function prefetch() {
    if (fetchPromise) return fetchPromise;
    fetchPromise = (async () => {
      let manifest;
      try {
        const res = await fetch(`${ASSET_BASE}manifest.json`);
        if (!res.ok) throw new Error(`manifest ${res.status}`);
        manifest = await res.json();
      } catch (e) {
        console.warn('[audio] no manifest; running silent', e);
        return;
      }

      await Promise.all(Object.entries(manifest).map(async ([slot, files]) => {
        raw[slot] = [];
        await Promise.all(files.map(async (file) => {
          try {
            const res = await fetch(ASSET_BASE + file);
            if (!res.ok) throw new Error(`${file} ${res.status}`);
            raw[slot].push(await res.arrayBuffer());
          } catch (e) {
            console.warn(`[audio] failed ${file}`, e);
          }
        }));
      }));
    })();
    return fetchPromise;
  }

  async function decodeAll() {
    await Promise.all(Object.entries(raw).map(async ([slot, arrs]) => {
      buffers[slot] = [];
      for (const arr of arrs) {
        try {
          // decodeAudioData detaches the buffer, so hand it a copy — otherwise a
          // second unlock (after a context loss) would find them all empty.
          buffers[slot].push(await ctx.decodeAudioData(arr.slice(0)));
        } catch (e) {
          console.warn(`[audio] decode failed in ${slot}`, e);
        }
      }
    }));
  }

  /* ---------------------------------------------------------------- *
   * Graph
   * ---------------------------------------------------------------- */

  /**
   * The hall. Generated rather than sampled: exponentially decaying noise that
   * darkens as it decays, because stone absorbs highs fastest, with the channels
   * decorrelated so it images wide. This is about the *space*, not the sources —
   * the sources are all real recordings.
   */
  function makeHallIR(seconds = 3.4, decay = 2.3) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        const n = Math.random() * 2 - 1;
        lp += (n - lp) * lerp(0.6, 0.07, t);
        d[i] = lp * Math.pow(1 - t, decay);
      }
      // Early reflections off the pillars give the tail somewhere to start.
      for (const [ms, amp] of [[11, 0.4], [19, 0.32], [31, 0.24], [47, 0.17], [63, 0.11]]) {
        const idx = Math.floor((ms / 1000) * ctx.sampleRate) + (ch ? 41 : 0);
        if (idx < len) d[idx] += amp * (Math.random() > 0.5 ? 1 : -1);
      }
    }
    return buf;
  }

  function init() {
    if (ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();

    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 24;
    comp.ratio.value = 3.4;
    comp.attack.value = 0.004;
    comp.release.value = 0.26;

    master = ctx.createGain();
    master.gain.value = 0;
    comp.connect(master);
    master.connect(ctx.destination);

    convolver = ctx.createConvolver();
    convolver.buffer = makeHallIR();

    dry = ctx.createGain();
    dry.gain.value = 1.0;
    wet = ctx.createGain();
    wet.gain.value = 0.14;
    dry.connect(comp);
    wet.connect(convolver);
    convolver.connect(comp);

    // Continuous bed for the draw: a real tree-creak recording pitched right
    // down and heavily filtered, so the "load" layer is still a physical object.
    bedFilter = ctx.createBiquadFilter();
    bedFilter.type = 'lowpass';
    bedFilter.frequency.value = 200;
    bedFilter.Q.value = 0.8;
    bedGain = ctx.createGain();
    bedGain.gain.value = 0;
    bedFilter.connect(bedGain);
    bedGain.connect(dry);
    bedGain.connect(wet);

    // The hearth. A megaron is built around its fire, so this runs the whole
    // time — loud and close on the title card, then pulled right back so it
    // sits under the piece as room tone rather than competing with it.
    fireFilter = ctx.createBiquadFilter();
    fireFilter.type = 'lowpass';
    fireFilter.frequency.value = 7000;
    fireFilter.Q.value = 0.7;
    fireGain = ctx.createGain();
    fireGain.gain.value = 0;
    fireFilter.connect(fireGain);
    fireGain.connect(dry);
    fireGain.connect(wet);

    ready = true;
  }

  /** Must be called from inside a user-gesture handler. */
  async function unlock() {
    init();
    if (!ctx) return;
    if (ctx.state === 'suspended') await ctx.resume();

    await prefetch();
    if (!Object.keys(buffers).length) await decodeAll();

    startBed();
    if (fireTarget > 0) startFire(fireTarget);

    if (!started) {
      started = true;
      master.gain.setTargetAtTime(muted ? 0 : volume, ctx.currentTime, 0.5);
    }
  }

  /**
   * Start the hearth. The loop was crossfaded end-over-start when it was built,
   * so it cycles without a seam.
   *
   * @param level target gain — louder on the title card than in the hall
   */
  function startFire(level = 0.5) {
    fireTarget = level;
    if (!ready) return;
    if (!fireSource && buffers.fire?.length) {
      fireSource = ctx.createBufferSource();
      fireSource.buffer = buffers.fire[0];
      fireSource.loop = true;
      fireSource.playbackRate.value = 0.97;
      fireSource.connect(fireFilter);
      fireSource.start(0, Math.random() * buffers.fire[0].duration);
    }
    if (fireGain) fireGain.gain.setTargetAtTime(fireTarget, ctx.currentTime, 0.9);
  }

  /** Pull the hearth back once the piece proper begins. */
  function setFireLevel(level, seconds = 1.6) {
    fireTarget = level;
    if (ready && fireGain) fireGain.gain.setTargetAtTime(level, ctx.currentTime, seconds / 3);
  }

  function startBed() {
    if (bedSource || !buffers.creak?.length) return;
    // creak-2 is the long tree creak; slowed hard it becomes structural groan.
    const buf = buffers.creak[buffers.creak.length > 1 ? 1 : 0];
    bedSource = ctx.createBufferSource();
    bedSource.buffer = buf;
    bedSource.loop = true;
    bedSource.playbackRate.value = 0.32;
    bedSource.connect(bedFilter);
    bedSource.start();
  }

  /* ---------------------------------------------------------------- *
   * Playback
   * ---------------------------------------------------------------- */

  function pick(slot, index) {
    const list = buffers[slot];
    if (!list || !list.length) return null;
    if (index !== undefined) return list[clamp(index, 0, list.length - 1)] || null;
    return list[(Math.random() * list.length) | 0];
  }

  /**
   * Fire one sample. Everything is randomised a little and routed through a
   * filter, so repeated hits never phase-align into an obvious loop.
   *
   * @param opts.rate      playback rate (pitch)
   * @param opts.gain      level
   * @param opts.offset    start offset into the buffer
   * @param opts.duration  stop after this long
   * @param opts.filter    ['lowpass'|'highpass'|'bandpass', freq, Q]
   * @param opts.fadeOut   release tail in seconds
   * @param opts.index     play this specific file in the slot, not a random one
   * @param opts.buffer    use this buffer instead of picking from the slot
   * @param opts.send      extra reverb send, 0..1
   */
  function play(slot, opts = {}) {
    if (!ready) return null;
    const buf = opts.buffer || pick(slot, opts.index);
    if (!buf) return null;

    const t = ctx.currentTime + (opts.delay || 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = opts.rate ?? 1;

    let node = src;
    if (opts.filter) {
      const [type, freq, q] = opts.filter;
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q ?? 1;
      node.connect(f);
      node = f;
    }

    const g = ctx.createGain();
    const level = opts.gain ?? 1;
    g.gain.setValueAtTime(level, t);

    const dur = opts.duration;
    if (dur) {
      const fade = opts.fadeOut ?? 0.08;
      g.gain.setValueAtTime(level, t + Math.max(0, dur - fade));
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    }

    node.connect(g);
    g.connect(dry);
    if (opts.send !== 0) {
      const s = ctx.createGain();
      s.gain.value = opts.send ?? 1;
      g.connect(s);
      s.connect(wet);
    }

    src.start(t, opts.offset || 0, dur ? dur + 0.05 : undefined);
    if (dur) src.stop(t + dur + 0.06);
    return src;
  }

  /* ---------------------------------------------------------------- *
   * Voices
   * ---------------------------------------------------------------- */

  /**
   * A creak. Real wood and rope recordings, entered at a random offset and at a
   * random pitch, so the same four files never read as four repeating sounds.
   */
  function creakGrain(intensity, amp = 1) {
    const buf = pick('creak');
    if (!buf) return;
    // Start somewhere in the middle of the file, where the creak is active,
    // rather than always at the (often silent) head.
    const offset = rand(0, Math.max(0, buf.duration - 0.5));
    play('creak', {
      buffer: buf,
      offset,
      duration: rand(0.14, 0.42),
      // Tighter, higher-pitched creaks as the limb loads up.
      rate: rand(0.7, 1.35) * lerp(0.85, 1.25, intensity),
      gain: rand(0.25, 0.6) * amp * lerp(0.5, 1.15, intensity),
      filter: ['bandpass', lerp(420, 1100, intensity) * rand(0.75, 1.3), 1.4],
      fadeOut: 0.1,
      send: 0.6,
    });
  }

  /**
   * The bow's pluck: one low plucked piano string, and nothing else layered on
   * it. A long steel string under high tension over a wooden soundboard is about
   * as close as a recorded instrument gets to what a heavy bowstring does.
   *
   * There's a single sample here, so all the variation has to come from how it's
   * played. Pull harder and it sounds higher, louder, longer and brighter — the
   * pitch tracks the displacement rather than wandering at random, so the string
   * reads as one object responding to you.
   */
  function pluck(strength = 0.5) {
    const s = clamp(strength, 0, 1);
    play('pluck', {
      rate: lerp(0.78, 1.18, s) * rand(0.99, 1.01),
      gain: lerp(0.30, 1.0, s),
      duration: lerp(1.8, 4.4, s),
      fadeOut: 1.0,
      filter: ['lowpass', lerp(2200, 7200, s), 0.7],
      send: 0.85,
    });
  }

  /** The slip-back when the rhythm falters: a duller, choked pluck. */
  function slip(intensity = 0.5) {
    play('pluck', {
      rate: rand(0.54, 0.68),
      gain: 0.32 + intensity * 0.26,
      duration: 0.6,
      fadeOut: 0.32,
      filter: ['lowpass', 1300, 0.8],
      send: 0.7,
    });
    creakGrain(0.8, 0.9);
  }

  /**
   * The three bronze notes of the motif, struck as the draw deepens. Ascending
   * playback rates on real gong recordings — the film used 35 gongs of differing
   * sizes for exactly this kind of pitched bronze.
   */
  /* ---- the three notes -------------------------------------------------
   * Real piano recordings, one file per note, from a single chromatic set:
   * measured at F4 352.25 Hz, A4 443.75 Hz and C5 527.75 Hz — all a consistent
   * +0.15 semitones, so they're in tune with each other.
   *
   * Because each key owns its own recording, nothing is transposed and there
   * are no resampling artefacts. That's the whole reason for grabbing three
   * separate notes instead of pitch-shifting one.
   *
   * Together they spell an F major triad: root, major third, perfect fifth.
   * ---------------------------------------------------------------------- */
  /* Which recording each key sounds, and at what rate. Keeping this as an
   * explicit table means shifting the whole set up or down is a one-line edit
   * rather than a hunt through playback rates.
   *
   * Slot order in the manifest is [piano-f, piano-a, piano-c] = F4, A4, C5.
   * Rate 0.5 drops a recording a clean octave, which on a real sample is a far
   * better result than resampling by an awkward interval. */
  const NOTES = [
    { index: 2, rate: 0.5 },   // A key -> C4, the C below the root
    { index: 0, rate: 1.0 },   // S key -> F4
    { index: 1, rate: 1.0 },   // D key -> A4
  ];

  /**
   * Sound one note. Bound to A / S / D, and struck automatically as the draw
   * crosses each mark.
   */
  function motifNote(i) {
    const n = NOTES[clamp(i, 0, NOTES.length - 1)];
    play('note', {
      index: n.index,
      rate: n.rate,
      gain: 0.66,
      // An octave down stretches the sample, so give it room to ring out.
      duration: 2.6 / n.rate,
      fadeOut: 1.1,
      // Takes the top off so a modern piano sits inside a stone hall.
      filter: ['lowpass', 4600, 0.7],
      send: 1.0,
    });
  }

  /**
   * A bronze swell as the draw deepens. Gongs, not piano: the three tiles belong
   * to the player, and having the draw play them made the instrument feel like
   * it was being taken away mid-phrase.
   *
   * Gongs are inharmonic, so these are pitch *shifts* for weight and rising
   * tension rather than notes — no attempt to be in tune with anything.
   */
  function drawSwell(step) {
    const rate = [0.42, 0.50, 0.60][clamp(step, 0, 2)] * rand(0.98, 1.02);
    play('gong', {
      rate,
      gain: 0.20 + step * 0.05,
      duration: 3.6 - step * 0.4,
      fadeOut: 1.6,
      filter: ['lowpass', 900 + step * 350, 0.7],
      send: 1.0,
    });
  }

  /** The string seating into the nock: struck bronze plus a low gong swell. */
  function snapLock() {
    play('metal', { rate: rand(0.86, 1.0), gain: 0.55, duration: 1.1, fadeOut: 0.5, send: 0.9 });
    play('gong', { rate: 0.52, gain: 0.42, duration: 4.0, fadeOut: 1.8, delay: 0.03,
                   filter: ['lowpass', 2200, 0.7], send: 1.0 });
    // The newly-braced string answers, quietly.
    setTimeout(() => pluck(0.22), 140);
  }

  /**
   * The shot. The real bow-release recording carries the transient; the bow's
   * own string lands the motif's fourth and final note — the cutting one,
   * played by the bow, exactly as in the film.
   */
  function release() {
    // The hero layer is a single real recording of a bow being loosed with the
    // arrow crossing the stereo field, trimmed to start just before its
    // transient. Nothing synthesized gets close to the crack of an actual
    // bowstring, so everything else here sits underneath it.
    const hero = play('bowshot', { rate: rand(0.97, 1.03), gain: 0.95, send: 0.55 });
    if (!hero) {
      // Fallback if that clip is missing.
      play('release', { rate: rand(0.92, 1.06), gain: 0.85, send: 0.8 });
      play('whoosh', { rate: rand(0.88, 1.05), gain: 0.5, delay: 0.03, send: 0.9 });
    }
    // Bronze underneath, for weight.
    play('gong', { rate: 0.46, gain: 0.34, duration: 3.4, fadeOut: 1.6,
                   filter: ['lowpass', 1500, 0.7], send: 1.0 });
    // The motif's fourth and final note — the cutting one, played by the bow.
    // Same string as the pluck, pitched up, so the bow has one voice throughout.
    // The fourth note: an octave above the triad's root, which is the resolution
    // the first three have been leaning toward.
    // The fourth note: the root again, an octave up — the resolution the first
    // three have been leaning toward.
    // Deliberately no piano here. The three tiles are the player's instrument;
    // having the shot sound one of them made the piece play over the top of
    // whoever was at the keys. The bronze below carries the moment instead.
    setTimeout(() => play('metal', {
      rate: rand(0.62, 0.74), gain: 0.30, duration: 1.8, fadeOut: 0.9,
      filter: ['lowpass', 2600, 0.7], send: 1.0,
    }), 80);
  }

  /** The arrow burying itself in the timber at the end of the hall. */
  function impact() {
    play('impact', { rate: rand(0.9, 1.08), gain: 0.8, send: 1.0 });
    play('metal', { rate: rand(0.5, 0.62), gain: 0.22, duration: 1.6, fadeOut: 0.8,
                    filter: ['lowpass', 1200, 0.7], delay: 0.01, send: 1.0 });
  }

  /** Drawing the bow — the real "bow drawn" recording, once, at draw onset. */
  function drawOnset() {
    play('bowdraw', { rate: rand(0.9, 1.05), gain: 0.5, filter: ['highpass', 160, 0.7], send: 0.7 });
  }

  /* ---------------------------------------------------------------- *
   * Continuous state
   * ---------------------------------------------------------------- */

  let scrapeUntil = 0;
  /** Finger dragging across the string while a pluck is held. */
  function setScrape(intensity, displacement) {
    if (!ready || intensity < 0.12) return;
    // Rate-limited creak grains stand in for the finger on the string.
    const now = ctx.currentTime;
    if (now < scrapeUntil) return;
    scrapeUntil = now + lerp(0.12, 0.045, clamp(intensity, 0, 1));
    play('creak', {
      offset: rand(0, 1.0),
      duration: rand(0.05, 0.13),
      rate: rand(1.6, 2.6),
      gain: clamp(intensity, 0, 1) * 0.16,
      filter: ['bandpass', lerp(1400, 3400, clamp(displacement, 0, 1)), 2.0],
      fadeOut: 0.04,
      send: 0.4,
    });
  }

  /**
   * @param dt        seconds since last frame
   * @param s.tension 0..1 stringing progress
   * @param s.draw    0..1 draw
   * @param s.rate    current taps/sec
   * @param s.held    true at full draw — everything drops away for the held breath
   * @param s.camDist camera distance, which opens up the hall reverb
   */
  function update(dt, s) {
    if (!ready) return;
    const t = ctx.currentTime;

    // Creak density follows how hard the player is working.
    creakRate = lerp(creakRate, s.rate * 1.9 * (0.4 + s.tension), clamp(dt * 6, 0, 1));
    if (!s.strung && creakRate > 0.1) {
      creakTimer -= dt;
      if (creakTimer <= 0) {
        creakGrain(s.tension);
        creakTimer = 1 / clamp(creakRate, 0.5, 16);
      }
    }
    // A heavy bow complains as it's drawn, too — just more slowly.
    if (s.strung && s.draw > 0.12 && !s.held) {
      creakTimer -= dt;
      if (creakTimer <= 0) {
        creakGrain(s.draw * 0.85, 0.5);
        creakTimer = lerp(0.6, 0.2, s.draw);
      }
    }

    // The load bed: rises with tension while bracing and with draw once strung.
    // At full draw it drops to nothing — the held breath is silence.
    const load = s.strung ? s.draw : s.tension;
    const duck = s.held ? 0.05 : 1;
    bedGain.gain.setTargetAtTime(Math.pow(load, 1.4) * 0.30 * duck, t, 0.12);
    bedFilter.frequency.setTargetAtTime(lerp(120, 420, load), t, 0.15);
    if (bedSource) bedSource.playbackRate.setTargetAtTime(lerp(0.26, 0.46, load), t, 0.2);

    // As the camera pulls back, the hall opens up around you.
    const wetness = clamp((s.camDist - 1.6) / 5.0, 0, 1);
    wet.gain.setTargetAtTime(lerp(0.14, 0.66, wetness), t, 0.25);
    dry.gain.setTargetAtTime(lerp(1.0, 0.7, wetness), t, 0.25);
  }

  function setMasterGain(v) {
    volume = clamp(v, 0, 1);
    if (ready && !muted) master.gain.setTargetAtTime(volume, ctx.currentTime, 0.2);
  }

  function setMuted(v) {
    muted = !!v;
    if (ready) master.gain.setTargetAtTime(muted ? 0 : volume, ctx.currentTime, 0.12);
    return muted;
  }

  // Warm the network up immediately; decoding waits for the first gesture.
  prefetch();

  return {
    unlock,
    update,
    creakGrain,
    pluck,
    slip,
    motifNote,
    snapLock,
    drawSwell,
    release,
    impact,
    drawOnset,
    setScrape,
    startFire,
    setFireLevel,
    setMasterGain,
    setMuted,
    toggleMute: () => setMuted(!muted),
    get isMuted() { return muted; },
    get isReady() { return ready; },
    get context() { return ctx; },
  };
}
