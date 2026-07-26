/**
 * main.js — state machine, camera rig, and the frame loop.
 *
 * The whole experience is two beats:
 *   1. String the bow, by holding a tapping rhythm inside a target cadence.
 *   2. Draw it, with a zoom-out gesture that pulls the camera back as it bends
 *      the limbs, then let go.
 */

import * as THREE from 'three';
import { buildTextureLibrary } from './textures.js';
import { createRenderer, createCamera, createScene, HALL } from './scene.js';
import { createBow } from './bow.js';
import { createDust } from './dust.js';
import { createPost } from './post.js';
import { createAudio } from './audio.js';
import { createTapTracker, createZoomGesture } from './input.js';
import { createHUD } from './hud.js';

/* ------------------------------------------------------------------ *
 * Tuning
 * ------------------------------------------------------------------ */

const TUNE = {
  // Cadence, in taps/sec, that fills the tension meter.
  rateLo: 3.8,
  rateHi: 10.0,
  rateFloor: 2.0,       // below this, tension bleeds away

  slipAfterMs: 640,     // silence this long and the string slips back
  slipAmount: 0.15,
  slipCooldown: 0.7,

  drawSensitivity: 0.85,
  drawDecay: 0.30,      // per second while no gesture is arriving
  drawSmooth: 7.5,
  holdThreshold: 0.97,
  minReleaseDraw: 0.35,

  /* Camera framing, close (undrawn) to wide (full draw).
   *
   * The bow is ~1.67 m tip to tip. At the close framing that has to fit inside
   * the letterboxed frame with room left for the HUD, so the radius is set from
   * that: 2*r*tan(fov/2) is the visible height, and the bow should occupy about
   * three quarters of it. The look-at sits slightly below the grip, which lifts
   * the bow off the bottom of the frame where the meter lives.
   *
   * The direction swings too: close in, it's nearly side-on so the recurve
   * profile reads; pulling back it rotates behind the bow to look down the hall.
   */
  camNear: {
    radius: 3.40,
    target: new THREE.Vector3(0, -0.08, 0.06),
    fov: 36,
    dir: new THREE.Vector3(0.76, 0.15, 0.63).normalize(),
  },
  camFar: {
    radius: 7.00,
    target: new THREE.Vector3(0, -0.05, -2.30),
    fov: 44,
    dir: new THREE.Vector3(0.34, 0.17, 0.92).normalize(),
  },

  pluckGrabPx: 46,      // screen-space radius for grabbing the string

  arrowSpeed: 82,       // m/s
  // Real gravity would drop the shaft more than half a metre over the length of
  // the hall, and the whole point of the contest is that it threads twelve
  // sockets. Dialled down so the arc still reads without breaking the shot.
  arrowGravity: 2.6,
};

const State = {
  TITLE: 'title',
  STRINGING: 'stringing',
  SEATING: 'seating',
  STRUNG: 'strung',
  DRAWING: 'drawing',
  HELD: 'held',
  RELEASING: 'releasing',
};

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

const canvas = document.getElementById('scene');
const renderer = createRenderer(canvas);
const camera = createCamera();

const textures = buildTextureLibrary();
const world = createScene(renderer, textures);
const scene = world.scene;

const bow = createBow(textures);
scene.add(bow.group);

const dust = createDust(textures.mote, world.sunDir, { count: 340, origin: world.dustOrigin });
scene.add(dust.mesh);

const post = createPost(renderer, scene, camera);
const audio = createAudio();
const hud = createHUD();

const taps = createTapTracker();
// Grabbing the string plucks it; dragging anywhere else draws the bow.
const zoom = createZoomGesture(canvas, {
  allowDrag: (e) => !canGrabString(e.clientX, e.clientY),
});

console.info(
  `[bow] string length ${bow.stats.stringLength.toFixed(3)} m, ` +
  `braced tip (y ${bow.stats.bracedTipY.toFixed(3)}, z ${bow.stats.bracedTipZ.toFixed(3)}), ` +
  `brace height ${bow.stats.braceHeight.toFixed(3)} m`
);

/* ------------------------------------------------------------------ *
 * Runtime state
 * ------------------------------------------------------------------ */

const sim = {
  state: State.TITLE,
  tension: 0,
  drawRaw: 0,
  draw: 0,
  slipTimer: 0,
  stateTime: 0,
  shake: 0,
  camBlend: 0,        // 0 = close framing, 1 = wide
  arrow: null,        // in-flight arrow, once released
  motifIndex: 0,      // how many bronze notes of the motif have struck
};

