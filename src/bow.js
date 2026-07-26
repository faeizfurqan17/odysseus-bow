/**
 * bow.js — the bow itself: procedural geometry, the bone rig that bends it,
 * and the string solver that keeps limb bend and string travel physically coupled.
 *
 * Geometry is swept, not primitive-based. A bow limb is wide across the face and
 * thin front-to-back, and it tapers — a constant-radius tube can't express any of
 * that, so every part here is built by sweeping a tapering superellipse profile
 * along a spine curve.
 *
 * Coordinate system (metres):
 *   +Y  up, along the limbs
 *   +Z  toward the archer  (the string draws this way)
 *   -Z  downrange          (the arrow flies this way)
 *   +X  across the bow's face
 */

import * as THREE from 'three';

/* ------------------------------------------------------------------ *
 * Tuning constants — everything you'd want to feel out lives here.
 * ------------------------------------------------------------------ */

export const BOW = {
  // Spine of the upper limb as [y, z] pairs: a deflex-reflex recurve that
  // sweeps away from the archer through the mid-limb, then curls back at the tip.
  limbSpine: [
    [0.120,  0.0475],
    [0.260,  0.0180],
    [0.390, -0.0320],
    [0.510, -0.0780],
    [0.620, -0.0880],
    [0.710, -0.0380],
    [0.775,  0.0480],
  ],
  // Riser spine — the ends deliberately land on the limb path so the join hides.
  riserSpine: [
    [-0.215, 0.0265],
    [-0.130, 0.0540],
    [ 0.000, 0.0720],
    [ 0.130, 0.0540],
    [ 0.215, 0.0265],
  ],

  limbSamples: 56,
  limbSides: 14,
  boneCount: 9,          // 8 rotate; the 9th is the tip marker the string hangs off

  // How the total bend is distributed inner-limb -> outer-limb. Front-loaded,
  // because on a recurve the working limb near the fade does most of the bending
  // while the recurved tip mostly unrolls. Bone 0 is pinned so the limb never
  // pokes out through the riser it's socketed into.
  bendProfile: [0, 0.13, 0.20, 0.20, 0.17, 0.14, 0.10, 0.06],

  braceAngle: 0.42,      // radians of total limb bend once strung
  fullDrawAngle: 1.06,   // ...and at full draw
  braceHeight: 0.190,    // string-to-riser distance when braced (metres)

  arrowLength: 0.82,
};

/* ------------------------------------------------------------------ *
 * Sweep machinery
 * ------------------------------------------------------------------ */

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();

/** Sample a Catmull-Rom through [y, z] pairs into evenly-spaced Vector3s. */
function sampleSpine(pairs, count, mirrorY = false) {
  const pts = pairs.map(([y, z]) => new THREE.Vector3(0, mirrorY ? -y : y, z));
  const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5);
  return curve.getSpacedPoints(count - 1);
}

/**
 * Sweep a tapering superellipse along a polyline.
 *
 * The spine is planar (it lives in YZ), so instead of Frenet frames — which flip
 * at inflection points, and this curve has one — the frame is built explicitly:
 * X is always the wide axis, and the thin axis falls out of the cross product.
 * That's exact, and guarantees zero twist along the limb.
 *
 * `profile(s)` returns { w, h }: half-width across X, half-thickness across the
 * bending axis, at arc-length fraction s.
 */
