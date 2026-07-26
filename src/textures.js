/**
 * textures.js — every PBR map in the scene is generated here, in code.
 *
 * The project ships no image files on purpose: no build step, no asset pipeline,
 * nothing to 404. Maps are written straight into Uint8Array buffers and handed to
 * THREE.DataTexture, which skips the canvas round-trip entirely.
 *
 * Normal maps are derived from the same height field that shaped the roughness,
 * so grain, wear and shading always agree with each other.
 */

import * as THREE from 'three';

/* ------------------------------------------------------------------ *
 * Tiling value noise
 * ------------------------------------------------------------------ */

// Integer hash on a lattice that wraps at `period`, which is what makes the
// resulting textures tile seamlessly.
function hash2(x, y, period, seed) {
  x = ((x % period) + period) % period;
  y = ((y % period) + period) % period;
  let h = Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(seed, 83492791);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function vnoise(x, y, period, seed) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2(x0,     y0,     period, seed);
  const b = hash2(x0 + 1, y0,     period, seed);
  const c = hash2(x0,     y0 + 1, period, seed);
  const d = hash2(x0 + 1, y0 + 1, period, seed);
  return (a * (1 - ux) + b * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy;
}

// Octave frequencies double, and so does the lattice period — otherwise the
// higher octaves would break the seam.
function fbm(x, y, octaves, period, seed) {
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * vnoise(x * freq, y * freq, period * freq, seed + i * 17);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

// Ridged noise — sharp creases. Good for cracked leather and stone pitting.
function ridged(x, y, octaves, period, seed) {
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(vnoise(x * freq, y * freq, period * freq, seed + i * 31) * 2 - 1);
    sum += amp * n * n;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;

/* ------------------------------------------------------------------ *
 * Texture assembly
 * ------------------------------------------------------------------ */

function makeTexture(data, size, srgb) {
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Sobel the height field into a tangent-space normal map.
 * Sampling wraps, so the normal map tiles exactly like its source.
 */
function normalFromHeight(height, size, strength) {
  const data = new Uint8Array(size * size * 4);
  const at = (x, y) => height[(((y % size) + size) % size) * size + (((x % size) + size) % size)];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
      const l  = at(x - 1, y),                       r  = at(x + 1, y);
      const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);

      const dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const dy = (bl + 2 * b + br) - (tl + 2 * t + tr);

      let nx = -dx * strength;
      let ny = -dy * strength;
      const nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv; ny *= inv;

      const i = (y * size + x) * 4;
      data[i]     = (nx * 0.5 + 0.5) * 255;
      data[i + 1] = (ny * 0.5 + 0.5) * 255;
      data[i + 2] = (nz * inv * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  return makeTexture(data, size, false);
}

function grayTexture(values, size) {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < values.length; i++) {
    const v = clamp01(values[i]) * 255;
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  return makeTexture(data, size, false);
}

function colorTexture(rgb, size) {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    data[i * 4]     = clamp01(rgb[i * 3]) * 255;
    data[i * 4 + 1] = clamp01(rgb[i * 3 + 1]) * 255;
    data[i * 4 + 2] = clamp01(rgb[i * 3 + 2]) * 255;
    data[i * 4 + 3] = 255;
  }
  return makeTexture(data, size, true);
}

/* ------------------------------------------------------------------ *
 * Olive wood — the riser and limb cores
 * ------------------------------------------------------------------ */

export function makeWood({ size = 512, seed = 7, repeat = [1, 1] } = {}) {
  const rgb = new Float32Array(size * size * 3);
  const rough = new Float32Array(size * size);
  const height = new Float32Array(size * size);

  // Olive is a light, tawny wood; the darker bands are the late growth rings.
  const light = [0.52, 0.415, 0.262];
  const dark  = [0.235, 0.166, 0.098];
  const sap   = [0.60, 0.50, 0.345];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;

      // Rings run along V (the limb's length) and get pushed around by turbulence
      // so they read as sawn timber rather than printed stripes.
      const warp = fbm(u * 4, v * 1.6, 4, 4, seed) - 0.5;
      const rings = Math.sin((u * 13.0 + warp * 5.4) * Math.PI * 2);
      let grain = Math.pow(Math.abs(rings), 0.42);

      // Fine longitudinal fibre, stretched hard along V.
      const fibre = fbm(u * 90, v * 5, 3, 90, seed + 3);
      grain = clamp01(grain * 0.76 + fibre * 0.24);

      // Sparse knots and figure — olive is famously wild.
      const figure = ridged(u * 3.1, v * 2.2, 3, 3, seed + 11);
      const knot = Math.pow(clamp01(figure - 0.42) / 0.58, 2.4);

      const t = clamp01(grain * 0.82 + knot * 0.55);
      const sapMix = clamp01(fbm(u * 2, v * 1.2, 2, 2, seed + 21) * 1.5 - 0.42);

      let r = lerp(dark[0], light[0], t);
      let g = lerp(dark[1], light[1], t);
      let b = lerp(dark[2], light[2], t);
      r = lerp(r, sap[0], sapMix * 0.4);
      g = lerp(g, sap[1], sapMix * 0.4);
      b = lerp(b, sap[2], sapMix * 0.4);

      // Handled-for-decades darkening: grime settles into the low spots.
      const grime = clamp01(fbm(u * 6, v * 3, 4, 6, seed + 33) * 1.35 - 0.3);
      const darken = 1 - grime * 0.34;
      r *= darken; g *= darken; b *= darken;

      const i = y * size + x;
      rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b;

      // Late wood is harder and takes a polish; early wood stays matte.
      rough[i] = clamp01(0.86 - t * 0.34 + grime * 0.16 - knot * 0.1);
      height[i] = grain * 0.72 + fibre * 0.2 + knot * 0.34;
    }
  }

  const map = colorTexture(rgb, size);
  const roughnessMap = grayTexture(rough, size);
  const normalMap = normalFromHeight(height, size, 2.4);
  for (const t of [map, roughnessMap, normalMap]) t.repeat.set(repeat[0], repeat[1]);
  return { map, roughnessMap, normalMap };
}

/* ------------------------------------------------------------------ *
 * Leather — the grip wrap
 * ------------------------------------------------------------------ */

export function makeLeather({ size = 256, seed = 41, repeat = [1, 1] } = {}) {
  const rgb = new Float32Array(size * size * 3);
  const rough = new Float32Array(size * size);
  const height = new Float32Array(size * size);

  const base = [0.150, 0.098, 0.062];
  const worn = [0.268, 0.183, 0.113];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;

      // Pebbled hide: ridged noise makes the raised cell walls between pores.
      const cells = ridged(u * 22, v * 22, 3, 22, seed);
      const pores = fbm(u * 64, v * 64, 2, 64, seed + 5);
      const creases = Math.pow(ridged(u * 7, v * 7, 2, 7, seed + 9), 2.6);

      const h = clamp01(cells * 0.62 + pores * 0.18 + creases * 0.4);

      // The high points are burnished by the shooting hand; hollows stay dark.
      const polish = clamp01((h - 0.45) / 0.55);
      let r = lerp(base[0], worn[0], polish);
      let g = lerp(base[1], worn[1], polish);
      let b = lerp(base[2], worn[2], polish);

      // Sweat-and-oil patches, irregular across the wrap.
      const oil = clamp01(fbm(u * 3.4, v * 3.4, 3, 3, seed + 13) * 1.4 - 0.35);
      r *= 1 - oil * 0.3; g *= 1 - oil * 0.32; b *= 1 - oil * 0.3;

      const i = y * size + x;
      rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b;
      rough[i] = clamp01(0.94 - polish * 0.3 - oil * 0.2);
      height[i] = h;
    }
  }

  const map = colorTexture(rgb, size);
  const roughnessMap = grayTexture(rough, size);
  const normalMap = normalFromHeight(height, size, 3.4);
  for (const t of [map, roughnessMap, normalMap]) t.repeat.set(repeat[0], repeat[1]);
  return { map, roughnessMap, normalMap };
}