const _v = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _camTarget = new THREE.Vector3();

function setState(next) {
  sim.state = next;
  sim.stateTime = 0;
}

/* ------------------------------------------------------------------ *
 * Stringing
 * ------------------------------------------------------------------ */

/** How fast tension builds at a given cadence. Negative means it's bleeding. */
function tensionGain(rate) {
  if (rate < TUNE.rateFloor) {
    return -0.22 - (TUNE.rateFloor - rate) * 0.10;
  }
  if (rate < TUNE.rateLo) {
    const t = (rate - TUNE.rateFloor) / (TUNE.rateLo - TUNE.rateFloor);
    return -0.06 + t * 0.46;
  }
  if (rate <= TUNE.rateHi) return 0.42;
  // Mashing isn't rhythm. Past the top of the band the returns fall away.
  return Math.max(0.06, 0.42 - (rate - TUNE.rateHi) * 0.10);
}

/** 0..1 measure of how well the cadence sits inside the target band. */
function bandQuality(rate) {
  if (rate <= 0) return 0;
  const mid = (TUNE.rateLo + TUNE.rateHi) / 2;
  const half = (TUNE.rateHi - TUNE.rateLo) / 2;
  return Math.max(0, 1 - Math.abs(rate - mid) / (half * 2.1));
}

taps.onTap(() => {
  if (sim.state !== State.STRINGING) return;
  hud.pulsePip();
  // Each heave on the string sets the slack swinging.
  bow.nudgeString((Math.random() - 0.5) * 0.09 + 0.05);
});

function updateStringing(dt) {
  const rate = taps.update();
  const gain = tensionGain(rate);

  sim.tension += gain * dt;

  // Going quiet costs more the longer it lasts.
  const idle = taps.msSinceTap;
  if (idle > TUNE.slipAfterMs) {
    sim.tension -= (0.22 + (idle - TUNE.slipAfterMs) / 1400) * dt;
  }

  sim.tension = Math.max(0, Math.min(1, sim.tension));

  // Slip: lose the rhythm and the string works its way back down the limb.
  sim.slipTimer -= dt;
  if (idle > TUNE.slipAfterMs && sim.tension > 0.12 && sim.slipTimer <= 0) {
    sim.tension = Math.max(0, sim.tension - TUNE.slipAmount);
    sim.slipTimer = TUNE.slipCooldown;
    audio.slip(sim.tension);
    bow.nudgeString(0.26);
    hud.flash(0.05);
  }

  bow.state.tension = sim.tension;
  hud.setMeter('Tension', sim.tension);
  hud.setPipQuality(bandQuality(rate));

  if (sim.tension >= 1) seatString();
}

/** The string drops into the nock groove and the bow holds its brace. */
function seatString() {
  if (sim.state !== State.STRINGING) return;
  sim.tension = 1;
  bow.state.tension = 1;
  bow.setMode('strung');
  bow.state.draw = 0;
  audio.snapLock();
  hud.flash(0.16);
  post.setFocus(TUNE.camNear.radius, 0.00042);   // rack hard onto the bow
  setState(State.SEATING);
}

/* ------------------------------------------------------------------ *
 * Drawing
 * ------------------------------------------------------------------ */

/* The draw used to strike the piano notes as it crossed these marks. It fought
 * the A/S/D keys — the instrument should answer to the player, not play itself —
 * so the draw now sounds bronze instead, and the piano is yours alone. */
const MOTIF_MARKS = [0.25, 0.52, 0.79];

function updateDrawing(dt) {
  const delta = zoom.consume();
  const wasIdle = sim.draw < 0.02;
  sim.drawRaw += delta * TUNE.drawSensitivity;

  // Bleed off when nothing is arriving, so the draw has to be sustained.
  if (!zoom.isActive) sim.drawRaw -= TUNE.drawDecay * dt;
  sim.drawRaw = Math.max(0, Math.min(1, sim.drawRaw));

  sim.draw += (sim.drawRaw - sim.draw) * Math.min(1, dt * TUNE.drawSmooth);

  if (wasIdle && sim.draw >= 0.02) audio.drawOnset();

  // Deepen the bronze each time the draw crosses a mark. No piano here.
  while (sim.motifIndex < MOTIF_MARKS.length && sim.draw >= MOTIF_MARKS[sim.motifIndex]) {
    audio.drawSwell(sim.motifIndex);
    sim.motifIndex++;
  }
  // Relaxing back below a mark re-arms it.
  while (sim.motifIndex > 0 && sim.draw < MOTIF_MARKS[sim.motifIndex - 1] - 0.06) {
    sim.motifIndex--;
  }

  bow.state.draw = sim.draw;
  sim.camBlend = sim.draw;

  hud.setMeter('Draw', sim.draw);

  if (sim.draw >= TUNE.holdThreshold && sim.state === State.DRAWING) {
    setState(State.HELD);
  } else if (sim.draw < TUNE.holdThreshold - 0.05 && sim.state === State.HELD) {
    setState(State.DRAWING);
  }
}

