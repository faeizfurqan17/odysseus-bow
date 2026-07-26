/**
 * post.js — the cinematic grade.
 *
 * Chain order matters:
 *   RenderPass    scene -> HDR buffer
 *   BokehPass     depth of field; renders its own depth target and reads the
 *                 colour buffer, so it has to follow RenderPass, not replace it
 *   UnrealBloom   picks up the shaft and the bronze speculars
 *   FilmPass      grain
 *   AfterimagePass  only switched on for the release beat
 *   GradePass     desaturate / contrast / split-tone / vignette
 *   OutputPass    tone mapping + sRGB, and it must terminate the chain
 *
 * Tone mapping deliberately isn't applied by the materials: three skips it when
 * rendering into a render target, which is exactly why OutputPass exists.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { FilmPass } from 'three/addons/postprocessing/FilmPass.js';
import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/**
 * Print-style grade. Desaturated, contrast pushed, shadows cooled and highlights
 * warmed — the split-tone is what stops a desaturated image reading as grey mud.
 */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uSaturation: { value: 0.82 },
    uContrast: { value: 1.07 },
    uLift: { value: new THREE.Vector3(0.014, 0.018, 0.030) },
    uGain: { value: new THREE.Vector3(1.045, 1.005, 0.945) },
    uVignette: { value: 0.58 },
    uFade: { value: 0.0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uSaturation;
    uniform float uContrast;
    uniform vec3 uLift;
    uniform vec3 uGain;
    uniform float uVignette;
    uniform float uFade;
    varying vec2 vUv;

    void main() {
      vec4 tex = texture2D(tDiffuse, vUv);
      vec3 c = tex.rgb;

      // Luma-preserving desaturation.
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, uSaturation);

      // Contrast about mid-grey.
      c = (c - 0.5) * uContrast + 0.5;

      // Lift shadows cool, gain highlights warm.
      c = c * uGain + uLift * (1.0 - l);

      // Vignette, softened so it never shows a ring.
      vec2 d = vUv - 0.5;
      float v = 1.0 - dot(d, d) * uVignette;
      c *= clamp(v, 0.0, 1.0);

      c = max(c, 0.0);
      c = mix(c, vec3(0.0), uFade);
      gl_FragColor = vec4(c, tex.a);
    }
  `,
};

export function createPost(renderer, scene, camera) {
  const size = renderer.getSize(new THREE.Vector2());

  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(size.x, size.y);

  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  // nearClip/farClip are refreshed from the camera on every render by the pass
  // itself, so they don't need seeding here.
  const bokeh = new BokehPass(scene, camera, {
    focus: 1.05,
    aperture: 0.00021,
    maxblur: 0.0075,
  });
  composer.addPass(bokeh);

  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.42, 0.72, 0.72);
  composer.addPass(bloom);

  const film = new FilmPass(0.20, false);
  composer.addPass(film);

  const afterimage = new AfterimagePass(0.0);
  afterimage.enabled = false;    // switched on only for the release
  composer.addPass(afterimage);

  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);

  composer.addPass(new OutputPass());

  /* --- focus control -------------------------------------------------
   * Focus is racked toward a world-space target rather than snapped, so the
   * rack itself is visible — that's the whole point of having DoF here.
   * ------------------------------------------------------------------- */
  let focusTarget = 1.05;
  let apertureTarget = 0.00021;
  // The afterimage shader blends against a buffer that survives being disabled.
  // Re-enabling it straight at full strength would smear in a ghost of the
  // *previous* shot, so the pass runs one frame at zero damping first to refresh
  // that buffer, and only then ramps up.
  let pendingSmear = 0;

  return {
    composer,
    bokeh,
    bloom,
    film,
    afterimage,
    grade,

    /** Distance in metres from camera to whatever should be sharp. */
    setFocus(distance, aperture) {
      focusTarget = distance;
      if (aperture !== undefined) apertureTarget = aperture;
    },

    /** Kick the afterimage into a motion-blur smear that then decays away. */
    triggerSmear(strength = 0.9) {
      afterimage.enabled = true;
      afterimage.uniforms.damp.value = 0;
      pendingSmear = strength;
    },

    setFade(v) {
      grade.uniforms.uFade.value = v;
    },

    update(dt) {
      const u = bokeh.uniforms;
      // Fast enough to feel like a focus puller, slow enough that you read it as
      // a rack rather than a cut.
      u.focus.value += (focusTarget - u.focus.value) * Math.min(1, dt * 4.2);
      u.aperture.value += (apertureTarget - u.aperture.value) * Math.min(1, dt * 3.0);

      if (afterimage.enabled) {
        const d = afterimage.uniforms.damp;
        if (pendingSmear > 0) {
          // The refresh frame has now been rendered; safe to smear.
          d.value = pendingSmear;
          pendingSmear = 0;
        } else {
          d.value -= dt * 2.6;
          if (d.value <= 0.001) {
            d.value = 0;
            afterimage.enabled = false;   // a passthrough pass still costs a blit
          }
        }
      }
    },

    setSize(w, h) {
      composer.setSize(w, h);
      bloom.setSize(w, h);
    },
  };
}
