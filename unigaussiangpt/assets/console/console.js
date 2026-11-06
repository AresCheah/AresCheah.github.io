// Interactive Console: walk through the house from the promo film's first part, as 3D Gaussians,
// with its walls and ceiling. Every splat carries the class UniGaussianGPT predicted for it; each
// piece of furniture is one instance, a separate, complete piece. Walk with the keyboard, look by
// dragging, click a piece, then move, turn, copy or remove it. Data: scene.bin / scene.json from
// homepage/tools/console_pack.py (v1/v2, an orbit view of film part 2: _console/console_v2_orbit.js).
import * as THREE from "three";
import { SparkRenderer, SplatMesh, PackedSplats, utils } from "spark";

const STRIDE = 18;
const RADIUS = 0.22;          // the walker's body, against walls (m)
const SPEED = 1.5;            // walking speed (m/s); Shift doubles it
const TURN = 1.6;             // turning speed with the arrow keys (rad/s)

// byte j of splat i: at i * STRIDE + j (interleaved) or j * n + i (byte-planar, compresses better)
function decode(meta, bytes) {
  const n_ = meta.n;
  const planar = meta.layout === "byte-planar";
  const u8 = planar ? (i, j) => bytes[j * n_ + i] : (i, j) => bytes[i * STRIDE + j];
  const u16 = (i, j) => u8(i, j) | (u8(i, j + 1) << 8);
  const i8 = (i, j) => (u8(i, j) << 24) >> 24;
  const lo = meta.lo, span = meta.hi.map((h, i) => h - meta.lo[i]);
  const groups = [];
  let off = 0;
  for (const g of meta.groups) {
    const n = g.n;
    // positions relative to a pivot near the splats: Spark keeps centres as float16
    const pivot = g.pivot || (g.cls ? [g.foot[0], g.foot[1], meta.floor_z] : [0, 0, 0]);
    // room for a whole number of 2048-splat texture rows: given a packedArray, PackedSplats keeps
    // only floor(length / 4 / 2048) * 2048 splats, and the last ones of a piece are the legs
    // and back posts that figs/film3/legs.py rebuilt (a chair's 9443 drew as 8192, no posts)
    const cap = Math.ceil(n / 2048) * 2048;
    const rgb = new Uint32Array(cap * 4);
    const sem = new Uint32Array(cap * 4);
    const cls = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const b = off + i;
      const x = lo[0] + (u16(b, 0) / 65535) * span[0] - pivot[0];
      const y = lo[1] + (u16(b, 2) / 65535) * span[1] - pivot[1];
      const z = lo[2] + (u16(b, 4) / 65535) * span[2] - pivot[2];
      const sx = Math.exp(-10 + (u8(b, 6) / 255) * 10);
      const sy = Math.exp(-10 + (u8(b, 7) / 255) * 10);
      const sz = Math.exp(-10 + (u8(b, 8) / 255) * 10);
      const qw = i8(b, 9) / 127, qx = i8(b, 10) / 127;
      const qy = i8(b, 11) / 127, qz = i8(b, 12) / 127;
      const ql = Math.hypot(qw, qx, qy, qz) || 1;
      const r = u8(b, 13) / 255, gg = u8(b, 14) / 255, bb = u8(b, 15) / 255;
      const o = u8(b, 16) / 255;
      const k = u8(b, 17);
      cls[i] = k;
      utils.setPackedSplat(rgb, i, x, y, z, sx, sy, sz, qx / ql, qy / ql, qz / ql, qw / ql, o, r, gg, bb);
      const pc = meta.palette[meta.labels[k]] || [120, 120, 120];
      utils.setPackedSplat(sem, i, x, y, z, sx, sy, sz, qx / ql, qy / ql, qz / ql, qw / ql, o,
        pc[0] / 255, pc[1] / 255, pc[2] / 255);
    }
    off += n;
    groups.push({ meta: g, pivot, rgb, sem, cls, n });
  }
  return groups;
}