function tryRelease() {
  if (sim.state !== State.DRAWING && sim.state !== State.HELD) return;
  if (sim.draw < TUNE.minReleaseDraw) return;
  fireArrow();
}

function fireArrow() {
  const origin = bow.getArrowOrigin(new THREE.Vector3()).clone();

  // Hand the arrow off from the bow group to the scene so it keeps flying while
  // the bow snaps back behind it.
  bow.unnockArrow();
  const arrow = bow.arrow;
  bow.group.remove(arrow);
  scene.add(arrow);
  arrow.position.copy(origin);
  arrow.visible = true;

  // Launch a touch nose-up so the (reduced) gravity brings it back onto the axis
  // right about where the axe heads are.
  const flightTime = Math.abs(HALL.axeTargetZ - origin.z) / TUNE.arrowSpeed;
  const vy = 0.5 * TUNE.arrowGravity * flightTime;

  sim.arrow = {
    mesh: arrow,
    vel: new THREE.Vector3(0, vy, -TUNE.arrowSpeed),
    t: 0,
    landed: false,
  };

  audio.release();
  post.triggerSmear(0.86);
  hud.flash(0.30);
  sim.shake = 1.0;
  sim.drawRaw = 0;
  sim.motifIndex = 0;
  setState(State.RELEASING);
}

function updateArrow(dt) {
  const a = sim.arrow;
  if (!a || a.landed) return;

  a.vel.y -= TUNE.arrowGravity * dt;
  a.mesh.position.addScaledVector(a.vel, dt);
  a.t += dt;

  // Point the shaft along its velocity — the nose-over is the detail that sells
  // it as a projectile rather than a sliding prop.
  _v.copy(a.vel).normalize();
  a.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), _v);

  if (a.mesh.position.z <= HALL.axeTargetZ) {
    a.landed = true;
    a.mesh.position.z = HALL.axeTargetZ;
    audio.impact();
  }
}

/* ------------------------------------------------------------------ *
 * Release recovery — the string springs forward past brace and rings down.
 * ------------------------------------------------------------------ */

function updateReleasing(dt) {
  // Critically-ish damped spring back to brace, allowed to overshoot slightly
  // past it so the string visibly snaps rather than merely returning.
  const k = 210, c = 15;
  sim.drawVel = (sim.drawVel || 0) + (-k * sim.draw - c * (sim.drawVel || 0)) * dt;
  sim.draw += sim.drawVel * dt;

  // A hard clamp keeps the solver inside the range where the string can actually
  // reach the tips; without it the bow briefly tries to be unstrung.
  sim.draw = Math.max(-0.05, sim.draw);
  bow.state.draw = sim.draw;

  sim.camBlend += (0 - sim.camBlend) * Math.min(1, dt * 6.5);
  hud.setMeter('Draw', Math.max(0, sim.draw));

  if (sim.stateTime > 2.6) {
    // Reset for another shot.
    sim.draw = 0;
    sim.drawVel = 0;
    sim.drawRaw = 0;
    bow.state.draw = 0;
    if (sim.arrow) {
      scene.remove(sim.arrow.mesh);
      bow.group.add(sim.arrow.mesh);
      sim.arrow = null;
    }
    bow.nockArrow();
    zoom.reset();
    setState(State.STRUNG);
  }
}

/* ------------------------------------------------------------------ *
 * Plucking the string
 *
 * Hit-testing happens in screen space against the two straight runs of the
 * string rather than by raycasting the mesh: the cable is 2.4 mm across, so a
 * ray test would demand pixel-perfect aim, and a few pixels of tolerance is what
 * makes it feel like you're grabbing something.
 * ------------------------------------------------------------------ */

const _s0 = new THREE.Vector3();
const _s1 = new THREE.Vector3();
const _s2 = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _off = new THREE.Vector3();

