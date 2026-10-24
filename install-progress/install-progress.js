import {mountScheduleLinkGuide} from './schedule-link-guide.mjs';
import {initViewer,loadModel} from './viewer.js';
import {Views} from './views.js';
import {fetchJson,onModelReady,escapeHtml} from './helpers.js';
import {CONFIG} from './config.js';
import {revitIfcGuid} from './ifc-guid.mjs';
import {clampSplit,INTEGRATIONS,dashboardDate,sourceFreshness,costSummary,labourSummary,labourAssignments,dashboardIcon,demoBimSnapshot,dashboardTimestamp} from './project-dashboard.mjs';
const $=id=>document.getElementById(id);
// The schedule's own stages and their colors (shown ones), then the ghosted rest.
// The color legend over the 3D view: the schedule's stages with their wall counts on the shown date. Click a stage to
// hide or show it on the model (as the Stages legend in the schedule does); Show all brings every stage back.
function renderModelStatusLegend(summary={}){
    const stages=summary.stages||[],el=$('model-legend');
    el.innerHTML=stages.length?`<b>Colors on ${escapeHtml(dashboardDate(summary.cursor))}</b>${stages.map(({color,name,hidden,count},i)=>`<span class="legend-chip${hidden?' off':''}"><input type="color" data-legend-color="${i}" value="${color}" aria-label="Color for ${escapeHtml(name)}" title="Change the color"><button data-legend-stage="${i}" aria-pressed="${!hidden}" title="${hidden?'Show':'Hide'} ${escapeHtml(name)} on the model"><span>${escapeHtml(name)}</span><small>${(count||0).toLocaleString()}</small></button></span>`).join('')}<span class="legend-ghost"><i></i>Not started / other trades</span>${stages.some(s=>s.hidden)?'<button data-legend-all>Show all</button>':''}`:'<span class="legend-ghost"><i></i>Loading schedule…</span>';
    el.querySelectorAll('[data-legend-stage]').forEach(b=>b.onclick=()=>{const s=stages[+b.dataset.legendStage];tracker?.setStageHidden(s.name,!s.hidden);});
    el.querySelector('[data-legend-all]')?.addEventListener('click',()=>tracker?.setStageHidden(null,false));
    el.querySelectorAll('[data-legend-color]').forEach(c=>c.onchange=()=>tracker?.setStageColor(stages[+c.dataset.legendColor].name,c.value));
    const gap=$('apart-gap');if(gap)gap.hidden=!tracker?.apartOn;
    document.querySelectorAll('[data-model-view="apart"]').forEach(b=>b.setAttribute('aria-pressed',!!tracker?.apartOn));
    document.querySelectorAll('[data-model-view="plans"]').forEach(b=>b.setAttribute('aria-pressed',!!tracker?.allPlans?.isOpen));
}
const sourceLabel=id=>({revit:'Model',schedule:'Schedule',cost:'Cost',labour:'Labour'})[id];
const money=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(n);
const variance=n=>(n>0?'+':'')+money(n);
let bimSnapshot=demoBimSnapshot();
let tracker,views,tools,summary,share=.34,resizeFrame,links={},linkKey='',integration='revit',mode='both';
try{const saved=localStorage.getItem('cas-project-dashboard:split');if(saved!==null)share=clampSplit(Number(saved));}catch{}
// Layout: 'below' (model on top, schedule and data full width under it; the default) or 'side' (side by side).
let arrange='below',rowShare=.6;
try{arrange=localStorage.getItem('cas-project-dashboard:arrange')==='side'?'side':'below';const rows=localStorage.getItem('cas-project-dashboard:rows-60');if(rows!==null)rowShare=clampSplit(Number(rows));}catch{}
const main=$('main'),divider=$('workspace-divider');
try{$('selection-context-zoom').checked=localStorage.getItem('cas-project-dashboard:selection-context-zoom')!=='off';}catch{}
$('selection-context-zoom').onchange=e=>{views?.setSelectionFollow(true,{contextZoom:e.target.checked});try{localStorage.setItem('cas-project-dashboard:selection-context-zoom',e.target.checked?'on':'off');}catch{}};