async function load(base, say) {
  const meta = await (await fetch(`${base}scene.json`)).json();
  // meta.bin: the splats; a ".b64.txt" name holds them base64-encoded (the claude.ai preview
  // host serves no .bin files; see tools/make_artifact.py)
  const bin = meta.bin || "scene.bin";
  const res = await fetch(`${base}${bin}`);
  const total = Number(res.headers.get("content-length")) || meta.n * STRIDE * (bin.endsWith(".b64.txt") ? 4 / 3 : 1);
  const reader = res.body.getReader();
  let bytes = new Uint8Array(Math.max(1 << 20, Math.ceil(total) + 4));
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (got + value.length > bytes.length) { const b = new Uint8Array(2 * (got + value.length)); b.set(bytes.subarray(0, got)); bytes = b; }
    bytes.set(value, got);
    got += value.length;
    say(`Loading the house  ${Math.min(99, Math.round((100 * got) / total))}%`);
  }
  if (bin.endsWith(".b64.txt")) {
    const txt = atob(new TextDecoder().decode(bytes.subarray(0, got)).replace(/\s+/g, ""));
    bytes = new Uint8Array(txt.length);
    for (let i = 0; i < txt.length; i++) bytes[i] = txt.charCodeAt(i);
    got = bytes.length;
  }
  bytes = bytes.subarray(0, got);
  // gzipped by console_pack.py; a host may already have undone it (Content-Encoding), so look
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    say("Unpacking the house");
    const ds = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    bytes = new Uint8Array(await new Response(ds).arrayBuffer());
  }
  return { meta, groups: decode(meta, bytes) };
}

