// The That Open (IFC) 3D engine for the schedule viewer: loaded only when the user picks it in the header switch, so the
// default APS view is untouched. It shows an IFC of the same building in the 3D slot; the schedule colors, the level
// section, fit / top / iso and picks are driven by the page through the small interface below, keyed by IFC GlobalId
// (ifc-guid.mjs turns the APS walls' Revit UniqueIds into those). The 2D pane stays the APS sheet.
// Libraries (loaded from the jsDelivr CDN on first use, pinned): @thatopen/components, @thatopen/fragments, three,
// web-ifc (WASM from unpkg). Docs: https://docs.thatopen.com/Tutorials/Components/Core/IfcLoader,
// https://docs.thatopen.com/Tutorials/Fragments/Fragments/IfcImporter,
// https://docs.thatopen.com/api/@thatopen/fragments/classes/FragmentsModel

// web-ifc 0.0.77: the version fragments 3.4.8 / components 3.4.9 were built against (0.0.78 changed StreamMeshes).
const V = { three: '0.186.1', components: '3.4.9', fragments: '3.4.8', webIfc: '0.0.77', cameraControls: '3.1.2' };
const CDN = 'https://cdn.jsdelivr.net/npm/';
// The IFC -> fragments converter with web-ifc pinned to 0.0.77 (jsDelivr would resolve 0.0.78 for it).
const IMPORTER = `https://esm.sh/@thatopen/fragments@${V.fragments}?deps=three@${V.three},web-ifc@${V.webIfc}`;
const WASM = `https://unpkg.com/web-ifc@${V.webIfc}/`;
const CACHE_DB = 'cas-ifc-fragments', CACHE_STORE = 'models';
// Selection: magenta, apart from the schedule's orange / blue / green.
const SELECTED = '#e535ab';

// Converted models (fragments) are kept in this browser, so a big IFC is converted once.
function cache(mode, key, value) {
    return new Promise((resolve) => {
        let req;
        try { req = indexedDB.open(CACHE_DB, 1); } catch { resolve(null); return; }
        req.onupgradeneeded = () => req.result.createObjectStore(CACHE_STORE);
        req.onerror = () => resolve(null);
        req.onsuccess = () => {
            try {
                const tx = req.result.transaction(CACHE_STORE, mode), store = tx.objectStore(CACHE_STORE);
                const op = mode === 'readonly' ? store.get(key) : store.put(value, key);
                op.onsuccess = () => resolve(mode === 'readonly' ? op.result || null : true);
                op.onerror = () => resolve(null);
            } catch { resolve(null); }
        };
    });
}

// Revit's default plan cut: 4'-0" above the level (View Range, Cut Plane). The IFC plan view cuts there.
export const REVIT_CUT = 1.2192;