function resizeWorkspace(value,save=false){
    const below=arrange==='below',size=(below?main.clientHeight:main.clientWidth)-(below?28:40),v=clampSplit(value??(below?rowShare:share),size);
    if(below){rowShare=v;main.style.setProperty('--model-height',`${Math.round(size*v)}px`);}else{share=v;main.style.setProperty('--model-width',`${Math.round(size*v)}px`);}
    divider.setAttribute('aria-valuenow',Math.round(v*100));divider.setAttribute('aria-valuetext',`${Math.round(v*100)}% model, ${Math.round((1-v)*100)}% schedule`);
    if(save)try{localStorage.setItem(below?'cas-project-dashboard:rows-60':'cas-project-dashboard:split',String(v));}catch{}
    cancelAnimationFrame(resizeFrame);resizeFrame=requestAnimationFrame(()=>views?.resize());
}
function setWorkspaceMode(value,save=true){mode=value;main.dataset.workspaceMode=mode;document.querySelectorAll('[data-workspace-mode]').forEach(b=>b.setAttribute('aria-pressed',b.dataset.workspaceMode===mode));if(save)try{localStorage.setItem('cas-project-dashboard:mode',mode);}catch{}resizeWorkspace();}
divider.onpointerdown=e=>{if(e.button!==0||mode!=='both')return;divider.setPointerCapture(e.pointerId);document.body.classList.add('workspace-resizing');e.preventDefault();};
divider.onpointermove=e=>{if(!divider.hasPointerCapture(e.pointerId))return;const r=main.getBoundingClientRect();resizeWorkspace(arrange==='below'?(e.clientY-r.top)/(main.clientHeight-28):(e.clientX-r.left)/(main.clientWidth-40));};
const finishResize=()=>{document.body.classList.remove('workspace-resizing');resizeWorkspace(share,true);};
divider.onpointerup=finishResize;divider.onlostpointercapture=finishResize;divider.onpointercancel=finishResize;
divider.ondblclick=()=>resizeWorkspace(arrange==='below'?.6:.34,true);
divider.onkeydown=e=>{const v=arrange==='below'?rowShare:share,step=e.shiftKey?.05:.02,values=arrange==='below'?{ArrowUp:v-step,ArrowDown:v+step,Home:0,End:1,Enter:.6}:{ArrowLeft:v-step,ArrowRight:v+step,Home:0,End:1,Enter:.34};if(Object.hasOwn(values,e.key)){e.preventDefault();setWorkspaceMode('both');resizeWorkspace(values[e.key],true);}};
document.querySelectorAll('[data-workspace-mode]').forEach(b=>b.onclick=()=>setWorkspaceMode(b.dataset.workspaceMode));
function setArrange(value,save=true){arrange=value==='side'?'side':'below';main.dataset.arrange=arrange;divider.setAttribute('aria-orientation',arrange==='below'?'horizontal':'vertical');document.querySelectorAll('[data-arrange]').forEach(b=>b.setAttribute('aria-pressed',b.dataset.arrange===arrange));if(save)try{localStorage.setItem('cas-project-dashboard:arrange',arrange);}catch{}resizeWorkspace();requestAnimationFrame(()=>{views?.resize();tracker?.fitGantt();});}
document.querySelectorAll('[data-arrange]').forEach(b=>b.onclick=()=>setArrange(b.dataset.arrange));
setArrange(arrange,false);
new ResizeObserver(()=>resizeWorkspace()).observe(main);setWorkspaceMode(mode,false);renderModelStatusLegend();
function renderSources(){
    $('source-statuses').innerHTML=INTEGRATIONS.map(s=>{const saved=links[s.id],at=s.id==='schedule'?summary?.dataDate:saved?.at|| (['cost','labour'].includes(s.id)?'2026-10-12':'');const fresh=sourceFreshness(at);let text=s.id==='revit'?(summary?'Demo link current · '+bimSnapshot.revision+' · '+dashboardTimestamp(bimSnapshot.updatedAt):'Loading viewer'):s.id==='schedule'?(summary?(fresh.state==='unknown'?'Data date unknown':'Checked '+dashboardDate(at)):'Waiting for schedule'):s.id==='labour'?'Sample labour plan':'Sample cost plan';let state=s.id==='revit'?(summary?'current':'unknown'):fresh.state;if(saved?.mode==='setup'){text='Setup saved · sync not enabled';state='unknown';}else if(fresh.state==='stale')text=fresh.label+' · '+dashboardDate(at);return `<button data-source-step="${s.id}" title="Open ${escapeHtml(s.name)} data source"><i class="source-dot ${state}"></i><b>${sourceLabel(s.id)}</b><span>${escapeHtml(text)}</span>${s.id==='revit'&&summary?'<span class="demo-badge">Demo data</span>':''}</button>`;}).join('');
    document.querySelectorAll('[data-source-step]').forEach(b=>b.onclick=()=>openConnect(b.dataset.sourceStep));
}
function saveLinks(){if(linkKey)try{localStorage.setItem(linkKey,JSON.stringify(links));}catch{}renderSources();}
function financeHtml(){
    const c=costSummary(),l=labourSummary();
    return `<section class="connected-cost-plan" data-labour-finance><header><h4>Cost & labour forecast</h4><span class="demo-badge">Demo data</span></header><p>Labour is included in the project total below. It is not an additional cost.</p><div class="integration-table"><table><thead><tr><th>Cost component</th><th>Budget</th><th>Forecast</th><th>Variance</th></tr></thead><tbody>${[['Labour',l.budgetCost,l.forecastCost],['Materials & other costs',l.otherBudget,l.otherForecast],['Project total',c.budget,c.forecast]].map(([name,budget,forecast])=>`<tr><th>${name}</th><td>${money(budget)}</td><td>${money(forecast)}</td><td>${variance(forecast-budget)}</td></tr>`).join('')}</tbody></table></div></section>`;
}
function labourHtml(){
    const l=labourSummary(),rows=labourAssignments(tracker?.linked||[],summary?.asOf||'2026-10-12');
    return `<section class="labour-detail"><header><h4>Mock labour allocation</h4><span class="demo-badge">Demo data</span></header><p>Week of ${dashboardDate(rows[0].weekStart)} · ${l.crew} people · ${l.weekHours.toLocaleString()} hours of ${l.plannedWeek.toLocaleString()} planned. Includes ${l.overtime} overtime hours.</p><div class="integration-table labour-allocation" tabindex="0" role="region" aria-label="Work-package labour allocations"><table><thead><tr><th>Work package / context</th><th>Crew</th><th>Regular hrs</th><th>OT hrs</th><th>Planned hrs</th><th>Explore</th></tr></thead><tbody>${rows.map(r=>`<tr><td><b>${r.name}</b><small>${r.id} · ${r.code}</small><small>${escapeHtml(r.level||'No matching schedule activity')} ${escapeHtml(r.activityId)}</small><small>Project forecast: ${r.forecastHours.toLocaleString()} hrs / ${money(r.forecastHours*r.rate)}</small></td><td>${r.crew}</td><td>${r.regular}</td><td>${r.overtime}</td><td>${r.plannedWeek}</td><td><button data-labour-model="${escapeHtml(r.activityId)}" ${r.activityId?'':'disabled'}>Model</button><button data-labour-schedule="${escapeHtml(r.activityId)}" ${r.activityId?'':'disabled'}>Schedule</button></td></tr>`).join('')}</tbody></table></div><p>Project hours: ${l.forecastHours.toLocaleString()} forecast vs ${l.budgetHours.toLocaleString()} budget (+${l.hourVariance.toLocaleString()} hrs). Blended loaded rate: $60/hr, including overtime in this mock forecast.</p><p class="integration-origin">Allocations are illustrative and matched to available schedule activities for context. They do not change wall counts, field stages, quantities or activity dates.</p></section>${financeHtml()}<button data-connect-step="cost">View cost source</button>`;
}
async function focusLabour(id,target){
    const activity=tracker?.activity(id);if(!activity)return;
    closeConnect();tracker.clearFocus();await views.setLevel(activity.level);
    tracker.setTab('gantt');tracker.selectActivity(id);showActivityContext();renderDrill();
}
function bimHtml(){
    const b=bimSnapshot;
    return `<section class="bim-source-status"><header><h4>BIM delivery status</h4><span class="demo-badge">Demo data</span></header><p><b>Model ${b.revision}</b> · Updated ${dashboardTimestamp(b.updatedAt)} (Pacific time)<br>Demo link current · Phase: ${b.phase}</p><div class="integration-table"><table><thead><tr><th>Milestone</th><th>Complete</th><th>Packages</th></tr></thead><tbody><tr><th>Shop drawings issued</th><td>${b.shopPct}%</td><td>${b.shopIssued} / ${b.packages}</td></tr><tr><th>Prefab ready</th><td>${b.prefabPct}%</td><td>${b.prefabReady} / ${b.packages}</td></tr><tr><th>Material delivered</th><td>${b.deliveryPct}%</td><td>${b.materialDelivered} / ${b.packages}</td></tr></tbody></table></div><p class="integration-origin">Illustrative model revision, link status and package milestones. They do not verify an actual Revit revision or change the model quantities.</p></section>`;
}
function sourceRecordsHtml(source,kind){
    return `<h4>Sample records <small>3 examples, not model totals</small></h4><div class="integration-table" data-source-records><table><thead><tr><th>Source ID</th><th>Context</th><th>${kind==='cost'?'Forecast':'Linked value'}</th></tr></thead><tbody>${source.rows.map(row=>`<tr>${row.map(v=>`<td>${escapeHtml(v)}${String(v).startsWith('$')?'<span class="demo-badge">Demo data</span>':''}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
function decorateControls(){
    const groups=[['[data-ui-icon]',''],['#integrations-open,#sources-connect','connect'],['#help','help'],['#linking-guide','connect'],['#present','present'],['[data-review="fit"]','home'],['.model-review>summary','tools'],['[data-tab="management"]','both'],['[data-tab="stages"]','review'],['[data-tab="gantt"]','schedule'],['[data-tab="lookahead"]','next'],['.pg-menu>summary','more'],['[data-links-toggle]','connect'],['[data-decision-model],[data-labour-model]','model'],['[data-decision-next],[data-labour-schedule]','schedule'],['[data-decision-review]','review'],['[data-labour-open]','crew'],['[data-bim-open]','drawings'],['[data-subview="gantt"]','schedule'],['[data-subview="calendar"]','calendar'],['[data-layout="3d"]','model'],['[data-layout="split"]','both'],['[data-layout="2d"]','drawings'],['#back-overview,#integrations-close','home']];
    for(const [selector,icon] of groups)document.querySelectorAll(selector).forEach(b=>{if(!b.querySelector('[data-dashboard-icon]'))b.insertAdjacentHTML('afterbegin',dashboardIcon(b.dataset.uiIcon||icon));});
    const upload=$('panel').querySelector('[data-upload]')?.closest('label');if(upload&&!upload.querySelector('[data-dashboard-icon]'))upload.insertAdjacentHTML('afterbegin',dashboardIcon('upload'));
}
function renderIntegration(){
    const source=INTEGRATIONS.find(s=>s.id===integration),saved=links[integration];
    $('integration-tabs').innerHTML=INTEGRATIONS.map((s,i)=>`<button data-integration="${s.id}" aria-pressed="${s.id===integration}"><b>${i+1}. ${sourceLabel(s.id)}</b><small>${links[s.id]?.mode==='setup'?'Setup only':links[s.id]?'Sample ready':'Choose source'}</small></button>`).join('');
    $('integration-body').innerHTML=`<div class="integration-source-head"><h3>${escapeHtml(source.name)}</h3><span>${saved?.mode==='setup'?'Setup saved; sync not enabled':saved?'Sample data ready':'Choose how to supply data'}</span></div><p>${escapeHtml(source.description)}</p><div class="integration-actions"><button id="integration-demo">Use demo data</button><button id="integration-connect">Connect</button></div><div id="connection-form" hidden><h4>Connection setup</h4><p>Save the proposed system and project reference. External sync is not enabled here.</p><label class="integration-system">System <select id="connection-system">${(integration==='cost'?['Procore','Autodesk Cost Management','Sage / ERP','Other cost system']:integration==='labour'?['Internal Production Tracking Tool']:integration==='revit'?['Revit export / future bridge']:['Schedule file / P6']).map(s=>`<option>${escapeHtml(s)}</option>`).join('')}</select></label><label class="integration-system">Project reference <input id="connection-project" placeholder="Project name or reference" value="${escapeHtml(saved?.project||'')}"></label>${integration==='schedule'?'<button id="connection-file">Choose schedule file</button>':''}<div class="integration-actions"><button id="connection-save">Save setup</button><button id="connection-cancel">Cancel</button></div></div><h4>Field mapping</h4><div class="integration-mappings">${source.fields.map(([from,to])=>`<div><b>${escapeHtml(from)}</b><span>→</span><span>${escapeHtml(to)}</span></div>`).join('')}</div>${integration==='revit'?bimHtml():''}${integration==='labour'?labourHtml():sourceRecordsHtml(source,integration)}${integration==='cost'?financeHtml()+'<button data-connect-step="labour">View labour source</button>':''}${saved?'<button id="integration-unlink">Remove source setup</button>':''}<p class="integration-origin">${saved?'Last checked '+dashboardDate(saved.at):'No external account connection is active. Use demo data to preview the flow.'}</p>`;
    if(['labour','cost','revit'].includes(integration)){
        const body=$('integration-body'),heading=[...body.querySelectorAll('h4')].find(h=>h.textContent==='Field mapping');
        const mappings=heading.nextElementSibling,details=document.createElement('details'),label=document.createElement('summary');
        details.className='source-mapping';label.textContent=integration==='labour'?'Internal tool field mapping':integration==='revit'?'Model source field mapping':'Cost source field mapping';
        details.append(label,mappings);heading.replaceWith(details);
        if(integration==='labour')body.insertBefore(body.querySelector('.labour-detail'),details);
        if(integration==='revit')body.insertBefore(body.querySelector('.bim-source-status'),details);
        else{body.insertBefore(body.querySelector('[data-labour-finance]'),details);body.insertBefore(body.querySelector('[data-connect-step]'),details);}
    }
    document.querySelectorAll('[data-connect-step]').forEach(b=>b.onclick=()=>openConnect(b.dataset.connectStep));
    document.querySelectorAll('[data-labour-model]').forEach(b=>b.onclick=()=>focusLabour(b.dataset.labourModel,'model'));
    document.querySelectorAll('[data-labour-schedule]').forEach(b=>b.onclick=()=>focusLabour(b.dataset.labourSchedule,'schedule'));
    document.querySelectorAll('[data-integration]').forEach(b=>b.onclick=()=>{integration=b.dataset.integration;renderIntegration();});
    if(saved?.system)$('connection-system').value=saved.system;
    $('integration-demo').onclick=async()=>{if(integration==='schedule'&&tracker){if(!tracker.schedule?.source.sample&&!confirm('Replace the current schedule with demo data?'))return;await tracker.loadSample({quiet:true});await tracker.saveSchedule();tracker.render();}links[integration]={at:new Date().toISOString(),system:source.name,mode:'demo'};saveLinks();renderIntegration();$('integration-feedback').textContent=`${source.name} sample data ready. No external sync performed.`;};
    $('integration-connect').onclick=()=>{$('connection-form').hidden=false;$('connection-project').focus();};
    $('connection-cancel').onclick=()=>{$('connection-form').hidden=true;};
    $('connection-save').onclick=()=>{links[integration]={at:new Date().toISOString(),system:$('connection-system').value,project:$('connection-project').value,mode:'setup'};saveLinks();renderIntegration();$('integration-feedback').textContent='Connection setup saved in this browser. External sync is not enabled.';};
    if($('connection-file'))$('connection-file').onclick=()=>tracker?.panel.querySelector('[data-upload]').click();
    if($('integration-unlink'))$('integration-unlink').onclick=()=>{delete links[integration];saveLinks();renderIntegration();$('integration-feedback').textContent='Source setup removed.';};
}
function openConnect(step='revit'){setWorkspaceMode('both');integration=INTEGRATIONS.some(s=>s.id===step)?step:'revit';$('panel').hidden=true;$('connect-page').hidden=false;renderIntegration();$('connect-page').scrollTop=0;main.scrollIntoView({block:'start'});}
function closeConnect(){ $('connect-page').hidden=true;$('panel').hidden=false;tracker?.setTab('gantt');renderDrill();}
$('integrations-open').onclick=()=>openConnect();$('sources-connect').onclick=()=>openConnect();document.addEventListener('dashboard-integrations',e=>openConnect(e.detail?.step||'cost'));
$('integrations-close').onclick=closeConnect;
$('integration-refresh').onclick=()=>{bimSnapshot=demoBimSnapshot();const at=new Date().toISOString();for(const s of INTEGRATIONS)if(links[s.id]?.mode==='demo')links[s.id].at=at;saveLinks();renderIntegration();$('integration-feedback').textContent='Sample records refreshed. No external service contacted.';};
$('demo-reset').onclick=async()=>{if(!tracker||!confirm('Start over with demo data? The current schedule, its links and colors will be replaced.'))return;$('demo-reset').disabled=true;try{await tracker.resetDemo();tracker.reviewed={};tracker.saveReviewed();links=Object.fromEntries(INTEGRATIONS.map(s=>[s.id,{at:new Date().toISOString(),system:s.name,mode:'demo'}]));saveLinks();tracker.render();renderIntegration();$('integration-feedback').textContent='Demo data restored.';}finally{$('demo-reset').disabled=false;}};
async function backOverview(){closeConnect();tracker?.clearFocus();setWorkspaceMode('both');await views?.setLevel(null);tracker?.refresh();renderDrill();}
function renderDrill(context={}){const level=views?.level?.name,act=tracker?.selectedAct,tab=tracker?.tab;const show=!!(level||act);$('drill-context').hidden=!show;$('drill-label').textContent=[level,act,tab?({gantt:'P6 Gantt',calendar:'P6 Gantt',lookahead:'Lookahead'})[tab]:null].filter(Boolean).join(' · ');}
$('back-overview').onclick=backOverview;document.addEventListener('dashboard-context',e=>{renderDrill(e.detail);decorateControls();});
function showActivityContext(){setWorkspaceMode('both');if(!tracker?.apartOn&&!tracker?.allPlans?.isOpen)views?.setLayout('split');$('panel').hidden=false;$('connect-page').hidden=true;const panel=tracker?.panel,details=panel?.querySelector('.pg-details');if(details){const head=panel.querySelector('.pg-head');panel.scrollTop+=details.getBoundingClientRect().top-panel.getBoundingClientRect().top-(head?.offsetHeight||0)-12;}}
// Built-in Viewer panels: PropertiesManager (selected element's properties) and ModelStructure (model browser).
// https://aps.autodesk.com/en/docs/viewer/v7/reference/Extensions/PropertiesManager/ and .../Extensions/ModelStructure/
async function builtinPanel(id,on){
    try{const ext=views.viewer3d.getExtension(id)||await views.viewer3d.loadExtension(id);if(on)ext.activate();else ext.deactivate();}
    catch(err){$('save-notice').textContent=`${id==='Autodesk.ModelStructure'?'Model browser':'Properties'} is not available: ${err.message||err}`;}
}
const propsOn=()=>document.querySelector('[data-view-panel="props"]')?.getAttribute('aria-pressed')==='true';
// Scope: Walls only (the default) limits hover and selection to the model's walls; off, any element (as before).
let wallsOnly=true;
try{wallsOnly=localStorage.getItem('cas-project-dashboard:walls-only')!=='off';}catch{}
const isWall=id=>!!tracker?.byDbId?.has(id);
// A selection that includes other elements keeps only its walls (none: nothing selected). Viewer3D getSelection /
// select / clearSelection: https://aps.autodesk.com/en/docs/viewer/v7/reference/Viewing/Viewer3D/
function keepWallSelection(viewer){
    if(!wallsOnly||!viewer?.model||!tracker?.byDbId)return;
    const sel=viewer.getSelection(),keep=sel.filter(isWall);
    if(keep.length===sel.length)return;
    if(keep.length)viewer.select(keep,viewer.model);else viewer.clearSelection();
}
function watchWallSelection(viewer){
    if(!viewer||viewer.__wallScope)return;
    viewer.__wallScope=true;
    viewer.addEventListener(Autodesk.Viewing.SELECTION_CHANGED_EVENT,()=>keepWallSelection(viewer));
}
function setWallsOnly(on){
    wallsOnly=on;
    try{localStorage.setItem('cas-project-dashboard:walls-only',on?'on':'off');}catch{}
    document.querySelectorAll('[data-wall-scope]').forEach(b=>b.setAttribute('aria-pressed',on));
    if(on)[views?.viewer3d,views?.viewer2d].forEach(keepWallSelection);
}
// Hover: quick properties of the element under the pointer, in 3D and on the sheet (Viewer3D.hitTest, Model.getProperties).
function mountHoverProperties(){
    const tip=document.createElement('div');tip.className='hover-props';tip.hidden=true;tip.setAttribute('role','tooltip');document.body.append(tip);
    const names=new Map();let at=0,shown=null;
    const viewerAt=target=>[views?.viewer3d,views?.viewer2d].find(v=>v?.model&&v.canvas===target);
    const place=e=>{tip.style.left=Math.min(innerWidth-tip.offsetWidth-8,e.clientX+14)+'px';tip.style.top=Math.min(innerHeight-tip.offsetHeight-8,e.clientY+16)+'px';};
    const show=(e,html)=>{tip.innerHTML=html;tip.hidden=false;place(e);};
    document.addEventListener('pointermove',e=>{
        const v=viewerAt(e.target);if(!v||e.buttons){tip.hidden=true;shown=null;return;}
        if(!tip.hidden)place(e);const now=performance.now();if(now-at<90)return;at=now;
        const r=v.canvas.getBoundingClientRect(),hit=v.hitTest(e.clientX-r.left,e.clientY-r.top,true),id=hit?.dbId;
        if(!id||wallsOnly&&!isWall(id)){tip.hidden=true;shown=null;return;}if(id===shown)return;shown=id;
        const wall=tracker?.byDbId?.get(id);
        if(wall){const a=tracker.reached?.get(wall);show(e,`<b>${escapeHtml(wall.wallType||'Wall')}</b><span>${escapeHtml(wall.level||'No level')}${wall.fireRating?' · '+escapeHtml(wall.fireRating):''}</span><span>${a?`<i style="background:${tracker.colorOf(a)}"></i>${escapeHtml(a.stage)} · ${escapeHtml(a.id)}`:'Not started on '+dashboardDate(tracker.cursor)}</span>`);return;}
        const key=v.model.id+':'+id;
        if(names.has(key)){show(e,names.get(key));return;}
        v.model.getProperties(id,p=>{const cat=p.properties?.find(x=>x.displayName==='Category')?.displayValue,type=p.properties?.find(x=>x.displayName==='Type Name')?.displayValue;const html=`<b>${escapeHtml(p.name||'Element')}</b>${cat||type?`<span>${escapeHtml([cat,type].filter(Boolean).join(' · '))}</span>`:''}`;names.set(key,html);if(shown===id)show(e,html);},()=>{});
    },{passive:true});
    document.addEventListener('pointerdown',()=>{tip.hidden=true;},{passive:true});
}
function mountViewControls(){
    const bar=document.createElement('div');bar.className='view-context-controls';bar.setAttribute('role','toolbar');bar.setAttribute('aria-label','3D view controls');
    bar.innerHTML=`<button data-view-command="top" title="Look straight down at the model">Top view</button><button data-view-command="iso" title="Isometric 3D view">Iso view</button><button data-view-command="fit" title="Fit the current floor or building">Fit</button><button data-model-view="apart" aria-pressed="false" title="Every floor at once, each lifted over the one below, with the schedule's share per floor">Floors apart</button><label id="apart-gap" hidden title="Space between the floors">Gap <input type="range" min="0.5" max="3" step="0.25" value="1"></label><button data-model-view="plans" aria-pressed="false" title="Every floor sheet at once, colored by the schedule">All plans</button><button data-wall-scope aria-pressed="${wallsOnly}" title="Scope: on, hover and selection pick walls only; off, any element of the model">Walls only</button><button data-view-panel="props" aria-pressed="true" title="Properties: open the selected element's properties">Properties</button><button data-view-panel="browser" title="Model browser: hide or isolate parts of the model">Model browser</button><button data-model-full title="Full screen 3D: only the model, with its own timeline">Full screen</button>`;
    bar.querySelector('[data-wall-scope]').onclick=()=>setWallsOnly(!wallsOnly);
    // The 3D view's buttons sit in the model card's toolbar, after the layout buttons, so the view itself stays clear.
    document.querySelector('.model-bar .layout').after(bar);
    bar.querySelectorAll('[data-view-command]').forEach(b=>b.onclick=()=>{const action=b.dataset.viewCommand;if(engine==='ifc'){ifc?.frame(levelGuids(),action==='fit'?null:action);return;}if(engine==='speckle'){spk?.frame(levelGuids(),action==='fit'?null:action);return;}if(action==='fit')views.fitShown();else{tools?.look(action==='top'?[0,0,1]:[1,-1,.8]);views.fitShown();}});
    bar.querySelectorAll('[data-model-view]').forEach(b=>b.onclick=async()=>{if(!tracker?.schedule)return;if(engine!=='aps'&&b.dataset.modelView==='apart'){$('save-notice').textContent='Floors apart is in the APS viewer for now.';return;}if(b.dataset.modelView==='apart')await tracker.setApart(!tracker.apartOn);else await tracker.setAllPlans(!tracker.allPlans.isOpen);renderModelStatusLegend(summary||{});});
    bar.querySelector('#apart-gap input').onchange=e=>tracker?.setApartGap(Number(e.target.value));
    // The color legend sits in the project banner over the model card (the same colors are used everywhere);
    // in full screen it rides on the 3D view.
    document.querySelector('.project-banner .project-view-context').before($('model-legend'));
    bar.querySelector('[data-model-full]').onclick=()=>setModelFull(true);
    // The Viewer's own Properties and Model browser panels (built-in extensions), opened from here.
    bar.querySelectorAll('[data-view-panel]').forEach(b=>b.onclick=()=>{const on=b.getAttribute('aria-pressed')!=='true';b.setAttribute('aria-pressed',on);if(b.dataset.viewPanel==='browser')builtinPanel('Autodesk.ModelStructure',on);else builtinPanel('Autodesk.PropertiesManager',on&&views.viewer3d.getSelection().length>0);});
    bar.addEventListener('pointerdown',e=>e.stopPropagation());bar.addEventListener('keydown',e=>e.stopPropagation());
}
document.addEventListener('dashboard-focus',showActivityContext);
// Floors apart / All plans loading: a progress bar over the model with Cancel. Model controls wait until it is done, so
// another click cannot cut the loading short.
document.addEventListener('model-views-loading',e=>{
    const d=e.detail,card=document.querySelector('.model-card');let box=$('views-loading');
    card.classList.toggle('views-busy',!!d);
    if(!d){box?.remove();return;}
    if(!box){box=document.createElement('div');box.id='views-loading';box.setAttribute('role','status');box.setAttribute('aria-live','polite');card.append(box);}
    const what=d.kind==='apart'?'Floors apart':'All plans',pct=d.total?Math.round(100*d.done/d.total):0;
    box.innerHTML=`<div><b>Loading ${what}</b><span>${d.total?`${Math.min(d.done+1,d.total)} of ${d.total} · ${escapeHtml(d.name||'')}`:'Preparing…'}</span><div class="vl-bar"><i style="width:${Math.max(4,pct)}%"></i></div><small>${pct}% · the model controls wait until this finishes</small><button data-vl-cancel>Cancel</button></div>`;
    box.querySelector('[data-vl-cancel]').onclick=()=>{if(d.kind==='apart')tracker?.setApart(false);else tracker?.setAllPlans(false);};
});
window.addEventListener('pagehide',()=>tracker?.endPlayback());
// Start / finish move the timeline there; the share card goes to the Gantt.
document.querySelectorAll('[data-headline]').forEach(b=>b.onclick=()=>{if(!tracker?.schedule||!summary)return;setWorkspaceMode('both');$('connect-page').hidden=true;$('panel').hidden=false;tracker.setTab('gantt');const key=b.dataset.headline;if(key==='start'&&summary.start)tracker.setCursor(summary.start,{move:true});else if(key==='finish'&&summary.finish)tracker.setCursor(summary.finish,{move:true});main.scrollIntoView({block:'start'});renderDrill();});
document.querySelectorAll('[data-review]').forEach(b=>b.onclick=async()=>{if(!tools)return;const action=b.dataset.review;if(action==='shot')tools.screenshot('3d');else if(action==='top')tools.look([0,0,1]);else if(action==='iso')tools.look([1,-1,.8]);else{tracker?.clearFocus();await views.setLevel(null);views.showAll();tools.look([1,-1,.8]);views.fitShown();tracker?.refresh();tracker?.renderBody();}const detail=b.closest('details');if(detail)detail.open=false;});
$('help').onclick=()=>$('briefing').showModal();
mountScheduleLinkGuide({button:$('linking-guide'),dialog:$('link-guide'),canReview:()=>!!tracker?.schedule,onSources:()=>openConnect('revit'),onReview:()=>{setWorkspaceMode('both');$('panel').hidden=false;$('connect-page').hidden=true;const panel=tracker.panel,links=panel.querySelector('[data-links]');links.hidden=false;panel.querySelector('[data-links-toggle]')?.classList.add('active');tracker.renderLinks();tracker.fitGantt();panel.scrollTop=0;main.scrollIntoView({block:'start'});panel.querySelector('[data-link-review-filter]')?.focus();}});
$('present').onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}catch{$('save-notice').textContent='Use the browser full-screen command to present.';}};
document.addEventListener('fullscreenchange',()=>{$('present').textContent=document.fullscreenElement?'Exit presentation':'Present';decorateControls();});
document.addEventListener('keydown',e=>{if(e.key==='Escape')document.querySelectorAll('details[open]').forEach(d=>d.open=false);});
document.addEventListener('progress-summary',e=>{
    summary=e.detail;const s=summary;if(!s?.schedule)return;
    $('kpi-walls').textContent=s.walls.toLocaleString();$('kpi-levels').textContent=s.levels+' levels';$('kpi-activities').textContent=s.activities;
    $('snapshot-date').textContent=dashboardDate(s.cursor);$('model-health').textContent='Viewer ready';$('model-health').classList.add('connected');$('model-loading').hidden=true;$('demo-reset').disabled=false;
    $('project-status').textContent=s.activities?`The model shows the schedule on ${dashboardDate(s.cursor)}: ${s.reachedPct}% of walls are in drywall or framing work started by then.`:'No schedule loaded yet.';
    $('start-value').textContent=dashboardDate(s.start);$('finish-value').textContent=dashboardDate(s.finish);$('reached-value').textContent=s.activities?s.reachedPct+'%':'—';
    $('reached-status').textContent='On '+dashboardDate(s.cursor);
    renderModelStatusLegend(s);
    renderPlannedLf(s);
    renderSources();renderDrill();
});
// Above the model: the wall length (LF) the schedule expects done by the shown date, per stage and overall, with the
// planned curve over the whole schedule (a marker on the shown date; click the graph to move the date there).
function renderPlannedLf(s){
    let el=$('plan-progress');const lf=s.lf;
    if(!lf?.total){el?.remove();return;}
    if(!el){el=document.createElement('section');el.id='plan-progress';el.setAttribute('aria-label','Planned wall length by the shown date');document.querySelector('.model-card .model-bar').after(el);}
    const color=new Map((s.stages||[]).map(x=>[x.name,x.color])),c=lf.curve,W=300,H=46,n=Math.max(1,c.length-1);
    const span=Date.parse(lf.to)-Date.parse(lf.from),at=span>0?Math.max(0,Math.min(1,(Date.parse(s.cursor)-Date.parse(lf.from))/span)):0;
    // Each bar: the wall length the schedule plans in that week (the curve's step), stacked by stage.
    const weeks=c.slice(1).map((p,i)=>({from:c[i].day,to:p.day,parts:lf.stages.map(r=>({stage:r.stage,lf:Math.max(0,(p.stages.find(q=>q.stage===r.stage)?.planned||0)-(c[i].stages.find(q=>q.stage===r.stage)?.planned||0))}))}));
    const top=Math.max(1,...weeks.map(w=>w.parts.reduce((t,q)=>t+q.lf,0))),bw=W/Math.max(1,weeks.length),now=Math.min(weeks.length-1,Math.floor(at*weeks.length));
    const bars=weeks.map((w,i)=>{let y=H;const total=w.parts.reduce((t,q)=>t+q.lf,0);return `<g class="${i===now?'pp-wk now':i>now?'pp-wk later':'pp-wk'}"><title>Week of ${escapeHtml(dashboardDate(w.from))}: ${Math.round(total).toLocaleString()} LF planned${w.parts.filter(q=>q.lf>0).map(q=>`\n${q.stage}: ${Math.round(q.lf).toLocaleString()} LF`).join('')}</title>${w.parts.map(q=>{const h=(q.lf/top)*(H-4);y-=h;return h>0?`<rect x="${(i*bw+.6).toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(.8,bw-1.2).toFixed(1)}" height="${h.toFixed(1)}" fill="${color.get(q.stage)||'#8c96a0'}"/>`:'';}).join('')}</g>`;}).join('');
    // Axis: each month's first day (Sep 1, Oct 1, ...) where it falls (not under the shown date's badge), with the
    // start and finish dates at the ends.
    const short=d=>new Date(String(d).slice(0,10)+'T12:00:00Z').toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'UTC'}),ticks=[];
    if(span>0)for(let d=new Date(lf.from.slice(0,7)+'-01T00:00:00Z');d.getTime()<=Date.parse(lf.to);d.setUTCMonth(d.getUTCMonth()+1)){const f=(d.getTime()-Date.parse(lf.from))/span;if(f>0.06&&f<0.94&&Math.abs(f-at)>0.06)ticks.push(`<span class="pp-tick" style="left:${(f*100).toFixed(2)}%">${escapeHtml(short(d.toISOString()))}</span>`);}
    const axis=`<span class="pp-end">${escapeHtml(short(lf.from))}</span>${ticks.join('')}<span class="pp-end last">${escapeHtml(short(lf.to))}</span>`;
    const cum=c.map((p,i)=>`${((i/n)*W).toFixed(1)},${(H-2-(p.pct/100)*(H-4)).toFixed(1)}`).join(' ');
    el.innerHTML=`<div class="pp-head" title="Per schedule (working days elapsed in each activity), not field-verified"><strong>${lf.pct}%</strong><span><b>Planned by ${escapeHtml(dashboardDate(s.cursor))}${lf.level?` · ${escapeHtml(lf.level)}`:''}${lf.filtered?` · ${escapeHtml(lf.filtered==='filtered'?'filtered':lf.filtered)}`:''}</b><small>${lf.planned.toLocaleString()} / ${lf.total.toLocaleString()} LF across ${lf.stages.length} stage${lf.stages.length===1?"":"s"} · per schedule</small></span></div>
        <div class="pp-stages">${lf.stages.map(r=>`<div class="pp-stage" title="${escapeHtml(r.stage)}: ${r.planned.toLocaleString()} of ${r.total.toLocaleString()} LF planned by ${escapeHtml(dashboardDate(s.cursor))}"><span><i style="background:${color.get(r.stage)||'#8c96a0'}"></i>${escapeHtml(r.stage)}</span><b>${r.pct}%</b><div class="pp-bar"><i style="width:${r.pct}%;background:${color.get(r.stage)||'#8c96a0'}"></i></div></div>`).join('')}</div>
        <figure class="pp-hist"><figcaption><b>Planned LF per week${lf.level?` · ${escapeHtml(lf.level)}`:''}</b><span>${Math.round(top).toLocaleString()} LF peak week</span></figcaption>
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Wall length planned each week, by stage, with the cumulative percent; click to move the date">${bars}
            <polyline points="${cum}" class="pp-cum"/><line x1="${(at*W).toFixed(1)}" x2="${(at*W).toFixed(1)}" y1="0" y2="${H}" class="pp-now"/></svg>
        <div class="pp-axis">${axis}<span class="pp-axis-now" style="left:${(at*100).toFixed(2)}%">${escapeHtml(short(s.cursor))}</span></div></figure>`;
    el.querySelector('.pp-hist svg').onclick=e=>{const r=e.currentTarget.getBoundingClientRect(),f=Math.max(0,Math.min(1,(e.clientX-r.left)/r.width));const d=new Date(Date.parse(lf.from)+f*span).toISOString().slice(0,10);tracker?.setCursor(d,{move:true});};
}
renderSources();decorateControls();
async function start(){
    if(!window.Autodesk?.Viewing?.GuiViewer3D)throw Error('The Autodesk Viewer could not load. Check your internet connection to the Autodesk services, then retry.');
    const [{TOOLS_EXTENSION_ID}]=await Promise.all([import('./tools.js'),import('./demos/03-progress/extension.js')]);
    const params=new URLSearchParams(location.search);params.set('layout','split');params.set('tab','gantt');history.replaceState(null,'',location.pathname+'?'+params+location.hash);
    const models=await fetchJson('samples/urns.json'),model=models.find(m=>/WILTON/i.test(m.file||'')||m.progressDemo==='hotel')||models.find(m=>m.sampleSchedule);if(!model)throw Error('The demonstration model is unavailable.');
    const hotel=/WILTON/i.test(model.file||'')||model.progressDemo==='hotel';$('project-name').textContent=(hotel?'Wilton Hotel':model.name.replace(/ \(Arch\)$/,''))+' (Demo)';
    linkKey='cas-project-dashboard:links:'+model.urn;
    try{const saved=JSON.parse(localStorage.getItem(linkKey)||'{}');for(const source of INTEGRATIONS)if(saved[source.id]&&Number.isFinite(Date.parse(saved[source.id].at)))links[source.id]={at:saved[source.id].at,system:source.id==='labour'&&saved[source.id].system==='Internal labour tool'?source.name:String(saved[source.id].system||source.name),mode:saved[source.id].mode==='setup'?'setup':'demo',project:String(saved[source.id].project||'')};}catch{}
    const access=await fetch(CONFIG.tokenUrl,{cache:'no-store'});if(!access.ok)throw Error(`Model access service returned ${access.status}. Retry when the connection is available.`);
    location.hash=model.urn;const viewer=await initViewer($('preview'));views=new Views(viewer);views.setSelectionFollow(true,{contextZoom:$('selection-context-zoom').checked});views.on('selectioncontext',context=>{const el=$('selection-context');el.dataset.level=context.level||'';el.hidden=!context.ids.length;el.textContent=context.level?`${context.ids.length} wall${context.ids.length===1?'':'s'} selected · ${context.level} · Whole floor context · ${context.plan}`:'Selection spans levels or has no wall-level mapping';setWorkspaceMode('both');if(context.level&&tracker){tracker.selectedAct=null;tracker.linkedOnly=false;tracker.isolatedBySchedule=false;tracker.isolatedStage=null;tracker.refresh();tracker.renderBody();}tracker?.setModelSelection(context);renderDrill();});
    tools=await viewer.loadExtension(TOOLS_EXTENSION_ID,{views,is3d:true,toolbar:{builtin:[],tools:['showall','fit']}});views.use2d(TOOLS_EXTENSION_ID,{views,is3d:false,toolbar:{builtin:[],tools:['showall','fit']}});
    mountViewControls();
    // The model opens in an iso (3/4) view, fitted with a margin, once its floors are known.
    let firstView=false;
    onModelReady(viewer,m=>views.setModel(m).then(()=>{if(firstView)return;firstView=true;tools?.look([1,-1,.8]);views.fitShown();}).catch(()=>{$('save-notice').textContent='Model loaded; floor-plan setup needs a retry.';}));
    tracker=await viewer.loadExtension('Drywall.Progress',{panel:$('panel'),views,standalone:true,hotelDemo:hotel,reviewPdf:file=>openP6('import',file)});
    mountHoverProperties();
    mountModelExtras(viewer);
    // Clicking an element opens its properties (Properties on), docked by the Viewer beside the 3D view.
    viewer.addEventListener(Autodesk.Viewing.SELECTION_CHANGED_EVENT,()=>{if(propsOn()&&viewer.getSelection().length)builtinPanel('Autodesk.PropertiesManager',true);});
    // Walls only: the 3D viewer now, the sheet viewer as soon as it exists (it is made when the plan pane first shows).
    watchWallSelection(viewer);
    document.addEventListener('pointerdown',()=>watchWallSelection(views.viewer2d),{capture:true,passive:true});
    views.on('level',()=>watchWallSelection(views.viewer2d));
    // A floor plan of another level picked in the Sheet list takes the 3D (section, schedule, LF) to that level too;
    // the sheet stays the one picked.
    $('sheets').addEventListener('change',()=>{const name=views.sheets[Number($('sheets').value)]?.levelName;if(name&&!views.apart&&views.levelOf(name)&&name!==views.level?.name)views.setLevel(name,{plan:false});});
    await loadModel(viewer,model.urn);
    views.on('level',()=>{if($('selection-context').dataset.level!==views.level?.name)$('selection-context').hidden=true;renderDrill();});renderSources();new ResizeObserver(()=>views.resize()).observe($('main'));
}
start().catch(err=>{$('model-health').textContent='Connection needs attention';$('model-loading').replaceChildren();const title=document.createElement('b');title.textContent='Model connection unavailable';const message=document.createElement('p');message.textContent=err.message||'Check your connection to the Autodesk services.';const retry=document.createElement('button');retry.textContent='Retry';retry.onclick=()=>location.reload();$('model-loading').append(title,message,retry);$('save-notice').textContent='Open Help for connection guidance.';});

// --- 3D viewer switch: APS (the default; its code path is unchanged), That Open IFC, Speckle (not connected yet) ---
// Nothing here runs until IFC is picked. The IFC viewer takes the 3D slot; the 2D pane stays the APS sheet. Walls are
// matched by IFC GlobalId, worked out from each APS wall's Revit UniqueId (ifc-guid.mjs).
let engine='aps',ifc=null,ifcHost=null,ifcBridged=false,ifcQueue=Promise.resolve();
const guidOfWall=new Map(),wallOfGuid=new Map();
function wallGuids(){if(guidOfWall.size||!tracker?.walls)return;for(const w of tracker.walls){const g=revitIfcGuid(w.externalId);if(g){guidOfWall.set(w.dbId,g);wallOfGuid.set(g,w);}}}
function ifcColors(colors){const out=new Map();for(const [id,hex] of colors||[]){const g=guidOfWall.get(id);if(g)out.set(g,hex);}return out;}
function levelGuids(){const name=views?.level?.name;return name&&tracker?.walls?tracker.walls.filter(w=>w.level===name).map(w=>guidOfWall.get(w.dbId)).filter(Boolean):null;}
function ifcStatus(text,{error=false,choose=false}={}){
    const el=ifcHost?.querySelector('.ifc-status');if(!el)return;
    el.hidden=!text&&!choose;el.classList.toggle('error',error);
    el.innerHTML=`${text?`<span>${escapeHtml(text)}</span>`:''}${choose?'<label class="ifc-choose">Choose IFC file…<input type="file" accept=".ifc,.frag" hidden></label><small>An IFC export of this building (Revit, IFC2x3 or IFC4). It is read in this browser and kept here after the first conversion.</small>':''}${error?'<button data-ifc-back>Back to APS</button>':''}`;
    el.querySelector('[data-ifc-back]')?.addEventListener('click',()=>setEngine('aps'));
}
function chooseIfcFile(){return new Promise(resolve=>{ifcStatus('No IFC model on this site yet.',{choose:true});ifcHost.querySelector('.ifc-choose input').onchange=e=>resolve(e.target.files[0]||null);});}
async function loadIfcModel(){
    // The site's own converted model first (the browser's HTTP cache keeps it between visits), then one converted in
    // this browser earlier, then a file the user picks.
    ifcStatus('Downloading the IFC model…');
    const hosted=await fetch('ifc/wilton.frag').catch(()=>null);
    if(hosted?.ok){const bytes=await hosted.arrayBuffer();ifcSource={bytes:bytes.slice(0),name:'wilton.frag'};await ifc.load({bytes,name:'wilton.frag'});return;}
    let key='';try{key=localStorage.getItem('cas-project-dashboard:ifc-key')||'';}catch{}
    if(key)try{await ifc.load({key,name:'the IFC model'});ifcSource={key,name:'the IFC model'};return;}catch{}
    const file=await chooseIfcFile();if(!file)throw Error('No IFC file chosen.');
    key=`${file.name}:${file.size}:${file.lastModified}`;
    await ifc.load({bytes:await file.arrayBuffer(),name:file.name,key});ifcSource={key,name:file.name};
    try{localStorage.setItem('cas-project-dashboard:ifc-key',key);}catch{}
}
function bridgeIfc(){
    if(ifcBridged)return;ifcBridged=true;
    const setColors=views.setColors.bind(views);
    views.setColors=colors=>{setColors(colors);if(engine==='ifc'&&ifc?.loaded)ifc.setColors(ifcColors(colors));if(ifcPlanOn())ifcPlan.setColors(ifcColors(colors));if(engine==='speckle'&&spk?.loaded)spk.setColors(ifcColors(colors));};
    views.on('level',()=>{if(engine!=='speckle'||!spk?.loaded)return;const g=levelGuids();spk.section(g);spk.frame(g);});
    // IFC camera moves run in order: a floor change frames the floor, then a linked selection zooms to its walls.
    const queue=fn=>{ifcQueue=ifcQueue.then(()=>engine==='ifc'&&ifc?.loaded?fn():null).catch(err=>console.warn('IFC viewer:',err));};
    views.on('level',()=>queue(async()=>{const g=levelGuids();await ifc.section(g);await ifc.frame(g);if(ifcPlanOn())await planAtLevel();}));
    views.on('sheet',()=>{if(ifcPlanOn()&&!views.level)queue(planAtLevel);});
    // Plan <-> 3D: a selection on the sheet (or in the IFC view) zooms the IFC view to it, as Linked selection zoom does in APS.
    views.on('selectioncontext',({ids})=>{if(!$('selection-context-zoom')?.checked)return;const g=(ids||[]).map(id=>guidOfWall.get(id)).filter(Boolean);if(!g.length)return;if(engine==='speckle'&&spk?.loaded)spk.frame(g,null,{min:6});queue(async()=>{await ifc.frame(g,null,{min:6});if(ifcPlanOn())await ifcPlan.frame(g,null,{min:6});});});
    views.viewer3d.addEventListener(Autodesk.Viewing.SELECTION_CHANGED_EVENT,()=>{const g=views.viewer3d.getSelection().map(id=>guidOfWall.get(id)).filter(Boolean);if(engine==='ifc'&&ifc?.loaded)ifc.select(g);if(ifcPlanOn())ifcPlan.select(g);if(engine==='speckle'&&spk?.loaded)spk.select(g);});
}
// A pick in the IFC view selects the same wall through the APS pipeline (sheet highlight, floor, related activities).
// Of the elements under the pointer (nearest first) it takes a wall of the shown floor, else the nearest wall.
function pickFromIfc(guids){
    const walls=guids.map(g=>wallOfGuid.get(g)).filter(Boolean),level=views?.level?.name;
    const w=walls.find(x=>!level||x.level===level)||(level?null:walls[0]);
    if(w)views.select([w.dbId]);else{views.viewer3d.clearSelection();if(guids.length&&!wallsOnly)$('save-notice').textContent='Picked an IFC element that is not one of the schedule walls.';}
}
async function setEngine(name){
    if(name===engine||!views)return;
    engine=name;
    document.querySelectorAll('[data-engine]').forEach(b=>b.setAttribute('aria-pressed',b.dataset.engine===engine));
    const preview=$('preview');
    document.querySelectorAll('.plan-source').forEach(g=>g.hidden=engine!=='ifc');
    preview.classList.toggle('engine-ifc',engine==='ifc');preview.classList.toggle('engine-speckle',engine==='speckle');
    if(ifcHost)ifcHost.hidden=engine!=='ifc';if(spkHost)spkHost.hidden=engine!=='speckle';
    if(engine!=='ifc'){$('viewer2d').classList.remove('plan-ifc');if(ifcPlanHost)ifcPlanHost.hidden=true;}
    if(engine==='aps'){views.resize();return;}
    if(engine==='speckle'){await openSpeckle();return;}
    if(!ifcHost){ifcHost=document.createElement('div');ifcHost.id='ifc-view';ifcHost.innerHTML='<div class="ifc-canvas"></div><div class="ifc-status" role="status" hidden></div>';preview.append(ifcHost);}
    ifcHost.hidden=false;
    try{
        if(!ifc){const {createIfcEngine}=await import('./ifc-engine.mjs');ifc=await createIfcEngine(ifcHost.querySelector('.ifc-canvas'),{onStatus:t=>ifcStatus(t),onPick:pickFromIfc});}
        if(!ifc.loaded)await loadIfcModel();
        if(engine!=='ifc')return;
        wallGuids();bridgeIfc();
        const g=levelGuids();
        await ifc.setColors(ifcColors(views.colors));await ifc.section(g);await ifc.frame(g,'iso');
        ifc.select(views.viewer3d.getSelection().map(id=>guidOfWall.get(id)).filter(Boolean));
        ifc.rooms();
        ifcStatus('');
        if(planSource==='ifc')setPlanSource('ifc');
    }catch(err){console.warn('IFC viewer:',err);ifcStatus(`Open IFC: ${err.message||err}`,{error:true});}
}
// --- Speckle (the third 3D engine): static Speckle objects hosted with the site (speckle/wilton.json + chunks), shown
// by the Speckle viewer in the 3D slot with the same links as Open IFC (colors, floor section, picks, selection, linked
// zoom). Loaded only when Speckle is picked.
let spk=null,spkHost=null;
function spkStatus(text,{error=false}={}){
    const el=spkHost?.querySelector('.ifc-status');if(!el)return;
    el.hidden=!text;el.classList.toggle('error',error);
    el.innerHTML=`${text?`<span>${escapeHtml(text)}</span>`:''}${error?'<button data-spk-back>Back to APS</button>':''}`;
    el.querySelector('[data-spk-back]')?.addEventListener('click',()=>setEngine('aps'));
}
async function openSpeckle(){
    if(!spkHost){spkHost=document.createElement('div');spkHost.id='speckle-view';spkHost.innerHTML='<div class="ifc-canvas"></div><div class="ifc-status" role="status" hidden></div>';$('preview').append(spkHost);}
    spkHost.hidden=false;
    try{
        if(!spk){const {createSpeckleEngine}=await import('./speckle-engine.mjs');spk=await createSpeckleEngine(spkHost.querySelector('.ifc-canvas'),{onStatus:t=>spkStatus(t),onPick:pickFromIfc});}
        if(!spk.loaded)await spk.load('speckle/wilton.json');
        if(engine!=='speckle')return;
        wallGuids();bridgeIfc();
        const g=levelGuids();
        spk.setColors(ifcColors(views.colors));spk.section(g);spk.frame(g,'iso');
        spk.select(views.viewer3d.getSelection().map(id=>guidOfWall.get(id)).filter(Boolean));
        spkStatus('');
    }catch(err){console.warn('Speckle viewer:',err);spkStatus(`Speckle: ${err.message||err}`,{error:true});}
}
document.querySelectorAll('[data-engine]').forEach(b=>b.onclick=()=>setEngine(b.dataset.engine));

// --- Floor tags on the whole building, compact Properties, full-screen 3D -------------------------------------------
// Whole building in 3D (All levels): each floor's name beside the building at its height, sized to the space between
// floors on screen (closer floors: smaller text, and floors too close to read are skipped). Click a tag to go to that
// floor. Floors apart has its own labels; one floor shown needs none. Positions: the walls' fragment bounds (robust
// percentiles, so far-off elements don't move the tags) and Viewer3D.worldToClient, re-placed when the camera moves.
// https://aps.autodesk.com/en/docs/viewer/v7/reference/Viewing/Viewer3D/
function mountLevelTags(viewer){
    const layer=document.createElement('div');layer.className='level-tags';viewer.container.append(layer);
    let floors=null,frame=0;
    const pct=(arr,p)=>arr[Math.min(arr.length-1,Math.max(0,Math.floor(p*(arr.length-1))))];
    function measure(){
        const m=viewer.model,it=m?.getInstanceTree?.(),fl=m?.getFragmentList?.();
        if(!it||!fl||!views?.wallsByLevel?.size)return null;
        const b=new THREE.Box3(),xs=[],ys=[],out=[];
        for(const [name,ids] of views.wallsByLevel){
            if(!name||!views.levelOf(name))continue;const zs=[];
            for(const id of ids)it.enumNodeFragments(id,f=>{fl.getWorldBounds(f,b);if(b.isEmpty())return;zs.push(b.min.z);xs.push((b.min.x+b.max.x)/2);ys.push((b.min.y+b.max.y)/2);},true);
            if(zs.length)out.push({name,z:pct(zs.sort((p,q)=>p-q),.25)});
        }
        if(!out.length||!xs.length)return null;
        xs.sort((p,q)=>p-q);ys.sort((p,q)=>p-q);out.sort((p,q)=>p.z-q.z);
        const step=out.length>1?(out.at(-1).z-out[0].z)/(out.length-1):10;
        out.forEach((f,i)=>f.mid=(f.z+(out[i+1]?.z??f.z+step))/2);
        return {floors:out,x:[pct(xs,.02),pct(xs,.98)],y:[pct(ys,.02),pct(ys,.98)]};
    }
    // The building corner farthest left on screen at this height: tags sit just left of it.
    const cornerAt=z=>{const {x,y}=floors;return [[x[0],y[0]],[x[1],y[0]],[x[0],y[1]],[x[1],y[1]]].map(c=>({c,p:viewer.worldToClient(new THREE.Vector3(c[0],c[1],z))})).filter(o=>o.p).sort((a,b)=>a.p.x-b.p.x)[0];};
    function place(){
        frame=0;
        const all=engine==='aps'&&!views?.level&&!views?.apart&&viewer.model,one=engine==='aps'&&views?.level&&!views?.apart&&viewer.model;
        if(!all&&!one){layer.innerHTML='';return;}
        if(!floors)floors=measure();
        if(!floors){layer.innerHTML='';return;}
        // One floor shown: its name beside it, for context (click: every floor again).
        if(one){
            const f=floors.floors.find(o=>o.name===views.level.name),corner=f&&cornerAt(f.mid);
            if(!corner){layer.innerHTML='';return;}
            const left=corner.p.x>110,W=layer.clientWidth,H=layer.clientHeight,px=Math.min(W-8,Math.max(8,left?corner.p.x-6:corner.p.x+6)),py=Math.min(H-12,Math.max(12,corner.p.y));
            layer.style.setProperty('--tag-size','12px');
            layer.innerHTML=`<button class="level-tag current ${left?'left':'right'}" data-level-all style="left:${px.toFixed(0)}px;top:${py.toFixed(0)}px" title="Showing ${escapeHtml(f.name)} · click for every floor">${escapeHtml(f.name)}</button>`;
            layer.querySelector('[data-level-all]').onclick=e=>{e.stopPropagation();views.setLevel(null);};
            return;
        }
        const mid=floors.floors[Math.floor(floors.floors.length/2)].mid;
        const corner=cornerAt(mid);
        if(!corner){layer.innerHTML='';return;}
        const pts=floors.floors.map(f=>({f,p:viewer.worldToClient(new THREE.Vector3(corner.c[0],corner.c[1],f.mid))})).filter(o=>o.p);
        const gaps=pts.slice(1).map((o,i)=>Math.abs(o.p.y-pts[i].p.y)).sort((a,b)=>a-b),gap=gaps.length?gaps[Math.floor(gaps.length/2)]:20;
        if(gap<5){layer.innerHTML='';return;}
        const size=Math.max(8,Math.min(12.5,gap*.62)),W=layer.clientWidth,H=layer.clientHeight;let last=Infinity;
        const keep=[];for(const o of [...pts].sort((a,b)=>b.p.y-a.p.y)){if(last-o.p.y<size+3)continue;last=o.p.y;keep.push(o);}
        const left=corner.p.x>90;
        layer.style.setProperty('--tag-size',size.toFixed(1)+'px');
        layer.innerHTML=keep.filter(o=>o.p.y>-10&&o.p.y<H+10&&o.p.x>-40&&o.p.x<W+40).map(o=>`<button class="level-tag ${left?'left':'right'}" data-level-tag="${escapeHtml(o.f.name)}" style="left:${(left?o.p.x-6:o.p.x+6).toFixed(0)}px;top:${o.p.y.toFixed(0)}px" title="Show ${escapeHtml(o.f.name)}">${escapeHtml(o.f.name)}</button>`).join('');
        layer.querySelectorAll('[data-level-tag]').forEach(b=>b.onclick=e=>{e.stopPropagation();views.setLevel(b.dataset.levelTag);});
    }
    const later=()=>{if(!frame)frame=requestAnimationFrame(place);};
    viewer.addEventListener(Autodesk.Viewing.CAMERA_CHANGE_EVENT,later);
    viewer.addEventListener(Autodesk.Viewing.GEOMETRY_LOADED_EVENT,()=>{floors=null;later();});
    views.on('level',later);new ResizeObserver(later).observe(viewer.container);
    document.addEventListener('progress-summary',later);
    layer.addEventListener('pointerdown',e=>{if(e.target.closest('.level-tag'))e.stopPropagation();});
    return {refresh:later};
}

// The Viewer's Properties panel, compact: opened at the top right of the 3D view, narrower and shorter (move or
// resize it as usual). Rows and title are made smaller in install-progress.css.
function placePropertiesPanel(){
    const host=views?.viewer3d?.container,panel=host?.querySelector('.property-panel');
    if(!panel||panel.dataset.compact)return;
    panel.dataset.compact='1';
    const w=Math.min(280,host.clientWidth-24),h=Math.max(160,Math.min(320,host.clientHeight-24));
    Object.assign(panel.style,{left:Math.max(8,host.clientWidth-w-12)+'px',top:'10px',width:w+'px',height:h+'px'});
    window.dispatchEvent(new Event('resize'));
}

// Full-screen 3D: only the model, with its own timeline (play, date, week, planned LF), floor and view controls and the
// color legend. These extra controls exist only in full screen; Esc or Exit returns to the dashboard as it was.
// Element.requestFullscreen (falls back to filling the window when the browser refuses).
let fullUi=null;
async function setModelFull(on){
    const preview=$('preview');
    if(on===!!fullUi)return;
    if(on){
        preview.classList.add('model-full');
        fullUi=document.createElement('div');fullUi.className='full-ui';
        fullUi.innerHTML=`<div class="full-top"><b>${escapeHtml($('project-name').textContent)}</b><label>Floor <select data-full-level></select></label><span class="full-views"><button data-full-view="top">Top</button><button data-full-view="iso">Iso</button><button data-full-view="fit">Fit</button></span><button class="full-exit" data-full-exit title="Back to the dashboard (Esc)">Exit full screen</button></div>
            <div class="full-gantt" data-full-gantt></div>
            <div class="full-time"><button data-full-play>Play</button><div class="full-date"><b data-full-date></b><small data-full-week></small></div><div class="full-track"><input type="range" data-full-range min="0" value="0" aria-label="Schedule date"><div class="full-ticks" data-full-ticks></div></div><div class="full-lf" data-full-lf></div></div>`;
        preview.append(fullUi);
        fullUi.querySelector('.full-top').insertBefore($('model-legend'),fullUi.querySelector('[data-full-exit]'));
        if($('plan-progress'))preview.append($('plan-progress'));
        const tip=document.querySelector('.hover-props');if(tip)preview.append(tip);
        const sel=fullUi.querySelector('[data-full-level]');
        sel.innerHTML=$('levels').innerHTML;sel.value=$('levels').value;
        sel.onchange=()=>views.setLevel(sel.value||null);
        fullUi.querySelectorAll('[data-full-view]').forEach(b=>b.onclick=()=>document.querySelector(`.view-context-controls [data-view-command="${b.dataset.fullView}"]`)?.click());
        fullUi.querySelector('[data-full-exit]').onclick=()=>setModelFull(false);
        fullUi.querySelector('[data-full-play]').onclick=()=>{if(!tracker)return;if(tracker.playTimer)tracker.stopPlay();else tracker.play();setTimeout(syncFull,50);};
        const range=fullUi.querySelector('[data-full-range]');
        range.oninput=()=>{if(!tracker?.span)return;tracker.stopPlay?.();tracker.setCursor(dayFrom(tracker.span[0],+range.value));};
        syncFull();
        // Not awaited: some browsers leave the request pending; the window-filling layout works either way.
        try{if(!document.fullscreenElement)preview.requestFullscreen?.()?.catch?.(()=>{});}catch{}
    }else{
        // The legend goes back to the banner before the full-screen layer (which holds it) is removed.
        document.querySelector('.project-banner .project-view-context')?.before($('model-legend'));
        const ui=fullUi;fullUi=null;ui?.remove();
        preview.classList.remove('model-full');
        document.querySelector('.project-banner .project-view-context')?.before($('model-legend'));
        if($('plan-progress'))document.querySelector('.model-card .model-bar')?.after($('plan-progress'));
        const tip=preview.querySelector('.hover-props');if(tip)document.body.append(tip);
        try{if(document.fullscreenElement)document.exitFullscreen()?.catch?.(()=>{});}catch{}
    }
    requestAnimationFrame(()=>{views?.resize();ifc&&window.dispatchEvent(new Event('resize'));});
}
const dayFrom=(start,n)=>new Date(Date.parse(start+'T00:00:00Z')+n*864e5).toISOString().slice(0,10);
function syncFull(){
    if(!fullUi||!tracker?.span)return;
    const [a,b]=tracker.span,days=Math.round((Date.parse(b)-Date.parse(a))/864e5),at=Math.round((Date.parse(tracker.cursor)-Date.parse(a))/864e5);
    const range=fullUi.querySelector('[data-full-range]');range.max=days;if(document.activeElement!==range)range.value=at;
    range.style.setProperty('--at',(days?100*at/days:0).toFixed(2)+'%');
    const d=new Date(tracker.cursor+'T12:00:00Z'),monday=new Date(d.getTime()-((d.getUTCDay()+6)%7)*864e5);
    fullUi.querySelector('[data-full-date]').textContent=d.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',year:'numeric',timeZone:'UTC'});
    fullUi.querySelector('[data-full-week]').textContent=`Week of ${monday.toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'UTC'})} · day ${at+1} of ${days+1}`;
    fullUi.querySelector('[data-full-play]').textContent=tracker.playTimer?'Pause':'Play';
    const lf=summary?.lf;fullUi.querySelector('[data-full-lf]').innerHTML=lf?.total?`<b>${lf.pct}%</b><span>planned LF${lf.level?' · '+escapeHtml(lf.level):''}<small>${lf.planned.toLocaleString()} / ${lf.total.toLocaleString()} LF</small></span>`:'';
    const ticks=fullUi.querySelector('[data-full-ticks]');
    if(ticks.dataset.span!==a+b){ticks.dataset.span=a+b;const out=[];for(let m=new Date(a.slice(0,7)+'-01T00:00:00Z');m.getTime()<=Date.parse(b);m.setUTCMonth(m.getUTCMonth()+1)){const f=(m.getTime()-Date.parse(a))/864e5/Math.max(1,days);if(f>=0&&f<=1)out.push(`<span style="left:${(100*f).toFixed(2)}%">${m.toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'UTC'})}</span>`);}ticks.innerHTML=out.join('');}
    const sel=fullUi.querySelector('[data-full-level]');if(sel&&document.activeElement!==sel)sel.value=$('levels').value;
    renderFullGantt();
}
// Full screen: a Gantt strip of the work around the shown date (a week before to three weeks after): what is under way
// first, then what starts next, up to 6 rows, each bar in its stage's color with the shown date marked. Same filters as
// the schedule (floor, search, column filters). Click a row to pick that activity.
function renderFullGantt(){
    const el=fullUi?.querySelector('[data-full-gantt]');if(!el||!tracker?.linked||!tracker.cursor)return;
    const DAY=864e5,at=Date.parse(tracker.cursor),from=at-7*DAY,to=at+21*DAY,span=to-from,pos=t=>Math.max(0,Math.min(1,(t-from)/span))*100;
    const acts=tracker.visibleActivities('all').filter(a=>a.start&&a.finish&&a.type!=='start'&&a.type!=='finish'&&Date.parse(a.start)<=to&&Date.parse(a.finish)+DAY>=from);
    const live=a=>Date.parse(a.start)<=at&&Date.parse(a.finish)+DAY>at;
    acts.sort((a,b)=>(live(b)-live(a))||a.start.localeCompare(b.start)||String(a.id).localeCompare(String(b.id)));
    const rows=acts.slice(0,6),more=acts.length-rows.length,short=t=>new Date(t).toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'UTC'});
    const ticks=[0,1,2,3,4].map(i=>from+i*7*DAY);
    el.hidden=!acts.length;
    el.innerHTML=`<div class="fg-head"><b>${acts.filter(live).length} under way</b><span>${acts.length-acts.filter(live).length} starting in the next 3 weeks${more>0?` · ${more} more in the Gantt`:''}</span><div class="fg-axis">${ticks.map(t=>`<i style="left:${pos(t).toFixed(1)}%">${short(t)}</i>`).join('')}</div></div>
        ${rows.map(a=>{const l=pos(Date.parse(a.start)),r=pos(Date.parse(a.finish)+DAY),pct=a.pct??0;return `<button class="fg-row${a.id===tracker.selectedAct?' on':''}" data-fg-act="${escapeHtml(a.id)}" style="--stage-color:${tracker.colorOf(a)}" title="${escapeHtml(a.name)} · ${escapeHtml(a.id)} · ${escapeHtml(a.start)} – ${escapeHtml(a.finish)} · P6 ${pct}%"><span class="fg-name"><b>${escapeHtml(a.name)}</b><small>${escapeHtml(a.level||'Project')}${live(a)?' · under way':''}</small></span><span class="fg-track"><i class="fg-bar" style="left:${l.toFixed(1)}%;width:${Math.max(1.2,r-l).toFixed(1)}%"><i style="width:${pct}%"></i></i></span></button>`;}).join('')}
        <i class="fg-now" style="left:calc(12px + var(--fg-name) + (100% - 24px - var(--fg-name)) * ${(pos(at)/100).toFixed(4)})"></i>`;
    el.querySelectorAll('[data-fg-act]').forEach(b=>b.onclick=()=>tracker.selectActivity(b.dataset.fgAct));
}
document.addEventListener('progress-summary',()=>syncFull());
document.addEventListener('fullscreenchange',()=>{if(!document.fullscreenElement&&fullUi)setModelFull(false);requestAnimationFrame(()=>views?.resize());});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&fullUi&&!document.fullscreenElement)setModelFull(false);});
function mountModelExtras(viewer){
    mountLevelTags(viewer);
    mountPlanSource();
    addFitMenu(viewer);views.on('viewer2d',addFitMenu);
    viewer.addEventListener(Autodesk.Viewing.SELECTION_CHANGED_EVENT,()=>setTimeout(placePropertiesPanel,0));
    views.on('level',()=>syncFull());
}

// --- IFC plan (2D pane in IFC mode) and right-click fit --------------------------------------------------------------
// In IFC mode the plan pane can show the Revit sheet (APS, as before) or a plan of the IFC: a second That Open view,
// orthographic and locked looking down, cut 4'-0" above the floor as Revit plans are (REVIT_CUT), with the cut edges
// drawn, the schedule colors, room names and the same picks and selection links as the sheet. The sheet stays the
// default; the IFC plan opens only when picked.
let ifcPlan=null,ifcPlanHost=null,planSource='sheet',ifcSource=null;
function planLevelName(){return views?.level?.name||views?.planLevelName||[...(views?.wallsByLevel||[])].sort((a,b)=>b[1].length-a[1].length)[0]?.[0]||null;}
function planGuids(){const name=planLevelName();return name&&tracker?.walls?tracker.walls.filter(w=>w.level===name).map(w=>guidOfWall.get(w.dbId)).filter(Boolean):null;}
const ifcPlanOn=()=>engine==='ifc'&&planSource==='ifc'&&!!ifcPlan?.loaded;
function mountPlanSource(){
    const bar=document.querySelector('.pane2d-bar');if(!bar||bar.querySelector('.plan-source'))return;
    const g=document.createElement('div');g.className='plan-source';g.hidden=engine!=='ifc';g.setAttribute('role','group');g.setAttribute('aria-label','Plan source');
    g.innerHTML=`<button data-plan-source="sheet" aria-pressed="${planSource==='sheet'}" title="The Revit sheet (APS)">Sheet</button><button data-plan-source="ifc" aria-pressed="${planSource==='ifc'}" title="Open IFC (That Open engine): a plan of the IFC, cut 4'-0&quot; above the floor as Revit plans are">Open IFC plan</button>`;
    bar.append(g);
    g.querySelectorAll('[data-plan-source]').forEach(b=>b.onclick=()=>setPlanSource(b.dataset.planSource));
}
async function setPlanSource(name){
    planSource=name;
    document.querySelectorAll('[data-plan-source]').forEach(b=>b.setAttribute('aria-pressed',b.dataset.planSource===name));
    const pane=$('viewer2d');
    if(name!=='ifc'||engine!=='ifc'){pane.classList.remove('plan-ifc');if(ifcPlanHost)ifcPlanHost.hidden=true;views?.resize();return;}
    if(!ifcPlanHost){ifcPlanHost=document.createElement('div');ifcPlanHost.id='ifc-plan';ifcPlanHost.innerHTML='<div class="ifc-canvas"></div><div class="ifc-plan-note" role="status"></div>';pane.append(ifcPlanHost);}
    ifcPlanHost.hidden=false;pane.classList.add('plan-ifc');
    const note=ifcPlanHost.querySelector('.ifc-plan-note');
    try{
        if(!ifcPlan){note.textContent='Opening the Open IFC plan…';const {createIfcEngine}=await import('./ifc-engine.mjs');ifcPlan=await createIfcEngine(ifcPlanHost.querySelector('.ifc-canvas'),{plan:true,onPick:pickFromIfc,onStatus:t=>{note.textContent=t;}});}
        if(!ifcPlan.loaded){if(!ifcSource)throw Error('Open the IFC 3D view first.');await ifcPlan.load(ifcSource.bytes?{bytes:ifcSource.bytes.slice(0),name:ifcSource.name}:{key:ifcSource.key,name:ifcSource.name});}
        if(planSource!=='ifc'||engine!=='ifc')return;
        await ifcPlan.setColors(ifcColors(views.colors));await planAtLevel();
        ifcPlan.select(views.viewer3d.getSelection().map(id=>guidOfWall.get(id)).filter(Boolean));
    }catch(err){console.warn('IFC plan:',err);note.textContent=`IFC plan: ${err.message||err}`;}
}
async function planAtLevel(){
    if(!ifcPlan?.loaded)return;const name=planLevelName();
    ifcPlanHost.querySelector('.ifc-plan-note').textContent=name?`${name} · Open IFC plan · cut 4'-0" above the floor`:'';
    await ifcPlan.planAt(planGuids());
}
// Right-click a selected element: "Fit selection in 3D and plan" frames it in the 3D view and on the plan (and in the
// IFC views when they are shown). GuiViewer3D.registerContextMenuCallback:
// https://aps.autodesk.com/en/docs/viewer/v7/reference/Viewing/GuiViewer3D/
function fitSelectionBoth(ids){
    ids=ids?.length?ids:views.viewer3d.getSelection();if(!ids?.length)return;
    const v3=views.viewer3d,v2=views.viewer2d,g=ids.map(id=>guidOfWall.get(id)).filter(Boolean);
    if(v3?.model)views.fitPadded(v3,ids,v3.model,1.6);
    if(v2?.model)views.fitPadded(v2,ids,v2.model,2.2);
    if(engine==='ifc'&&g.length){ifc?.frame(g,null,{min:6});if(ifcPlanOn())ifcPlan.frame(g,null,{min:6});}
    if(engine==='speckle'&&g.length)spk?.frame(g,null,{min:6});
}
function addFitMenu(viewer){
    if(!viewer||viewer.__fitMenu)return;viewer.__fitMenu=true;
    viewer.registerContextMenuCallback('cas-fit-3d-plan',(menu,status)=>{if(status.hasSelected)menu.unshift({title:'Fit selection in 3D and plan',target:()=>fitSelectionBoth(viewer.getSelection())});});
}