const pluck = { active: false, startX: 0, startY: 0, lastX: 0, lastY: 0, speed: 0 };

function worldToScreen(v, out) {
  out.copy(v).project(camera);
  out.x = (out.x * 0.5 + 0.5) * window.innerWidth;
  out.y = (-out.y * 0.5 + 0.5) * window.innerHeight;
  return out;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Is the bow in a state where the string can be played with? */
function canPluck() {
  return bow.state.mode === 'strung'
    && sim.draw < 0.06
    && (sim.state === State.STRUNG || sim.state === State.DRAWING);
}

function canGrabString(x, y) {
  if (!canPluck()) return false;
  worldToScreen(bow.getTipUpper(_v), _s0);
  worldToScreen(bow.getStringGrabPoint(_v), _s1);
  worldToScreen(bow.getTipLower(_v), _s2);
  const d = Math.min(
    distToSegment(x, y, _s0.x, _s0.y, _s1.x, _s1.y),
    distToSegment(x, y, _s1.x, _s1.y, _s2.x, _s2.y)
  );
  return d <= TUNE.pluckGrabPx;
}

/** Convert a pixel drag into a world offset on the plane facing the camera. */
function dragToWorld(dx, dy, out) {
  bow.getStringGrabPoint(_v);
  const dist = camera.position.distanceTo(_v);
  const perPx = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * dist) / window.innerHeight;
  camera.matrixWorld.extractBasis(_right, _up, _fwd);
  out.copy(_right).multiplyScalar(dx * perPx).addScaledVector(_up, -dy * perPx);
  // The string runs along Y, so sliding along its own axis would do nothing.
  out.y = 0;
  return out;
}

function loosePluck(magnitude) {
  // "The sound of the lyre being the pluck of Odysseus' bow" — Nolan's idea,
  // taken from Homer, who has Odysseus string the bow as easily as a musician
  // strings a lyre. Pull harder and it sounds a higher string.
  audio.pluck(Math.min(1, magnitude / 0.14));
}

function onPluckDown(e) {
  if (!canGrabString(e.clientX, e.clientY)) return;
  e.preventDefault();
  pluck.active = true;
  pluck.startX = pluck.lastX = e.clientX;
  pluck.startY = pluck.lastY = e.clientY;
  pluck.speed = 0;
  canvas.setPointerCapture?.(e.pointerId);
  bow.holdPluck(_off.set(0, 0, 0));
  audio.unlock();
  canvas.style.cursor = 'grabbing';
}

function onPluckMove(e) {
  if (!pluck.active) {
    // Hover affordance — otherwise nobody discovers this exists.
    if (canGrabString(e.clientX, e.clientY)) canvas.style.cursor = 'grab';
    else if (canvas.style.cursor === 'grab') canvas.style.cursor = '';
    return;
  }
  bow.holdPluck(dragToWorld(e.clientX - pluck.startX, e.clientY - pluck.startY, _off));

  const moved = Math.hypot(e.clientX - pluck.lastX, e.clientY - pluck.lastY);
  pluck.lastX = e.clientX;
  pluck.lastY = e.clientY;
  pluck.speed = pluck.speed * 0.7 + moved * 0.3;
  audio.setScrape(Math.min(1, pluck.speed / 14), bow.pluckAmount / 0.14);
}

function onPluckUp() {
  if (!pluck.active) return;
  pluck.active = false;
  canvas.style.cursor = '';
  audio.setScrape(0, 0);
  const magnitude = bow.releasePluck();
  if (magnitude > 0.004) loosePluck(magnitude);
}

/** Keyboard / button pluck, for when nobody finds the drag. */
function pluckImpulse(strength = 1) {
  if (!canPluck() || pluck.active) return;
  audio.unlock();
  bow.holdPluck(_off.set(0.085 * strength, 0, 0.03 * strength));
  setTimeout(() => {
    if (pluck.active) return;
    loosePluck(bow.releasePluck());
  }, 115);
}

canvas.addEventListener('pointerdown', onPluckDown);
window.addEventListener('pointermove', onPluckMove);
window.addEventListener('pointerup', onPluckUp);
window.addEventListener('pointercancel', onPluckUp);

/* ------------------------------------------------------------------ *
 * Camera
 * ------------------------------------------------------------------ */

const _camDir = new THREE.Vector3();

