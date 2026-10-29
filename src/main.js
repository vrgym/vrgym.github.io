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
const GRAB_MARGIN = 0.04;  // metres added to an object's radius to grab it (surface contact)
const GRAB_MODE_DIST = 0.06; // thumb-index closer than this => "grabbing", soften fingertips

// Joints turned into kinematic sphere colliders so hands can hit objects.
// [jointName, radiusInMetres, softWhenGrabbing]
// Fingertips are softened while grabbing so they don't bat the target away.
// Knuckles, metacarpals (palm + back + sides) and wrist stay active so you can
// hit with the back or edge of the hand, or a fist.
const HAND_COLLIDER_JOINTS = [
  ['thumb-tip', 0.013, true],
  ['index-finger-tip', 0.013, true],
  ['middle-finger-tip', 0.013, true],
  ['ring-finger-tip', 0.013, true],
  ['pinky-finger-tip', 0.013, true],
  ['index-finger-phalanx-proximal', 0.016, false],
  ['middle-finger-phalanx-proximal', 0.016, false],
  ['ring-finger-phalanx-proximal', 0.016, false],
  ['pinky-finger-phalanx-proximal', 0.016, false],
  ['index-finger-metacarpal', 0.022, false],
  ['middle-finger-metacarpal', 0.030, false], // palm
  ['pinky-finger-metacarpal', 0.022, false],
  ['wrist', 0.030, false],
];

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
const handMat = new CANNON.Material('hand'); // kinematic fingertip/palm colliders

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
// Hands hit things: a bit of bounce so a punch sends objects flying.
world.addContactMaterial(new CANNON.ContactMaterial(handMat, sphereMat, {
  restitution: 0.5,
  friction: 0.3,
}));
world.addContactMaterial(new CANNON.ContactMaterial(handMat, boxMat, {
  restitution: 0.3,
  friction: 0.4,
}));

// Safety net far BELOW the scene. We intentionally do NOT put a floor at y = 0:
// objects must rest on the *real* detected floor plane (posed at its true
// height), otherwise an assumed y = 0 floor can hover at head height if the
// runtime's origin isn't exactly on the ground. This plane only stops objects
// from falling forever before the floor is detected.
const catchBody = new CANNON.Body({ type: CANNON.Body.STATIC, material: surfaceMat });
catchBody.addShape(new CANNON.Plane());
catchBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0); // face +Y
catchBody.position.set(0, -6, 0);
world.addBody(catchBody);

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

  register(body, mesh, r); // grab radius = sphere radius
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

  register(body, mesh, s * 0.7); // grab radius ~ cube half-extent + margin
}

function register(body, mesh, grabRadius) {
  objects.push({ body, mesh, held: false, grabRadius });
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
  for (const h of hands) h.held = null; // drop anything being held
}

/** Nearest object whose surface the fingers are touching, or null. */
function findGrabbable(point) {
  let best = null;
  let bestDist = Infinity;
  for (const o of objects) {
    if (o.held) continue;
    const b = o.body;
    const dx = point.x - b.position.x;
    const dy = point.y - b.position.y;
    const dz = point.z - b.position.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    // Grab when the pinch point reaches the object's surface (+ a little margin).
    if (d < o.grabRadius + GRAB_MARGIN && d < bestDist) {
      bestDist = d;
      best = o;
    }
  }
  return best;
}

/** Pick up an object: becomes kinematic and follows the hand. */
function grab(state, obj) {
  state.held = obj;
  obj.held = true;
  const b = obj.body;
  b.type = CANNON.Body.KINEMATIC;
  b.allowSleep = false;
  b.angularVelocity.set(0, 0, 0);
  b.wakeUp();
}

/** Let go: back to dynamic and inherit the hand's velocity (throw). */
function release(state) {
  const obj = state.held;
  state.held = null;
  if (!obj) return;
  obj.held = false;
  const b = obj.body;
  b.type = CANNON.Body.DYNAMIC;
  b.updateMassProperties();
  b.allowSleep = true;
  const v = state.tipVelocity;
  b.velocity.set(v.x, v.y, v.z);
  b.wakeUp();
}

// ---------------------------------------------------------------------------
// Detected planes -> physics colliders
// ---------------------------------------------------------------------------
// Each XRPlane is mirrored by a static cannon Box (thin slab) sized to the
// plane's polygon, plus a translucent mesh so you can see what was detected.
const planeColliders = new Map(); // XRPlane -> { body, mesh, lastChanged }

// Visualize surfaces so you can confirm detection: green-ish for things you
// can rest objects on (floor, tables), blue-ish for walls/ceilings.
function makePlaneMat(color) {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.1,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
}
const horizontalMat = makePlaneMat(0x7cf29a); // floor / tables / desks
const verticalMat = makePlaneMat(0x6ea8ff); // walls / windows / doors

// Labels that mean "a surface you can put things on top of".
const TABLE_LABELS = new Set(['table', 'desk', 'shelf', 'couch', 'bed', 'other']);

