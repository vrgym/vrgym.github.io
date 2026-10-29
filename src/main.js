// VR Gym — WebXR mixed-reality sandbox for Meta Quest.
//
// What this does:
//   - Starts an immersive-ar session (passthrough) with plane + mesh detection.
//   - Turns detected real-world surfaces (floor, walls, tables) into physics colliders.
//   - Lets you spawn cubes and spheres with hand-tracking pinch gestures.
//   - Runs a rigid-body simulation so spheres bounce and cubes stack / topple.
//
// Everything is plain ES modules loaded from a CDN, so it can be served as-is
// from GitHub Pages (WebXR requires HTTPS, which Pages provides).

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { ARButton } from 'three/addons/webxr/ARButton.js';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
const PINCH_ON = 0.018;   // metres: fingertips closer than this => pinch
const PINCH_OFF = 0.035;  // hysteresis so a pinch doesn't flicker
const MAX_OBJECTS = 160;  // oldest objects are recycled past this count
const MAX_THROW_SPEED = 6; // m/s cap so a fast flick can't launch things absurdly

// ---------------------------------------------------------------------------
// Three.js scene
// ---------------------------------------------------------------------------
const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
  70,
  window.innerWidth / window.innerHeight,
  0.01,
  40
);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);

// Lighting that looks decent against a real-world passthrough background.
scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.1));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.4);
dirLight.position.set(1, 3, 1.5);
scene.add(dirLight);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------------------
// Physics world (cannon-es)
// ---------------------------------------------------------------------------
const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
world.broadphase = new CANNON.SAPBroadphase(world);
world.allowSleep = true; // stacked objects fall asleep -> stable towers

// Materials control how surfaces interact (bounce + friction).
const surfaceMat = new CANNON.Material('surface'); // detected walls/tables/floor
const sphereMat = new CANNON.Material('sphere');
const boxMat = new CANNON.Material('box');

world.addContactMaterial(new CANNON.ContactMaterial(surfaceMat, sphereMat, {
  restitution: 0.75, // lively bounce off real surfaces
  friction: 0.4,
}));
world.addContactMaterial(new CANNON.ContactMaterial(surfaceMat, boxMat, {
  restitution: 0.05,
  friction: 0.6,
}));
world.addContactMaterial(new CANNON.ContactMaterial(boxMat, boxMat, {
  restitution: 0.0,
  friction: 0.55, // high friction so cubes grip and stack into towers
}));
world.addContactMaterial(new CANNON.ContactMaterial(sphereMat, sphereMat, {
  restitution: 0.6,
  friction: 0.2,
}));
world.addContactMaterial(new CANNON.ContactMaterial(boxMat, sphereMat, {
  restitution: 0.35,
  friction: 0.4,
}));

// Safety-net ground at y = 0 (local-floor origin sits on the real floor).
// This guarantees objects never fall forever, even before plane detection
// has produced a floor collider.
const groundBody = new CANNON.Body({ type: CANNON.Body.STATIC, material: surfaceMat });
groundBody.addShape(new CANNON.Plane());
groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0); // face +Y
world.addBody(groundBody);

// ---------------------------------------------------------------------------
// Spawnable objects (mesh <-> body pairs)
// ---------------------------------------------------------------------------
/** @type {{ body: CANNON.Body, mesh: THREE.Mesh }[]} */
const objects = [];

const sphereGeo = new THREE.SphereGeometry(1, 24, 16);
const boxGeo = new THREE.BoxGeometry(1, 1, 1);

const palette = [0x6ee7ff, 0xff7eb6, 0xffd166, 0x9b8cff, 0x7cf29a, 0xff8c6b];
let colorIndex = 0;
function nextColor() {
  return palette[colorIndex++ % palette.length];
}

function spawnSphere(position, velocity) {
  const r = 0.05 + Math.random() * 0.03; // 5–8 cm radius
  const mesh = new THREE.Mesh(
    sphereGeo,
    new THREE.MeshStandardMaterial({ color: nextColor(), roughness: 0.35, metalness: 0.1 })
  );
  mesh.scale.setScalar(r);
  scene.add(mesh);

  const body = new CANNON.Body({
    mass: 0.4,
    material: sphereMat,
    shape: new CANNON.Sphere(r),
    position: new CANNON.Vec3(position.x, position.y, position.z),
    velocity: new CANNON.Vec3(velocity.x, velocity.y, velocity.z),
  });
  body.linearDamping = 0.01;
  world.addBody(body);

  register(body, mesh);
}

