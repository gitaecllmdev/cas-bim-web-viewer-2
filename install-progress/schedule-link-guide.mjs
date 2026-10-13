import {escapeHtml} from './helpers.js';
import {dashboardIcon} from './project-dashboard.mjs';

// These are explanations, not assignment commands. Keep availability explicit.
const METHODS = [
    {id:'model',icon:'model',name:'Source model properties',status:'Available: floor + stage',best:'Start here when the modeller can prepare consistent properties.',
        input:'The modeller supplies the floor. For richer grouping, agree zone, work package and element identity fields with the planner. A future exact-link workflow could also author one P6 Activity ID property per work stage in the source model.',
        model:['Wall A · Floor: 3RD FLOOR','Wall B · Floor: 3RD FLOOR'],key:'Floor + work stage',schedule:['WH04F · Frame walls','Location: 3RD FLOOR · Stage: Framed'],
        steps:['Agree the property names and values before modelling.','Give the P6 activity the same location value and an install-stage code.','Map the P6 location to the model floor, then review the matching walls.'],
        boundary:'The demo reads wall floors and links whole-floor work by stage. Custom zone/package/property keys and writing assignments back to Revit are design options.'},
    {id:'codes',icon:'schedule',name:'P6 activity codes',status:'Available now',best:'Recommended first setup: one floor and one work stage per activity.',
        input:'The planner supplies Activity ID, Location/Level and Install Stage in the P6 export. The reviewer corrects mappings in Activity links.',
        model:['Walls on 3RD FLOOR','Work stage: Framed'],key:'Location = floor · Stage = Framed',schedule:['WH04F · Frame walls','Location: 3RD FLOOR · Stage: Framed'],
        steps:['Prepare a model and import the P6 schedule snapshot.','Use Activity links → Bulk location and stage mappings to match the codes.','Review an activity, its floor plan and whole-floor 3D section together.'],
        boundary:'This is a floor/stage association, not an exact element assignment. One wall can relate to separate framing, boarding, taping and finishing activities. P6 sync/writeback is not active.'},
    {id:'rules',icon:'tools',name:'Matching rules',status:'Available: floor / name inference',best:'Useful for an existing schedule without well-organized activity codes.',
        input:'Use floor and work-stage words in the activity name or WBS. A reviewer checks suggestions and saves corrections.',
        model:['Walls · Floor: 3RD FLOOR','Future filter: Zone A + partition type'],key:'Name / WBS → suggested floor + stage',schedule:['A310 · Board walls Level 3','Suggested: 3RD FLOOR · Boarded'],
        steps:['Start with floor names and recognizable work-stage words.','Use the Check link entries in Activity links to inspect inferred matches.','Correct the floor or stage in Link settings; verify coverage and overlaps.'],
        boundary:'Name/WBS inference is available but needs review. Combining zone, type, phase and other property conditions into saved rules is a design option; ambiguous names should remain unresolved.'},
    {id:'batch',icon:'both',name:'Batch selection',status:'Design option',best:'Best for zones or work packages that do not follow a whole floor.',
        input:'Select a group of model elements, choose a P6 Activity ID and work stage, then confirm the set before saving.',
        model:['Select walls A, B and C','Scope: east corridor'],key:'Selected element identities + stage',schedule:['PKG-210 · Frame east corridor','Stage: Framed · selected set'],
        steps:['Filter a floor, zone or type, then select the intended elements.','Choose the P6 task and stage; inspect the highlighted set and count.','Save the group assignment and check for missing or overlapping elements.'],
        boundary:'Exact group-to-activity assignment is not implemented yet. Progress by floor currently edits field stages; selecting several walls does not create a P6 assignment.'},
    {id:'single',icon:'review',name:'Single element',status:'Design option',best:'Best for an exception or an element with its own schedule task.',
        input:'Click one element and choose an Activity ID for each relevant work stage. Store the model identity and stable source element identity with the link.',
        model:['Selected wall A','Stable source identity: wall-001'],key:'One element + one stage → Activity ID',schedule:['EX-100 · Frame wall A','EX-200 · Board wall A'],
        steps:['Select the element in the model or plan and inspect its identity.','Assign its framing task, boarding task and other stages as needed.','Check the same element in both views and review the links after a model revision.'],
        boundary:'The demo can show related floor/stage tasks for a selected wall. Saving an exact individual element-to-activity assignment is a design option; a viewer selection number should not be the permanent link key.'},
    {id:'sheet',icon:'drawings',name:'Link spreadsheet',status:'Design option',best:'Best for bulk preparation, review or moving assignments between systems.',
        input:'Prepare one row per model element + stage + P6 activity. Include model identity, source element identity, Activity ID and stage; keep revision context.',
        model:['Model: Wilton · element: wall-001','Model: Wilton · element: wall-002'],key:'Model | Element | Activity ID | Stage',schedule:['wall-001 → WH04F · Framed','wall-002 → WH04B · Boarded'],
        steps:['Export the element identities and P6 Activity IDs into a shared template.','Fill the assignment rows; validate unknown IDs, duplicates and stage conflicts.','Preview the matched/unmatched sets before importing, and recheck after revisions.'],
        boundary:'Exact link-spreadsheet import/export is not implemented. Current CSV/XLSX upload reads schedule activities, not this proposed element-link template.'},
];