function sweep({ pts, profile, sides = 12, exponent = 3.4, uv = [1, 1], capStart = false, capEnd = false }) {
  const n = pts.length;

  // Arc-length fraction per ring.
  const dist = [0];
  for (let i = 1; i < n; i++) dist[i] = dist[i - 1] + pts[i].distanceTo(pts[i - 1]);
  const total = dist[n - 1];
  const sArr = dist.map((d) => d / total);

  // Cross-section shape, precomputed once.
  const shape = [];
  const e = 2 / exponent;
  for (let k = 0; k <= sides; k++) {
    const th = (k / sides) * Math.PI * 2;
    const c = Math.cos(th), s = Math.sin(th);
    shape.push([
      Math.sign(c) * Math.pow(Math.abs(c), e),
      Math.sign(s) * Math.pow(Math.abs(s), e),
    ]);
  }

  const position = [];
  const uvs = [];
  const vertS = [];        // arc fraction per vertex, used to build skin weights
  const centers = [];
  const tangents = [];

  const wide = new THREE.Vector3(1, 0, 0);
  const thin = new THREE.Vector3();
  const tan = new THREE.Vector3();

  for (let i = 0; i < n; i++) {
    // Central difference for the tangent; matches the polyline we actually built.
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(n - 1, i + 1)];
    tan.subVectors(next, prev).normalize();
    thin.crossVectors(tan, wide).normalize();

    centers.push(pts[i].clone());
    tangents.push(tan.clone());

    const { w, h } = profile(sArr[i]);
    for (let k = 0; k <= sides; k++) {
      const [sx, sy] = shape[k];
      _v1.copy(pts[i])
        .addScaledVector(wide, w * sx)
        .addScaledVector(thin, h * sy);
      position.push(_v1.x, _v1.y, _v1.z);
      uvs.push((k / sides) * uv[0], sArr[i] * uv[1]);
      vertS.push(sArr[i]);
    }
  }

  const index = [];
  const ring = sides + 1;
  for (let i = 0; i < n - 1; i++) {
    for (let k = 0; k < sides; k++) {
      const a = i * ring + k;
      const b = a + 1;
      const c = a + ring;
      const d = c + 1;
      index.push(a, c, b, b, c, d);
    }
  }

  // Caps close the ends so you never see inside a limb.
  const addCap = (ringIdx, flip) => {
    const base = position.length / 3;
    const c = centers[ringIdx];
    position.push(c.x, c.y, c.z);
    uvs.push(0.5, sArr[ringIdx] * uv[1]);
    vertS.push(sArr[ringIdx]);
    for (let k = 0; k < sides; k++) {
      const a = ringIdx * ring + k;
      const b = ringIdx * ring + k + 1;
      if (flip) index.push(base, b, a);
      else index.push(base, a, b);
    }
  };
  if (capStart) addCap(0, true);
  if (capEnd) addCap(n - 1, false);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(index);
  geo.computeVertexNormals();

  // The UV seam duplicates a column of vertices; averaging leaves each copy with
  // a slightly different normal and a visible hairline. Force them to agree.
  const nrm = geo.attributes.normal;
  for (let i = 0; i < n; i++) {
    const a = i * ring;
    const b = a + sides;
    _v1.set(nrm.getX(a), nrm.getY(a), nrm.getZ(a));
    _v2.set(nrm.getX(b), nrm.getY(b), nrm.getZ(b));
    _v1.add(_v2).normalize();
    nrm.setXYZ(a, _v1.x, _v1.y, _v1.z);
    nrm.setXYZ(b, _v1.x, _v1.y, _v1.z);
  }
  nrm.needsUpdate = true;

  return { geometry: geo, vertS, centers, tangents, sArr, total };
}

/**
 * Attach skinIndex/skinWeight for a straight bone chain running along the sweep.
 * Each vertex blends the two bones bracketing its arc position, which is all a
 * limb needs — there's no branching or twisting to account for.
 */
function skinAlongChain(geometry, vertS, boneCount) {
  const count = vertS.length;
  const idx = new Uint16Array(count * 4);
  const wgt = new Float32Array(count * 4);
  const span = boneCount - 1;

  for (let i = 0; i < count; i++) {
    const p = Math.min(vertS[i], 0.9999) * span;
    const j = Math.floor(p);
    const f = p - j;
    idx[i * 4] = j;
    idx[i * 4 + 1] = Math.min(j + 1, span);
    wgt[i * 4] = 1 - f;
    wgt[i * 4 + 1] = f;
  }
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(wgt, 4));
}

/** Piecewise-linear lookup over [s, value] stops. */
function ramp(stops) {
  return (s) => {
    for (let i = 1; i < stops.length; i++) {
      if (s <= stops[i][0]) {
        const [s0, v0] = stops[i - 1];
        const [s1, v1] = stops[i];
        const t = (s - s0) / (s1 - s0 || 1);
        return v0 + (v1 - v0) * t;
      }
    }
    return stops[stops.length - 1][1];
  };
}

/* ------------------------------------------------------------------ *
 * Materials
 * ------------------------------------------------------------------ */

