// The Speckle 3D engine for the schedule viewer: loaded only when the user picks Speckle in the header switch, so the
// default APS view is untouched. It shows the building from static Speckle objects hosted with the site (speckle/: a
// manifest with the root collections and JSON chunks of elements; scripts/frag-to-speckle.html makes them from the IFC
// export), so no Speckle server is needed. Same interface as ifc-engine.mjs: colors, level section, fit / top / iso,
// selection and picks, keyed by IFC GlobalId (each element's applicationId).
// Library: @speckle/viewer (Apache-2.0), from the jsDelivr CDN, pinned. Docs: https://speckle.guide/viewer/
// (Viewer, SpeckleLoader, CameraController, SelectionExtension, FilteringExtension, SectionTool, ViewerEvent).

const SPECKLE = 'https://cdn.jsdelivr.net/npm/@speckle/viewer@2.31.14/+esm';
const SELECTED = 0xe535ab; // magenta, as in Open IFC: apart from the schedule's orange / blue / green

// The object source for the loader below (the viewer's SpeckleLoader asks for it while it is being constructed).
let pendingSource = null;

export async function createSpeckleEngine(host, { onPick = () => {}, onStatus = () => {} } = {}) {
    onStatus('Loading the Speckle viewer…');
    const SV = await import(SPECKLE);
    const viewer = new SV.Viewer(host, { ...SV.DefaultViewerParams, showStats: false, verbose: false });
    await viewer.init();
    const camera = viewer.createExtension(SV.CameraController);
    const selection = viewer.createExtension(SV.SelectionExtension);
    const filtering = viewer.createExtension(SV.FilteringExtension);
    const sections = viewer.createExtension(SV.SectionTool);
    try { selection.options = { ...selection.options, selectionMaterialData: { ...selection.options.selectionMaterialData, color: SELECTED } }; } catch { /* default selection color */ }
    // Hidden (another engine shown) the host is 0 x 0: a resize then would leave the camera without an aspect ratio and the
    // next fit at NaN, so the viewer keeps its last size until it is shown again.
    const resize = new ResizeObserver(() => { if (host.clientWidth && host.clientHeight) { viewer.resize(); viewer.requestRender(); } });
    resize.observe(host);

    // A SpeckleLoader fed from memory: the object loader it would make for a server URL is replaced by the hosted
    // objects (getTotalObjectCount / getObjectIterator / getObject / disposeAsync are what its converter uses).
    class StaticLoader extends SV.SpeckleLoader {
        initObjectLoader() { const source = pendingSource; pendingSource = null; return source; }
    }

    const byGuid = new Map(), guidOf = new Map();
    let loaded = false;
    async function load(manifestUrl) {
        onStatus('Downloading the Speckle model…');
        const base = new URL(manifestUrl, location.href);
        const res = await fetch(base);
        if (!res.ok) throw new Error('No Speckle model on this site yet.');
        const manifest = await res.json(), objects = new Map();
        let done = 0;
        await Promise.all(manifest.chunks.map(async (chunk) => {
            const list = await (await fetch(new URL(chunk.name, base))).json();
            for (const o of list) {
                objects.set(o.id, o);
                // The meshes carry the render views (colors, selection, boxes); the element is their parent.
                if (o.applicationId) { const meshes = (o.displayValue || []).map(d => d.id); byGuid.set(o.applicationId, meshes); guidOf.set(o.id, o.applicationId); for (const id of meshes) guidOf.set(id, o.applicationId); }
            }
            onStatus(`Downloading the Speckle model: part ${++done} of ${manifest.chunks.length}…`);
        }));
        onStatus('Opening the Speckle model…');
        const root = manifest.root;
        pendingSource = {
            getTotalObjectCount: async () => objects.size + 1,
            async *getObjectIterator() { yield root; },
            getObject: async ({ id }) => objects.get(id),
            getRootObject: async () => root,
            disposeAsync: async () => {},
        };
        await viewer.loadObject(new StaticLoader(viewer.getWorldTree(), 'speckle-static/' + root.id), true);
        loaded = true;
        onStatus('');
    }
    const idsOf = (guids) => (guids || []).flatMap(g => byGuid.get(g) || []);

    // Colors: Map(GlobalId -> '#rrggbb'), one color group per hex (FilteringExtension.setUserObjectColors).
    function setColors(colors) {
        if (!loaded) return;
        const groups = new Map();
        for (const [g, hex] of colors) { const ids = byGuid.get(g); if (ids) (groups.get(hex) || groups.set(hex, []).get(hex)).push(...ids); }
        const list = [...groups].map(([color, objectIds]) => ({ objectIds, color }));
        if (list.length) filtering.setUserObjectColors(list); else filtering.removeUserObjectColors();
        viewer.requestRender();
    }

    function select(guids) {
        if (!loaded) return;
        const ids = idsOf(guids);
        if (ids.length) selection.selectObjects(ids, false); else selection.clearSelection();
        viewer.requestRender();
    }

    // The level section: a box around these walls, cut just under their tops (null: off). Sizes relative to the walls'
    // height, so it works in whatever units the viewer converted to.
    function section(guids) {
        if (!loaded) return;
        const ids = idsOf(guids);
        if (!ids.length) { sections.enabled = false; viewer.requestRender(); return; }
        const box = viewer.getRenderer().boxFromObjects(ids), h = Math.max(1e-6, box.max.z - box.min.z);
        box.min.x -= 0.2 * h; box.min.y -= 0.2 * h; box.max.x += 0.2 * h; box.max.y += 0.2 * h;
        box.min.z -= 0.2 * h; box.max.z -= 0.05 * h;
        sections.setBox(box);
        sections.enabled = true;
        sections.visible = false;
        viewer.requestRender();
    }

    // Camera: these elements (or the whole model), from the top or a 3/4 view, else the current angle; a single wall is
    // shown with some room around it.
    function frame(guids = null, view = null, { min = 1 } = {}) {
        if (!loaded || !host.clientWidth || !host.clientHeight) return;
        viewer.resize();
        if (view === 'top') camera.setCameraView('top', false);
        else if (view === 'iso') camera.setCameraView('3d', false);
        const ids = idsOf(guids), renderer = viewer.getRenderer();
        const box = ids.length ? renderer.boxFromObjects(ids) : renderer.sceneBox.clone();
        if (!box || box.isEmpty()) return;
        // At least `min` (meters, the viewer's units) across, so a single wall is shown with its surroundings.
        const c = box.getCenter(box.min.clone()), half = box.getSize(box.min.clone()).multiplyScalar(0.5);
        half.set(Math.max(half.x, min / 2), Math.max(half.y, min / 2), Math.max(half.z, min / 2));
        box.min.copy(c).sub(half); box.max.copy(c).add(half);
        camera.setCameraView(box, false, 0.85);
        viewer.requestRender();
    }

    // A click: the GlobalIds under the pointer, nearest first (the walls' meshes carry their element's id).
    viewer.on(SV.ViewerEvent.ObjectClicked, (event) => {
        const guids = [];
        for (const hit of event?.hits || []) {
            let node = hit.node, g = null;
            while (node && !g) { const raw = node.model?.raw; g = raw?.applicationId || guidOf.get(raw?.id); node = node.parent; }
            if (g && !guids.includes(g)) guids.push(g);
        }
        onPick(guids);
    });

    return {
        load, setColors, select, section, frame,
        get loaded() { return loaded; },
        dispose() { resize.disconnect(); viewer.dispose(); },
    };
}