export function mountScheduleLinkGuide({button,dialog,canReview,onReview,onSources}) {
    let method = 'codes';
    const render = () => {
        const selected = METHODS.find(m => m.id === method), e = escapeHtml;
        dialog.innerHTML = `<div class="link-guide-shell"><header><div><span class="eyebrow">MODEL / PLAN / P6</span><h2 id="link-guide-title">How to link model content to the schedule</h2><p>Start with a shared floor and work stage. Use exact element links when a smaller work package needs them.</p></div><button data-guide-close autofocus aria-label="Close Linking guide">${dashboardIcon('close')} Close</button></header>
            <div class="link-guide-body"><nav aria-label="Choose a linking method">${METHODS.map(m => `<button data-link-method="${m.id}" aria-pressed="${m.id === method}">${dashboardIcon(m.icon)}<span><b>${e(m.name)}</b><small>${e(m.status)}</small></span></button>`).join('')}</nav>
            <section class="link-guide-method" aria-live="polite"><div class="link-guide-heading"><h3>${e(selected.name)}</h3><span>${e(selected.status)}</span></div><p>${e(selected.best)}</p>
            <div class="link-guide-flow" aria-label="Example linking flow"><article>${dashboardIcon('model')}<b>Model content</b>${selected.model.map(t => `<span>${e(t)}</span>`).join('')}</article><div class="link-guide-key">${dashboardIcon('connect')}<b>Shared link</b><span>${e(selected.key)}</span><small>Illustrative example</small></div><article>${dashboardIcon('schedule')}<b>P6 activities</b>${selected.schedule.map(t => `<span>${e(t)}</span>`).join('')}</article></div>
            <div class="link-guide-entry"><b>Who enters what</b><p>${e(selected.input)}</p></div><ol>${selected.steps.map(t => `<li>${e(t)}</li>`).join('')}</ol><p class="link-guide-boundary"><b>Current support</b> ${e(selected.boundary)}</p></section>
            <section class="link-guide-checks"><b>Before you rely on a link</b><div><span>${dashboardIcon('review')} Review missing and duplicate assignments</span><span>${dashboardIcon('model')} Confirm the highlighted elements and stage</span><span>${dashboardIcon('history')} Recheck links after model or P6 revisions</span></div><p>Schedule percentages and field/model percentages are separate measures. Linking does not change quantities or establish that installation is complete.</p></section></div>
            <footer><span>Available now uses imported schedule snapshots. Design options describe possible future input workflows.</span><button data-guide-sources>${dashboardIcon('model')} Model & schedule sources</button><button data-guide-review ${canReview() ? '' : 'disabled'}>${dashboardIcon('connect')} Open Activity links</button></footer></div>`;
        dialog.querySelector('[data-guide-close]').onclick = () => dialog.close();
        dialog.querySelectorAll('[data-link-method]').forEach(b => b.onclick = () => { method = b.dataset.linkMethod; render(); dialog.querySelector(`[data-link-method="${method}"]`).focus({preventScroll:true}); });
        dialog.querySelector('[data-guide-review]').onclick = () => { dialog.close(); onReview(); };
        dialog.querySelector('[data-guide-sources]').onclick = () => { dialog.close(); onSources(); };
    };
    button.onclick = () => { method = 'codes'; render(); dialog.showModal(); };
}
