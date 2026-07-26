/**
 * dust.js — motes drifting through the light shaft.
 *
 * The drift is computed entirely in the vertex shader from uTime and a per-instance
 * seed, so the CPU never touches an instance matrix. Updating 900 matrices per
 * frame on the main thread would cost more than everything else in this file
 * combined; this way the whole system is one uniform write.
 */

import * as THREE from 'three';

export function createDust(sprite, sunDir, { count = 340, origin = null } = {}) {
  // A single quad, billboarded in the shader.
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(
    [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(
    [0, 0, 1, 0, 1, 1, 0, 1], 2));

  // Per-instance: home position, and a seed packing size / speed / phase.
  const home = new Float32Array(count * 3);
  const seed = new Float32Array(count * 3);

  // Scatter through the volume the shaft passes through, biased toward it so
  // the motes that catch the light aren't outnumbered by ones that never do.
  for (let i = 0; i < count; i++) {
    const inBeam = Math.random() < 0.62;
    const r = inBeam ? Math.pow(Math.random(), 0.6) * 0.95 : 0.9 + Math.random() * 2.6;
    const th = Math.random() * Math.PI * 2;

    home[i * 3]     = Math.cos(th) * r + (inBeam ? 0 : (Math.random() - 0.5) * 1.5);
    home[i * 3 + 1] = -0.9 + Math.random() * 3.0;
    home[i * 3 + 2] = Math.sin(th) * r * 1.15 + (Math.random() - 0.5) * 1.2;

    seed[i * 3]     = 0.6 + Math.random() * 1.9;    // size multiplier
    seed[i * 3 + 1] = 0.25 + Math.random() * 0.85;  // drift speed
    seed[i * 3 + 2] = Math.random() * 100.0;        // phase
  }

  geo.setAttribute('aHome', new THREE.InstancedBufferAttribute(home, 3));
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 3));
  geo.instanceCount = count;

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uMap: { value: sprite },
      uSunDir: { value: sunDir.clone().normalize() },
      // Where the shaft actually starts, so the in-beam test matches the beam.
      uOrigin: { value: (origin ? origin.clone() : new THREE.Vector3(0, 1.6, 0)) },
      uScale: { value: 1.0 },
      uOpacity: { value: 1.0 },
      uColor: { value: new THREE.Color(0xffe0b4) },
    },
    vertexShader: /* glsl */`
      uniform float uTime;
      uniform float uScale;
      uniform vec3 uSunDir;
      uniform vec3 uOrigin;
      attribute vec3 aHome;
      attribute vec3 aSeed;
      varying vec2 vUv;
      varying float vBeam;

      void main() {
        vUv = uv;

        float speed = aSeed.y;
        float phase = aSeed.z;
        float t = uTime * speed;

        // Lazy curl-ish drift: three decorrelated sines per axis. Motes are light
        // enough that they never fall in a straight line.
        vec3 p = aHome;
        p.x += sin(t * 0.31 + phase) * 0.20 + sin(t * 0.13 + phase * 1.7) * 0.10;
        p.z += cos(t * 0.27 + phase * 1.3) * 0.20 + sin(t * 0.11 + phase) * 0.09;
        // Slow settle, wrapped so the column never empties out.
        p.y = mod(p.y - t * 0.030 + 1.4, 3.9) - 1.0;

        // Distance from the shaft's axis, used to brighten the motes inside it.
        vec3 d = p - uOrigin;
        float along = dot(d, uSunDir);
        float radial = length(d - uSunDir * along);
        float coneR = 0.30 + along * 0.14;
        vBeam = 1.0 - smoothstep(coneR * 0.45, coneR * 1.25, radial);

        // Billboard: build the quad in view space so it always faces the camera.
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float size = aSeed.x * 0.0034 * uScale;
        mv.xy += position.xy * size;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */`
      uniform sampler2D uMap;
      uniform vec3 uColor;
      uniform float uOpacity;
      varying vec2 vUv;
      varying float vBeam;

      void main() {
        float a = texture2D(uMap, vUv).a;
        // Outside the beam a mote is essentially invisible; only the shaft
        // picks them out. Without this they read as snow falling through a room.
        float lit = 0.012 + vBeam * vBeam * 1.5;
        gl_FragColor = vec4(uColor * lit, a * lit * uOpacity * 0.55);
      }
    `,
  });

  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;   // instances move in the shader; bounds are meaningless
  mesh.renderOrder = 5;

  return {
    mesh,
    material,
    update(time) {
      material.uniforms.uTime.value = time;
    },
  };
}
