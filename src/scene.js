/**
 * scene.js — renderer, camera rig, practical lighting, and the megaron hall.
 *
 * The lighting is deliberately spare: one warm directional key standing in for a
 * sun through a roof opening, a low hemisphere fill, and an environment probe
 * so the bronze has something to reflect. No coloured rim lights and no
 * fill-from-nowhere — every highlight traces back to that one key.
 */

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export const HALL = {
  axeCount: 12,
  axeFirstZ: -3.4,      // nearest axe head
  axeSpacing: -0.92,    // they recede downrange
  // Wide enough that a shot with any real trajectory can thread all twelve.
  axeSocketRadius: 0.075,
  axeTargetZ: -15.0,
  // Pushed out past the camera's arc: at the close framing the rig sits around
  // x=2.9 and at full pull-back around x=4.3, so anything nearer than that puts
  // a pillar between the lens and the bow.
  pillarRows: [-5.0, 5.0],
  pillarCount: 8,
  // Set so the bow's lower tip (y = -0.835) clears the floor by ~15 mm.
  // Anything lower and the bow reads as floating.
  floorY: -0.85,
};

/* ------------------------------------------------------------------ *
 * Renderer / camera
 * ------------------------------------------------------------------ */

export function createRenderer(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
    stencil: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.18;
  return renderer;
}

export function createCamera() {
  const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.05, 90);
  camera.position.set(0.72, 0.10, 1.05);
  camera.lookAt(0, 0, 0);
  return camera;
}

/* ------------------------------------------------------------------ *
 * Dust focus
 *
 * There is no volumetric beam mesh: an additive cone is a lot of overdraw for
 * something a directional key plus lit dust already implies. This is just the
 * point the dust shader treats as the light's entry, so the motes that catch
 * the light form a band instead of glowing uniformly.
 * ------------------------------------------------------------------ */

export const LIGHT_FOCUS = new THREE.Vector3(0, 0.10, 0.05);

/** Where the key light would enter the room, used only to shape the dust. */
function dustOrigin(direction) {
  return LIGHT_FOCUS.clone().addScaledVector(direction, -5.2);
}

/* ------------------------------------------------------------------ *
 * The hall
 * ------------------------------------------------------------------ */