function spawnCube(position, velocity) {
  const s = 0.07 + Math.random() * 0.03; // 7–10 cm edge
  const mesh = new THREE.Mesh(
    boxGeo,
    new THREE.MeshStandardMaterial({ color: nextColor(), roughness: 0.6, metalness: 0.05 })
  );
  mesh.scale.setScalar(s);
  scene.add(mesh);

  const body = new CANNON.Body({
    mass: 0.6,
    material: boxMat,
    shape: new CANNON.Box(new CANNON.Vec3(s / 2, s / 2, s / 2)),
    position: new CANNON.Vec3(position.x, position.y, position.z),
    velocity: new CANNON.Vec3(velocity.x, velocity.y, velocity.z),
  });
  body.linearDamping = 0.02;
  body.angularDamping = 0.1;
  world.addBody(body);

  register(body, mesh);
}

function register(body, mesh) {
  objects.push({ body, mesh });
  if (objects.length > MAX_OBJECTS) {
    const old = objects.shift();
    world.removeBody(old.body);
    scene.remove(old.mesh);
    old.mesh.material.dispose();
  }
}

function clearObjects() {
  for (const o of objects) {
    world.removeBody(o.body);
    scene.remove(o.mesh);
    o.mesh.material.dispose();
  }
  objects.length = 0;
}

// ---------------------------------------------------------------------------
// Detected planes -> physics colliders
// ---------------------------------------------------------------------------
// Each XRPlane is mirrored by a static cannon Box (thin slab) sized to the
// plane's polygon, plus a translucent mesh so you can see what was detected.
const planeColliders = new Map(); // XRPlane -> { body, mesh, lastChanged }

const planeVizMat = new THREE.MeshBasicMaterial({
  color: 0x6ee7ff,
  transparent: true,
  opacity: 0.08,
  side: THREE.DoubleSide,
  depthWrite: false,
});

function updatePlanes(frame, referenceSpace) {
  const detected = frame.detectedPlanes;
  if (!detected) return;

  // Remove colliders for planes that no longer exist.
  for (const [plane, record] of planeColliders) {
    if (!detected.has(plane)) {
      world.removeBody(record.body);
      scene.remove(record.mesh);
      planeColliders.delete(plane);
    }
  }

  for (const plane of detected) {
    const pose = frame.getPose(plane.planeSpace, referenceSpace);
    if (!pose) continue;

    const p = pose.transform.position;
    const q = pose.transform.orientation;

    let record = planeColliders.get(plane);

    // (Re)build geometry only when the plane's polygon actually changes.
    if (!record || record.lastChanged !== plane.lastChangedTime) {
      // Polygon points lie in the plane's local X-Z; +Y is the surface normal.
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const pt of plane.polygon) {
        minX = Math.min(minX, pt.x); maxX = Math.max(maxX, pt.x);
        minZ = Math.min(minZ, pt.z); maxZ = Math.max(maxZ, pt.z);
      }
      const width = Math.max(maxX - minX, 0.05);
      const depth = Math.max(maxZ - minZ, 0.05);
      const cx = (minX + maxX) / 2;
      const cz = (minZ + maxZ) / 2;
      const halfY = 0.01; // 2 cm thick slab

      if (record) {
        world.removeBody(record.body);
        scene.remove(record.mesh);
      }

      const body = new CANNON.Body({ type: CANNON.Body.STATIC, material: surfaceMat });
      body.addShape(
        new CANNON.Box(new CANNON.Vec3(width / 2, halfY, depth / 2)),
        new CANNON.Vec3(cx, 0, cz) // offset so the slab is centred on the polygon
      );

      const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, halfY * 2, depth), planeVizMat);
      mesh.position.set(cx, 0, cz);
      const group = new THREE.Group(); // group holds the offset mesh, posed by XR pose
      group.add(mesh);
      scene.add(group);

      record = { body, mesh: group, lastChanged: plane.lastChangedTime };
      planeColliders.set(plane, record);
    }

    // Pose the collider + visualization to match the real surface every frame.
    record.body.position.set(p.x, p.y, p.z);
    record.body.quaternion.set(q.x, q.y, q.z, q.w);
    record.mesh.position.set(p.x, p.y, p.z);
    record.mesh.quaternion.set(q.x, q.y, q.z, q.w);
  }
}

// ---------------------------------------------------------------------------
// Hand tracking + pinch gestures
// ---------------------------------------------------------------------------
const handFactory = new XRHandModelFactory();

/** State tracked per hand so pinches are edge-triggered and throwable. */
function makeHandState(index) {
  const hand = renderer.xr.getHand(index);
  hand.add(handFactory.createHandModel(hand, 'mesh'));
  scene.add(hand);

  const state = {
    hand,
    handedness: null, // 'left' | 'right', learned on connect
    indexPinching: false,
    middlePinching: false,
    prevTip: new THREE.Vector3(),
    tipVelocity: new THREE.Vector3(),
    hasPrev: false,
  };

  hand.addEventListener('connected', (e) => {
    state.handedness = e.data?.handedness ?? null;
  });
  hand.addEventListener('disconnected', () => {
    state.handedness = null;
    state.hasPrev = false;
    state.indexPinching = false;
    state.middlePinching = false;
  });

  return state;
}