function buildMaterials(tex) {
  const wood = new THREE.MeshPhysicalMaterial({
    ...tex.wood,
    roughness: 1.0,
    metalness: 0.0,
    normalScale: new THREE.Vector2(0.85, 0.85),
    clearcoat: 0.14,           // decades of hand oil, not lacquer
    clearcoatRoughness: 0.62,
    envMapIntensity: 0.7,
  });

  const riserWood = new THREE.MeshPhysicalMaterial({
    ...tex.riserWood,
    roughness: 1.0,
    metalness: 0.0,
    normalScale: new THREE.Vector2(0.9, 0.9),
    clearcoat: 0.18,
    clearcoatRoughness: 0.55,
    envMapIntensity: 0.7,
  });

  const leather = new THREE.MeshPhysicalMaterial({
    ...tex.leather,
    roughness: 1.0,
    metalness: 0.0,
    normalScale: new THREE.Vector2(1.35, 1.35),
    sheen: 0.25,
    sheenRoughness: 0.85,
    sheenColor: new THREE.Color(0x6b5236),
    envMapIntensity: 0.45,
  });

  const bronze = new THREE.MeshPhysicalMaterial({
    ...tex.bronze,
    roughness: 1.0,
    metalness: 1.0,          // modulated down by the patina in metalnessMap
    normalScale: new THREE.Vector2(0.7, 0.7),
    envMapIntensity: 1.15,
  });

  const sinew = new THREE.MeshPhysicalMaterial({
    ...tex.sinew,
    roughness: 1.0,
    metalness: 0.0,
    normalScale: new THREE.Vector2(1.1, 1.1),
    sheen: 0.45,
    sheenRoughness: 0.55,
    sheenColor: new THREE.Color(0xbfae8a),
    envMapIntensity: 0.6,
  });

  // Horn is dense and translucent. Real transmission would force an extra full
  // scene render every frame for two small meshes; sheen plus a low-roughness
  // clearcoat gives the same waxy edge glow for free.
  const horn = new THREE.MeshPhysicalMaterial({
    ...tex.horn,
    roughness: 1.0,
    metalness: 0.0,
    normalScale: new THREE.Vector2(0.6, 0.6),
    sheen: 0.85,
    sheenRoughness: 0.35,
    sheenColor: new THREE.Color(0xc8a77a),
    clearcoat: 0.55,
    clearcoatRoughness: 0.28,
    envMapIntensity: 0.95,
  });

  const string = new THREE.MeshPhysicalMaterial({
    color: 0x9b9075,
    roughness: 0.72,
    metalness: 0.0,
    sheen: 0.5,
    sheenRoughness: 0.4,
    sheenColor: new THREE.Color(0xd8cbaa),
    envMapIntensity: 0.5,
  });

  const feather = new THREE.MeshPhysicalMaterial({
    color: 0x5c5348,
    roughness: 0.92,
    metalness: 0.0,
    side: THREE.DoubleSide,
    sheen: 0.6,
    sheenRoughness: 0.5,
    sheenColor: new THREE.Color(0x8d8371),
  });

  return { wood, riserWood, leather, bronze, sinew, horn, string, feather };
}

/* ------------------------------------------------------------------ *
 * Limb assembly
 * ------------------------------------------------------------------ */

const limbWidth = ramp([
  [0.00, 0.0215], [0.18, 0.0205], [0.55, 0.0140], [0.85, 0.0092], [1.00, 0.0062],
]);
const limbThick = ramp([
  [0.00, 0.0140], [0.18, 0.0128], [0.55, 0.0086], [0.85, 0.0064], [1.00, 0.0050],
]);