function updateCamera(dt, time) {
  const b = sim.camBlend;
  const radius = THREE.MathUtils.lerp(TUNE.camNear.radius, TUNE.camFar.radius, b);
  const fov = THREE.MathUtils.lerp(TUNE.camNear.fov, TUNE.camFar.fov, b);

  _camTarget.lerpVectors(TUNE.camNear.target, TUNE.camFar.target, b);
  _camDir.lerpVectors(TUNE.camNear.dir, TUNE.camFar.dir, b).normalize();
  _camPos.copy(_camDir).multiplyScalar(radius).add(_camTarget);

  // A very slow breath on the rig, so the frame is never dead still.
  _camPos.x += Math.sin(time * 0.21) * 0.011;
  _camPos.y += Math.sin(time * 0.17 + 1.3) * 0.009;

  if (sim.shake > 0) {
    sim.shake = Math.max(0, sim.shake - dt * 2.4);
    const s = sim.shake * sim.shake * 0.055;
    _camPos.x += (Math.sin(time * 71) + Math.sin(time * 113)) * s;
    _camPos.y += (Math.sin(time * 83 + 2) + Math.sin(time * 131)) * s;
    _camPos.z += Math.sin(time * 97 + 1) * s * 0.6;
  }

  camera.position.copy(_camPos);
  camera.lookAt(_camTarget);

  if (Math.abs(camera.fov - fov) > 0.001) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }

  // Keep the bow sharp; let the hall fall off behind it.
  post.setFocus(camera.position.distanceTo(_camTarget));
  hud.setWide(b);
}

/* ------------------------------------------------------------------ *
 * Prompts
 * ------------------------------------------------------------------ */

function updatePrompt() {
  switch (sim.state) {
    case State.STRINGING:
      hud.setPrompt(
        'Tap <span class="key">Space</span> — find the rhythm',
        'Steady and quick. Falter and the string slips back.'
      );
      break;
    case State.SEATING:
      hud.setPrompt('The string seats', '');
      break;
    case State.STRUNG:
      hud.setPrompt(
        'Scroll down, pinch out, or drag to draw',
        'Grab the string to pluck it · Hold at full draw, then release or press Enter'
      );
      break;
    case State.DRAWING:
      hud.setPrompt('', '');
      break;
    case State.HELD:
      hud.setPrompt('Loose', '');
      break;
    case State.RELEASING:
      hud.setPrompt('', '');
      break;
    default:
      hud.setPrompt('', '');
  }
}

/* ------------------------------------------------------------------ *
 * Loop
 * ------------------------------------------------------------------ */

const clock = new THREE.Clock();
let fpsAccum = 0, fpsFrames = 0, fps = 0;

function frame() {
  requestAnimationFrame(frame);

  const dt = Math.min(clock.getDelta(), 1 / 20);   // a tab-switch shouldn't teleport anything
  const time = clock.elapsedTime;
  sim.stateTime += dt;

  switch (sim.state) {
    case State.STRINGING: updateStringing(dt); break;
    case State.SEATING:
      hud.setMeter('Tension', 1);
      if (sim.stateTime > 1.15) {
        bow.nockArrow();
        post.setFocus(TUNE.camNear.radius, 0.00021);
        hud.showPips(false);
        setState(State.STRUNG);
      }
      break;
    case State.STRUNG:
    case State.DRAWING:
    case State.HELD:
      if (sim.state === State.STRUNG && sim.drawRaw > 0.002) setState(State.DRAWING);
      updateDrawing(dt);
      break;
    case State.RELEASING: updateReleasing(dt); break;
  }

  updateArrow(dt);
  bow.update(dt);
  updateCamera(dt, time);
  updatePrompt();

  dust.update(time);
  post.update(dt);
  hud.update(dt);

  audio.update(dt, {
    tension: sim.tension,
    draw: Math.max(0, sim.draw),
    rate: taps.rate,
    strung: bow.state.mode === 'strung',
    held: sim.state === State.HELD,
    camDist: camera.position.distanceTo(_camTarget),
  });

  post.composer.render(dt);

  fpsAccum += dt; fpsFrames++;
  if (fpsAccum >= 0.5) {
    fps = fpsFrames / fpsAccum;
    fpsAccum = 0; fpsFrames = 0;
    const info = renderer.info.render;
    hud.setStats(
      `${fps.toFixed(0)} fps\n` +
      `${info.calls} draw calls\n` +
      `${(info.triangles / 1000).toFixed(1)}k tris\n` +
      `state ${sim.state}\n` +
      `tension ${sim.tension.toFixed(2)}  draw ${sim.draw.toFixed(2)}\n` +
      `rate ${taps.rate.toFixed(1)}/s`
    );
  }
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

zoom.onRelease(tryRelease);

window.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    if (sim.state === State.TITLE) begin();
    else tryRelease();
  }
  // A/S/D sound the three bronze notes of the motif by hand, so the hall can be
  // played as an instrument rather than only reacting to the draw.
  const note = { a: 0, s: 1, d: 2 }[e.key.toLowerCase()];
  if (note !== undefined && !e.repeat && !e.metaKey && !e.ctrlKey) {
    playNote(note);
  }

  // Escape hatch: skip the rhythm game. Also how you test the draw in isolation.
  if (e.key === 'f' || e.key === 'F') seatString();
  if (e.key === '`') hud.toggleStats();
  if (e.key === 'r' || e.key === 'R') reset();
  if (e.key === 'p' || e.key === 'P') pluckImpulse();
  if (e.key === 'm' || e.key === 'M') toggleMute();
});