export async function initConsole(root, base) {
  const $ = (s) => root.querySelector(s);
  const canvas = $("canvas");
  const status = $("[data-status]");
  const say = (t) => { if (status) status.textContent = t; };

  say("Loading the house");
  const { meta, groups } = await load(base, say);
  const fz = meta.floor_z;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true });
  // where the splats thin out (a wall's foot, a corner) the house's own beige shows, not the page
  renderer.setClearColor(0x857d70, 1);
  // supersampled like the film (thin legs stay whole); back to the screen's own ratio if it runs slow
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(Math.min(dpr * 1.5, 2));
  const scene = new THREE.Scene();
  // classic 3DGS filtering, as gsplat renders the film (rasterize_mode "classic", eps2d 0.3): Spark's
  // default blur also scales a splat's opacity by its spread, which leaves thin legs faint and broken
  const spark = new SparkRenderer({ renderer, preBlurAmount: 0.3, blurAmount: 0 });
  scene.add(spark);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 60);
  camera.up.set(0, 0, 1);

  // ---- the house and the pieces
  const objects = [];          // pieces (and copies): {mesh, packed, g, proxy, removed, base, under, on, home}
  const packs = [];
  const rooms = [];            // the house's meshes, for picking: a click on a wall or the floor deselects
  const byGroup = new Map();
  groups.forEach((g, gi) => {
    const packed = new PackedSplats({ packedArray: g.rgb.slice(), numSplats: g.n });
    packs.push({ packed, g });
    const mesh = new SplatMesh({ packedSplats: packed });
    mesh.position.set(...g.pivot);
    scene.add(mesh);
    if (g.meta.cls) {
      const o = makeObject(mesh, packed, g);
      objects.push(o);
      byGroup.set(gi, o);
    } else rooms.push(mesh);
  });
  function makeObject(mesh, packed, g) {
    const s = g.meta.size;
    const proxy = new THREE.Mesh(new THREE.BoxGeometry(s[0], s[1], s[2]), new THREE.MeshBasicMaterial({ visible: false }));
    proxy.position.set(0, 0, g.meta.foot[2] - fz + s[2] / 2);
    mesh.add(proxy);
    return { mesh, packed, g, proxy, removed: false, on: null, under: [] };
  }
  // a piece standing on another (the vase on the coffee table) rides along with it
  objects.forEach((o) => {
    const p = o.g.meta.on != null ? byGroup.get(o.g.meta.on) : null;
    if (p) { o.on = p; o.base = p; p.under.push(o); p.mesh.attach(o.mesh); }
  });
  objects.forEach((o) => {
    o.home = { parent: o.mesh.parent, pos: o.mesh.position.clone(), rot: o.mesh.rotation.z, on: o.on, under: [...o.under] };
  });

  // floor ring under the selected piece
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.955, 1.0, 96),
    new THREE.MeshBasicMaterial({ color: 0x5ad7ee, transparent: true, opacity: 0.75, depthWrite: false }));
  ring.visible = false;
  ring.renderOrder = 10;
  scene.add(ring);

  // ---- where one can stand: the walking grid (floor, no wall) and the pieces standing on the floor
  const walk = meta.walk;
  const grid = walk ? Uint8Array.from(atob(walk.bits), (c) => c.charCodeAt(0)) : null;
  const freeCell = (x, y) => {
    if (!grid) return true;
    const i = Math.floor((x - walk.lo[0]) / walk.cell), j = Math.floor((y - walk.lo[1]) / walk.cell);
    if (i < 0 || j < 0 || i >= walk.w || j >= walk.h) return false;
    const k = j * walk.w + i;
    return (grid[k >> 3] >> (7 - (k & 7))) & 1;
  };
  const tmpV = new THREE.Vector3();
  function inPiece(x, y, pad) {
    for (const o of objects) {
      if (o.removed || o.on || o.g.meta.foot[2] - fz > 0.3) continue;
      const s = o.g.meta.size;
      o.mesh.getWorldPosition(tmpV);
      const c = Math.cos(-o.mesh.rotation.z), sn = Math.sin(-o.mesh.rotation.z);
      const dx = x - tmpV.x, dy = y - tmpV.y;
      const lx = c * dx - sn * dy, ly = sn * dx + c * dy;
      if (Math.abs(lx) < s[0] / 2 + pad && Math.abs(ly) < s[1] / 2 + pad) return true;
    }
    return false;
  }
  function canStand(x, y) {
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      if (!freeCell(x + RADIUS * Math.cos(a), y + RADIUS * Math.sin(a))) return false;
    }
    return freeCell(x, y) && !inPiece(x, y, 0.12);
  }

  // ---- the walker: position on the floor, eye height, yaw / pitch
  const st = meta.start || { eye: [0, 0, fz + 1.5], target: [1, 0, fz + 1.4], hfov: 64 };
  const me = { x: 0, y: 0, yaw: 0, pitch: 0 };
  const eyeZ = st.eye[2];
  const hfov = THREE.MathUtils.degToRad(st.hfov || 64);
  function goStart() {
    me.x = st.eye[0];
    me.y = st.eye[1];
    const d = st.target.map((v, i) => v - st.eye[i]);
    me.yaw = Math.atan2(d[1], d[0]);
    me.pitch = Math.atan2(d[2], Math.hypot(d[0], d[1]));
    applyCamera();
  }
  function applyCamera() {
    me.pitch = THREE.MathUtils.clamp(me.pitch, -1.3, 1.3);
    camera.position.set(me.x, me.y, eyeZ);
    const cp = Math.cos(me.pitch);
    tmpV.set(me.x + cp * Math.cos(me.yaw), me.y + cp * Math.sin(me.yaw), eyeZ + Math.sin(me.pitch));
    camera.lookAt(tmpV);
    camera.updateMatrixWorld();
  }
  function step(fwd, side, dt) {
    if (!fwd && !side) return;
    const v = (keys.has("ShiftLeft") || keys.has("ShiftRight") ? 2 : 1) * SPEED * dt;
    const n = Math.hypot(fwd, side) || 1;
    const dx = v * (Math.cos(me.yaw) * fwd + Math.sin(me.yaw) * side) / n;
    const dy = v * (Math.sin(me.yaw) * fwd - Math.cos(me.yaw) * side) / n;
    const stuck = !canStand(me.x, me.y);            // started inside something: let it walk out
    if (stuck || canStand(me.x + dx, me.y + dy)) { me.x += dx; me.y += dy; }
    else if (canStand(me.x + dx, me.y)) me.x += dx;  // slide along the wall
    else if (canStand(me.x, me.y + dy)) me.y += dy;
  }

  // ---- state
  let semantic = false;
  let selected = null;
  const label = $("[data-label]");
  const actions = root.querySelectorAll("[data-act]");
  const keys = new Set();

  function setSemantic(on) {
    // only when it changes (Reset turns it off): new splat arrays make Spark sort all of them again
    if (on !== semantic) {
      for (const { packed, g } of packs) {
        packed.packedArray.set(on ? g.sem : g.rgb);
        packed.needsUpdate = true;
      }
      // every mesh drawing these splats (copies share their source's) regenerates
      scene.traverse((m) => { if (m instanceof SplatMesh) m.updateVersion(); });
    }
    semantic = on;
    root.classList.toggle("is-semantic", on);
    $("[data-legend]").hidden = !on;
    root.querySelectorAll("[data-view]").forEach((b) => b.setAttribute("aria-pressed", String((b.dataset.view === "sem") === on)));
  }

  function dimAll(sel) {
    const lit = new Set();
    if (sel) { lit.add(sel.mesh); sel.under.forEach((c) => lit.add(c.mesh)); }
    scene.traverse((m) => {
      if (m instanceof SplatMesh) {
        const s = !sel || lit.has(m) ? 1 : 0.45;
        m.recolor.setRGB(s, s, s * 1.04);
        m.updateVersion();
      }
    });
  }

  function select(o) {
    selected = o;
    dimAll(o);
    ring.visible = !!o;
    actions.forEach((b) => { if (b.dataset.act !== "reset") b.disabled = !o; });
    if (o) {
      const s = o.g.meta.size;
      ring.scale.setScalar(0.42 * Math.hypot(s[0], s[1]) + 0.04);
      label.hidden = false;
      label.querySelector("[data-name]").textContent = o.g.meta.cls.replace("_", " ");
      const pc = meta.palette[o.g.meta.cls];
      label.style.setProperty("--dot", `rgb(${pc.join(",")})`);
      say(`Selected: ${o.g.meta.cls.replace("_", " ")}. Drag it to move it, Q / E to turn, C to copy, X to remove.`);
    } else {
      label.hidden = true;
      say("Walk with W A S D or the arrow keys, drag to look around, click a piece of furniture.");
    }
    placeRing();
  }
  function placeRing() {
    if (!selected) return;
    selected.mesh.getWorldPosition(tmpV);
    ring.position.set(tmpV.x, tmpV.y, selected.g.meta.foot[2] + (tmpV.z - fz) + 0.012);
  }

  // a dragged or copied piece stays over the house; a piece that stood on another stands on it
  // again when it is put back over it, and on the floor anywhere else
  function clampToPlan(o, pos) {
    const s = o.g.meta.size, h = 0.35 * Math.min(s[0], s[1]);
    pos.x = THREE.MathUtils.clamp(pos.x, meta.lo[0] + h, meta.hi[0] - h);
    pos.y = THREE.MathUtils.clamp(pos.y, meta.lo[1] + h, meta.hi[1] - h);
    return pos;
  }
  function overSupport(o, x, y) {
    const p = o.base;                 // what it stood on in the house as generated
    if (!p || p.removed) return null;
    const s = p.g.meta.size;
    p.mesh.getWorldPosition(tmpV);
    const c = Math.cos(-p.mesh.rotation.z), sn = Math.sin(-p.mesh.rotation.z);
    const dx = x - tmpV.x, dy = y - tmpV.y;
    return Math.abs(c * dx - sn * dy) < s[0] / 2 && Math.abs(sn * dx + c * dy) < s[1] / 2 ? p : null;
  }
  function settle(o) {
    if (!o.base) return;
    const lift = o.g.meta.foot[2] - fz;
    scene.attach(o.mesh);
    const p = overSupport(o, o.mesh.position.x, o.mesh.position.y);
    if (o.on) o.on.under = o.on.under.filter((u) => u !== o);
    o.on = p;
    if (p) { o.mesh.position.z = fz; p.mesh.attach(o.mesh); p.under.push(o); }
    else o.mesh.position.z = fz - lift;
  }

  // ---- picking: the first splat the ray meets decides (Spark's splat raycast), so a piece behind
  // another piece's bounding box can be clicked; when that splat is the house's (a click between a
  // chair's legs lands on the floor), a piece whose box the ray enters first still counts
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  function pointer(e) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
  }
  function pick() {
    const live = objects.filter((o) => !o.removed);
    const hits = ray.intersectObjects([...rooms, ...live.map((o) => o.mesh)], false);
    const first = hits.length ? live.find((o) => o.mesh === hits[0].object) : null;
    if (first) return first;
    const far = hits.length ? hits[0].distance : Infinity;
    const boxes = ray.intersectObjects(live.map((o) => o.proxy), false).filter((h) => h.distance < far);
    return boxes.length ? live.find((o) => o.proxy === boxes[0].object) : null;
  }

  // ---- pointer: drag the selected piece over the floor, drag anywhere else to look around
  let drag = null;
  let look = null;
  let downAt = null;
  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    pointer(e);
    downAt = [e.clientX, e.clientY];
    canvas.setPointerCapture(e.pointerId);
    const o = selected ? pick() : null;
    if (o && o === selected) {
      const w = o.mesh.getWorldPosition(new THREE.Vector3());
      const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -(fz + o.g.meta.foot[2] - fz + (w.z - fz)));
      const p = new THREE.Vector3();
      if (ray.ray.intersectPlane(plane, p)) {
        if (o.on) scene.attach(o.mesh);
        drag = { o, plane, from: p, start: o.mesh.position.clone() };
        root.classList.add("is-dragging");
        return;
      }
    }
    look = { x: e.clientX, y: e.clientY, yaw: me.yaw, pitch: me.pitch };
  });
  canvas.addEventListener("pointermove", (e) => {
    if (drag) {
      pointer(e);
      const p = new THREE.Vector3();
      if (ray.ray.intersectPlane(drag.plane, p)) {
        drag.o.mesh.position.set(drag.start.x + p.x - drag.from.x, drag.start.y + p.y - drag.from.y, drag.start.z);
        clampToPlan(drag.o, drag.o.mesh.position);
        placeRing();
      }
    } else if (look) {
      const k = (camera.fov * Math.PI) / 180 / canvas.clientHeight;   // one pixel of view
      me.yaw = look.yaw + (e.clientX - look.x) * k;
      me.pitch = look.pitch + (e.clientY - look.y) * k;
      applyCamera();
    }
  });
  const endPointer = (e) => {
    if (drag) {
      settle(drag.o);
      drag = null;
      root.classList.remove("is-dragging");
      placeRing();
    } else if (downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) < 5) {
      pointer(e);
      select(pick());
    }
    look = null;
    downAt = null;
  };
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", () => { drag = null; look = null; downAt = null; root.classList.remove("is-dragging"); });
  // the wheel walks forward / back (trackpads too)
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const n = Math.max(-1, Math.min(1, -e.deltaY / 120));
    for (let i = 0; i < 6; i++) step(n * 0.5, 0, 1 / 30);
    applyCamera();
  }, { passive: false });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  // ---- actions
  const faded = [];             // copies Reset took away, still in the scene at opacity 0
  function copyOne(o, parentMesh) {
    const mesh = new SplatMesh({ packedSplats: o.packed });
    mesh.position.copy(o.mesh.position);
    mesh.rotation.copy(o.mesh.rotation);
    (parentMesh || o.mesh.parent).add(mesh);
    const c = makeObject(mesh, o.packed, o.g);
    c.copy = true;
    c.base = o.base;
    objects.push(c);
    o.under.filter((u) => !u.removed).forEach((u) => { const cu = copyOne(u, mesh); cu.on = c; c.under.push(cu); });
    return c;
  }
  function act(name) {
    if (name === "reset") return reset();
    if (!selected) return;
    const o = selected;
    if (name === "left" || name === "right") {
      o.mesh.rotation.z += THREE.MathUtils.degToRad(name === "left" ? 15 : -15);
    } else if (name === "remove") {
      // opacity 0, not visible = false: Spark draws a changed set of meshes only once it has
      // sorted it again (all 1.1M splats), a changed opacity on the next frame
      const gone = (x) => { x.removed = true; x.mesh.opacity = 0; x.under.forEach(gone); };
      gone(o);
      select(null);
      say(`Removed the ${o.g.meta.cls.replace("_", " ")}. The floor under it is complete.`);
    } else if (name === "copy") {
      faded.splice(0).forEach((m) => m.parent?.remove(m));
      if (o.on) scene.attach(o.mesh);
      const c = copyOne(o, scene);
      if (o.on) o.on.mesh.attach(o.mesh);
      // beside the original, to the right as seen from here: its width that way + 15 cm
      const side = new THREE.Vector3(Math.sin(me.yaw), -Math.cos(me.yaw), 0);
      const local = side.clone().applyAxisAngle(new THREE.Vector3(0, 0, 1), -c.mesh.rotation.z);
      const stepW = 0.15 + Math.abs(local.x) * o.g.meta.size[0] + Math.abs(local.y) * o.g.meta.size[1];
      c.mesh.position.addScaledVector(side, stepW);
      clampToPlan(c, c.mesh.position);
      settle(c);
      select(c);
      say(`Copied the ${o.g.meta.cls.replace("_", " ")}. Drag the copy into place.`);
    }
  }
  function reset() {
    drag = null;
    look = null;
    root.classList.remove("is-dragging");
    for (let i = objects.length - 1; i >= 0; i--) {
      const o = objects[i];
      if (o.copy) {
        // no SplatMesh.dispose(): it also disposes the PackedSplats the copy shares with the
        // original piece. Faded out (see remove), and taken out of the scene at the next copy,
        // which changes the set of meshes anyway (Spark re-sorts once for both)
        o.mesh.opacity = 0;
        faded.push(o.mesh);
        objects.splice(i, 1);
      }
    }
    for (const o of objects) {
      o.on = o.home.on;
      o.under = [...o.home.under];
      o.removed = false;
      o.mesh.opacity = 1;
      // not add() when it is already there: that moves it to the end of the scene's list, and
      // Spark takes a reordered list of meshes for a new set and sorts every splat again
      if (o.mesh.parent !== o.home.parent) o.home.parent.add(o.mesh);
      o.mesh.position.copy(o.home.pos);
      o.mesh.rotation.set(0, 0, o.home.rot);
    }
    select(null);
    setSemantic(false);
    goStart();
  }
  actions.forEach((b) => b.addEventListener("click", () => act(b.dataset.act)));
  root.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => setSemantic(b.dataset.view === "sem")));

  // ---- keyboard: held keys walk (read every frame); single presses act
  const active = () => root.isConnected && !root.closest("[hidden]");
  const MOVE = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft", "ShiftRight"]);
  window.addEventListener("keydown", (e) => {
    if (!active() || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest && e.target.closest("input, textarea, select")) return;
    if (MOVE.has(e.code)) { keys.add(e.code); e.preventDefault(); return; }
    if (e.repeat) return;
    if (e.code === "KeyQ") act("left");
    else if (e.code === "KeyE") act("right");
    else if (e.code === "KeyC") act("copy");
    else if (e.code === "KeyX" || e.code === "Delete" || e.code === "Backspace") { act("remove"); e.preventDefault(); }
    else if (e.code === "KeyT") setSemantic(!semantic);
    else if (e.code === "Escape") select(null);
  });
  window.addEventListener("keyup", (e) => keys.delete(e.code));
  window.addEventListener("blur", () => keys.clear());
  // touch: the on-screen pad holds the same keys
  root.querySelectorAll("[data-key]").forEach((b) => {
    const k = b.dataset.key;
    b.addEventListener("pointerdown", (e) => { e.preventDefault(); keys.add(k); b.setPointerCapture(e.pointerId); });
    const up = () => keys.delete(k);
    b.addEventListener("pointerup", up);
    b.addEventListener("pointercancel", up);
  });
  function update(dt) {
    const fwd = (keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0) - (keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0);
    const side = (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0);
    const turn = (keys.has("ArrowLeft") ? 1 : 0) - (keys.has("ArrowRight") ? 1 : 0);
    if (turn) me.yaw += turn * TURN * dt;
    step(fwd, side, dt);
    if (fwd || side || turn) applyCamera();
  }

  // legend: the classes present in the house
  const counts = {};
  groups.forEach((g) => g.cls.forEach((k) => { counts[k] = (counts[k] || 0) + 1; }));
  const leg = $("[data-legend]");
  Object.keys(counts).map(Number).filter((k) => counts[k] > 0.002 * meta.n).sort((a, b) => counts[b] - counts[a]).forEach((k) => {
    const li = document.createElement("li");
    const pc = meta.palette[meta.labels[k]] || [120, 120, 120];
    li.innerHTML = `<i style="background:rgb(${pc.join(",")})"></i>${meta.labels[k].replace("_", " ")}`;
    leg.appendChild(li);
  });

  // ---- loop
  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * renderer.getPixelRatio()) || canvas.height !== Math.round(h * renderer.getPixelRatio())) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      // the film's horizontal field of view, the vertical one at most 80 deg (phones held upright)
      camera.fov = Math.min(80, THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(hfov / 2) / camera.aspect)));
      camera.updateProjectionMatrix();
    }
  }
  const tmpL = new THREE.Vector3();
  function drawLabel() {
    if (!selected) return;
    selected.mesh.getWorldPosition(tmpL);
    tmpL.z += selected.g.meta.foot[2] - fz + selected.g.meta.size[2] + 0.12;
    tmpL.project(camera);
    const r = canvas.getBoundingClientRect();
    label.hidden = tmpL.z > 1;
    label.style.transform = `translate(${((tmpL.x + 1) / 2) * r.width}px, ${((1 - tmpL.y) / 2) * r.height}px) translate(-50%, -100%)`;
  }
  const clock = new THREE.Clock();
  const slow = [];             // frame times while supersampled: median over 1/30 s drops it, once
  renderer.setAnimationLoop(() => {
    const dt0 = clock.getDelta(), dt = Math.min(dt0, 0.1);
    if (!active()) return;
    if (renderer.getPixelRatio() > dpr && dt0 < 1 && slow.push(dt0) >= 90) {
      slow.sort((p, q) => p - q);
      if (slow[45] > 1 / 30) renderer.setPixelRatio(dpr);
      slow.length = 0;
    }
    resize();
    update(dt);
    renderer.render(scene, camera);
    drawLabel();
  });
  resize();
  goStart();
  select(null);
  setSemantic(false);
  root.classList.add("is-ready");

  // ---- for page tests: stop the loop / step and draw one frame / screen position of a piece /
  // look from an eye at a target / where the walker is
  const stop = () => renderer.setAnimationLoop(null);
  const frame = (dt = 1 / 30) => { resize(); update(dt); renderer.render(scene, camera); drawLabel(); };
  const where = (i) => {
    const o = objects[i];
    const v = o.mesh.getWorldPosition(new THREE.Vector3());
    v.z += o.g.meta.foot[2] - fz + o.g.meta.size[2] * 0.5;
    v.project(camera);
    const r = canvas.getBoundingClientRect();
    return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
  };
  const lookAt = (eye, tgt) => {
    me.x = eye[0]; me.y = eye[1];
    const d = tgt.map((v, i) => v - eye[i]);
    me.yaw = Math.atan2(d[1], d[0]);
    me.pitch = Math.atan2(d[2], Math.hypot(d[0], d[1]));
    applyCamera();
  };
  const pose = () => ({ ...me });
  // how many meshes the picture on screen is made of (Spark shows a new set once it is sorted)
  const shown = () => spark.display?.mapping?.length ?? -1;
  const filter = (pre, blur) => { spark.preBlurAmount = pre; spark.blurAmount = blur; };
  const ratio = (r) => { if (r) renderer.setPixelRatio(r); return renderer.getPixelRatio(); };
  // splats per group in the file vs. what Spark holds (they must match)
  const held = () => packs.map((p) => [p.g.n, p.packed.numSplats]);
  return { reset, select, setSemantic, act, stop, frame, where, objects, look: lookAt, pose, keys, canStand, shown, filter, ratio, held };
}