function buildLimb(materials, mirror) {
  const group = new THREE.Group();
  const pts = sampleSpine(BOW.limbSpine, BOW.limbSamples, mirror);

  const core = sweep({
    pts,
    profile: (s) => ({ w: limbWidth(s), h: limbThick(s) }),
    sides: BOW.limbSides,
    exponent: 3.2,
    uv: [1, 3.4],
    capStart: true,
    capEnd: true,
  });

  // Sinew backing: a thin strip glued along the limb's back (the face that ends
  // up under tension). Slightly narrower than the limb, standing a little proud.
  const sinewPts = pts.map((p, i) => {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];
    const t = _v1.subVectors(next, prev).normalize().clone();
    const thin = new THREE.Vector3().crossVectors(t, new THREE.Vector3(1, 0, 0)).normalize();
    const s = core.sArr[i];
    return p.clone().addScaledVector(thin, -limbThick(s) * 0.82);
  });
  const sinewGeo = sweep({
    pts: sinewPts,
    profile: (s) => ({ w: limbWidth(s) * 0.86, h: limbThick(s) * 0.24 }),
    sides: 10,
    exponent: 2.4,
    uv: [1, 5.0],
  });

  /* --- bone chain --- */
  const bones = [];
  const bonePos = [];
  for (let j = 0; j < BOW.boneCount; j++) {
    const s = j / (BOW.boneCount - 1);
    // Walk the sampled spine to the matching arc fraction.
    let i = 0;
    while (i < core.sArr.length - 1 && core.sArr[i + 1] < s) i++;
    const s0 = core.sArr[i], s1 = core.sArr[Math.min(i + 1, core.sArr.length - 1)];
    const f = s1 > s0 ? (s - s0) / (s1 - s0) : 0;
    bonePos.push(new THREE.Vector3().lerpVectors(pts[i], pts[Math.min(i + 1, pts.length - 1)], f));
  }
  for (let j = 0; j < BOW.boneCount; j++) {
    const bone = new THREE.Bone();
    if (j === 0) bone.position.copy(bonePos[0]);
    else {
      bone.position.copy(bonePos[j]).sub(bonePos[j - 1]);
      bones[j - 1].add(bone);
    }
    bones.push(bone);
  }
  group.add(bones[0]);

  skinAlongChain(core.geometry, core.vertS, BOW.boneCount);
  skinAlongChain(sinewGeo.geometry, sinewGeo.vertS, BOW.boneCount);

  const limbMesh = new THREE.SkinnedMesh(core.geometry, materials.wood);
  const sinewMesh = new THREE.SkinnedMesh(sinewGeo.geometry, materials.sinew);
  for (const m of [limbMesh, sinewMesh]) {
    m.castShadow = true;
    m.receiveShadow = true;
    m.frustumCulled = false;   // the bind-pose bounds don't cover a full draw
    group.add(m);
  }

  // World matrices must be current before Skeleton derives its bone inverses.
  group.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  limbMesh.bind(skeleton);
  sinewMesh.bind(skeleton);

  /* --- horn tip, riding on the last bone so it follows the bend --- */
  const tipBone = bones[BOW.boneCount - 1];
  const tipDir = core.tangents[core.tangents.length - 1].clone();

  // Bones carry no rest rotation, so "bone-local" is world-axis-aligned here and
  // the horn can simply be built along the tip tangent, centred on the bone.
  const hornPts = [];
  for (let i = 0; i <= 10; i++) {
    const t = -0.030 + (i / 10) * 0.125;
    hornPts.push(new THREE.Vector3().copy(tipDir).multiplyScalar(t));
  }
  const horn = sweep({
    pts: hornPts,
    profile: (s) => ({
      w: 0.0088 - 0.0036 * s,
      h: 0.0068 - 0.0026 * s,
    }),
    sides: 12,
    exponent: 3.0,
    uv: [1, 1.6],
    capStart: true,
    capEnd: true,
  });
  const hornMesh = new THREE.Mesh(horn.geometry, materials.horn);
  hornMesh.castShadow = true;
  tipBone.add(hornMesh);

  // Bronze collar banding the horn to the limb.
  const collarGeo = new THREE.CylinderGeometry(0.0098, 0.0106, 0.011, 18, 1, true);
  const collar = new THREE.Mesh(collarGeo, materials.bronze);
  collar.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tipDir);
  collar.position.copy(tipDir).multiplyScalar(-0.020);
  collar.castShadow = true;
  tipBone.add(collar);

  // The groove the string loop actually sits in.
  const nockGeo = new THREE.TorusGeometry(0.0052, 0.0016, 8, 18);
  const nockRing = new THREE.Mesh(nockGeo, materials.horn);
  nockRing.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), tipDir);
  nockRing.position.copy(tipDir).multiplyScalar(0.074);
  tipBone.add(nockRing);

  // Empty the string actually anchors to.
  const nockAnchor = new THREE.Object3D();
  nockAnchor.position.copy(tipDir).multiplyScalar(0.074);
  tipBone.add(nockAnchor);

  return { group, bones, skeleton, nockAnchor, spine: pts, sArr: core.sArr, tipDir };
}

/* ------------------------------------------------------------------ *
 * Riser
 * ------------------------------------------------------------------ */

const riserWidth = ramp([
  [0.00, 0.0180], [0.22, 0.0198], [0.50, 0.0212], [0.78, 0.0198], [1.00, 0.0180],
]);
const riserThick = ramp([
  [0.00, 0.0150], [0.22, 0.0205], [0.50, 0.0262], [0.78, 0.0205], [1.00, 0.0150],
]);

