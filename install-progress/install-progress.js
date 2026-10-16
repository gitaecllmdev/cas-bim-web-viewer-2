import {mountScheduleLinkGuide} from './schedule-link-guide.mjs';
import {initViewer,loadModel} from './viewer.js';
import {Views} from './views.js';
import {fetchJson,onModelReady,escapeHtml} from './helpers.js';
import {CONFIG} from './config.js';
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
function renderDrill(context={}){const level=views?.level?.name,act=tracker?.selectedAct,tab=tracker?.tab;const show=!!(level||act);$('drill-context').hidden=!show;$('drill-label').textContent=[level,act,tab?({gantt:'P6 Gantt',calendar:'P6 Gantt',lookahead:'Next 3 weeks'})[tab]:null].filter(Boolean).join(' · ');}
$('back-overview').onclick=backOverview;document.addEventListener('dashboard-context',e=>{renderDrill(e.detail);decorateControls();});
function showActivityContext(){setWorkspaceMode('both');if(!tracker?.apartOn&&!tracker?.allPlans?.isOpen)views?.setLayout('split');$('panel').hidden=false;$('connect-page').hidden=true;const panel=tracker?.panel,details=panel?.querySelector('.pg-details');if(details){const head=panel.querySelector('.pg-head');panel.scrollTop+=details.getBoundingClientRect().top-panel.getBoundingClientRect().top-(head?.offsetHeight||0)-12;}}
// Built-in Viewer panels: PropertiesManager (selected element's properties) and ModelStructure (model browser).
// https://aps.autodesk.com/en/docs/viewer/v7/reference/Extensions/PropertiesManager/ and .../Extensions/ModelStructure/
async function builtinPanel(id,on){
    try{const ext=views.viewer3d.getExtension(id)||await views.viewer3d.loadExtension(id);if(on)ext.activate();else ext.deactivate();}
    catch(err){$('save-notice').textContent=`${id==='Autodesk.ModelStructure'?'Model browser':'Properties'} is not available: ${err.message||err}`;}
}
const propsOn=()=>document.querySelector('[data-view-panel="props"]')?.getAttribute('aria-pressed')==='true';
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
        if(!id){tip.hidden=true;shown=null;return;}if(id===shown)return;shown=id;
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
    bar.innerHTML=`<button data-view-command="top" title="Look straight down at the model">Top view</button><button data-view-command="iso" title="Isometric 3D view">Iso view</button><button data-view-command="fit" title="Fit the current floor or building">Fit</button><button data-model-view="apart" aria-pressed="false" title="Every floor at once, each lifted over the one below, with the schedule's share per floor">Floors apart</button><label id="apart-gap" hidden title="Space between the floors">Gap <input type="range" min="0.5" max="3" step="0.25" value="1"></label><button data-model-view="plans" aria-pressed="false" title="Every floor sheet at once, colored by the schedule">All plans</button><button data-view-panel="props" aria-pressed="true" title="Properties: open the selected element's properties">Properties</button><button data-view-panel="browser" title="Model browser: hide or isolate parts of the model">Model browser</button>`;
    // The 3D view's buttons sit in the model card's toolbar, after the layout buttons, so the view itself stays clear.
    document.querySelector('.model-bar .layout').after(bar);
    bar.querySelectorAll('[data-view-command]').forEach(b=>b.onclick=()=>{const action=b.dataset.viewCommand;if(action==='fit')views.fitShown();else tools?.look(action==='top'?[0,0,1]:[1,-1,.8]);});
    bar.querySelectorAll('[data-model-view]').forEach(b=>b.onclick=async()=>{if(!tracker?.schedule)return;if(b.dataset.modelView==='apart')await tracker.setApart(!tracker.apartOn);else await tracker.setAllPlans(!tracker.allPlans.isOpen);renderModelStatusLegend(summary||{});});
    bar.querySelector('#apart-gap input').onchange=e=>tracker?.setApartGap(Number(e.target.value));
    // The color legend rides on the 3D view (top left).
    $('preview').append($('model-legend'));
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
    renderSources();renderDrill();
});
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
    // The model opens looking straight down (top view), fitted, once its floors are known.
    let topDone=false;
    onModelReady(viewer,m=>views.setModel(m).then(()=>{if(topDone)return;topDone=true;tools?.look([0,0,1]);views.fitShown();}).catch(()=>{$('save-notice').textContent='Model loaded; floor-plan setup needs a retry.';}));
    tracker=await viewer.loadExtension('Drywall.Progress',{panel:$('panel'),views,standalone:true,hotelDemo:hotel});
    mountHoverProperties();
    // Clicking an element opens its properties (Properties on), docked by the Viewer beside the 3D view.
    viewer.addEventListener(Autodesk.Viewing.SELECTION_CHANGED_EVENT,()=>{if(propsOn()&&viewer.getSelection().length)builtinPanel('Autodesk.PropertiesManager',true);});
    await loadModel(viewer,model.urn);
    views.on('level',()=>{if($('selection-context').dataset.level!==views.level?.name)$('selection-context').hidden=true;renderDrill();});renderSources();new ResizeObserver(()=>views.resize()).observe($('main'));
}
start().catch(err=>{$('model-health').textContent='Connection needs attention';$('model-loading').replaceChildren();const title=document.createElement('b');title.textContent='Model connection unavailable';const message=document.createElement('p');message.textContent=err.message||'Check your connection to the Autodesk services.';const retry=document.createElement('button');retry.textContent='Retry';retry.onclick=()=>location.reload();$('model-loading').append(title,message,retry);$('save-notice').textContent='Open Help for connection guidance.';});