// Counts for the on-screen feedback, refreshed every frame.
const planeStats = { total: 0, tables: 0 };

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

      // Thick slab (10 cm) whose TOP face sits exactly on the real surface, so
      // objects rest flush on the tabletop and fast throws don't tunnel through.
      const halfY = 0.05;

      if (record) {
        world.removeBody(record.body);
        scene.remove(record.mesh);
      }

      const body = new CANNON.Body({ type: CANNON.Body.STATIC, material: surfaceMat });
      body.addShape(
        new CANNON.Box(new CANNON.Vec3(width / 2, halfY, depth / 2)),
        new CANNON.Vec3(cx, -halfY, cz) // push the slab down so its top is the surface
      );

      // Flat quad drawn right on the surface (plane local X-Z).
      const vizGeo = new THREE.PlaneGeometry(width, depth).rotateX(-Math.PI / 2);
      const mat = plane.orientation === 'vertical' ? verticalMat : horizontalMat;
      const mesh = new THREE.Mesh(vizGeo, mat);
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

  // Refresh on-screen stats so you can confirm the room was picked up.
  planeStats.total = 0;
  planeStats.tables = 0;
  for (const plane of detected) {
    planeStats.total++;
    if (plane.orientation === 'horizontal' && TABLE_LABELS.has(plane.semanticLabel)) {
      planeStats.tables++;
    }
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

  // Kinematic colliders that follow the tracked joints so the hand can
  // physically strike objects and knock them away.
  const colliders = HAND_COLLIDER_JOINTS.map(([name, r, soft]) => {
    const body = new CANNON.Body({ type: CANNON.Body.KINEMATIC, material: handMat });
    body.addShape(new CANNON.Sphere(r));
    body.collisionResponse = false; // off until the joint is actually tracked
    world.addBody(body);
    return { name, body, soft, hasPrev: false };
  });

  const state = {
    hand,
    handedness: null, // 'left' | 'right', learned on connect
    colliders,
    held: null, // object currently grabbed by this hand
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
    if (state.held) release(state); // drop whatever was held when tracking is lost
    for (const c of state.colliders) {
      c.body.collisionResponse = false;
      c.body.velocity.set(0, 0, 0);
      c.hasPrev = false;
    }
  });

  return state;
}

const hands = [makeHandState(0), makeHandState(1)];

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _c = new THREE.Vector3();
const _vel = new THREE.Vector3();

function jointWorld(hand, name, out) {
  const joint = hand.joints?.[name];
  if (!joint) return false;
  joint.getWorldPosition(out);
  // When a hand isn't tracked the joints sit exactly at the origin.
  if (out.lengthSq() < 1e-6) return false;
  return true;
}

// Drive the kinematic hand colliders from the tracked joints. Setting both
// position AND velocity each frame is what lets a moving hand transfer
// momentum to the objects it touches.
function updateHandColliders(dt) {
  for (const state of hands) {
    // "Grabbing" when already holding something, or when thumb and index are
    // closing in. While grabbing, the fingertips stop pushing so you can
    // enclose an object instead of knocking it away.
    const hasThumb = jointWorld(state.hand, 'thumb-tip', _a);
    const hasIndex = jointWorld(state.hand, 'index-finger-tip', _b);
    const grabbing = !!state.held || (hasThumb && hasIndex && _a.distanceTo(_b) < GRAB_MODE_DIST);

    for (const c of state.colliders) {
      const b = c.body;
      const tracked = dt > 0 && jointWorld(state.hand, c.name, _c);

      if (!tracked) {
        b.collisionResponse = false;
        b.velocity.set(0, 0, 0);
        c.hasPrev = false;
        continue;
      }

      if (grabbing && c.soft) {
        // Fingertip in grab mode: follow the joint but don't shove objects.
        b.position.set(_c.x, _c.y, _c.z);
        b.velocity.set(0, 0, 0);
        b.collisionResponse = false;
        c.hasPrev = true;
        continue;
      }

      if (!c.hasPrev) {
        // First frame tracked: teleport into place without a velocity spike.
        b.position.set(_c.x, _c.y, _c.z);
        b.velocity.set(0, 0, 0);
        c.hasPrev = true;
      } else {
        // Steer toward the joint via velocity so the engine integrates the
        // motion and transfers momentum to anything the collider hits.
        _vel.set((_c.x - b.position.x) / dt, (_c.y - b.position.y) / dt, (_c.z - b.position.z) / dt);
        if (_vel.length() > MAX_THROW_SPEED * 1.5) _vel.setLength(MAX_THROW_SPEED * 1.5);
        b.velocity.set(_vel.x, _vel.y, _vel.z);
      }
      b.collisionResponse = true;
    }
  }
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

    // A held object follows the pinch point. Keeping its velocity in sync
    // means it also shoves anything it sweeps into while carried.
    if (state.held) {
      const b = state.held.body;
      if (dt > 0) {
        _vel.set((_mid.x - b.position.x) / dt, (_mid.y - b.position.y) / dt, (_mid.z - b.position.z) / dt);
        if (_vel.length() > MAX_THROW_SPEED * 1.5) _vel.setLength(MAX_THROW_SPEED * 1.5);
        b.velocity.set(_vel.x, _vel.y, _vel.z);
      }
    }

    // --- index + thumb pinch: grab a nearby object, else spawn a new one ---
    if (!state.indexPinching && indexDist < PINCH_ON) {
      state.indexPinching = true;
      const target = findGrabbable(_mid);
      if (target) {
        grab(state, target);
      } else {
        const vel = state.tipVelocity.clone();
        if (state.handedness === 'left') {
          spawnCube(_mid, vel);
        } else {
          spawnSphere(_mid, vel); // right hand, or unknown handedness
        }
      }
    } else if (state.indexPinching && indexDist > PINCH_OFF) {
      state.indexPinching = false;
      if (state.held) release(state); // open the pinch => throw
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
const hudPlanes = document.getElementById('hud-planes');
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
    updateHandColliders(dt);
    updateHands(dt);

    // Lightweight on-screen confirmation of what the room scan picked up.
    if (hudPlanes) {
      if (planeStats.total === 0) {
        hudPlanes.innerHTML = '<span class="dot" style="color:#ffb86b">●</span> Mueve la cabeza para detectar superficies…';
      } else {
        const tableNote = planeStats.tables > 0 ? ` · 🟢 ${planeStats.tables} mesa(s)` : '';
        hudPlanes.innerHTML = `<span class="dot">●</span> ${planeStats.total} superficies${tableNote}`;
      }
    }
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