function buildRiser(materials) {
  const group = new THREE.Group();
  const pts = sampleSpine(BOW.riserSpine, 48);

  const body = sweep({
    pts,
    profile: (s) => ({ w: riserWidth(s), h: riserThick(s) }),
    sides: 16,
    exponent: 3.0,
    uv: [1, 2.2],
    capStart: true,
    capEnd: true,
  });
  const riserMesh = new THREE.Mesh(body.geometry, materials.riserWood);
  riserMesh.castShadow = true;
  riserMesh.receiveShadow = true;
  group.add(riserMesh);

  // Leather grip: a sleeve over the middle of the riser. The radius is modulated
  // by a sine along its length so the coils of the wrap read without the cost and
  // z-fighting of an actual helical sweep.
  const gripPts = [];
  const gLo = 0.30, gHi = 0.70;
  for (let i = 0; i <= 40; i++) {
    const s = gLo + (i / 40) * (gHi - gLo);
    let idx = 0;
    while (idx < body.sArr.length - 1 && body.sArr[idx + 1] < s) idx++;
    gripPts.push(pts[idx].clone());
  }
  const grip = sweep({
    pts: gripPts,
    profile: (s) => {
      const abs = gLo + s * (gHi - gLo);
      const coil = Math.sin(s * Math.PI * 2 * 11) * 0.00075;
      // Taper the sleeve to nothing at both ends so it blends into the riser.
      const fade = Math.min(1, Math.sin(Math.min(1, Math.max(0, s)) * Math.PI) * 3.2);
      return {
        w: riserWidth(abs) + (0.0022 + coil) * fade,
        h: riserThick(abs) + (0.0022 + coil) * fade,
      };
    },
    sides: 16,
    exponent: 3.0,
    uv: [1, 1],
  });
  const gripMesh = new THREE.Mesh(grip.geometry, materials.leather);
  gripMesh.castShadow = true;
  gripMesh.receiveShadow = true;
  group.add(gripMesh);

  // Bronze collars masking the limb-to-riser join at both fades.
  for (const sign of [1, -1]) {
    const collarGeo = new THREE.CylinderGeometry(0.0235, 0.0250, 0.026, 20, 1, true);
    const collar = new THREE.Mesh(collarGeo, materials.bronze);
    collar.position.set(0, sign * 0.1985, 0.0345);
    collar.rotation.x = sign * 0.30;
    collar.castShadow = true;
    group.add(collar);
  }

  return { group, mesh: riserMesh };
}

/* ------------------------------------------------------------------ *
 * String
 * ------------------------------------------------------------------ */

const STRING_SEGMENTS = 72;
const STRING_SIDES = 5;
const STRING_RADIUS = 0.0024;

function buildStringMesh(material) {
  const ring = STRING_SIDES + 1;
  const count = (STRING_SEGMENTS + 1) * ring;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(count * 3), 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(count * 3), 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2));

  const index = [];
  for (let i = 0; i < STRING_SEGMENTS; i++) {
    for (let k = 0; k < STRING_SIDES; k++) {
      const a = i * ring + k;
      const b = a + 1;
      const c = a + ring;
      const d = c + 1;
      index.push(a, c, b, b, c, d);
    }
  }
  geo.setIndex(index);

  const uv = geo.attributes.uv;
  for (let i = 0; i <= STRING_SEGMENTS; i++) {
    for (let k = 0; k <= STRING_SIDES; k++) {
      uv.setXY(i * ring + k, k / STRING_SIDES, i / STRING_SEGMENTS * 40);
    }
  }
  uv.needsUpdate = true;

  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  mesh.frustumCulled = false;
  return mesh;
}

/**
 * Rewrite the cable's vertices in place from a centreline. Frames are carried
 * along by parallel transport, which stays stable even where the string doubles
 * back on itself at the nocking point.
 */
const _path = [];
for (let i = 0; i <= STRING_SEGMENTS; i++) _path.push(new THREE.Vector3());
const _tan = new THREE.Vector3();
const _nrm = new THREE.Vector3();
const _bin = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _prevT = new THREE.Vector3();

function updateStringMesh(mesh, path) {
  const pos = mesh.geometry.attributes.position;
  const nor = mesh.geometry.attributes.normal;
  const ring = STRING_SIDES + 1;
  const n = path.length;

  // Seed the frame with any vector perpendicular to the first tangent.
  _prevT.subVectors(path[1], path[0]).normalize();
  _nrm.set(1, 0, 0);
  if (Math.abs(_nrm.dot(_prevT)) > 0.9) _nrm.set(0, 0, 1);
  _nrm.crossVectors(_prevT, _nrm).normalize();

  for (let i = 0; i < n; i++) {
    const prev = path[Math.max(0, i - 1)];
    const next = path[Math.min(n - 1, i + 1)];
    _tan.subVectors(next, prev);
    if (_tan.lengthSq() < 1e-12) _tan.copy(_prevT);
    _tan.normalize();

    // Rotate the carried normal by the twist between consecutive tangents.
    _axis.crossVectors(_prevT, _tan);
    const len = _axis.length();
    if (len > 1e-6) {
      _axis.divideScalar(len);
      _nrm.applyAxisAngle(_axis, Math.atan2(len, _prevT.dot(_tan)));
    }
    _nrm.addScaledVector(_tan, -_nrm.dot(_tan)).normalize();
    _bin.crossVectors(_tan, _nrm);
    _prevT.copy(_tan);

    for (let k = 0; k <= STRING_SIDES; k++) {
      const th = (k / STRING_SIDES) * Math.PI * 2;
      const cx = Math.cos(th), cy = Math.sin(th);
      const nx = _nrm.x * cx + _bin.x * cy;
      const ny = _nrm.y * cx + _bin.y * cy;
      const nz = _nrm.z * cx + _bin.z * cy;
      const vi = i * ring + k;
      pos.setXYZ(vi,
        path[i].x + nx * STRING_RADIUS,
        path[i].y + ny * STRING_RADIUS,
        path[i].z + nz * STRING_RADIUS);
      nor.setXYZ(vi, nx, ny, nz);
    }
  }
  pos.needsUpdate = true;
  nor.needsUpdate = true;
}