// --- P6 Converter in the team site: the same tool as the standalone P6 Converter page (p6-converter.html), in a dialog.
// Header "P6 Converter": the demo (download only, never touches the dashboard). Upload of a PDF: the import copy gets
// the file; the user reviews it there and "Load into dashboard" sends the reviewed rows back (importReviewed). Two
// separate frames, so the demo stays isolated; messages are taken only from the import frame, same origin.
const p6Frames={};
function p6Dialog(){
    let d=$('p6-dialog');if(d)return d;
    d=document.createElement('dialog');d.id='p6-dialog';
    d.innerHTML='<header><b data-p6-title></b><span data-p6-note></span><button data-p6-close>Close</button></header><div class="p6-frames"></div>';
    document.body.append(d);
    d.querySelector('[data-p6-close]').onclick=()=>d.close();
    return d;
}
function p6Frame(mode){
    if(p6Frames[mode])return p6Frames[mode];
    const f=document.createElement('iframe');f.title=mode==='import'?'P6 Converter: review the upload':'P6 Converter demo';f.dataset.mode=mode;
    f.ready=new Promise(resolve=>{f.markReady=resolve;});
    f.src=`p6-converter.html?embed=${mode}`;
    p6Dialog().querySelector('.p6-frames').append(f);
    return p6Frames[mode]=f;
}
async function openP6(mode,file=null){
    const d=p6Dialog(),f=p6Frame(mode);
    for(const [m,frame] of Object.entries(p6Frames))frame.hidden=m!==mode;
    d.querySelector('[data-p6-title]').textContent=mode==='import'?`Review ${file?.name||'the schedule'} before loading`:'P6 Converter · demo';
    d.querySelector('[data-p6-note]').textContent=mode==='import'?'Same tool as the P6 Converter; Load into dashboard when ready.':'Separate from the dashboard: downloads only.';
    if(!d.open)d.showModal();
    if(file){await f.ready;f.contentWindow.postMessage({type:'p6-converter:file',file},location.origin);}
}
window.addEventListener('message',async e=>{
    if(e.origin!==location.origin)return;
    const frame=Object.values(p6Frames).find(f=>f.contentWindow===e.source);if(!frame)return;
    if(e.data?.type==='p6-converter:ready')frame.markReady();
    if(e.data?.type==='p6-converter:load'&&frame.dataset.mode==='import'){p6Dialog().close();await tracker?.importReviewed(e.data.doc,e.data.file,e.data.bytes);}
});
$('p6-open').onclick=()=>openP6('demo');