/* ------------------------------------------------------------------ *
 * Bronze — end caps, collars, arrow point, the twelve axe heads
 * ------------------------------------------------------------------ */

export function makeBronze({ size = 256, seed = 77, repeat = [1, 1] } = {}) {
  const rgb = new Float32Array(size * size * 3);
  const rough = new Float32Array(size * size);
  const metal = new Float32Array(size * size);
  const height = new Float32Array(size * size);

  const clean  = [0.72, 0.52, 0.25];   // freshly burnished bronze
  const dull   = [0.40, 0.30, 0.16];   // tarnish
  const patina = [0.22, 0.40, 0.33];   // verdigris green

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;

      const blotch = fbm(u * 5, v * 5, 4, 5, seed);
      const fine = fbm(u * 40, v * 40, 3, 40, seed + 7);
      const pit = Math.pow(clamp01(ridged(u * 18, v * 18, 2, 18, seed + 15) - 0.5) / 0.5, 2.0);

      // Verdigris only takes hold in the blotchy low-lying areas.
      const green = clamp01((blotch - 0.52) / 0.48) * clamp01(fbm(u * 11, v * 11, 2, 11, seed + 23) * 1.6 - 0.3);
      const tarnish = clamp01(blotch * 0.8 + fine * 0.35 - 0.15);

      let r = lerp(clean[0], dull[0], tarnish);
      let g = lerp(clean[1], dull[1], tarnish);
      let b = lerp(clean[2], dull[2], tarnish);
      r = lerp(r, patina[0], green * 0.85);
      g = lerp(g, patina[1], green * 0.85);
      b = lerp(b, patina[2], green * 0.85);

      const i = y * size + x;
      rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b;

      // Corroded bronze scatters; where it's still bright it reflects sharply.
      rough[i] = clamp01(0.22 + tarnish * 0.42 + green * 0.35 + pit * 0.3);
      // Patina is a mineral crust, not metal — drop metalness where it's green.
      metal[i] = clamp01(1 - green * 0.8 - pit * 0.25);
      height[i] = clamp01(green * 0.5 + pit * 0.6 + fine * 0.25);
    }
  }

  const map = colorTexture(rgb, size);
  const roughnessMap = grayTexture(rough, size);
  const metalnessMap = grayTexture(metal, size);
  const normalMap = normalFromHeight(height, size, 2.0);
  for (const t of [map, roughnessMap, metalnessMap, normalMap]) t.repeat.set(repeat[0], repeat[1]);
  return { map, roughnessMap, metalnessMap, normalMap };
}