/* ------------------------------------------------------------------ *
 * Arrow
 * ------------------------------------------------------------------ */

function buildArrow(materials) {
  const group = new THREE.Group();
  const L = BOW.arrowLength;

  // Shaft runs from the nock at the origin, downrange along -Z.
  const shaftGeo = new THREE.CylinderGeometry(0.0042, 0.0038, L, 10, 1);
  shaftGeo.rotateX(Math.PI / 2);
  shaftGeo.translate(0, 0, -L / 2);
  const shaft = new THREE.Mesh(shaftGeo, materials.wood);
  shaft.castShadow = true;
  group.add(shaft);

  const headGeo = new THREE.ConeGeometry(0.0088, 0.052, 12);
  headGeo.rotateX(-Math.PI / 2);
  headGeo.translate(0, 0, -L - 0.018);
  const head = new THREE.Mesh(headGeo, materials.bronze);
  head.castShadow = true;
  group.add(head);

  const socketGeo = new THREE.CylinderGeometry(0.0052, 0.0052, 0.016, 10);
  socketGeo.rotateX(Math.PI / 2);
  socketGeo.translate(0, 0, -L + 0.006);
  group.add(new THREE.Mesh(socketGeo, materials.bronze));

  // Three fletchings at 120°.
  for (let i = 0; i < 3; i++) {
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.lineTo(0.016, -0.028);
    shape.lineTo(0.020, -0.098);
    shape.lineTo(0.0, -0.115);
    shape.lineTo(0, 0);
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateY(Math.PI / 2);
    geo.rotateZ(-Math.PI / 2);
    const f = new THREE.Mesh(geo, materials.feather);
    f.rotation.z = (i / 3) * Math.PI * 2;
    f.position.z = -0.035;
    group.add(f);
  }

  const nockGeo = new THREE.CylinderGeometry(0.0055, 0.0042, 0.020, 10);
  nockGeo.rotateX(Math.PI / 2);
  nockGeo.translate(0, 0, -0.008);
  group.add(new THREE.Mesh(nockGeo, materials.horn));

  group.visible = false;
  return group;
}

/* ------------------------------------------------------------------ *
 * Assembly
 * ------------------------------------------------------------------ */