// plan: a floor plan of the IFC (orthographic, looking straight down, rotation locked; planAt cuts it), else 3D.
export async function createIfcEngine(host, { onPick = () => {}, onStatus = () => {}, plan = false } = {}) {
    onStatus('Loading the Open IFC viewer (That Open engine)…');
    // jsDelivr's ESM builds for viewing (components 3.4.9 resolves to these three / fragments / camera-controls
    // versions, one shared three.js); the converter is loaded only when an IFC needs converting.
    const [THREE, OBC] = await Promise.all([
        import(`${CDN}three@${V.three}/+esm`),
        import(`${CDN}@thatopen/components@${V.components}/+esm`),
    ]);
    const components = new OBC.Components();
    const world = components.get(OBC.Worlds).create();
    world.scene = new OBC.SimpleScene(components);
    world.scene.setup();
    world.scene.three.background = new THREE.Color(plan ? '#ffffff' : '#f4f6f8');
    world.renderer = new OBC.SimpleRenderer(components, host);
    world.camera = new OBC.OrthoPerspectiveCamera(components);
    components.init();
    const fragments = components.get(OBC.FragmentsManager);
    fragments.init(await OBC.FragmentsManager.getWorker());
    world.camera.controls.addEventListener('update', () => fragments.core.update());
    // Room labels (declared before anything below can fire a resize or camera update).
    let roomList = null, roomMode = plan ? 'plan' : 'section', roomsFrame = 0;
    const roomLayer = document.createElement('div');
    roomLayer.className = 'ifc-rooms';
    host.append(roomLayer);
    const resize = new ResizeObserver(() => { if (!host.clientWidth || !host.clientHeight) return; world.renderer.resize?.(); world.camera.updateAspect?.(); fragments.core.update(true); placeRoomsLater(); }); // hidden: keep the last size
    resize.observe(host);

    let model = null, byGuid = new Map(), guidOf = new Map(), colored = new Map(), selected = [], hiddenByLevel = [];
    const update = () => fragments.core.update(true);
    // One planes array, shared by the renderer and the model (so picks skip what the section cuts away); changed in place.
    const planes = [];
    world.renderer.three.clippingPlanes = planes;
    // Plan: orthographic, and the Plan navigation mode (pan and zoom only, no orbit). OrthoPerspectiveCamera
    // projection.set / set(mode): https://docs.thatopen.com/Tutorials/Components/Core/OrthoPerspectiveCamera
    if (plan) { await world.camera.projection.set('Orthographic'); world.camera.set('Plan'); }
    world.camera.controls.addEventListener('update', () => placeRoomsLater());

    // An IFC (converted in this browser, then cached) or an already converted .frag.
    async function load({ bytes, name = 'model.ifc', key = name }) {
        const isFrag = /\.frag$/i.test(name);
        let frag = isFrag ? bytes : await cache('readonly', key);
        if (!frag && !bytes) throw new Error('Not converted in this browser yet.');
        if (!frag) {
            onStatus(`Converting ${name} for the web viewer (once per browser)…`);
            const FRAGS = await import(IMPORTER);
            const importer = new FRAGS.IfcImporter();
            importer.wasm = { absolute: true, path: WASM };
            frag = await importer.process({ bytes: new Uint8Array(bytes), progressCallback: (p) => { if (typeof p === 'number') onStatus(`Converting ${name}: ${Math.round(p * 100)}%`); } });
            await cache('readwrite', key, frag);
        }
        onStatus('Opening the model…');
        if (model) { await fragments.core.disposeModel?.(model.modelId); model = null; }
        model = await fragments.core.load(frag, { modelId: 'ifc-model' });
        model.useCamera(world.camera.three);
        model.useClippingPlanes?.(planes);
        world.scene.three.add(model.object);
        update();
        byGuid = new Map(); guidOf = new Map(); colored = new Map(); roomList = null;
        onStatus('');
        return model;
    }

    // GlobalIds -> the model's local ids (found once, then remembered).
    async function idsOf(guids) {
        const missing = guids.filter(g => !byGuid.has(g));
        if (missing.length && model) {
            const ids = await model.getLocalIdsByGuids(missing);
            missing.forEach((g, i) => { byGuid.set(g, ids[i] ?? null); if (ids[i] != null) guidOf.set(ids[i], g); });
        }
        return guids.map(g => byGuid.get(g)).filter(id => id != null);
    }

    // Colors: Map(GlobalId -> '#rrggbb'); elements no longer in it go back to their own material.
    async function setColors(colors) {
        if (!model) return;
        const groups = new Map(), back = [];
        for (const [g, hex] of colors) if (colored.get(g) !== hex) (groups.get(hex) || groups.set(hex, []).get(hex)).push(g);
        for (const g of colored.keys()) if (!colors.has(g)) back.push(g);
        if (back.length) await model.resetColor(await idsOf(back));
        for (const [hex, guids] of groups) await model.setColor(await idsOf(guids), new THREE.Color(hex));
        colored = new Map(colors);
        await applySelection();
        redrawCutLater();
        update();
    }

    // The selected walls, drawn in the selection color over their schedule color.
    async function select(guids) {
        selected = guids || [];
        await applySelection(true);
        redrawCutLater();
        update();
    }
    let shownSelection = [];
    async function applySelection(force = false) {
        if (!model) return;
        if (force || shownSelection.length) {
            const prior = shownSelection.filter(g => !selected.includes(g));
            for (const g of prior) { const id = await idsOf([g]); if (!id.length) continue; if (colored.has(g)) await model.setColor(id, new THREE.Color(colored.get(g))); else await model.resetColor(id); }
        }
        if (selected.length) await model.setColor(await idsOf(selected), new THREE.Color(SELECTED));
        shownSelection = [...selected];
    }

    // The level section: a box around these walls (null: the whole model). The slabs / roofs over them and the
    // ceilings are hidden meanwhile, as in the APS view.
    async function section(guids, margin = 0.6) {
        if (!model) return;
        planes.length = 0;
        placeRoomsLater();
        if (hiddenByLevel.length) { await model.setVisible(hiddenByLevel, true); hiddenByLevel = []; }
        if (guids?.length) {
            const box = await model.getMergedBox(await idsOf(guids));
            // Cut just under the walls' tops (as a plan cut): the next floor's walls start there and would catch the picks.
            const lo = box.min.clone().subScalar(margin), hi = box.max.clone().addScalar(margin);
            hi.y = box.max.y - 0.15;
            planes.push(
                new THREE.Plane(new THREE.Vector3(1, 0, 0), -lo.x), new THREE.Plane(new THREE.Vector3(-1, 0, 0), hi.x),
                new THREE.Plane(new THREE.Vector3(0, 1, 0), -lo.y), new THREE.Plane(new THREE.Vector3(0, -1, 0), hi.y),
                new THREE.Plane(new THREE.Vector3(0, 0, 1), -lo.z), new THREE.Plane(new THREE.Vector3(0, 0, -1), hi.z),
            );
            const cats = await model.getItemsOfCategories([/^IFCSLAB$/, /^IFCROOF$/, /^IFCCOVERING$/]);
            const ids = Object.values(cats || {}).flat();
            if (ids.length) {
                const covering = new Set(cats.IFCCOVERING || []);
                const boxes = await model.getBoxes(ids);
                hiddenByLevel = ids.filter((id, i) => boxes[i] && (boxes[i].min.y > box.min.y + margin || covering.has(id)) && boxes[i].min.y < hi.y);
                if (hiddenByLevel.length) await model.setVisible(hiddenByLevel, false);
            }
        }
        update();
    }

    // Camera: fit these elements (or the whole model), from the top or a 3/4 view, else keeping the current angle; at
    // least `min` meters around them (some context around a single wall). Y is up in the IFC scene.
    async function frame(guids = null, view = null, { min = 1 } = {}) {
        if (!model) return;
        const ids = guids?.length ? await idsOf(guids) : null;
        const box = ids?.length ? await model.getMergedBox(ids) : model.box?.clone() || new THREE.Box3().setFromObject(model.object);
        if (box.isEmpty()) return; // nothing to frame (yet)
        const c = box.getCenter(new THREE.Vector3()), r = Math.max(min, box.getSize(new THREE.Vector3()).length() / 2);
        // Applied at once (no transition) and updated here, so the view never depends on an animation frame running.
        // fitToSphere keeps the viewing angle (fitToBox would turn it to face a side of the box); 0.85: the box seldom fills its sphere.
        const controls = world.camera.controls, cam = world.camera.three;
        if (!(cam.aspect > 0) || !isFinite(cam.aspect)) world.camera.updateAspect?.();
        const dir = view === 'top' ? [0, 1, 0.0005] : view === 'iso' ? [1.3, 1.1, 1.3] : null;
        if (dir || !isFinite(controls.distance)) { const [x, y, z] = dir || [1.3, 1.1, 1.3]; controls.setLookAt(c.x + x * r, c.y + y * r, c.z + z * r, c.x, c.y, c.z, false); }
        if (plan) { await controls.fitToBox(new THREE.Box3(c.clone().subScalar(r * 0.6), c.clone().addScalar(r * 0.6)), false); controls.update(0); update(); placeRoomsLater(); return; }
        controls.fitToSphere(new THREE.Sphere(c, r * 0.85), false);
        controls.update(0);
        placeRoomsLater();
        if (!isFinite(controls.distance)) { controls.setLookAt(c.x + r * 2, c.y + r * 1.7, c.z + r * 2, c.x, c.y, c.z, false); controls.update(0); }
        update();
    }

    // Rooms: the IFC's spaces (IfcSpace; in a Revit export Name is the room number, LongName its name) with their boxes,
    // read once. FragmentsModel getItemsOfCategories / getItemsData / getBoxes:
    // https://docs.thatopen.com/api/@thatopen/fragments/classes/FragmentsModel
    async function rooms() {
        if (!model) return [];
        if (roomList) return roomList;
        const ids = (await model.getItemsOfCategories([/^IFCSPACE$/]))?.IFCSPACE || [];
        if (!ids.length) return (roomList = []);
        const [data, boxes] = await Promise.all([model.getItemsData(ids, { attributesDefault: true, relationsDefault: { attributes: false, relations: false } }), model.getBoxes(ids)]);
        const val = (a) => (a && typeof a === 'object' && 'value' in a ? a.value : a);
        roomList = ids.map((id, i) => {
            const d = data[i] || {}, box = boxes[i];
            if (!box || box.isEmpty()) return null;
            const number = String(val(d.Name) ?? '').trim(), name = String(val(d.LongName) ?? '').trim();
            return (name || number) ? { id, number, name: name || number, box } : null;
        }).filter(Boolean);
        placeRoomsLater();
        return roomList;
    }
    // Room names over the view: in the plan, every room big enough on screen to hold its name; in 3D, the rooms of the
    // sectioned floor once zoomed in close (none for the whole building). Each at its room's center on the floor,
    // sized to the room on screen.
    function placeRoomsLater() { if (!roomsFrame) roomsFrame = requestAnimationFrame(placeRooms); }
    function placeRooms() {
        roomsFrame = 0;
        if (!model || !roomList?.length || !roomMode || (roomMode === 'section' && !planes.length)) { roomLayer.innerHTML = ''; return; }
        const cam = world.camera.three, W = host.clientWidth, H = host.clientHeight, out = [], p = new THREE.Vector3();
        const toScreen = (v) => { v.project(cam); return { x: (v.x + 1) / 2 * W, y: (1 - v.y) / 2 * H, z: v.z }; };
        for (const r of roomList) {
            const b = r.box, floor = b.min.y + 0.05;
            p.set((b.min.x + b.max.x) / 2, floor, (b.min.z + b.max.z) / 2);
            if (!planes.every(pl => pl.distanceToPoint(p) >= -0.3)) continue;
            const s = toScreen(p.clone());
            if (s.z < -1 || s.z > 1 || s.x < -30 || s.x > W + 30 || s.y < -30 || s.y > H + 30) continue;
            const a = toScreen(new THREE.Vector3(b.min.x, floor, b.min.z)), c = toScreen(new THREE.Vector3(b.max.x, floor, b.max.z));
            const size = Math.min(Math.abs(a.x - c.x) || Infinity, Math.abs(a.y - c.y) || Infinity, Math.hypot(a.x - c.x, a.y - c.y));
            if (size < (roomMode === 'plan' ? 34 : 80)) continue;
            out.push({ r, x: s.x, y: s.y, z: s.z, size });
        }
        out.sort((m, n) => m.z - n.z);
        const esc = (t) => String(t).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
        roomLayer.innerHTML = out.slice(0, 160).map(({ r, x, y, size }) => `<span style="left:${x.toFixed(0)}px;top:${y.toFixed(0)}px;font-size:${Math.max(8.5, Math.min(13, size / 9)).toFixed(1)}px"><b>${esc(r.name)}</b>${r.number && r.number !== r.name ? `<i>${esc(r.number)}</i>` : ''}</span>`).join('');
    }
    function showRooms(mode) { roomMode = mode; if (mode) rooms(); placeRoomsLater(); }

    // The plan of a floor: cut at the Revit cut height over the floor of these walls (their bottoms), looking down; the
    // floor below shown, everything above removed. The cut is drawn as a plan is: every cut element's outline and a light
    // fill, then each schedule color's walls filled in that color and the selection over them
    // (FragmentsModel.getSection(plane, localIds): the edges and fills where the plane cuts those items; `index` counts
    // vertices, `fillsIndices` are triangles over the same vertices). Redrawn when the colors or the selection change.
    let cutGroup = null, cutPlane = null, cutTimer = 0, cutVersion = 0, planFloor = null;
    const disposeGroup = (g) => g?.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
    async function sectionMesh(ids, color, { lines = false, opacity = 1, order = 0 } = {}) {
        const s = await model.getSection(cutPlane, ids).catch(() => null), n = s?.index || 0;
        if (n < 3 || !s.buffer) return null;
        const pos = new THREE.BufferAttribute(s.buffer.slice(0, n * 3), 3), out = new THREE.Group();
        if (s.fillsIndices?.length) {
            const g = new THREE.BufferGeometry();
            g.setAttribute('position', pos); g.setIndex(Array.from(s.fillsIndices));
            const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: opacity < 1, opacity, depthWrite: false }));
            mesh.renderOrder = 10 + order; out.add(mesh);
        }
        if (lines) {
            const g = new THREE.BufferGeometry();
            g.setAttribute('position', pos);
            const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: '#1b2733' }));
            l.renderOrder = 30; out.add(l);
        }
        out.position.y = -0.003;
        return out;
    }
    async function redrawCut() {
        if (!plan || !cutPlane || !model) return;
        const version = ++cutVersion, group = new THREE.Group();
        const base = await sectionMesh(undefined, '#8d98a3', { lines: true, opacity: 0.45 });
        if (base) group.add(base);
        const byHex = new Map();
        for (const [g, hex] of colored) (byHex.get(hex) || byHex.set(hex, []).get(hex)).push(g);
        for (const [hex, guids] of byHex) { const ids = await idsOf(guids); const m = ids.length && await sectionMesh(ids, hex, { order: 1 }); if (m) group.add(m); }
        if (selected.length) { const ids = await idsOf(selected); const m = ids.length && await sectionMesh(ids, SELECTED, { order: 2 }); if (m) group.add(m); }
        if (version !== cutVersion) { disposeGroup(group); return; }
        if (cutGroup) { world.scene.three.remove(cutGroup); disposeGroup(cutGroup); }
        cutGroup = group; world.scene.three.add(group);
        update();
    }
    function redrawCutLater() { if (!plan || !cutPlane) return; clearTimeout(cutTimer); cutTimer = setTimeout(redrawCut, 120); }
    async function planAt(guids, { cut = REVIT_CUT, below = 0.4 } = {}) {
        if (!model) return;
        const ids = guids?.length ? await idsOf(guids) : [];
        if (!ids.length) return;
        const boxes = (await model.getBoxes(ids)).filter(b => b && !b.isEmpty());
        const bottoms = boxes.map(b => b.min.y).sort((x, y) => x - y), floor = bottoms[Math.floor(bottoms.length * 0.1)];
        const box = await model.getMergedBox(ids), cutY = floor + cut;
        planFloor = { floor, cutY, box };
        planes.length = 0;
        planes.push(new THREE.Plane(new THREE.Vector3(0, -1, 0), cutY), new THREE.Plane(new THREE.Vector3(0, 1, 0), -(floor - below)));
        if (hiddenByLevel.length) { await model.setVisible(hiddenByLevel, true); hiddenByLevel = []; }
        cutPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), cutY);
        await redrawCut();
        await planFrame(box);
        rooms();
        update();
    }
    async function planFrame(box = planFloor?.box) {
        if (!box || !planFloor) return;
        const controls = world.camera.controls, c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
        controls.setLookAt(c.x, planFloor.cutY + 50, c.z + 0.0001, c.x, planFloor.floor, c.z, false);
        const flat = new THREE.Box3(new THREE.Vector3(box.min.x, planFloor.floor, box.min.z), new THREE.Vector3(box.max.x, planFloor.cutY, box.max.z));
        const pad = Math.max(size.x, size.z) * 0.04;
        await controls.fitToBox(flat, false, { paddingTop: pad, paddingBottom: pad, paddingLeft: pad, paddingRight: pad });
        controls.update(0);
        update(); placeRoomsLater();
    }

    // A click (not a drag) picks under the pointer: onPick gets the GlobalIds hit along the ray, nearest first, leaving out
    // what the section cuts away or hides (the raycast itself ignores both), so the page can prefer, say, a wall of the
    // shown floor; [] for empty space.
    let down = null;
    host.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
    host.addEventListener('pointerup', async (e) => {
        if (!model || !down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
        const hits = await model.raycastAll({ camera: world.camera.three, mouse: new THREE.Vector2(e.clientX, e.clientY), dom: world.renderer.three.domElement });
        const hidden = new Set(hiddenByLevel), ids = [], sorted = (hits || []).sort((a, b) => a.distance - b.distance);
        if (plan && planFloor) {
            // The plan: a ray from above first meets faces over the cut (hidden there). Keep what the plan shows: elements
            // that start under the cut and reach the floor shown (the cut walls, not the slab above).
            const cand = [...new Set(sorted.map(h => h.localId).filter(id => id != null))];
            const boxes = cand.length ? await model.getBoxes(cand) : [];
            cand.forEach((id, i) => { const b = boxes[i]; if (b && b.min.y <= planFloor.cutY + 0.01 && b.max.y >= planFloor.floor - 0.4) ids.push(id); });
        } else {
            for (const h of sorted)
                if (h.localId != null && !hidden.has(h.localId) && !ids.includes(h.localId) && planes.every(p => p.distanceToPoint(h.point) >= -0.01)) ids.push(h.localId);
        }
        const unknown = ids.filter(id => !guidOf.has(id));
        if (unknown.length) (await model.getGuidsByLocalIds(unknown)).forEach((g, i) => { if (g) { guidOf.set(unknown[i], g); byGuid.set(g, unknown[i]); } });
        onPick(ids.map(id => guidOf.get(id)).filter(Boolean));
    });

    return {
        load, setColors, select, section, frame, planAt, planFrame, rooms, showRooms,
        get loaded() { return !!model; },
        dispose() { resize.disconnect(); components.dispose(); },
    };
}