/* ------------------------------------------------------------------ *
 * Sinew — the backing glued along the limb's back
 * ------------------------------------------------------------------ */

export function makeSinew({ size = 256, seed = 91, repeat = [1, 1] } = {}) {
  const rgb = new Float32Array(size * size * 3);
  const rough = new Float32Array(size * size);
  const height = new Float32Array(size * size);

  const pale = [0.60, 0.545, 0.425];
  const glue = [0.36, 0.28, 0.175];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;

      // Fibres run the length of the limb: high frequency across U, stretched along V.
      const fibre = ridged(u * 110, v * 3, 2, 110, seed);
      const bundle = fbm(u * 14, v * 2, 3, 14, seed + 4);
      const hide = fbm(u * 6, v * 6, 3, 6, seed + 8);

      const h = clamp01(fibre * 0.6 + bundle * 0.3);
      const glueMix = clamp01(hide * 1.3 - 0.35);

      let r = lerp(pale[0], glue[0], glueMix);
      let g = lerp(pale[1], glue[1], glueMix);
      let b = lerp(pale[2], glue[2], glueMix);

      const i = y * size + x;
      rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b;
      // Dried hide glue goes slightly glassy where it pooled.
      rough[i] = clamp01(0.82 - glueMix * 0.34 + fibre * 0.1);
      height[i] = h;
    }
  }

  const map = colorTexture(rgb, size);
  const roughnessMap = grayTexture(rough, size);
  const normalMap = normalFromHeight(height, size, 3.0);
  for (const t of [map, roughnessMap, normalMap]) t.repeat.set(repeat[0], repeat[1]);
  return { map, roughnessMap, normalMap };
}

/* ------------------------------------------------------------------ *
 * Horn — the recurved tips
 * ------------------------------------------------------------------ */

export function makeHorn({ size = 256, seed = 55, repeat = [1, 1] } = {}) {
  const rgb = new Float32Array(size * size * 3);
  const rough = new Float32Array(size * size);
  const height = new Float32Array(size * size);

  const lightHorn = [0.30, 0.245, 0.185];
  const darkHorn  = [0.075, 0.058, 0.048];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;

      // Horn grows in translucent layered streaks along its length.
      const warp = fbm(u * 3, v * 2, 3, 3, seed) - 0.5;
      const streak = fbm(u * 5 + warp * 2, v * 26, 4, 26, seed + 6);
      const scratch = ridged(u * 50, v * 8, 2, 50, seed + 12);

      const t = clamp01(streak * 1.25 - 0.1);
      let r = lerp(darkHorn[0], lightHorn[0], t);
      let g = lerp(darkHorn[1], lightHorn[1], t);
      let b = lerp(darkHorn[2], lightHorn[2], t);

      const i = y * size + x;
      rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b;
      // Polished horn is smooth; the scratches from decades of stringing are not.
      rough[i] = clamp01(0.2 + scratch * 0.35 + (1 - t) * 0.12);
      height[i] = clamp01(streak * 0.4 + scratch * 0.5);
    }
  }

  const map = colorTexture(rgb, size);
  const roughnessMap = grayTexture(rough, size);
  const normalMap = normalFromHeight(height, size, 1.6);
  for (const t of [map, roughnessMap, normalMap]) t.repeat.set(repeat[0], repeat[1]);
  return { map, roughnessMap, normalMap };
}