export function createBow(tex) {
  const materials = buildMaterials(tex);
  const group = new THREE.Group();

  const upper = buildLimb(materials, false);
  const lower = buildLimb(materials, true);
  group.add(upper.group, lower.group);

  const riser = buildRiser(materials);
  group.add(riser.group);

  const stringMesh = buildStringMesh(materials.string);
  group.add(stringMesh);

  const arrow = buildArrow(materials);
  group.add(arrow);

  /* --- riser strain shader ---------------------------------------- *
   * Under full draw the limbs try to fold the riser toward the archer. The
   * deflection is a couple of millimetres, so rather than rig the riser it gets
   * a vertex nudge proportional to y-squared — zero at the grip, most at the
   * fades, which is how a beam under end-load actually deforms.
   *
   * The shadow depth material isn't patched to match. At this magnitude the
   * shadow discrepancy is far below a pixel, and patching it would double the
   * shader maintenance for no visible gain.
   * ---------------------------------------------------------------- */
  const strainUniform = { value: 0 };
  materials.riserWood.onBeforeCompile = (shader) => {
    shader.uniforms.uStrain = strainUniform;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uStrain;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         float _y = transformed.y;
         transformed.z += uStrain * _y * _y * 0.052;
         transformed.x *= 1.0 - uStrain * 0.045 * abs(_y);`
      );
  };
  materials.riserWood.customProgramCacheKey = () => 'riser-strain';

  /* --- calibrate the string length --------------------------------- *
   * Rather than pick a string length and hope the brace height lands somewhere
   * plausible, pose the bow at brace, measure where the tips actually ended up,
   * and derive the length that puts the string exactly one brace height off the
   * riser. Brace height is then correct by construction.
   * ------------------------------------------------------------------ */
  function setBend(angle) {
    for (let j = 0; j < BOW.bendProfile.length; j++) {
      upper.bones[j].rotation.x = angle * BOW.bendProfile[j];
      lower.bones[j].rotation.x = -angle * BOW.bendProfile[j];
    }
    group.updateMatrixWorld(true);
  }

  const _tipU = new THREE.Vector3();
  const _tipL = new THREE.Vector3();
  function readTips() {
    upper.nockAnchor.getWorldPosition(_tipU);
    lower.nockAnchor.getWorldPosition(_tipL);
  }

  setBend(BOW.braceAngle);
  readTips();
  const gripZ = BOW.riserSpine[2][1];
  const bracedNockZ = gripZ + BOW.braceHeight;
  const stringLength = 2 * Math.hypot(_tipU.y - 0, bracedNockZ - _tipU.z);
  const halfString = stringLength / 2;

  const stats = {
    stringLength,
    bracedTipY: _tipU.y,
    bracedTipZ: _tipU.z,
    braceHeight: BOW.braceHeight,
    drawLength: 0,
  };

  setBend(0);

  /* --- state ------------------------------------------------------- */
  const state = {
    mode: 'unstrung',   // 'unstrung' while the rhythm game runs, then 'strung'
    tension: 0,         // 0..1 stringing progress
    draw: 0,            // 0..1 draw, may go slightly negative on release overshoot
    swing: 0,           // loose-string sway, in metres
    swingVel: 0,
    pluckHeld: false,   // is the player currently holding the string aside
  };

  // Lateral displacement of the string when plucked, and its spring.
  const pluck = new THREE.Vector3();
  const pluckVel = new THREE.Vector3();
  const pluckTarget = new THREE.Vector3();

  // A real bowstring oscillates around 100 Hz, which at 60 fps is invisible —
  // you'd see nothing but a blur or, worse, an aliased crawl. This runs at about
  // 7 Hz so the vibration actually reads on screen. The audio model keeps the
  // real pitch; only the visible motion is slowed.
  const PLUCK_FREQ = 7.0;
  const PLUCK_DAMPING = 0.11;

  const nockPoint = new THREE.Vector3();
  const _a = new THREE.Vector3();
  const _b = new THREE.Vector3();

  /** Kick the slack string sideways — used on taps and on a slip. */
  function nudgeString(amount) {
    state.swingVel += amount;
  }

  // Rest positions of the upper limb's bones. The slack-string solver moves the
  // loop's rest-pose position by whatever its governing bone has since done.
  const restBonePos = [];
  for (let j = 0; j < BOW.boneCount; j++) {
    restBonePos.push(upper.bones[j].getWorldPosition(new THREE.Vector3()));
  }

  // Scratch objects for the slack solver, hoisted so the loop never allocates.
  const _seatQuat = new THREE.Quaternion();
  const _seatBone = new THREE.Vector3();

  /* --- per-frame update -------------------------------------------- */
  function update(dt) {
    const strung = state.mode === 'strung';

    // Limb bend: ramps to brace while stringing, then on to full draw.
    const bend = strung
      ? BOW.braceAngle + (BOW.fullDrawAngle - BOW.braceAngle) * state.draw
      : BOW.braceAngle * state.tension;
    setBend(bend);
    readTips();

    strainUniform.value = strung ? Math.max(0, state.draw) : 0;

    // Loose-string sway: one damped oscillator standing in for the whole slack
    // length. It's the only degree of freedom you can actually see.
    state.swingVel += -state.swing * 62 * dt - state.swingVel * 3.4 * dt;
    state.swing += state.swingVel * dt;

    // Pluck spring. Held: track the pointer. Released: ring down.
    if (state.pluckHeld) {
      pluck.lerp(pluckTarget, Math.min(1, dt * 22));
      pluckVel.set(0, 0, 0);
    } else if (pluck.lengthSq() > 1e-10 || pluckVel.lengthSq() > 1e-10) {
      const w = PLUCK_FREQ * Math.PI * 2;
      const k = w * w;
      const c = 2 * PLUCK_DAMPING * w;
      pluckVel.addScaledVector(pluck, -k * dt).addScaledVector(pluckVel, -c * dt);
      pluck.addScaledVector(pluckVel, dt);
      if (pluck.lengthSq() < 1e-10 && pluckVel.lengthSq() < 1e-8) {
        pluck.set(0, 0, 0);
        pluckVel.set(0, 0, 0);
      }
    }

    if (strung) {
      /* Taut. The string can't stretch, so with both tips known and the nocking
       * point on the centre axis, each half is the hypotenuse of a right triangle
       * and the nocking point falls out in closed form. */
      const midY = (_tipU.y + _tipL.y) * 0.5;
      const dy = _tipU.y - midY;
      const inner = Math.max(1e-6, halfString * halfString - dy * dy);
      const z = _tipU.z + Math.sqrt(inner);
      // Pulling the string aside genuinely stretches it, so the displacement is
      // simply added rather than solved back out of the length constraint.
      nockPoint.set(pluck.x, midY + pluck.y, z + pluck.z);

      // Straight run tip -> nock -> tip, with a vertex landing exactly on the
      // corner so the bend stays crisp.
      const half = STRING_SEGMENTS / 2;
      for (let i = 0; i <= STRING_SEGMENTS; i++) {
        if (i <= half) _path[i].lerpVectors(_tipU, nockPoint, i / half);
        else _path[i].lerpVectors(nockPoint, _tipL, (i - half) / half);
      }
      stats.drawLength = nockPoint.z - gripZ;
    } else {
      /* Slack. The lower loop is already seated; the upper loop is being walked
       * up the limb. The leftover length has to go somewhere, so the string
       * bellies out — depth from the standard shallow-cable approximation,
       * L ≈ d(1 + 8h²/3d²). */
      const t = state.tension;
      const seat = _a.copy(upper.spine[0]);
      const s = 0.34 + 0.66 * t;
      const arr = upper.sArr;
      let i = 0;
      while (i < arr.length - 1 && arr[i + 1] < s) i++;
      const s0 = arr[i], s1 = arr[Math.min(i + 1, arr.length - 1)];
      const f = s1 > s0 ? (s - s0) / (s1 - s0) : 0;
      seat.lerpVectors(upper.spine[i], upper.spine[Math.min(i + 1, upper.spine.length - 1)], f);
      // Track the flexing limb: take the loop's rest-pose position and carry it
      // through whatever rotation its governing bone has picked up.
      const bj = Math.min(Math.floor(s * (BOW.boneCount - 1)), BOW.boneCount - 2);
      upper.bones[bj].getWorldQuaternion(_seatQuat);
      upper.bones[bj].getWorldPosition(_seatBone);
      seat.sub(restBonePos[bj]).applyQuaternion(_seatQuat).add(_seatBone);

      const chord = seat.distanceTo(_tipL);
      const excess = Math.max(0, stringLength - chord);
      const sag = chord * Math.sqrt((3 * excess) / (8 * chord + 1e-6));

      for (let k = 0; k <= STRING_SEGMENTS; k++) {
        const u = k / STRING_SEGMENTS;
        _path[k].lerpVectors(_tipL, seat, u);
        const arch = Math.sin(u * Math.PI);
        // Belly toward the archer, sagging under its own weight, plus sway.
        _path[k].z += arch * sag * 0.82;
        _path[k].y -= arch * sag * 0.34;
        _path[k].x += arch * state.swing;
      }
    }

    updateStringMesh(stringMesh, _path);

    if (arrow.visible && arrow.userData.nocked) {
      arrow.position.copy(nockPoint);
    }
  }

  /* --- public surface ---------------------------------------------- */
  return {
    group,
    materials,
    arrow,
    stats,
    state,
    nockPoint,
    stringLength,
    update,
    nudgeString,
    setMode(mode) { state.mode = mode; },

    /* --- plucking ---------------------------------------------------- */

    /** Grab the string. `target` is a world-space displacement, in metres. */
    holdPluck(target) {
      state.pluckHeld = true;
      pluckTarget.copy(target);
      // The string can only be pulled so far before it's a draw, not a pluck.
      if (pluckTarget.length() > 0.14) pluckTarget.setLength(0.14);
    },

    /** Let go. Returns the displacement it was released from, in metres. */
    releasePluck() {
      state.pluckHeld = false;
      const magnitude = pluck.length();
      // Hand the stored energy to the spring so it snaps through centre.
      pluckVel.copy(pluck).multiplyScalar(-6.0);
      return magnitude;
    },

    get pluckAmount() { return pluck.length(); },
    get isPlucked() { return state.pluckHeld; },

    /** World-space position of the point the player grabs. */
    getStringGrabPoint(v) { return v.copy(nockPoint); },
    getTipUpper: (v) => v.copy(_tipU),
    getTipLower: (v) => v.copy(_tipL),
    /** World position the arrow should be released from. */
    getArrowOrigin(v) { return v.copy(nockPoint); },
    nockArrow() {
      arrow.visible = true;
      arrow.userData.nocked = true;
      arrow.position.copy(nockPoint);
      arrow.rotation.set(0, 0, 0);
    },
    unnockArrow() {
      arrow.userData.nocked = false;
    },
    hideArrow() {
      arrow.visible = false;
      arrow.userData.nocked = false;
    },
  };
}