/** Sound a note and depress its tile, whatever triggered it. */
function playNote(i) {
  audio.unlock();
  audio.motifNote(i);
  hud.pressKey(i);
}

function toggleMute() {
  const m = audio.toggleMute();
  hud.el.btnMute.innerHTML = m ? '<b>M</b>Unmute' : '<b>M</b>Mute';
}

/** Back to an unstrung bow, from any state. */
function reset() {
  if (sim.state === State.TITLE) return;
  sim.tension = 0;
  sim.draw = 0;
  sim.drawRaw = 0;
  sim.drawVel = 0;
  sim.camBlend = 0;
  sim.shake = 0;
  sim.motifIndex = 0;
  bow.state.tension = 0;
  bow.state.draw = 0;
  bow.state.pluckHeld = false;
  bow.releasePluck();
  bow.setMode('unstrung');
  bow.hideArrow();
  if (sim.arrow) {
    scene.remove(sim.arrow.mesh);
    bow.group.add(sim.arrow.mesh);
    sim.arrow = null;
  }
  pluck.active = false;
  canvas.style.cursor = '';
  audio.setScrape(0, 0);
  taps.reset();
  zoom.reset();
  hud.showPips(true);
  hud.setMeter('Tension', 0, true);
  setState(State.STRINGING);
}

function begin() {
  if (sim.state !== State.TITLE) return;
  audio.unlock();          // must happen inside the gesture handler
  // The hearth carries over into the hall, just pulled well back so it reads as
  // room tone under the piece rather than competing with it.
  audio.setFireLevel(0.20, 2.4);
  hud.hideTitle();
  hud.showKeys(true);
  hud.showPips(true);
  hud.setMeter('Tension', 0, true);
  setState(State.STRINGING);
}

/* Autoplay policy means no sound before a gesture, so the hearth can't be
 * burning when the page first paints. The next best thing: light it on the
 * very first interaction of any kind. Click or press a key anywhere on the
 * title card and the fire comes up while the card is still on screen. */
function lightTheHearth() {
  if (!hud.titleVisible) return;
  audio.unlock();
  audio.startFire(0.55);
}
window.addEventListener('pointerdown', lightTheHearth, { once: true });
window.addEventListener('keydown', lightTheHearth, { once: true });

hud.el.begin.addEventListener('click', begin);
hud.el.btnRestart.addEventListener('click', reset);
hud.el.btnPluck.addEventListener('click', () => pluckImpulse());
// Clicking the notes button runs the figure as a phrase rather than one note.
hud.el.btnNotes.addEventListener('click', () => {
  [0, 1, 2].forEach((i) => setTimeout(() => playNote(i), i * 420));
});
hud.onKeyPress(playNote);
hud.el.btnMute.addEventListener('click', toggleMute);
hud.el.btnStats.addEventListener('click', () => hud.toggleStats());

window.addEventListener('resize', () => {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(w, h);
  post.setSize(w, h);
});

// Render from the start so the first frame after the title card is already warm.
bow.state.mode = 'unstrung';
frame();

// Debug probe, used by the headless test harness.
window.__dbg = () => ({
  state: sim.state, tension: +sim.tension.toFixed(3), draw: +sim.draw.toFixed(3),
  drawRaw: +sim.drawRaw.toFixed(3), rate: +taps.rate.toFixed(2),
  mode: bow.state.mode, zoomActive: zoom.isActive,
});