const hands = [makeHandState(0), makeHandState(1)];

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _mid = new THREE.Vector3();

function jointWorld(hand, name, out) {
  const joint = hand.joints?.[name];
  if (!joint) return false;
  joint.getWorldPosition(out);
  // When a hand isn't tracked the joints sit exactly at the origin.
  if (out.lengthSq() < 1e-6) return false;
  return true;
}

function updateHands(dt) {
  for (const state of hands) {
    const { hand } = state;

    const hasThumb = jointWorld(hand, 'thumb-tip', _a);
    const hasIndex = jointWorld(hand, 'index-finger-tip', _b);
    if (!hasThumb || !hasIndex) {
      state.hasPrev = false;
      continue;
    }

    // Track fingertip velocity (for throwing) using the index tip.
    if (state.hasPrev && dt > 0) {
      state.tipVelocity.copy(_b).sub(state.prevTip).multiplyScalar(1 / dt);
      if (state.tipVelocity.length() > MAX_THROW_SPEED) {
        state.tipVelocity.setLength(MAX_THROW_SPEED);
      }
    } else {
      state.tipVelocity.set(0, 0, 0);
    }
    state.prevTip.copy(_b);
    state.hasPrev = true;

    _mid.copy(_a).add(_b).multiplyScalar(0.5); // pinch point
    const indexDist = _a.distanceTo(_b);

    // --- index + thumb pinch => spawn ---
    if (!state.indexPinching && indexDist < PINCH_ON) {
      state.indexPinching = true;
      // A gentle forward nudge even on a still pinch, plus any throw velocity.
      const vel = state.tipVelocity.clone();
      if (state.handedness === 'left') {
        spawnCube(_mid, vel);
      } else {
        spawnSphere(_mid, vel); // right hand, or unknown handedness
      }
    } else if (state.indexPinching && indexDist > PINCH_OFF) {
      state.indexPinching = false;
    }

    // --- middle + thumb pinch => clear everything ---
    if (jointWorld(hand, 'middle-finger-tip', _b)) {
      const middleDist = _a.distanceTo(_b);
      if (!state.middlePinching && middleDist < PINCH_ON) {
        state.middlePinching = true;
        clearObjects();
      } else if (state.middlePinching && middleDist > PINCH_OFF) {
        state.middlePinching = false;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Session lifecycle + render loop
// ---------------------------------------------------------------------------
const hud = document.getElementById('hud');
const landing = document.getElementById('landing');

renderer.xr.addEventListener('sessionstart', () => {
  hud.style.display = 'flex';
  landing.style.display = 'none';
});
renderer.xr.addEventListener('sessionend', () => {
  hud.style.display = 'none';
  landing.style.display = 'flex';
  clearObjects();
});

const clock = new THREE.Clock();

renderer.setAnimationLoop((timestamp, frame) => {
  const dt = Math.min(clock.getDelta(), 1 / 30); // clamp to keep physics stable

  if (frame) {
    const referenceSpace = renderer.xr.getReferenceSpace();
    updatePlanes(frame, referenceSpace);
    updateHands(dt);
  }

  // Step the simulation and copy transforms to the render meshes.
  world.step(1 / 60, dt, 4);
  for (const { body, mesh } of objects) {
    mesh.position.copy(body.position);
    mesh.quaternion.copy(body.quaternion);
  }

  renderer.render(scene, camera);
});

// ---------------------------------------------------------------------------
// ARButton + capability check
// ---------------------------------------------------------------------------
const statusEl = document.getElementById('status');
const buttonContainer = document.getElementById('ar-button-container');

const button = ARButton.createButton(renderer, {
  requiredFeatures: ['local-floor'],
  optionalFeatures: ['plane-detection', 'mesh-detection', 'hand-tracking', 'anchors', 'dom-overlay'],
  domOverlay: { root: document.body },
});
button.id = 'ar-button';
button.textContent = 'Entrar en Realidad Mixta';
buttonContainer.appendChild(button);

if (!('xr' in navigator)) {
  statusEl.textContent = 'Este navegador no soporta WebXR. Ábrelo en el navegador de tu Meta Quest.';
  button.style.display = 'none';
} else {
  navigator.xr.isSessionSupported('immersive-ar').then((supported) => {
    statusEl.textContent = supported
      ? 'Listo. Ponte las Quest, permite el tracking de manos y pulsa el botón.'
      : 'Tu dispositivo no soporta sesiones immersive-ar. Prueba en el navegador de Meta Quest.';
  });
}