/* ------------------------------------------------------------------ *
 * Stone — floor, walls, pillars of the megaron
 * ------------------------------------------------------------------ */

export function makeStone({ size = 512, seed = 137, repeat = [1, 1] } = {}) {
  const rgb = new Float32Array(size * size * 3);
  const rough = new Float32Array(size * size);
  const height = new Float32Array(size * size);

  const pale = [0.255, 0.238, 0.208];
  const grey = [0.128, 0.121, 0.110];
  const soot = [0.052, 0.047, 0.045];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;

      const grit = fbm(u * 48, v * 48, 4, 48, seed);
      const mottle = fbm(u * 6, v * 6, 4, 6, seed + 3);
      const cracks = Math.pow(clamp01(ridged(u * 9, v * 9, 3, 9, seed + 17) - 0.62) / 0.38, 1.6);

      // Block courses. Every other row is offset, like real ashlar.
      const rows = 4;
      const rowF = v * rows;
      const row = Math.floor(rowF);
      const cols = 4;
      const colF = u * cols + (row % 2) * 0.5;
      const mortarV = Math.min(rowF - row, 1 - (rowF - row));
      const mortarU = Math.min(colF - Math.floor(colF), 1 - (colF - Math.floor(colF)));
      const joint = clamp01(1 - Math.min(mortarV, mortarU) / 0.035);

      const t = clamp01(mottle * 0.75 + grit * 0.3);
      let r = lerp(grey[0], pale[0], t);
      let g = lerp(grey[1], pale[1], t);
      let b = lerp(grey[2], pale[2], t);

      // Recessed mortar, then centuries of hearth smoke over the top.
      r = lerp(r, grey[0] * 0.55, joint);
      g = lerp(g, grey[1] * 0.55, joint);
      b = lerp(b, grey[2] * 0.55, joint);

      const smoke = clamp01(fbm(u * 2.2, v * 1.4, 3, 2, seed + 29) * 1.5 - 0.42);
      r = lerp(r, soot[0], smoke * 0.6);
      g = lerp(g, soot[1], smoke * 0.6);
      b = lerp(b, soot[2], smoke * 0.6);

      const i = y * size + x;
      rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b;
      rough[i] = clamp01(0.88 + grit * 0.1 - smoke * 0.06);
      height[i] = clamp01(grit * 0.3 + mottle * 0.25 + cracks * 0.4) * (1 - joint * 0.8);
    }
  }

  const map = colorTexture(rgb, size);
  const roughnessMap = grayTexture(rough, size);
  const normalMap = normalFromHeight(height, size, 2.2);
  for (const t of [map, roughnessMap, normalMap]) t.repeat.set(repeat[0], repeat[1]);
  return { map, roughnessMap, normalMap };
}

/* ------------------------------------------------------------------ *
 * Soft radial sprite for the dust motes
 * ------------------------------------------------------------------ */

export function makeMoteSprite(size = 64) {
  const data = new Uint8Array(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c) / c;
      // Smooth falloff, squared so the core stays tight and the edge vanishes.
      const a = Math.pow(clamp01(1 - d), 2.2);
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = a * 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Build every map once and hand back a shared library. Called at boot; the
 * whole set costs a few milliseconds and is reused by every material.
 */
export function buildTextureLibrary() {
  return {
    wood:    makeWood({ size: 512, seed: 7,   repeat: [1, 1] }),
    riserWood: makeWood({ size: 512, seed: 19, repeat: [1, 2] }),
    leather: makeLeather({ size: 256, seed: 41, repeat: [2, 6] }),
    bronze:  makeBronze({ size: 256, seed: 77, repeat: [1, 1] }),
    sinew:   makeSinew({ size: 256, seed: 91, repeat: [1, 1] }),
    horn:    makeHorn({ size: 256, seed: 55, repeat: [1, 1] }),
    stone:   makeStone({ size: 512, seed: 137, repeat: [1, 1] }),
    mote:    makeMoteSprite(64),
  };
}