function buildHall(tex) {
  const group = new THREE.Group();

  const stoneMat = (repeat, tint = 0xffffff) => {
    const maps = {
      map: tex.stone.map.clone(),
      roughnessMap: tex.stone.roughnessMap.clone(),
      normalMap: tex.stone.normalMap.clone(),
    };
    for (const t of Object.values(maps)) {
      t.repeat.set(repeat[0], repeat[1]);
      t.needsUpdate = true;
    }
    return new THREE.MeshPhysicalMaterial({
      ...maps,
      color: tint,
      roughness: 1.0,
      metalness: 0.0,
      normalScale: new THREE.Vector2(1.0, 1.0),
      envMapIntensity: 0.35,
    });
  };

  /* --- floor --- */
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(46, 46), stoneMat([12, 12]));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = HALL.floorY;
  floor.receiveShadow = true;
  group.add(floor);

  /* --- side walls and the back wall of the hall --- */
  const wallMat = stoneMat([8, 3], 0xb9b2a4);
  for (const x of [-7.6, 7.6]) {
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(40, 9), wallMat);
    wall.position.set(x, HALL.floorY + 4.5, -9);
    wall.rotation.y = x < 0 ? Math.PI / 2 : -Math.PI / 2;
    wall.receiveShadow = true;
    group.add(wall);
  }
  const back = new THREE.Mesh(new THREE.PlaneGeometry(16, 9), wallMat);
  back.position.set(0, HALL.floorY + 4.5, -17.5);
  back.receiveShadow = true;
  group.add(back);

  /* --- pillars: instanced, two receding rows --- */
  const pillarGeo = new THREE.CylinderGeometry(0.20, 0.245, 5.2, 14, 1);
  const pillarMat = stoneMat([2, 5], 0xa79f8f);
  const total = HALL.pillarRows.length * HALL.pillarCount;
  const pillars = new THREE.InstancedMesh(pillarGeo, pillarMat, total);
  pillars.castShadow = true;
  pillars.receiveShadow = true;

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3(1, 1, 1);
  const p = new THREE.Vector3();
  let i = 0;
  for (const x of HALL.pillarRows) {
    for (let k = 0; k < HALL.pillarCount; k++) {
      p.set(x, HALL.floorY + 2.6, -1.0 - k * 2.3);
      // Break the rhythm slightly — nothing in a Bronze Age hall is on a grid.
      p.x += (k % 2 === 0 ? 0.035 : -0.045) * Math.sign(x);
      s.set(1, 1 + (k % 3) * 0.012, 1);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), k * 0.4);
      m.compose(p, q, s);
      pillars.setMatrixAt(i++, m);
    }
  }
  pillars.instanceMatrix.needsUpdate = true;
  group.add(pillars);

  /* --- roof beams --- */
  const beamGeo = new THREE.BoxGeometry(15.6, 0.30, 0.26);
  const beamMat = new THREE.MeshPhysicalMaterial({
    map: tex.wood.map,
    roughnessMap: tex.wood.roughnessMap,
    normalMap: tex.wood.normalMap,
    color: 0x5b4a35,
    roughness: 1.0,
    metalness: 0.0,
    envMapIntensity: 0.25,
  });
  const beamCount = 13;
  const beams = new THREE.InstancedMesh(beamGeo, beamMat, beamCount);
  beams.castShadow = true;
  for (let k = 0; k < beamCount; k++) {
    p.set(0, HALL.floorY + 5.15, 1.6 - k * 1.45);
    q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0);
    s.set(1, 1, 1);
    m.compose(p, q, s);
    beams.setMatrixAt(k, m);
  }
  beams.instanceMatrix.needsUpdate = true;
  group.add(beams);

  /* --- the timber the shot buries itself in, past the last axe head --- */
  const postGeo = new THREE.BoxGeometry(0.62, 2.5, 0.34);
  const post = new THREE.Mesh(postGeo, beamMat);
  post.position.set(0, HALL.floorY + 1.25, HALL.axeTargetZ);
  post.castShadow = true;
  post.receiveShadow = true;
  group.add(post);

  return group;
}

/* ------------------------------------------------------------------ *
 * The twelve axe heads
 *
 * Lined up down the hall with their sockets on the shot axis, exactly as the
 * contest is described: the arrow has to pass clean through all twelve.
 * ------------------------------------------------------------------ */

