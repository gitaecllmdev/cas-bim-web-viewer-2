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

export async function createIfcEngine(host, { onPick = () => {}, onStatus = () => {} } = {}) {
    onStatus('Loading the IFC viewer libraries…');
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
    world.scene.three.background = new THREE.Color('#f4f6f8');
    world.renderer = new OBC.SimpleRenderer(components, host);
    world.camera = new OBC.OrthoPerspectiveCamera(components);
    components.init();
    const fragments = components.get(OBC.FragmentsManager);
    fragments.init(await OBC.FragmentsManager.getWorker());
    world.camera.controls.addEventListener('update', () => fragments.core.update());
    const resize = new ResizeObserver(() => { world.renderer.resize?.(); world.camera.updateAspect?.(); fragments.core.update(true); });
    resize.observe(host);

    let model = null, byGuid = new Map(), guidOf = new Map(), colored = new Map(), selected = [], hiddenByLevel = [];
    const update = () => fragments.core.update(true);
    // One planes array, shared by the renderer and the model (so picks skip what the section cuts away); changed in place.
    const planes = [];
    world.renderer.three.clippingPlanes = planes;

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
        byGuid = new Map(); guidOf = new Map(); colored = new Map();
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
        update();
    }

    // The selected walls, drawn in the selection color over their schedule color.
    async function select(guids) {
        selected = guids || [];
        await applySelection(true);
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
        controls.fitToSphere(new THREE.Sphere(c, r * 0.85), false);
        controls.update(0);
        if (!isFinite(controls.distance)) { controls.setLookAt(c.x + r * 2, c.y + r * 1.7, c.z + r * 2, c.x, c.y, c.z, false); controls.update(0); }
        update();
    }

    // A click (not a drag) picks under the pointer: onPick gets the GlobalIds hit along the ray, nearest first, leaving out
    // what the section cuts away or hides (the raycast itself ignores both), so the page can prefer, say, a wall of the
    // shown floor; [] for empty space.
    let down = null;
    host.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
    host.addEventListener('pointerup', async (e) => {
        if (!model || !down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
        const hits = await model.raycastAll({ camera: world.camera.three, mouse: new THREE.Vector2(e.clientX, e.clientY), dom: world.renderer.three.domElement });
        const hidden = new Set(hiddenByLevel), ids = [];
        for (const h of (hits || []).sort((a, b) => a.distance - b.distance))
            if (h.localId != null && !hidden.has(h.localId) && !ids.includes(h.localId) && planes.every(p => p.distanceToPoint(h.point) >= -0.01)) ids.push(h.localId);
        const unknown = ids.filter(id => !guidOf.has(id));
        if (unknown.length) (await model.getGuidsByLocalIds(unknown)).forEach((g, i) => { if (g) { guidOf.set(unknown[i], g); byGuid.set(g, unknown[i]); } });
        onPick(ids.map(id => guidOf.get(id)).filter(Boolean));
    });

    return {
        load, setColors, select, section, frame,
        get loaded() { return !!model; },
        dispose() { resize.disconnect(); components.dispose(); },
    };
}
