// Interactive Console (v4, 2026-11-06): the house from the promo film's first part, as 3D Gaussians,
// seen whole from above and turned around by dragging (the overview of the ATAS console; v3 walked
// through it at eye level, _console/v4/console.js). The ceiling is left out so the rooms show from
// above. Every splat carries the class UniGaussianGPT predicted for it; each piece of furniture is one
// instance, a separate, complete piece, and carries a label with its class. Click a piece (or its
// label) to colour it by its class; then move, turn, copy or remove it. Data: scene.bin / scene.json
// from homepage/tools/console_pack.py.
import * as THREE from "three";
import { SparkRenderer, SplatMesh, PackedSplats, utils } from "spark";

const STRIDE = 18;
const CEILING = "ceiling";
// the walls' top 0.2 m is a white band of ceiling-coloured splats (the ceiling sits at 2.42-2.64 m,
// the walls' own colour stops at ~2.45 m): seen from above it drew as a frayed white rim
const WALL_TOP = 2.48;

// byte j of splat i: at i * STRIDE + j (interleaved) or j * n + i (byte-planar, compresses better)
function decode(meta, bytes) {
  const n_ = meta.n;
  const planar = meta.layout === "byte-planar";
  const u8 = planar ? (i, j) => bytes[j * n_ + i] : (i, j) => bytes[i * STRIDE + j];
  const u16 = (i, j) => u8(i, j) | (u8(i, j + 1) << 8);
  const i8 = (i, j) => (u8(i, j) << 24) >> 24;
  const lo = meta.lo, span = meta.hi.map((h, i) => h - meta.lo[i]);
  const ceil = meta.labels.indexOf(CEILING);
  const floor = meta.labels.indexOf("floor");
  // the walls each splat of the house (but the floor's) belongs to: the nearest wall line within
  // 0.5 m, so that the walls facing the camera can be faded out (meta.walls, from the film's rooms)
  const walls = meta.walls || [];
  const wallOf = (x, y) => {
    let best = -1, bd = 0.5;
    walls.forEach((w, i) => {
      const ex = w.b[0] - w.a[0], ey = w.b[1] - w.a[1];
      const t = Math.max(0, Math.min(1, ((x - w.a[0]) * ex + (y - w.a[1]) * ey) / (ex * ex + ey * ey || 1)));
      const d = Math.hypot(x - w.a[0] - t * ex, y - w.a[1] - t * ey);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  };
  const groups = [];
  let off = 0;
  meta.groups.forEach((g, gi) => {
    // the house's splats without the ceiling (its class) and the walls' white top; a piece keeps all
    // of its own
    const top = Math.round(((WALL_TOP - lo[2]) / span[2]) * 65535);
    const kept = [];
    for (let i = 0; i < g.n; i++) if (g.cls || (u8(off + i, 17) !== ceil && u16(off + i, 4) <= top)) kept.push(off + i);
    // the house's tile split by wall (-1: the floor and anything away from the walls)
    const parts = new Map();
    for (const b of kept) {
      let w = -1;
      if (!g.cls && walls.length && u8(b, 17) !== floor) w = wallOf(lo[0] + (u16(b, 0) / 65535) * span[0], lo[1] + (u16(b, 2) / 65535) * span[1]);
      if (!parts.has(w)) parts.set(w, []);
      parts.get(w).push(b);
    }
    for (const [wall, keep] of parts) {
      const n = keep.length;
      // positions relative to a pivot near the splats: Spark keeps centres as float16
      const pivot = g.pivot || (g.cls ? [g.foot[0], g.foot[1], meta.floor_z] : [0, 0, 0]);
      // room for a whole number of 2048-splat texture rows: given a packedArray, PackedSplats keeps
      // only floor(length / 4 / 2048) * 2048 splats, and the last ones of a piece are the legs
      // and back posts that figs/film3/legs.py rebuilt (a chair's 9443 drew as 8192, no posts)
      const cap = Math.max(2048, Math.ceil(n / 2048) * 2048);
      const rgb = new Uint32Array(cap * 4);
      const sem = new Uint32Array(cap * 4);
      const cls = new Uint8Array(n);
      keep.forEach((b, i) => {
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
      });
      if (n) groups.push({ meta: g, gi, pivot, rgb, sem, cls, n, wall: wall >= 0 ? walls[wall] : null });
    }
    off += g.n;
  });
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

const nice = (c) => c.replace("_", " ");

export async function initConsole(root, base) {
  const $ = (s) => root.querySelector(s);
  const canvas = $("canvas");
  const status = $("[data-status]");
  const tags = $("[data-tags]");
  const say = (t) => { if (status) status.textContent = t; };

  say("Loading the house");
  const { meta, groups } = await load(base, say);
  const fz = meta.floor_z;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  // the console's own light grey around the house (the page behind it is white)
  renderer.setClearColor(0xe6ecea, 1);
  // supersampled like the film (thin legs stay whole); back to the screen's own ratio if it runs slow
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(Math.min(dpr * 1.5, 2));
  const scene = new THREE.Scene();
  // classic 3DGS filtering, as gsplat renders the film (rasterize_mode "classic", eps2d 0.3): Spark's
  // default blur also scales a splat's opacity by its spread, which leaves thin legs faint and broken
  const spark = new SparkRenderer({ renderer, preBlurAmount: 0.3, blurAmount: 0 });
  scene.add(spark);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  camera.up.set(0, 0, 1);

  // ---- the house and the pieces
  const objects = [];          // pieces (and copies): {mesh, packed, g, proxy, removed, sem, tag, on, under, home}
  const rooms = [];            // the house's meshes: {mesh, packed, g, painted}
  const byGroup = new Map();
  groups.forEach((g) => {
    const packed = new PackedSplats({ packedArray: g.rgb.slice(), numSplats: g.n });
    const mesh = new SplatMesh({ packedSplats: packed });
    mesh.position.set(...g.pivot);
    scene.add(mesh);
    if (g.meta.cls) {
      const o = makeObject(mesh, packed, g);
      objects.push(o);
      byGroup.set(g.gi, o);
    } else rooms.push({ mesh, packed, g, painted: false, fade: 1 });
  });
  function makeObject(mesh, packed, g) {
    const s = g.meta.size;
    const proxy = new THREE.Mesh(new THREE.BoxGeometry(s[0], s[1], s[2]), new THREE.MeshBasicMaterial({ visible: false }));
    proxy.position.set(0, 0, g.meta.foot[2] - fz + s[2] / 2);
    mesh.add(proxy);
    const o = { mesh, packed, g, proxy, removed: false, sem: false, painted: false, on: null, under: [] };
    o.tag = makeTag(o);
    return o;
  }
  // a piece standing on another (the vase on the coffee table) rides along with it
  objects.forEach((o) => {
    const p = o.g.meta.on != null ? byGroup.get(o.g.meta.on) : null;
    if (p) { o.on = p; o.base = p; p.under.push(o); p.mesh.attach(o.mesh); }
  });
  objects.forEach((o) => {
    o.home = { parent: o.mesh.parent, pos: o.mesh.position.clone(), rot: o.mesh.rotation.z, on: o.on, under: [...o.under] };
  });

  // ---- the orbit: a target over the middle of the house, the camera on a sphere around it
  const lo = meta.lo, hi = meta.hi;
  const mid = new THREE.Vector3((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, fz + 0.6);
  const v0 = meta.orbit || { az: -62, el: 52 };
  // the start azimuth: meta.orbit.az on a wide screen (from the front, the house across the frame), its
  // portrait_az on a phone held upright (more from the end, so the long house runs up the screen)
  const startAz = () => THREE.MathUtils.degToRad(camera.aspect < 1 && v0.portrait_az != null ? v0.portrait_az : v0.az);
  const view = { az: 0, el: 0, dist: 10, target: mid.clone() };
  const EL = [THREE.MathUtils.degToRad(28), THREE.MathUtils.degToRad(84)];
  let fit = 10;                // the distance at which the whole house fills the view
  function fitDist() {
    // the house's box (floor to the wall tops) seen from the start view fills the frame, ~6% margin:
    // the nearest distance at which its eight corners all project inside
    const az = startAz(), el = THREE.MathUtils.degToRad(v0.el);
    const dir = new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el));
    const cam = camera.clone();
    cam.updateProjectionMatrix();
    const p = new THREE.Vector3();
    const inside = (d) => {
      cam.position.copy(mid).addScaledVector(dir, d);
      cam.lookAt(mid);
      cam.updateMatrixWorld();
      for (let i = 0; i < 8; i++) {
        p.set(i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? WALL_TOP : fz).project(cam);
        if (Math.abs(p.x) > 0.94 || Math.abs(p.y) > 0.9 || p.z > 1) return false;
      }
      return true;
    };
    let a = 1, b = 80;
    for (let i = 0; i < 24; i++) { const m = (a + b) / 2; if (inside(m)) b = m; else a = m; }
    return b;
  }
  function goStart() {
    view.az = startAz();
    view.el = THREE.MathUtils.degToRad(v0.el);
    view.target.copy(mid);
    view.dist = fit * (v0.k || 1);
    applyCamera();
  }
  const tmpV = new THREE.Vector3();
  function applyCamera() {
    view.el = THREE.MathUtils.clamp(view.el, EL[0], EL[1]);
    view.dist = THREE.MathUtils.clamp(view.dist, 0.35 * fit, 1.7 * fit);
    view.target.x = THREE.MathUtils.clamp(view.target.x, lo[0], hi[0]);
    view.target.y = THREE.MathUtils.clamp(view.target.y, lo[1], hi[1]);
    const c = Math.cos(view.el);
    camera.position.set(view.target.x + view.dist * c * Math.cos(view.az), view.target.y + view.dist * c * Math.sin(view.az),
      view.target.z + view.dist * Math.sin(view.el));
    camera.lookAt(view.target);
    camera.updateMatrixWorld();
  }

  // ---- colours: the whole house by class (the View switch), or one piece by its class (a click)
  let semantic = false;
  let active = null;           // the piece the edit buttons act on (the last one clicked on)
  const actions = root.querySelectorAll("[data-act]");
  function paintPack(x, on) {
    if (x.painted === on) return;
    x.packed.packedArray.set(on ? x.g.sem : x.g.rgb);
    x.packed.needsUpdate = true;
    x.painted = on;
    x.mesh.updateVersion();
  }
  function paint() {
    rooms.forEach((r) => paintPack(r, semantic));
    objects.forEach((o) => paintPack(o, semantic || o.sem));
    objects.forEach((o) => {
      o.tag.classList.toggle("is-on", semantic || o.sem);
      o.tag.classList.toggle("is-active", o === active);
      o.tag.setAttribute("aria-pressed", String(o.sem));
    });
  }
  function setSemantic(on) {
    semantic = on;
    root.classList.toggle("is-semantic", on);
    $("[data-legend]").hidden = !on;
    root.querySelectorAll("[data-view]").forEach((b) => b.setAttribute("aria-pressed", String((b.dataset.view === "sem") === on)));
    paint();
  }
  function setActive(o) {
    active = o;
    actions.forEach((b) => { if (b.dataset.act !== "reset") b.disabled = !o; });
    if (o) {
      say(`${nice(o.g.meta.cls)[0].toUpperCase() + nice(o.g.meta.cls).slice(1)}: a separate, complete piece. Drag it to move it, Q / E turn it, C copies it, X removes it.`);
    } else {
      say("Drag to turn the house, scroll to zoom. Click a piece of furniture or its label to color it by its class.");
    }
    paint();
  }
  // a click on a piece colours it by its class and makes it the one the buttons act on; a second
  // click takes the colour off again
  function toggle(o) {
    if (o.sem && (o === active || !active)) { o.sem = false; setActive(active === o ? null : active); return; }
    o.sem = true;
    setActive(o);
  }

  // ---- labels: every piece's class over it, in the class colour; where labels would overlap the
  // larger piece's wins (the active one and the coloured ones first)
  function makeTag(o) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tag";
    const pc = meta.palette[o.g.meta.cls] || [120, 120, 120];
    b.style.setProperty("--dot", `rgb(${pc.join(",")})`);
    // text on the coloured chip: dark on the light classes (stool, lamp, decor), white otherwise
    const lum = (0.2126 * pc[0] + 0.7152 * pc[1] + 0.0722 * pc[2]) / 255;
    b.style.setProperty("--on-ink", lum > 0.62 ? "#1f2428" : "#fff");
    b.innerHTML = `<i></i>${nice(o.g.meta.cls)}`;
    b.setAttribute("aria-label", `${nice(o.g.meta.cls)}: color it by its class`);
    b.addEventListener("click", (e) => { e.stopPropagation(); stopSpin(); toggle(o); });
    tags.appendChild(b);
    return b;
  }
  const tmpL = new THREE.Vector3();
  function drawTags() {
    const W = canvas.clientWidth, H = canvas.clientHeight;
    const live = objects.filter((o) => !o.removed);
    const order = live.map((o) => {
      const s = o.g.meta.size;
      return { o, k: (o === active ? 1e6 : 0) + (o.sem ? 1e5 : 0) + s[0] * s[1] * (1 + s[2]) };
    }).sort((a, b) => b.k - a.k);
    const placed = [];
    for (const { o } of order) {
      o.mesh.getWorldPosition(tmpL);
      tmpL.z += o.g.meta.foot[2] - fz + o.g.meta.size[2] + 0.06;
      tmpL.project(camera);
      const x = ((tmpL.x + 1) / 2) * W, y = ((1 - tmpL.y) / 2) * H;
      // a label's size is read once (reading it every frame after moving them forces a layout)
      if (!o.tagW) { o.tagW = o.tag.offsetWidth; o.tagH = o.tag.offsetHeight; }
      const w = o.tagW || 70, h = o.tagH || 24;
      const r = [x - w / 2 - 3, y - h - 3, x + w / 2 + 3, y + 3];
      const inView = tmpL.z < 1 && r[2] > 0 && r[0] < W && r[3] > 0 && r[1] < H;
      const free = inView && !placed.some((p) => r[0] < p[2] && r[2] > p[0] && r[1] < p[3] && r[3] > p[1]);
      if (free) placed.push(r);
      o.tag.classList.toggle("is-hidden", !free);
      o.tag.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
    }
    objects.filter((o) => o.removed).forEach((o) => o.tag.classList.add("is-hidden"));
  }

  // a dragged or copied piece stays over the house; a piece that stood on another stands on it
  // again when it is put back over it, and on the floor anywhere else
  function clampToPlan(o, pos) {
    const s = o.g.meta.size, h = 0.35 * Math.min(s[0], s[1]);
    pos.x = THREE.MathUtils.clamp(pos.x, lo[0] + h, hi[0] - h);
    pos.y = THREE.MathUtils.clamp(pos.y, lo[1] + h, hi[1] - h);
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
    const hits = ray.intersectObjects([...rooms.filter((r) => r.fade > 0.5).map((r) => r.mesh), ...live.map((o) => o.mesh)], false);
    const first = hits.length ? live.find((o) => o.mesh === hits[0].object) : null;
    if (first) return first;
    const far = hits.length ? hits[0].distance : Infinity;
    const boxes = ray.intersectObjects(live.map((o) => o.proxy), false).filter((h) => h.distance < far);
    return boxes.length ? live.find((o) => o.proxy === boxes[0].object) : null;
  }

  // ---- until the first touch the house sways a little about the start view (a whole turn passed through
  // the end-on views, where the long house is a sliver and the walls fade in and out)
  let spin = true, swayT = 0;
  const SWAY = THREE.MathUtils.degToRad(9);
  function stopSpin() { spin = false; }

  // ---- pointers: drag the active piece over the floor; drag anywhere else to turn the house
  // (right button, Shift, or two fingers: slide it; the wheel or a pinch: zoom)
  const pts = new Map();
  let drag = null, orbit = null, downAt = null, pinch = null;
  canvas.addEventListener("pointerdown", (e) => {
    stopSpin();
    canvas.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), dist: view.dist, c: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], t: view.target.clone() };
      orbit = null; drag = null; downAt = null;
      return;
    }
    pointer(e);
    downAt = [e.clientX, e.clientY];
    const o = active ? pick() : null;
    if (o && o === active && e.button === 0) {
      const w = o.mesh.getWorldPosition(new THREE.Vector3());
      const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -(o.g.meta.foot[2] + (w.z - fz)));
      const p = new THREE.Vector3();
      if (ray.ray.intersectPlane(plane, p)) {
        if (o.on) scene.attach(o.mesh);
        drag = { o, plane, from: p, start: o.mesh.position.clone() };
        root.classList.add("is-dragging");
        return;
      }
    }
    orbit = { x: e.clientX, y: e.clientY, az: view.az, el: view.el, t: view.target.clone(), pan: e.button === 2 || e.shiftKey };
    root.classList.add("is-dragging");
  });
  // a pixel of drag on the ground, at the target's distance
  const groundPx = () => (2 * view.dist * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / canvas.clientHeight;
  function slide(t, dx, dy) {
    const k = groundPx();
    const rx = -Math.sin(view.az), ry = Math.cos(view.az);         // screen right, on the ground
    const fx = -Math.cos(view.az), fy = -Math.sin(view.az);        // screen up, on the ground
    view.target.set(t.x - k * (dx * rx - dy * fx / Math.max(0.35, Math.sin(view.el))), t.y - k * (dx * ry - dy * fy / Math.max(0.35, Math.sin(view.el))), t.z);
  }
  canvas.addEventListener("pointermove", (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pinch && pts.size === 2) {
      const [a, b] = [...pts.values()];
      view.dist = pinch.dist * pinch.d / Math.max(20, Math.hypot(a[0] - b[0], a[1] - b[1]));
      slide(pinch.t, (a[0] + b[0]) / 2 - pinch.c[0], (a[1] + b[1]) / 2 - pinch.c[1]);
      applyCamera();
    } else if (drag) {
      pointer(e);
      const p = new THREE.Vector3();
      if (ray.ray.intersectPlane(drag.plane, p)) {
        drag.o.mesh.position.set(drag.start.x + p.x - drag.from.x, drag.start.y + p.y - drag.from.y, drag.start.z);
        clampToPlan(drag.o, drag.o.mesh.position);
      }
    } else if (orbit) {
      const dx = e.clientX - orbit.x, dy = e.clientY - orbit.y;
      if (orbit.pan) slide(orbit.t, dx, dy);
      else { view.az = orbit.az - dx * 0.0065; view.el = orbit.el + dy * 0.0045; }
      applyCamera();
    }
  });
  const endPointer = (e) => {
    pts.delete(e.pointerId);
    if (pinch) { if (pts.size < 2) pinch = null; return; }
    if (drag) {
      settle(drag.o);
      drag = null;
    } else if (downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) < 5) {
      pointer(e);
      const o = pick();
      if (o) toggle(o);
      else if (active) setActive(null);
    }
    orbit = null;
    downAt = null;
    root.classList.remove("is-dragging");
  };
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", (e) => { pts.delete(e.pointerId); drag = null; orbit = null; pinch = null; downAt = null; root.classList.remove("is-dragging"); });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    stopSpin();
    view.dist *= Math.exp(THREE.MathUtils.clamp(e.deltaY, -120, 120) * 0.0016);
    applyCamera();
  }, { passive: false });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  // ---- actions
  const faded = [];             // copies Reset took away, still in the scene at opacity 0
  function copyOne(o, parentMesh) {
    // its own splats (so colouring the copy leaves the original as it is)
    const packed = new PackedSplats({ packedArray: (o.painted ? o.g.sem : o.g.rgb).slice(), numSplats: o.g.n });
    const mesh = new SplatMesh({ packedSplats: packed });
    mesh.position.copy(o.mesh.position);
    mesh.rotation.copy(o.mesh.rotation);
    (parentMesh || o.mesh.parent).add(mesh);
    const c = makeObject(mesh, packed, o.g);
    c.painted = o.painted;
    c.copy = true;
    c.base = o.base;
    objects.push(c);
    o.under.filter((u) => !u.removed).forEach((u) => { const cu = copyOne(u, mesh); cu.on = c; c.under.push(cu); });
    return c;
  }
  function act(name) {
    if (name === "reset") return reset();
    if (!active) return;
    const o = active;
    if (name === "left" || name === "right") {
      o.mesh.rotation.z += THREE.MathUtils.degToRad(name === "left" ? 15 : -15);
    } else if (name === "remove") {
      // opacity 0, not visible = false: Spark draws a changed set of meshes only once it has
      // sorted it again (all the splats), a changed opacity on the next frame
      const gone = (x) => { x.removed = true; x.mesh.opacity = 0; x.under.forEach(gone); };
      gone(o);
      setActive(null);
      say(`Removed the ${nice(o.g.meta.cls)}. The floor under it is complete.`);
    } else if (name === "copy") {
      faded.splice(0).forEach((m) => m.parent?.remove(m));
      if (o.on) scene.attach(o.mesh);
      const c = copyOne(o, scene);
      if (o.on) o.on.mesh.attach(o.mesh);
      // beside the original, to the right as seen from here: its width that way + 15 cm
      const side = new THREE.Vector3(-Math.sin(view.az), Math.cos(view.az), 0);
      const local = side.clone().applyAxisAngle(new THREE.Vector3(0, 0, 1), -c.mesh.rotation.z);
      const stepW = 0.15 + Math.abs(local.x) * o.g.meta.size[0] + Math.abs(local.y) * o.g.meta.size[1];
      c.mesh.position.addScaledVector(side, stepW);
      clampToPlan(c, c.mesh.position);
      settle(c);
      c.sem = o.sem;
      setActive(c);
      say(`Copied the ${nice(o.g.meta.cls)}. Drag the copy into place.`);
    }
  }
  function reset() {
    drag = null;
    orbit = null;
    root.classList.remove("is-dragging");
    for (let i = objects.length - 1; i >= 0; i--) {
      const o = objects[i];
      if (o.copy) {
        // no SplatMesh.dispose() while it may still be drawn: faded out (see remove), and taken
        // out of the scene at the next copy, which changes the set of meshes anyway
        o.mesh.opacity = 0;
        faded.push(o.mesh);
        o.tag.remove();
        objects.splice(i, 1);
      }
    }
    for (const o of objects) {
      o.on = o.home.on;
      o.under = [...o.home.under];
      o.removed = false;
      o.sem = false;
      o.mesh.opacity = 1;
      // not add() when it is already there: that moves it to the end of the scene's list, and
      // Spark takes a reordered list of meshes for a new set and sorts every splat again
      if (o.mesh.parent !== o.home.parent) o.home.parent.add(o.mesh);
      o.mesh.position.copy(o.home.pos);
      o.mesh.rotation.set(0, 0, o.home.rot);
    }
    setSemantic(false);
    setActive(null);
    goStart();
  }
  actions.forEach((b) => b.addEventListener("click", () => act(b.dataset.act)));
  root.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => setSemantic(b.dataset.view === "sem")));

  // ---- keyboard: arrows turn the house, + / - zoom; single presses act on the active piece
  const active_ = () => root.isConnected && !root.closest("[hidden]");
  const held = new Set();
  window.addEventListener("keydown", (e) => {
    if (!active_() || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest && e.target.closest("input, textarea, select")) return;
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Equal", "Minus", "NumpadAdd", "NumpadSubtract"].includes(e.code)) {
      held.add(e.code); stopSpin(); e.preventDefault(); return;
    }
    if (e.repeat) return;
    if (e.code === "KeyQ") act("left");
    else if (e.code === "KeyE") act("right");
    else if (e.code === "KeyC") act("copy");
    else if (e.code === "KeyX" || e.code === "Delete" || e.code === "Backspace") { act("remove"); e.preventDefault(); }
    else if (e.code === "KeyT") setSemantic(!semantic);
    else if (e.code === "Escape") setActive(null);
  });
  window.addEventListener("keyup", (e) => held.delete(e.code));
  window.addEventListener("blur", () => held.clear());
  // a wall the camera stands outside of fades out (a cut-away like a doll's house), the far walls
  // stay whole; the wall between the rooms (no outside) always stays
  function fadeWalls(dt) {
    const k = dt > 0 ? Math.min(1, dt * 7) : 1;
    for (const r of rooms) {
      const w = r.g.wall;
      if (!w || !w.n) continue;
      const out = (camera.position.x - w.a[0]) * w.n[0] + (camera.position.y - w.a[1]) * w.n[1];
      const want = out > 0.3 ? 0 : 1;
      if (Math.abs(r.fade - want) < 0.003) { if (r.fade !== want) { r.fade = want; r.mesh.opacity = want; } continue; }
      r.fade += (want - r.fade) * k;
      r.mesh.opacity = r.fade;
    }
  }
  function update(dt) {
    let moved = false;
    if (spin) { swayT += dt; view.az = startAz() + SWAY * Math.sin(swayT * 0.4); moved = true; }
    const turn = (held.has("ArrowLeft") ? 1 : 0) - (held.has("ArrowRight") ? 1 : 0);
    const tilt = (held.has("ArrowUp") ? 1 : 0) - (held.has("ArrowDown") ? 1 : 0);
    const zoom = (held.has("Minus") || held.has("NumpadSubtract") ? 1 : 0) - (held.has("Equal") || held.has("NumpadAdd") ? 1 : 0);
    if (turn) { view.az += turn * 1.2 * dt; moved = true; }
    if (tilt) { view.el += tilt * 0.8 * dt; moved = true; }
    if (zoom) { view.dist *= Math.exp(zoom * 1.2 * dt); moved = true; }
    if (moved) applyCamera();
  }

  // legend: the classes present in the house
  const counts = {};
  groups.forEach((g) => g.cls.forEach((k) => { counts[k] = (counts[k] || 0) + 1; }));
  const nAll = groups.reduce((s, g) => s + g.n, 0);
  const leg = $("[data-legend]");
  Object.keys(counts).map(Number).filter((k) => counts[k] > 0.002 * nAll).sort((a, b) => counts[b] - counts[a]).forEach((k) => {
    const li = document.createElement("li");
    const pc = meta.palette[meta.labels[k]] || [120, 120, 120];
    li.innerHTML = `<i style="background:rgb(${pc.join(",")})"></i>${nice(meta.labels[k])}`;
    leg.appendChild(li);
  });

  // ---- loop
  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * renderer.getPixelRatio()) || canvas.height !== Math.round(h * renderer.getPixelRatio())) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      // a moderate lens: 40 deg vertically, wider on a phone held upright
      camera.fov = camera.aspect < 1 ? 58 : 40;
      camera.updateProjectionMatrix();
      const f = fitDist();
      view.dist *= f / fit;
      fit = f;
      applyCamera();
    }
  }
  const clock = new THREE.Clock();
  const slow = [];             // frame times while supersampled: median over 1/30 s drops it, once
  renderer.setAnimationLoop(() => {
    const dt0 = clock.getDelta(), dt = Math.min(dt0, 0.1);
    if (!active_()) return;
    if (renderer.getPixelRatio() > dpr && dt0 < 1 && slow.push(dt0) >= 90) {
      slow.sort((p, q) => p - q);
      if (slow[45] > 1 / 30) renderer.setPixelRatio(dpr);
      slow.length = 0;
    }
    resize();
    update(dt);
    fadeWalls(dt);
    renderer.render(scene, camera);
    drawTags();
  });
  resize();
  fit = fitDist();
  goStart();
  setActive(null);
  setSemantic(false);
  root.classList.add("is-ready");

  // ---- for page tests: stop the loop / step and draw one frame / screen position of a piece /
  // set the view / splats per group in the file vs. what Spark holds (they must match)
  const stop = () => { spin = false; renderer.setAnimationLoop(null); };
  const frame = (dt = 1 / 30) => { resize(); update(dt); fadeWalls(dt); renderer.render(scene, camera); drawTags(); };
  const where = (i) => {
    const o = objects[i];
    const v = o.mesh.getWorldPosition(new THREE.Vector3());
    v.z += o.g.meta.foot[2] - fz + o.g.meta.size[2] * 0.5;
    v.project(camera);
    const r = canvas.getBoundingClientRect();
    return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
  };
  const setView = (az, el, k = 1) => { stopSpin(); view.az = THREE.MathUtils.degToRad(az); view.el = THREE.MathUtils.degToRad(el); view.dist = fit * k; applyCamera(); };
  const shown = () => spark.display?.mapping?.length ?? -1;
  const ratio = (r) => { if (r) renderer.setPixelRatio(r); return renderer.getPixelRatio(); };
  const held2 = () => [...rooms, ...objects].map((p) => [p.g.n, p.packed.numSplats]);
  const wallsShown = () => rooms.filter((r) => r.g.wall && r.g.wall.n).map((r) => [r.g.wall.name, +r.fade.toFixed(2)]);
  // the canvas as an image, drawn and read in one go (no preserveDrawingBuffer needed)
  const snap = (type = "image/jpeg") => { resize(); fadeWalls(0); renderer.render(scene, camera); drawTags(); return canvas.toDataURL(type, 0.92); };
  // where each label is drawn, and whether it is shown
  const tagBoxes = () => objects.map((o) => ({ cls: o.g.meta.cls, shown: !o.tag.classList.contains("is-hidden"), on: o.tag.classList.contains("is-on"), t: o.tag.style.transform }));
  return { reset, toggle, setActive, setSemantic, act, stop, frame, where, objects, setView, view, shown, ratio, held: held2, snap, tagBoxes, wallsShown };
}
