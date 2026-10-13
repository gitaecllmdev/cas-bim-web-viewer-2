// The integrated Viewer 2 Wilton schedule is pinned to Sunday, October 11.
// Dedicated install-progress pages load their own current extension directly.
export function demoEntry(demo, modelUrn = '', progressBaseline = null) {
    if (demo.id === '03-progress' && progressBaseline?.urn && (!modelUrn || modelUrn === progressBaseline.urn)) {
        return { module: './demos/03-progress-sunday/extension.js', extensionId: 'Drywall.ProgressSunday' };
    }
    return { module: `./demos/${demo.id}/extension.js`, extensionId: demo.extensionId };
}