function buildAxes(tex) {
  const group = new THREE.Group();
  const axes = [];

  const bronzeMat = new THREE.MeshPhysicalMaterial({
    ...tex.bronze,
    roughness: 1.0,
    metalness: 1.0,
    envMapIntensity: 1.2,
  });
  const stakeMat = new THREE.MeshPhysicalMaterial({
    map: tex.wood.map,
    roughnessMap: tex.wood.roughnessMap,
    normalMap: tex.wood.normalMap,
    color: 0x6a563d,
    roughness: 1.0,
    metalness: 0.0,
    envMapIntensity: 0.3,
  });

  // A double axe head: two flared blades either side of a socket ring.
  const bladeShape = new THREE.Shape();
  bladeShape.moveTo(0.088, -0.024);
  bladeShape.lineTo(0.186, -0.125);
  bladeShape.lineTo(0.212, -0.014);
  bladeShape.lineTo(0.212, 0.014);
  bladeShape.lineTo(0.186, 0.125);
  bladeShape.lineTo(0.088, 0.024);
  bladeShape.closePath();
  const bladeGeo = new THREE.ExtrudeGeometry(bladeShape, {
    depth: 0.016, bevelEnabled: true, bevelSize: 0.004, bevelThickness: 0.003, bevelSegments: 2,
  });
  bladeGeo.translate(0, 0, -0.008);

  const socketGeo = new THREE.TorusGeometry(HALL.axeSocketRadius, 0.018, 10, 26);
  // The stake runs from the socket all the way down to the floor.
  const stakeLen = -HALL.floorY;
  const stakeGeo = new THREE.CylinderGeometry(0.036, 0.048, stakeLen, 10);
  const baseGeo = new THREE.CylinderGeometry(0.10, 0.13, 0.10, 12);

  for (let i = 0; i < HALL.axeCount; i++) {
    const z = HALL.axeFirstZ + i * HALL.axeSpacing;
    const axe = new THREE.Group();
    axe.position.set(0, 0, z);

    const socket = new THREE.Mesh(socketGeo, bronzeMat);
    socket.castShadow = true;
    axe.add(socket);

    for (const sign of [1, -1]) {
      const blade = new THREE.Mesh(bladeGeo, bronzeMat);
      blade.scale.x = sign;
      blade.castShadow = true;
      axe.add(blade);
    }

    const stake = new THREE.Mesh(stakeGeo, stakeMat);
    stake.position.y = -stakeLen / 2;
    stake.castShadow = true;
    axe.add(stake);

    const base = new THREE.Mesh(baseGeo, stakeMat);
    base.position.y = HALL.floorY + 0.05;
    base.castShadow = true;
    base.receiveShadow = true;
    axe.add(base);

    // A little irregularity so the row doesn't read as a machined jig.
    axe.rotation.z = (Math.sin(i * 2.3) * 0.5 + Math.cos(i * 1.1) * 0.5) * 0.022;
    axe.position.x = Math.sin(i * 1.7) * 0.006;

    group.add(axe);
    axes.push(axe);
  }

  return { group, axes };
}

/* ------------------------------------------------------------------ *
 * Scene assembly
 * ------------------------------------------------------------------ */

export function createScene(renderer, tex) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d0f14);
  scene.fog = new THREE.FogExp2(0x121419, 0.030);

  /* --- environment probe: without this, bronze has nothing to reflect and
   * reads as flat grey plastic no matter how the lights are set. --- */
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
  scene.environment = envRT.texture;
  scene.environmentIntensity = 0.48;
  pmrem.dispose();

  /* --- key light --- */
  const sunDir = new THREE.Vector3(-0.46, -0.82, 0.34).normalize();
  const sun = new THREE.DirectionalLight(0xffd2a0, 6.4);
  sun.position.copy(sunDir).multiplyScalar(-7.5);
  sun.target.position.set(0, 0, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  // A tight frustum around the bow is what buys crisp contact shadows at this
  // resolution; the hall behind it doesn't need shadow detail.
  sun.shadow.camera.left = -2.2;
  sun.shadow.camera.right = 2.2;
  sun.shadow.camera.top = 2.2;
  sun.shadow.camera.bottom = -2.2;
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 18;
  sun.shadow.bias = -0.00042;
  sun.shadow.normalBias = 0.018;
  sun.shadow.radius = 2.4;
  scene.add(sun, sun.target);

  /* --- fill: cold from the roof opening, warm bounce off the stone floor --- */
  const hemi = new THREE.HemisphereLight(0x5a6786, 0x3d2c1c, 1.05);
  scene.add(hemi);

  // A very low ambient so the shadow side never goes fully to black — a print
  // never does, and pure black reads as a hole rather than as shadow.
  scene.add(new THREE.AmbientLight(0x2b3040, 0.62));

  const hall = buildHall(tex);
  scene.add(hall);

  const { group: axeGroup, axes } = buildAxes(tex);
  scene.add(axeGroup);

  return {
    scene,
    sun,
    sunDir,
    dustOrigin: dustOrigin(sunDir),
    hemi,
    hall,
    axes,
    axeGroup,
  };
}
