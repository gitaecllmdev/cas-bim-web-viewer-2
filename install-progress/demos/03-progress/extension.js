// Demo 03: Install Progress Tracker, with the P6 schedule (Gantt chart and calendar) linked to the walls
// Spec and acceptance criteria: demos/03-progress/README.md
// Viewer3D (setThemingColor, getSelection, isolate, fitToView, SELECTION_CHANGED_EVENT): https://aps.autodesk.com/en/docs/viewer/v7/reference/Viewing/Viewer3D/
// Model (getBulkProperties with externalId): https://aps.autodesk.com/en/docs/viewer/v7/reference/Viewing/Model/
// Stage colors go through core/client/views.js (3D + 2D plan); selecting walls on the plan selects them in 3D too.
// The schedule: p6.mjs reads the P6 export and links activities to levels and stages; schedule-views.js draws them.
import { loadPropertyMap, getWallData, onModelReady, loadState, saveState, escapeHtml, downloadCsv, fetchJson, modelKey, onDockChange } from '../../helpers.js';
import { readXlsx } from '../common/xlsx.mjs';
import { readSchedulePdf, renderPdfPage } from '../common/pdf-reader.mjs';
import { scheduleRows } from '../common/p6-pdf.mjs';
import {
    STAGE_NAMES, demoShift, assignDemoLevels, linkedLevelNames, levelPercents, topStage, parseDateText, decodeText, parseXer, scheduleFromXer, scheduleFromRows, parseCsv, calendarOf, linkActivities, matchLevel, matchStage,
    stageCounts, modelProgress, compare, expectedPct, finishVariance, plannedStages, playbackStages, scheduleSpan, ganttRows, completeGroups, fmtDay as compactDay, addDays, dayMs, monthName,
    randomWallLinks, wallProgress, demoTarget, activityLinkState, relatedWallActivities,
    assignElements, applyElementLinks, stageOverlaps, readElementLinkRows, previewElementLinks, elementLinkTemplate,
    isStage, scheduleStageLinks, scheduleStageNames, stageColors, scheduleWallsAt, floorScheduleShare, projectStart, GHOST_COLOR,
    activityLengths, plannedLengths, plannedCurve,
} from './p6.mjs';
import { ganttHtml, calendarHtml, SCALES, ganttX } from './schedule-views.js';
import { AllPlans } from './all-plans.js';
import { parseKeywords, matchRows, keywordCounts, remember } from '../../p6-keywords.mjs'; // the P6 Converter's keyword search
import { passes, distinctValues, searchValues, compareValues } from '../../p6-table.mjs'; // the P6 Converter's Excel-style column filters
import { DemoToolbar } from '../../toolbar.js';
import {demoStagesFromSchedule,hotelDemoSchedule,lookaheadWeeks,activityQuantities,DEMO_DATE,DEMO_VERSION} from './presentation.mjs';
import {dashboardDate,dashboardMetrics,labourSummary,activityInsight,dashboardIcon,DEMO_BIM,PLAYBACK_COLORS,INSTALL_COLORS,COMPARISON_COLORS,NEUTRAL_STATUS_COLOR,modelStatusLegend} from '../../project-dashboard.mjs';

// Base64 for the source PDF kept with a schedule (state is JSON).
const toBase64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const fromBase64 = (text) => Uint8Array.from(atob(text), ch => ch.charCodeAt(0));

const EXTENSION_ID = 'Drywall.Progress';
// Saved per model: 'progress' / 'schedule' for the sample model (Snowdon, the one with a sample schedule in
// samples/urns.json), 'progress-<model>' / 'schedule-<model>' for every other model, so their walls and schedules
// never mix. <model> is a short hash of its URN.

const SAMPLE = { url: 'samples/schedule/snowdon-drywall-p6.xer', file: 'snowdon-drywall-p6.xer' };
const NOT_SET = 'Not set';
// "Not started" walls keep their normal look (no color).
const STAGES = Object.entries(INSTALL_COLORS).map(([name,color])=>({name,color}));
const FINISHED = 'Finished';
const TABS = { stages: 'Stages', gantt: 'Gantt', calendar: 'Calendar' };
const COLOR_MODES = { actual: 'Colors: installed', planned: 'Colors: planned on date (4D)', compare: 'Colors: installed vs plan' };
const COMPARE = COMPARISON_COLORS;
const OTHER = '#8c96a0'; // wall work not linked to an install stage (layout, inspections), milestones
const NOT_WALL = '#cfd5dc'; // MEP and other trades: greyed, never linked to walls
const SHOW = { all: 'All activities', walls: 'Wall work only', active: 'In progress', open: 'Not complete', linked: 'Linked to walls', behind: 'Model behind P6', critical: 'Critical (float ≤ 0)' };
// WBS groups: finished ones folded (the default, so the work in progress is near the top), all open, or all folded.
const FOLD = { done: 'Fold finished groups', none: 'Open all groups', all: 'Fold all groups' };
const localToday = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in the viewer's time zone
const KW_HISTORY = 'drywall-demos:schedule-keywords'; // this browser's schedule search history
const KW_SUGGEST = ['framing', 'layout', 'drywall', 'board', 'tape', 'finish', 'insulation', 'shaftwall', 'soffit'];
const same = (x, y) => x.toLowerCase() === y.toLowerCase();
// The Gantt's filterable columns (Excel-style header menus).
const COLUMN_LABELS = { id: 'Activity ID', name: 'Activity name', start: 'Start', finish: 'Finish', dur: 'Dur', pct: 'P6 %' };
// A paler version of a stage color (an activity's walls before it starts): mixed 60% with white.
const tint = (hex) => '#' + [1, 3, 5].map(i => Math.round(parseInt(hex.slice(i, i + 2), 16) * 0.4 + 255 * 0.6).toString(16).padStart(2, '0')).join('');

class ProgressExtension extends Autodesk.Viewing.Extension {
    load() {
        this.views = this.options.views;
        this.panel = this.options.panel;
        this.panel.classList.add('wide'); // room for the per-level stage pickers
        this.stages = {};this.reviewed={};this.reviewKey=''; // externalId -> stage name (walls without an entry are "Not started")
        this.selected = [];
        this.modelSelectionIds = [];
        const params = new URLSearchParams(location.search);
        // Standalone: a model schedule viewer (the schedule on the model by date), no field progress tracking.
        this.tabs=this.options.standalone?{gantt:'Timeline',calendar:'Calendar',lookahead:'Lookahead'}:TABS;
        this.tab = this.tabs[params.get('tab')] ? params.get('tab') : this.options.standalone?'gantt':'stages';
        this.colorMode = 'actual';
        // Schedule views: only the walls linked to the schedule, the floors apart (views.setLevelsApart), all floor plans.
        this.linkedOnly = false;
        this.apartOn = false;
        this.allPlans = new AllPlans(this.views);
        this.gantt = { scale: 'week', show: 'all', links: 'selected', fold: 'done', collapsed: new Set(), filters: new Map(), sort: null };
        try { this.gantt.hiddenCols = new Set(JSON.parse(localStorage.getItem('cas-project-dashboard:gantt-columns') || '[]')); } catch { this.gantt.hiddenCols = new Set(); }
        this.selectedAct = null;
        this.lookWeeks = 3; // the schedule viewer's lookahead: 3, 6 or 12 weeks (remembered in this browser)
        try { const w = +localStorage.getItem('cas-project-dashboard:lookahead-weeks'); if ([3, 6, 12].includes(w)) this.lookWeeks = w; } catch {}
        this.demoMove = true;
        try { this.demoMove = localStorage.getItem('drywall-demos:schedule-demo-shift') !== 'false'; } catch {}
        // Schedule search: keywords in use, the text being typed, any / all, and the history of keywords used.
        this.kw = { active: [], typed: '', all: false, history: [] };
        try { this.kw.history = JSON.parse(localStorage.getItem(KW_HISTORY) || '[]'); } catch { /* storage blocked */ }
        this.panel.innerHTML = `<div class="demo-panel"><h2>Install Progress Tracker</h2><p class="muted" data-status>Waiting for a model…</p></div>`;
        this.onSelection = () => this.updateSelection();
        this.viewer.addEventListener(Autodesk.Viewing.SELECTION_CHANGED_EVENT, this.onSelection);
        this.resizer = new ResizeObserver(() => this.fitGantt());
        this.resizer.observe(this.panel);
        this.stops = [
            onModelReady(this.viewer, (model) => this.init(model)),
            this.views.on('level', () => {
                if (!this.walls) return;
                // A floor change drops the picked activity of another floor (Floors apart shows every floor: it keeps it).
                if (this.options.standalone && !this.apartOn && this.selectedAct && this.activity(this.selectedAct)?.level !== this.views.level?.name) {
                    this.clearFocus();this.refresh();
                } else if (this.options.standalone) this.refresh(); // the planned LF follows the level
                this.renderBody();
            }),
            onDockChange(() => { if (this.walls) this.render(); }), // the Gantt's width and its ⤢ button follow the dock
            // Levels and their elevations arrive after the walls: redraw so floors list bottom to top.
            this.views.on('ready', () => { if (this.walls) { this.linkedCache = null; this.renderBody(); } }),
        ];
        return true;
    }

    unload() {
        this.importController?.abort();
        this.stops.forEach(stop => stop());
        this.stopPlay();
        this.resizer.disconnect();
        this.viewer.removeEventListener(Autodesk.Viewing.SELECTION_CHANGED_EVENT, this.onSelection);
        this.bar?.remove();
        this.allPlans.close();
        this.closeColumnMenu();
        this.views.setApartLabels(null);
        this.views.setLevelsApart(null);
        this.views.clearColors();
        if (this.isolatedBySchedule || this.isolatedStage !== undefined || this.linkedOnly) this.views.showAll();
        this.panel.classList.remove('wide', 'xwide');
        this.panel.innerHTML = '';
        return true;
    }

    // --- The 3D toolbar: how the walls are colored, show only a stage, set the stage of the picked walls ------------
    // Extension.onToolbarCreated: https://aps.autodesk.com/en/docs/viewer/v7/reference/Viewing/Extension/
    onToolbarCreated() {
        if (this.bar || this.options.standalone) return; // the schedule viewer has no stage-setting toolbar
        const stage = (s, i) => ({ key: `s${i}`, icon: `dw-icon-stage-${i}`, name: s.name });
        this.bar = new DemoToolbar(this.viewer, 'dw-progress', [
            { key: 'colors', icon: 'dw-icon-colors', tip: 'Color the walls: as installed, as planned on a date (4D), or installed vs plan', items:
                Object.entries(COLOR_MODES).map(([k, label]) => ({ key: k, icon: `dw-icon-cm-${k}`, tip: label.replace(/^Colors: /, 'Color: ') + (k === 'actual' ? '' : ' (with a schedule)'),
                    run: () => this.setColorMode(k), on: () => this.colorMode === k })) },
            { key: 'show', icon: 'dw-icon-show-stage', tip: 'Show only the walls at a stage', items: [
                ...STAGES.map(stage).map(({ key, icon, name }) => ({ key, icon, tip: `Show only: ${name}`, run: () => this.isolateStage(name), on: () => this.isolatedStage === name })),
                { key: 'wip', icon: 'dw-icon-stage-wip', tip: 'Show only: in progress (framed, boarded or taped)', run: () => this.isolateStage('wip'), on: () => this.isolatedStage === 'wip' },
                { key: 'all', icon: 'dw-icon-showall', tip: 'Show all walls', run: () => this.isolateStage(null) },
            ] },
            { key: 'views', icon: 'dw-icon-sched-views', tip: 'Schedule views: only the linked walls, the floors apart, all floor plans', items: [
                { key: 'linked', icon: 'dw-icon-linked', tip: 'Only the walls linked to the schedule', run: () => this.setLinkedOnly(!this.linkedOnly), on: () => this.linkedOnly },
                { key: 'apart', icon: 'dw-icon-apart', tip: 'Floors apart: every floor at once, each lifted over the one below', run: () => this.setApart(!this.apartOn), on: () => this.apartOn },
                { key: 'plans', icon: 'dw-icon-all-plans', tip: 'All floor plans at once, beside the schedule', run: () => this.setAllPlans(!this.allPlans.isOpen), on: () => this.allPlans.isOpen },
            ] },
            { key: 'set', icon: 'dw-icon-set-stage', tip: 'Set the stage of the picked walls (pick them in 3D or on the plan, Ctrl+click for several)', items:
                STAGES.map(stage).map(({ key, icon, name }) => ({ key, icon, tip: `Picked walls: ${name}`, run: () => this.setStageFromToolbar(name) })) },
        ]);
    }

    setColorMode(mode) {
        this.endPlayback();
        if (mode !== 'actual' && !this.schedule) {
            this.message('Planned and installed-vs-plan colors come from a schedule: load the sample or upload one in the Gantt tab.', 'warn');
            return;
        }
        this.colorMode = mode;
        this.clearFocus();
        this.refresh();
        this.renderBody();
        const select = this.panel.querySelector('[data-color-mode]');
        if (select) select.value = mode;
        this.bar?.refresh();
    }

    // Show only the walls at a stage ('wip': framed, boarded or taped; null: all walls again).
    isolateStage(name) {
        if (!this.walls) return;
        this.isolatedStage = name;
        if (!name) { this.showDefault(); this.bar?.refresh(); return; }
        const ids = this.walls.filter(w => (name === 'wip' ? [1, 2, 3].includes(this.stageIndex(w)) : this.stageOf(w) === name)).map(w => w.dbId);
        if (!ids.length) {
            this.message(`No walls are ${name === 'wip' ? 'in progress' : name.toLowerCase()} yet.`);
            this.isolatedStage = null;
            this.showDefault();
        } else {
            this.views.isolate(ids);
            this.message(`Showing ${ids.length.toLocaleString()} wall${ids.length === 1 ? '' : 's'}: ${name === 'wip' ? 'in progress' : name}.`);
        }
        this.bar?.refresh();
        if (this.views.apart) this.updateFloorLabels(); // the floors show that stage
    }

    setStageFromToolbar(name) {
        if (!this.selected.length) {
            this.message('Pick the walls first, in 3D or on the plan (Ctrl+click for several), then set their stage.', 'warn');
            return;
        }
        this.setStage(name);
        this.message(`${this.selected.length.toLocaleString()} wall${this.selected.length === 1 ? '' : 's'} set to ${name}.`);
    }

    async init(model) {
        this.model = model;
        try {
            // Which model this is (the URN is the page's #hash), and whether it has the sample schedule.
            const urn = decodeURIComponent(location.hash.slice(1));
            const models = await fetchJson('samples/urns.json').catch(() => []);
            const entry = models.find(m => m.urn === urn) || (!urn ? models[0] : null);
            if(this.options.standalone){this.reviewKey='cas-project-dashboard:reviewed:'+urn;try{const savedReviews=JSON.parse(localStorage.getItem(this.reviewKey)||'{}');if(savedReviews&&typeof savedReviews==='object'&&!Array.isArray(savedReviews))this.reviewed=savedReviews;}catch{}}
            this.sampleSchedule = this.options.hotelDemo ? 'model-level-demo' : entry?.sampleSchedule || null;
            this.stateName = this.sampleSchedule ? 'progress' : `progress-${modelKey(urn)}`;
            this.scheduleState = this.sampleSchedule ? 'schedule' : `schedule-${modelKey(urn)}`;
            if(this.options.standalone){const key=modelKey('install-progress-demo:'+urn);this.stateName=`progress-${key}`;this.scheduleState=`schedule-${key}`;}
            const [map, saved, schedule] = await Promise.all([loadPropertyMap(), loadState(this.stateName), loadState(this.scheduleState).catch(() => ({}))]);
            this.map = map;
            this.stages = saved.stages || {};
            // The day the field progress was recorded, when the saved progress says (a demo data set does): the plan
            // timeline opens there, so "installed vs plan" compares the walls with the plan on that day.
            this.asOf = /^\d{4}-\d{2}-\d{2}$/.test(saved.asOf || '') ? saved.asOf : null;
            this.walls =(await getWallData(model, map)).walls.map(w=>({...w,level:w.level||null}));
            this.byDbId = new Map(this.walls.map(w => [w.dbId, w]));
            this.wallsByExternalId = new Map(this.walls.filter(w => w.externalId).map(w => [w.externalId, w]));
            this.modelNames = [entry?.name, modelKey(urn)].filter(Boolean); // what an element link spreadsheet's Model cell may say
            this.wallOrder = [...this.walls].sort((a, b) => a.dbId - b.dbId);
            // The schedule viewer shows the schedule on the model; no field stages are kept or shown.
            if (this.options.standalone) { this.stages = {}; this.asOf = null; }
            // A browser's saved copy of an older demo schedule is replaced by the current one (its own uploads are kept).
            const staleDemo = this.options.hotelDemo && schedule?.source?.sample && schedule.source.demoVersion !== DEMO_VERSION;
            if (schedule?.activities?.length && !staleDemo) { this.useSchedule(schedule); this.loadPdf(); }
            else if (!schedule?.removed && this.sampleSchedule) await this.loadSample({ quiet: true }).catch(err => console.warn('Sample schedule:', err.message));
            this.render();
        } catch (err) {
            this.panel.querySelector('[data-status]').textContent = `Could not load progress: ${err.message || err}`;
        }
    }

    stageOf(wall) {
        return this.stages[wall.externalId] || STAGES[0].name;
    }
    stageIndex(wall) {
        return Math.max(0, STAGE_NAMES.indexOf(this.stageOf(wall)));
    }

    // Level names in elevation order when known (views.levels), else by name.
    get levels() {
        const names = new Set(this.walls.map(w => w.level ?? NOT_SET));
        const ordered = this.views.levels.map(l => l.name).filter(n => names.has(n));
        return [...ordered, ...[...names].filter(n => !ordered.includes(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))];
    }

    // --- The schedule ----------------------------------------------------------------------------------------------

    useSchedule(schedule) {
        this.endPlayback();
        schedule.map ??= { levels: {}, stages: {}, activities: {} };
        this.schedule = schedule;
        this.cal = calendarOf(schedule);
        this.span = scheduleSpan(schedule.activities);
        this.linkedCache = null;
        this.selectedAct = null;
        const asOf = this.asOf && this.span && this.asOf >= this.span[0] && this.asOf <= this.span[1] ? this.asOf : null;
        // The schedule viewer always opens on the project's own start, never on today's date.
        const start = this.options.standalone ? projectStart(schedule.activities) || schedule.project.dataDate || localToday() : asOf || schedule.project.dataDate || localToday();
        this.cursor =this.span ? (start < this.span[0] ? this.span[0] : start > this.span[1] ? this.span[1] : start) : start;
        this.calMonth = this.cursor.slice(0, 7);
        this.scrolled = false;
        this.gantt.collapsed = this.foldSet(this.gantt.fold);
    }

    foldSet(mode) {
        if (mode === 'done') return new Set(completeGroups(this.linked, this.schedule));
        if (mode === 'all') return new Set(this.schedule.wbs.filter(w => w.parent || !this.schedule.wbs.some(c => c.parent === w.id)).map(w => w.id));
        return new Set();
    }

    get linked() {
        if (!this.linkedCache) {
            this.linkedCache = this.schedule ? linkActivities(this.schedule, this.levels) : [];
            // Schedule viewer: wall work is staged by the schedule's own names, not the tracker's stage list.
            if (this.options.standalone && this.schedule) scheduleStageLinks(this.linkedCache, this.schedule);
            // Demo schedules (moved to this year and this project): every activity not linked to a level and a stage
            // gets a repeatable set of walls on this model (p6.mjs randomWallLinks), so each one shows something.
            // A model's own schedule moved in time (keepLinks) keeps its level links.
            if (this.schedule?.source.demo && !this.schedule.source.demo.keepLinks && this.walls) {
                const byLevel = new Map();
                for (const w of this.wallOrder) if (w.level) (byLevel.get(w.level) || byLevel.set(w.level, []).get(w.level)).push(w.dbId);
                // Every wall activity gets its own walls, picked so the share already at its stage matches how far along
                // it should be (done / some of each / not yet): picking one shows a real split.
                const dataDate = this.schedule.project.dataDate, cal = this.cal;
                const links = randomWallLinks(this.linkedCache, byLevel, {
                    seed: this.schedule.project.id, all: true,
                    stageIndexOf: (id) => this.stageIndex(this.byDbId.get(id)),
                    target: (a, r) => demoTarget(a, r, { dataDate, cal }),
                });
                for (const a of this.linkedCache) {
                    // Reviewed mappings take precedence over illustrative wall picking.
                    const map = this.schedule.map, demoLevels = this.schedule.source.demo.levelAssignments || {};
                    if (map.elements?.[a.id]?.length) continue; // an exact element assignment replaces the demo set
                    if (this.options.standalone && (Object.keys(map.activities?.[a.id] || {}).length || Object.hasOwn(map.stages, a.stageKey) ||
                        Object.hasOwn(map.levels, a.locationKey) && map.levels[a.locationKey] !== demoLevels[a.locationKey])) continue;
                    const l = links.get(a.id);
                    if (!l) continue;
                    a.levelHow = `demo: ${l.dbIds.length} walls picked to match its progress${a.level && a.level !== l.level ? ` (was ${a.level})` : ''}`;
                    if (!a.stage) a.stageHow = 'demo: picked at random';
                    Object.assign(a, { level: l.level, stage: l.stage, walls: l.dbIds.map(id => this.byDbId.get(id)), demoWalls: true });
                }
            }
            // Exact element assignments (map.elements, by externalId) override floor/stage and demo wall sets.
            if (this.schedule?.map?.elements && this.walls) applyElementLinks(this.linkedCache, this.schedule.map.elements, this.wallsByExternalId);
            this.stageNames = scheduleStageNames(this.linkedCache);
            this.stageColorMap = stageColors(this.stageNames, this.schedule?.map?.colors);
        }
        return this.linkedCache;
    }
    activity(id) {
        return this.linked.find(a => a.id === id) || null;
    }

    async loadSample({ quiet = false } = {}) {
        if(this.options.hotelDemo){
            this.useSchedule(hotelDemoSchedule(this.walls.map(w=>w.level)));
            if(!quiet){this.render();this.message(`Loaded the demonstration schedule: ${this.schedule.activities.length} activities linked to the hotel's model levels.`);}
            return;
        }
        const resp = await fetch(SAMPLE.url);
        if (!resp.ok) throw new Error(`Sample schedule not found (${resp.status})`);
        let s = scheduleFromXer(parseXer(decodeText(await resp.arrayBuffer())), { file: SAMPLE.file });
        if(this.options.standalone)s=demoShift(s,{today:new Date(2026,9,12,12),project:'Snowdon Towers',day:s.project.dataDate,keepLinks:true});
        s.source.sample = true;
        this.useSchedule(s);
        if (!quiet) { this.render(); this.message(`Loaded the sample schedule (made up): ${s.activities.length} activities.`); }
    }

    // A P6 export: .xer, or a layout exported to Excel (.xlsx) or CSV.
    async importFile(file) {
        const ext = file.name.split('.').pop().toLowerCase();
        if (!['pdf', 'xer', 'xlsx', 'csv', 'txt'].includes(ext)) throw new Error('Choose a PDF, XER, XLSX or CSV file.');
        const buffer = ext === 'pdf' ? null : await file.arrayBuffer();
        let s, pdfNotes = '', pdfBytes = null;
        if (ext === 'pdf') {
            const doc = await readSchedulePdf(file, { signal: this.importController?.signal, onProgress: message => this.message(message, 'warn') });
            s = scheduleFromRows(scheduleRows(doc), { file: file.name, format: 'pdf', dataDate: parseDateText(doc.dataDate).day });
            pdfNotes = ` PDF: ${doc.warnings.length} import notes; no relationships or calendar in a PDF (Monday–Friday used).`;
            s.source.warnings = doc.warnings;
            // Where each activity is printed (page, y in points): "Show in the PDF" in its details.
            s.source.pdfRows = Object.fromEntries(doc.rows.filter(r => r.kind === 'Activity').map(r => [r.cells.id, [r.page, Math.round(r.y)]]));
            pdfBytes = new Uint8Array(await file.arrayBuffer());
        } else if (ext === 'xlsx') {
            let firstError;
            for (const sheet of await readXlsx(buffer)) {
                try { s = scheduleFromRows(sheet.rows, { file: file.name, format: 'xlsx' }); break; } catch (err) { firstError ??= err; }
            }
            if (!s) throw firstError || new Error('The workbook has no sheets');
        } else {
            const text = decodeText(buffer);
            s = /^ERMHDR|\n%T\t/.test(text) ? scheduleFromXer(parseXer(text), { file: file.name }) : scheduleFromRows(parseCsv(text), { file: file.name, format: 'csv' });
        }
        // The same project again (a schedule update): keep its links to the model (a demo-moved one by its original id).
        const current = this.schedule?.source.demo?.originalId || this.schedule?.project.id;
        if (current && current === s.project.id && !this.schedule.source.sample) s.map = structuredClone(this.schedule.source.original?.map || this.schedule.map);
        if (this.demoMove) s = await this.applyDemoMove(s);
        if (this.importController?.signal.aborted) return;
        this.stopPlay();
        this.useSchedule(s);
        this.render();
        if (!await this.saveSchedule()) return;
        this.pdfBytes = pdfBytes;
        this.pdfFile = file.name;
        if (pdfBytes) await saveState(this.pdfState, { file: file.name, at: new Date().toISOString(), data: toBase64(pdfBytes) }).catch(err => console.warn('Source PDF not kept:', err.message));
        const linked = this.linked.filter(a => a.level && a.stage).length;
        this.message(`Loaded ${s.activities.length} activities from ${file.name} (${s.source.format}); ${linked} linked to walls.${linked ? '' : ' Link them with 🔗 Links.'}${pdfNotes}`, pdfNotes ? 'warn' : '');
    }

    // The schedule as it was imported (its own dates and project), in place of the demo-moved one, until switched back.
    // View only: nothing is saved meanwhile.
    toggleOriginal() {
        this.stopPlay();
        if (this.viewingOriginal) {
            this.viewingOriginal = false;
            this.useSchedule(this.adjustedSchedule);
            this.adjustedSchedule = null;
        } else {
            const original = this.schedule?.source.original;
            if (!original) return;
            this.adjustedSchedule = this.schedule;
            this.viewingOriginal = true;
            this.useSchedule({ ...structuredClone(original), source: { ...structuredClone(original.source), pdfRows: this.schedule.source.pdfRows } });
        }
        this.render();
        this.message(this.viewingOriginal ? `The original schedule: ${this.schedule.project.name}, data date ${this.fmtDay(this.schedule.project.dataDate)}, its own dates. View only.` : 'Back to the demo schedule (dates adjusted).');
    }

    // The source PDF of a schedule imported from one (state 'schedule-pdf-<model>'), and an activity's row in it.
    get pdfState() {
        return this.scheduleState.replace(/^schedule/, 'schedule-pdf');
    }

    // The kept PDF, when the schedule came from one: "Show in the PDF" appears in the details once it is here.
    async loadPdf() {
        if (!this.schedule?.source.pdfRows || this.pdfBytes) return;
        const saved = await loadState(this.pdfState).catch(() => ({}));
        if (!saved?.data) return;
        this.pdfBytes = fromBase64(saved.data);
        this.pdfFile = saved.file;
        if (this.selectedAct) this.renderDetails(this.panel.querySelector('[data-details]'));
    }

    async showInPdf(a) {
        const at = this.schedule.source.pdfRows?.[a.id];
        if (!at || !this.pdfBytes) return;
        const [page, y] = at, scale = 1.6;
        this.pdfModal?.remove();
        const modal = this.pdfModal = document.createElement('div');
        modal.className = 'pg-pdf-modal';
        modal.innerHTML = `<div class="pg-pdf-box"><div class="pg-pdf-bar"><b>${escapeHtml(this.pdfFile || this.schedule.source.file || 'Source PDF')}</b>
                <span class="muted">page ${page} · ${escapeHtml(a.id)} ${escapeHtml(a.name)}, as printed</span><button class="pg-btn" data-pdf-close>✕ Close</button></div>
            <div class="pg-pdf-page"><canvas></canvas><div class="pg-pdf-hi"></div></div></div>`;
        document.body.appendChild(modal);
        const close = () => { modal.remove(); if (this.pdfModal === modal) this.pdfModal = null; };
        modal.querySelector('[data-pdf-close]').onclick = close;
        modal.onclick = (e) => { if (e.target === modal) close(); };
        try {
            await renderPdfPage(this.pdfBytes, page, modal.querySelector('canvas'), { scale });
            const hi = modal.querySelector('.pg-pdf-hi');
            Object.assign(hi.style, { top: `${(y - 7) * scale}px`, height: `${13 * scale}px` });
            hi.scrollIntoView({ block: 'center' });
        } catch (err) {
            modal.querySelector('.pg-pdf-page').innerHTML = `<p class="warn">The PDF could not be shown: ${escapeHtml(err.message)}</p>`;
        }
    }

    // Demo: dates moved by whole weeks into this year, shown as this model's project, and P6 locations that match no
    // level assigned to the model's levels in order (p6.mjs demoShift, assignDemoLevels).
    async applyDemoMove(s) {
        const snapshot = await loadState('takeoff-snapshot').catch(() => ({}));
        const moved = demoShift(s, { project: snapshot.project || 'Snowdon Towers (Arch)' });
        const assignments = assignDemoLevels(linkActivities(moved, this.levels).filter(a => a.scope === 'wall'), this.levels);
        Object.assign(moved.map.levels, assignments);
        moved.source.demo.levelAssignments = assignments;
        return moved;
    }

    async saveSchedule() {
        if (this.viewingOriginal) { this.message('Viewing the original dates: changes are not saved. Switch back to the adjusted dates to change links.', 'warn'); return false; }
        try {
            await saveState(this.scheduleState, this.schedule);
            return true;
        } catch (err) {
            this.message(`Schedule not saved: ${err.message}`, 'warn');
            return false;
        }
    }

    // A note under the toolbar; it goes away by itself (warnings stay until the next one).
    message(text, kind = '') {
        const el = this.panel.querySelector('[data-msg]');
        if (!el) return;
        el.hidden = !text;
        el.className = `pg-msg ${kind}`;
        el.textContent = text;
        clearTimeout(this.messageTimer);
        el.title = 'Click to close';
        el.onclick = () => { el.hidden = true; clearTimeout(this.messageTimer); };
        if (text) this.messageTimer = setTimeout(() => { el.hidden = true; this.fitGantt(); }, kind === 'warn' ? 15000 : 8000);
        this.fitGantt();
    }

    // --- Rendering ---------------------------------------------------------------------------------------------------

    fmtDay(day){return this.options.standalone?dashboardDate(day):compactDay(day);}
    saveReviewed(){if(this.reviewKey)try{localStorage.setItem(this.reviewKey,JSON.stringify(this.reviewed));}catch{}}

    render() {
        const nav=this.options.standalone?{gantt:'P6 Gantt',lookahead:'Lookahead'}:this.tabs;
        const s = this.schedule;
        const d = s?.source.demo;
        this.panel.innerHTML = `<div class="demo-panel pg ${this.tab==='management'?'management':''}">
            <div class="tk-head pg-head">
                <div class="pg-row">
                    <b class="pg-title">${this.options.standalone?'Project workspace':'Install Progress'}</b>
                    <div class="tk-tabs" role="tablist" aria-label="Progress and schedule views">${Object.entries(nav).map(([k, label]) => `<button role="tab" aria-selected="${k===this.tab||this.options.standalone&&k==='gantt'&&this.tab==='calendar'}" data-tab="${k}" class="${k===this.tab||this.options.standalone&&k==='gantt'&&this.tab==='calendar'?'active':''}">${label}</button>`).join('')}</div>${this.options.standalone?`<div class="la-quick" role="group" aria-label="Lookahead shortcuts" title="Open the lookahead for the next 3, 6 or 12 weeks">${[3,6,12].map(w=>`<button data-la-quick="${w}" aria-pressed="${this.tab==='lookahead'&&this.lookWeeks===w}">${w} wk</button>`).join('')}</div>`:''}
                    <span class="pg-info" data-sched-info></span>
                    ${s?.source.original || this.viewingOriginal ? `<button class="pg-btn ${this.viewingOriginal ? 'active' : ''}" data-original title="${this.viewingOriginal ? 'Back to the demo schedule (dates adjusted)' : 'The schedule as imported: its own project, data date and dates (view only)'}">${this.viewingOriginal ? 'Original dates' : 'Show original'}</button>` : ''}
                    ${d?.day ? `<span class="pg-chip demo" title="Demo: dates moved ${d.shiftDays.toLocaleString()} days (whole weeks) so ${this.fmtDay(d.day)} falls today. Original: ${escapeHtml(d.originalProject)} (data date ${d.originalDataDate ? this.fmtDay(d.originalDataDate) : '–'}). Schedule ⋯ › Undo restores them.">dates adjusted</span>`
                        : d ? `<span class="pg-chip demo" title="Demo: dates moved ${d.years >= 0 ? '+' : ''}${d.years} years (${d.shiftDays.toLocaleString()} days) from ${escapeHtml(d.originalProject)} (${d.originalDataDate ? this.fmtDay(d.originalDataDate) : 'earliest start'}). Schedule ⋯ › Undo restores them.">${d.years ? `demo ${d.years > 0 ? '+' : ''}${d.years} y` : 'demo'}</span>` : ''}
                    <label class="pg-btn" title="Upload a P6 schedule: PDF, XER, Excel (.xlsx) or CSV">${this.options.standalone?'Upload':'⬆ Upload'}<input type="file" data-upload accept=".pdf,.xer,.xlsx,.csv,.txt" ${this.importController ? 'disabled' : ''} hidden></label>
                    <label class="pg-check" title="Demo: an uploaded schedule is moved to this year and shown as this project (dates by whole weeks; locations and walls assigned to the model). Shifted holidays are not the new year's real holidays."><input type="checkbox" data-demo-move ${this.demoMove ? 'checked' : ''}>Demo</label>
                    ${s ? `<button class="pg-btn" data-links-toggle title="Links: which model level and install stage each activity stands for">${this.options.standalone?'Activity links':'🔗'}</button>` : ''}
                    ${document.body.classList.contains('dock-bottom') ? '<button class="pg-btn" data-dock title="Give the schedule most of the screen; click again to bring the model back">⤢</button>' : ''}
                    <details class="tk-dd pg-menu"><summary class="pg-btn" title="Schedule: sample, export, remove">${this.options.standalone?'More':'⋯'}</summary><div class="tk-dd-list">
                        ${s?.source.original ? '<a href="#" data-undo-demo>Undo the demo move</a>' : ''}
                        ${this.sampleSchedule ? `<a href="#" data-sample>Load the sample schedule (made up)</a>
                        ${this.options.hotelDemo?'':`<a href="${SAMPLE.url}" download="${SAMPLE.file}">Download the sample .xer</a>`}` : ''}
                        ${s ? '<a href="#" data-export>Export CSV (P6 % vs model %)</a><a href="#" data-remove>Remove the schedule…</a>' : ''}
                    </div></details>
                    ${this.options.standalone?'':'<button class="pg-btn" data-switch-demo title="Switch to the Panel Tracker (Demo 7): the prefab panels from BIM review to framing complete, on this model">⇄ Panels</button>'}
                </div>
                ${s ? '<div class="pg-row pg-colorbar" data-colorbar></div>' : ''}
                ${s ? `<div class="pg-row pg-search" data-search ${['stages','management'].includes(this.tab) ? 'hidden' : ''}>
                    <input type="search" data-kw autocomplete="off" aria-label="Search the schedule" value="${escapeHtml(this.kw.typed)}"
                        placeholder="Search activities: framing, finish, drywall L3, &quot;tape and finish&quot;… (Enter keeps a keyword)">
                    <span class="pg-s-chips" data-kw-chips></span>
                    <span class="pg-s-count muted" data-kw-count></span>
                    <button class="pg-btn" data-kw-walls hidden title="Show the walls of every matching wall activity">Walls of all</button>
                    <details class="pg-keybox pg-s-hist"><summary class="pg-btn" title="Keywords used before, and suggestions">History</summary><div class="pg-keypop pg-histpop" data-kw-history></div></details>
                </div>` : ''}
                ${this.options.standalone ? '<div class="pg-related" data-related-work hidden></div>' : ''}
                <div data-links hidden></div>
                <p class="pg-msg" data-msg hidden></p>
            </div>
            ${this.options.standalone?`<div data-schedule-switch class="schedule-switch" ${['gantt','calendar'].includes(this.tab)?'':'hidden'}><button data-subview="gantt" aria-pressed="${this.tab==='gantt'}">Timeline</button><button data-subview="calendar" aria-pressed="${this.tab==='calendar'}">Calendar</button></div>`:''}<div data-body></div></div>`;
        const p = this.panel;
        p.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => this.setTab(b.dataset.tab==='gantt'&&this.options.standalone?(this.scheduleTab||'gantt'):b.dataset.tab));
        // Lookahead shortcuts: straight to the next 3, 6 or 12 weeks.
        p.querySelectorAll('[data-la-quick]').forEach(b => b.onclick = () => { this.lookWeeks = +b.dataset.laQuick; try { localStorage.setItem('cas-project-dashboard:lookahead-weeks', String(this.lookWeeks)); } catch {} if (this.tab === 'lookahead') { this.renderBody(); this.syncLookQuick(); } else this.setTab('lookahead'); });
        p.querySelectorAll('[data-subview]').forEach(b=>b.onclick=()=>this.setTab(b.dataset.subview));
        p.querySelector('[data-upload]').onchange = async (e) => {
            const file = e.target.files[0];
            e.target.value = '';
            if (!file || this.importController) return;
            this.importController = new AbortController(); e.target.disabled = true;
            try { await this.importFile(file); }
            catch (err) { if (err.name !== 'AbortError') this.message(`Could not read ${file.name}: ${err.message}`, 'warn'); }
            finally { this.importController = null; const input = this.panel.querySelector('[data-upload]'); if (input) input.disabled = false; }
        };
        p.querySelector('[data-demo-move]').onchange = e => { this.demoMove = e.target.checked; try { localStorage.setItem('drywall-demos:schedule-demo-shift', String(this.demoMove)); } catch {} };
        p.querySelector('[data-original]')?.addEventListener('click', () => this.toggleOriginal());
        p.querySelector('[data-undo-demo]')?.addEventListener('click', async e => { e.preventDefault(); this.stopPlay(); this.useSchedule(structuredClone(this.schedule.source.original)); this.render(); if (await this.saveSchedule()) this.message('Original dates, project and links restored.'); });
        const sampleLink = p.querySelector('[data-sample]');
        if (sampleLink) sampleLink.onclick = (e) => { e.preventDefault(); this.loadSample().then(() => this.saveSchedule()).catch(err => this.message(err.message, 'warn')); };
        const exp = p.querySelector('[data-export]');
        if (exp) exp.onclick = (e) => { e.preventDefault(); this.exportCsv(); };
        const rem = p.querySelector('[data-remove]');
        if (rem) rem.onclick = async (e) => {
            e.preventDefault();
            if (!confirm('Remove the schedule from this viewer? Wall stages stay.')) return;
            this.clearFocus();
            // The schedule views go with it: only the linked walls, the floors apart, all floor plans.
            this.stopPlay();
            if (this.apartOn) await this.setApart(false);
            if (this.allPlans.isOpen) await this.setAllPlans(false);
            if (this.linkedOnly) this.setLinkedOnly(false);
            this.schedule = null;
            this.colorMode = 'actual';
            await saveState(this.scheduleState, { removed: true, at: new Date().toISOString() }).catch(() => {});
            this.render();
        };
        p.querySelector('[data-dock]')?.addEventListener('click', () => document.dispatchEvent(new CustomEvent('dock-split', { detail: 'toggle' })));
        const switchDemo=p.querySelector('[data-switch-demo]');if(switchDemo)switchDemo.onclick = () => document.dispatchEvent(new CustomEvent('switch-demo', { detail: { id: '09-panel-tracker' } })); // main.js
        const lt = p.querySelector('[data-links-toggle]');
        if (lt) lt.onclick = () => { const d = p.querySelector('[data-links]'); d.hidden = !d.hidden; lt.classList.toggle('active', !d.hidden); if (!d.hidden) this.renderLinks(); this.fitGantt(); };
        this.renderInfo();
        this.renderColorBar();
        this.wireSearch();
        this.renderBody();
        this.refresh();
    }

    setTab(tab) {
        if (this.options.standalone && !this.tabs[tab]) tab = 'gantt'; // old Overview / Progress by floor links
        if (this.options.standalone && tab === 'calendar' && this.cursor) this.calMonth = this.cursor.slice(0, 7); // the month of the shown date
        this.tab = tab;if(['gantt','calendar'].includes(tab))this.scheduleTab=tab;
        const params = new URLSearchParams(location.search);
        params.set('tab',tab);
        history.replaceState(null, '', `${location.pathname}?${params}${location.hash}`);
        this.panel.querySelector('.pg').classList.toggle('management',tab==='management');
        this.panel.querySelectorAll('[data-tab]').forEach(b=>{const active=b.dataset.tab===tab||this.options.standalone&&b.dataset.tab==='gantt'&&tab==='calendar';b.classList.toggle('active',active);b.setAttribute('aria-selected',active);});const sub=this.panel.querySelector('[data-schedule-switch]');if(sub){sub.hidden=!['gantt','calendar'].includes(tab);sub.querySelectorAll('[data-subview]').forEach(b=>b.setAttribute('aria-pressed',b.dataset.subview===tab));}
        this.syncLookQuick();
        const search = this.panel.querySelector('[data-search]');
        if (search) search.hidden = ['stages','management'].includes(tab);
        this.renderBody();
    }

    renderInfo() {
        const el = this.panel.querySelector('[data-sched-info]');
        if (!el) return;
        const s = this.schedule;
        if (!s) { el.innerHTML = '<span class="muted">No schedule</span>'; return; }
        const linked = this.linked.filter(a => a.level && a.stage).length, random = this.linked.filter(a => a.demoWalls).length, other = this.linked.filter(a => a.scope === 'other').length;
        el.innerHTML = `<b title="${escapeHtml(s.source.file)}">${escapeHtml(s.project.name)}</b>${s.source.sample ? ' <span class="tk-src gap" title="A made-up P6 schedule for the sample model">sample</span>' : ''}
            <span class="muted">· data date ${s.project.dataDate ? `${this.fmtDay(s.project.dataDate)}${s.project.estimatedDataDate ? ' (estimated)' : ''}` : '–'}${this.asOf ? ` · field progress as of ${this.fmtDay(this.asOf)}` : ''} · ${s.activities.length} activities · ${linked} linked to walls${random ? ` (${random} to walls picked at random for the demo)` : ''}${other ? ` · ${other} not wall work (greyed)` : ''}</span>`;
    }

    // Model colors: installed stages, the plan on a date (4D), or installed vs plan; a date slider for the last two.
    renderColorBar() {
        const el = this.panel.querySelector('[data-colorbar]');
        if (!el || !this.span) return;
        const days = Math.round((dayMs(this.span[1]) - dayMs(this.span[0])) / 86400000);
        if (this.options.standalone) {
            // The timeline: play / scrub the schedule on the model. The Gantt's date scale scrubs the same date.
            el.innerHTML = `<div class="pg-timeline"><button class="pg-btn" data-play title="Play the schedule on the model from this date">Play</button>
                <button class="pg-btn" data-cursor-start title="The project's first activity start">Start</button>
                <div class="pg-slider" data-slider><output class="pg-slider-tip" data-slider-tip></output>
                    <input type="range" class="pg-range" data-cursor min="0" max="${days}" step="1" aria-label="Date the model shows the schedule for" title="Drag to see the model on a day of the schedule">
                    <div class="pg-slider-ticks" aria-hidden="true">${this.sliderTicks()}</div></div>
                <b data-cursor-label class="pg-cursor-label"></b>
                <button class="pg-btn" data-cursor-dd title="The schedule's data date">Data date</button></div>`;
            el.querySelector('[data-cursor]').oninput = (e) => { this.sliding(); this.setCursor(addDays(this.span[0], Number(e.target.value))); };
            el.querySelector('[data-cursor]').onpointerdown = () => this.sliding();
            el.querySelector('[data-play]').onclick = () => (this.playTimer ? this.stopPlay() : this.play());
            el.querySelector('[data-cursor-start]').onclick = () => this.setCursor(projectStart(this.schedule.activities) || this.span[0], { move: true });
            el.querySelector('[data-cursor-dd]').onclick = () => this.setCursor(this.schedule.project.dataDate || this.span[0], { move: true });
            this.updateCursorUi();
            return;
        }
        el.innerHTML = `<select data-color-mode title="How the model is colored">${Object.entries(COLOR_MODES).map(([k, l]) => `<option value="${k}" ${k === this.colorMode ? 'selected' : ''}>${l}</option>`).join('')}</select>
            <input type="range" data-cursor min="0" max="${days}" step="1" value="${Math.round((dayMs(this.cursor) - dayMs(this.span[0])) / 86400000)}" aria-label="Date the model shows the plan for" title="Slide to see the model as planned on a day">
            <b data-cursor-label class="pg-cursor-label"></b>
            <button class="pg-btn" data-play title="Reveal activity walls from the start of the schedule; later activities update their colors">${this.options.standalone?'Play':'▶'}</button>
            <button class="pg-btn" data-cursor-dd title="Back to the schedule's data date">Data date</button>
            ${this.asOf ? `<button class="pg-btn" data-cursor-asof title="The day the field progress was recorded (${this.fmtDay(this.asOf)}): compare the walls with the plan then">Status</button>` : ''}
            <span class="pg-views" title="Schedule views">
                <button class="pg-btn ${this.linkedOnly ? 'active' : ''}" data-view="linked" title="Only the walls linked to the schedule (the floors its wall work is on)">Linked walls</button>
                <button class="pg-btn ${this.apartOn ? 'active' : ''}" data-view="apart" title="Floors apart: every floor at once in 3D, each lifted over the one below, colored as the schedule plays">Floors apart</button>
                <button class="pg-btn ${this.allPlans.isOpen ? 'active' : ''}" data-view="plans" title="All floor plans at once, beside the schedule, colored as it plays">All plans</button></span>
            <span class="pg-legend" data-color-legend></span>`;
        el.querySelectorAll('[data-view]').forEach(b => b.onclick = () => ({ linked: () => this.setLinkedOnly(!this.linkedOnly), apart: () => this.setApart(!this.apartOn), plans: () => this.setAllPlans(!this.allPlans.isOpen) })[b.dataset.view]());
        el.querySelector('[data-cursor-asof]')?.addEventListener('click', () => this.setCursor(this.asOf, { move: true }));
        el.querySelector('[data-color-mode]').onchange = (e) => this.setColorMode(e.target.value);
        el.querySelector('[data-cursor]').oninput = (e) => this.setCursor(addDays(this.span[0], Number(e.target.value)));
        el.querySelector('[data-play]').onclick = () => (this.playTimer ? this.stopPlay() : this.play());
        el.querySelector('[data-cursor-dd]').onclick = () => this.setCursor(this.schedule.project.dataDate || localToday(), { move: true });
        this.updateCursorUi();
    }

    // --- Schedule views -------------------------------------------------------------------------------------------------

    // The floors the schedule's wall work is linked to (a level and an install stage), bottom to top.
    linkedLevels() {
        const names = linkedLevelNames(this.linked);
        return this.views.levels.filter(l => names.has(l.name));
    }

    // Their walls (and a demo schedule's picked walls).
    linkedWallIds() {
        const levels = new Set(this.linkedLevels().map(l => l.name));
        const ids = new Set(this.walls.filter(w => levels.has(w.level)).map(w => w.dbId));
        for (const a of this.linked) if (a.demoWalls) for (const w of a.walls || []) ids.add(w.dbId);
        return [...ids];
    }

    // Every wall again, or the linked ones while that view is on.
    showDefault() {
        if (this.linkedOnly && this.schedule) this.views.isolate(this.linkedWallIds(), { fit: false });
        else this.views.showAll();
    }

    // Floors apart: each floor's name, how far it is (its walls at their stages) and, with a schedule, the plan on the
    // timeline's date (p6.mjs levelPercents, up to the last wall stage the schedule reaches). An activity picked (or one
    // stage shown): that stage instead, framed / boarded / taped / finished on every floor, the picked one's floor marked.
    updateFloorLabels(planned = null) {
        const focus = this.focusActivity();
        if (this.options.standalone) {
            // Per floor: the share of its walls the schedule reaches by the date (per the schedule, not field progress).
            // One stage shown (others hidden, or a picked activity): that stage's share.
            const shown = (this.stageNames || []).filter(n => !this.hiddenStages?.has(n));
            const stage = focus?.stage || (shown.length === 1 ? shown[0] : null);
            const reached = this.reached || this.reachedWalls(), per = floorScheduleShare(this.walls, reached, { stage });
            // Without one stage chosen: the stage most of the floor's walls are at on this date.
            const latest = new Map();
            for (const [w, a] of reached) { const m = latest.get(w.level) || latest.set(w.level, new Map()).get(w.level); m.set(a.stage, (m.get(a.stage) || 0) + 1); }
            this.views.setApartLabels((level) => {
                const r = per.get(level);
                if (!r) return { title: level };
                const most = [...(latest.get(level) || [])].sort((x, y) => y[1] - x[1])[0]?.[0];
                const text = stage ? `${r.pct}% ${stage}` : most ? `${most} · ${r.pct}% of walls` : 'Not started';
                return { title: level, text: `${text} (schedule)`, done: r.pct, plan: null, focus: focus?.level === level };
            });
            return;
        }
        const stageName = focus?.stage || (STAGE_NAMES.includes(this.isolatedStage) && this.isolatedStage !== STAGE_NAMES[0] ? this.isolatedStage : null);
        const stage = stageName ? STAGE_NAMES.indexOf(stageName) : null;
        if (this.schedule && !planned) {
            const ranked = [...this.wallOrder].sort((a, b) => this.stageIndex(b) - this.stageIndex(a));
            planned = plannedStages(ranked, this.linked.filter(a => !a.demoWalls), this.cursor, this.cal);
        }
        const top = this.schedule ? topStage(this.linked) : STAGE_NAMES.length - 1;
        const per = levelPercents(this.walls, { stageIndexOf: (w) => this.stageIndex(w), plannedIndexOf: planned ? (w) => planned.get(w) : null, top, stage });
        const what = stageName ? stageName.toLowerCase() : 'done';
        this.views.setApartLabels((level) => {
            const r = per.get(level);
            if (!r) return { title: level };
            return { title: level, text: `${r.done}% ${what}${r.plan != null ? ` · plan ${r.plan}%` : ''}`, done: r.done, plan: r.plan, focus: focus?.level === level };
        });
    }

    setLinkedOnly(on) {
        if (on && !this.schedule) { this.message('Load a schedule first (Gantt tab): the linked walls come from it.', 'warn'); return; }
        this.linkedOnly = on;
        this.isolatedStage = null;
        this.clearFocus();
        this.showDefault();
        if (on) this.message(`Showing the ${this.linkedWallIds().length.toLocaleString()} walls on the ${this.linkedLevels().length} floors the schedule's wall work is linked to.`);
        this.updateViewButtons();
    }

    // Floors apart / All plans loading (kind null: done or cancelled): the page shows a progress bar over the model.
    viewsLoading(kind, done = 0, total = 0, name = '') {
        this.loadingViews = kind ? { kind, done, total, name } : null;
        document.dispatchEvent(new CustomEvent('model-views-loading', { detail: this.loadingViews }));
    }

    setApartGap(scale) {
        this.views.setApartGap(scale);
        this.updateFloorLabels();
    }

    async setApart(on) {
        if (!this.walls) return;
        this.apartOn = on;
        this.updateViewButtons();
        // The layout (3D, 3D + Plan, Plan) and the open sheet stay as they are; the floor shown before comes back after.
        if (!on) {
            this.viewsLoading(null); await this.views.setLevelsApart(null); this.showDefault(); this.message('');
            const back = this.levelBeforeApart; this.levelBeforeApart = null;
            if (this.options.standalone && back && !this.apartOn) { await this.views.setLevel(back, { plan: false }); this.refresh(); this.renderBody(); }
            return;
        }
        // Every floor, nothing filtered, so what shows is clear: no level cut (the header's Level: All levels), no stage
        // shown alone, not only the linked walls. The schedule viewer keeps the picked activity (highlighted on its floor).
        if (!this.options.standalone) this.selectedAct = null;
        this.isolatedBySchedule = false;
        this.isolatedStage = null;
        this.linkedOnly = false;
        this.updateViewButtons();
        this.views.showAll();
        if (this.views.level) {
            if (this.options.standalone) this.levelBeforeApart = this.views.level.name;
            await this.views.setLevel(null, { plan: !this.options.standalone }); // the schedule viewer keeps its sheet
        }
        this.refresh();
        this.renderBody();
        const levels = this.views.levels.filter(l => this.views.wallsByLevel.get(l.name)?.length).map(l => l.name);
        this.updateFloorLabels();
        await this.views.setLevelsApart(levels, { onProgress: (i, n, name) => {
            if (!this.apartOn) return;
            this.viewsLoading('apart', i, n, name);
            if (i >= n) this.message(`Floors apart: ${n} floors, each lifted over the one below. Colors and the timeline apply to every floor.`);
        } });
        this.viewsLoading(null);
        // Fit the stack to the 3D view as it is now (it may have been resized while the floors loaded).
        if (this.apartOn && this.views.apart) { this.views.frameApart(); this.views.placeApartLabels(); }
    }

    async setAllPlans(on) {
        if (!on) { this.viewsLoading(null); this.allPlans.close(); this.updateViewButtons(); return; }
        const levels = this.schedule ? this.linkedLevels() : this.views.levels.filter(l => this.views.wallsByLevel.get(l.name)?.length);
        if (!levels.length) { this.message('No floors to show: load a schedule linked to the model first.', 'warn'); return; }
        this.allPlans.colors = new Map(this.views.colors); // what the model shows now
        const opening = this.allPlans.open(levels, { onClose: () => { this.viewsLoading(null); this.updateViewButtons(); },
            onProgress: (i, n, name) => this.allPlans.isOpen && this.viewsLoading(i < n ? 'plans' : null, i, n, name) });
        this.updateViewButtons();
        await opening.finally(() => this.viewsLoading(null));
    }

    updateViewButtons() {
        this.bar?.refresh();
        const on = { linked: this.linkedOnly, apart: this.apartOn, plans: this.allPlans.isOpen };
        this.panel.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', !!on[b.dataset.view]));
        const gap = this.panel.querySelector('.pg-gap');
        if (gap) gap.hidden = !this.apartOn;
        // Schedule viewer: the same views as buttons on the 3D view (install-progress.js).
        document.querySelectorAll('[data-model-view]').forEach(b => b.setAttribute('aria-pressed', !!on[b.dataset.modelView]));
        const gap3d = document.getElementById('apart-gap');
        if (gap3d) gap3d.hidden = !this.apartOn;
    }

    // The 4D date. Moving it shows the plan on that day (from "Installed", it switches to "Planned on the date").
    setCursor(day, { move = false } = {}) {
        if (this.options.standalone) {
            // Schedule viewer: the picked activity, filters and floor stay; only the date moves.
            this.cursor = day;
            this.refresh();
            if (this.tab === 'calendar' && day.slice(0, 7) !== this.calMonth) { this.calMonth = day.slice(0, 7); this.renderBody(); }
            else if (this.tab === 'lookahead') this.renderBody();
            else if (this.tab === 'calendar') this.renderDayList();
            this.updateCursorUi({ move });
            return;
        }
        const wasActual = this.colorMode === 'actual', hadFocus = !!this.selectedAct;
        this.cursor = day;
        if (wasActual) this.colorMode = 'planned';
        this.clearFocus();
        this.refresh();
        const monthChanged = this.tab === 'calendar' && day.slice(0, 7) !== this.calMonth;
        if (monthChanged) this.calMonth = day.slice(0, 7);
        if (wasActual || hadFocus || monthChanged || this.tab==='lookahead') this.renderBody();
        else if (this.tab === 'calendar') this.renderDayList();
        this.updateCursorUi({ move });
    }

    // Month ticks under the timeline slider (positions in % of the schedule span).
    sliderTicks() {
        const total = dayMs(this.span[1]) - dayMs(this.span[0]), out = [];
        for (let t = Date.UTC(+this.span[0].slice(0, 4), +this.span[0].slice(5, 7), 1); t <= dayMs(this.span[1]); t = Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth() + 1, 1)) {
            const d = new Date(t), pct = (100 * (t - dayMs(this.span[0]))) / total;
            out.push(`<span style="left:${pct.toFixed(2)}%">${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]}${d.getUTCMonth() ? '' : ` ${d.getUTCFullYear()}`}</span>`);
        }
        // A small tick every Monday, like an editor's timeline ruler.
        for (let t = dayMs(this.span[0]); t <= dayMs(this.span[1]); t += 86400000) if (new Date(t).getUTCDay() === 1) out.push(`<i style="left:${((100 * (t - dayMs(this.span[0]))) / total).toFixed(2)}%"></i>`);
        return out.join('');
    }
    // While the slider moves (and briefly after), the bubble over its handle shows the date and its week, zoomed in.
    sliding() {
        const s = this.panel.querySelector('[data-slider]');
        if (!s) return;
        s.classList.add('sliding');
        clearTimeout(this.slideTimer);
        this.slideTimer = setTimeout(() => s.classList.remove('sliding'), 1400);
    }
    // The week of a day: Monday to Sunday, with its ISO week number.
    weekOf(day) {
        const t = dayMs(day), dow = (new Date(t).getUTCDay() + 6) % 7, monday = t - dow * 86400000, thursday = monday + 3 * 86400000;
        const jan1 = Date.UTC(new Date(thursday).getUTCFullYear(), 0, 1), week = 1 + Math.floor((thursday - jan1) / (7 * 86400000));
        return { from: new Date(monday).toISOString().slice(0, 10), to: new Date(monday + 6 * 86400000).toISOString().slice(0, 10), week };
    }

    updateCursorUi({ move = false } = {}) {
        const bar = this.panel.querySelector('[data-colorbar]');
        if (bar) {
            const mode = bar.querySelector('[data-color-mode]');
            if (mode) mode.value = this.colorMode;
            bar.querySelector('[data-cursor]').value = String(Math.round((dayMs(this.cursor) - dayMs(this.span[0])) / 86400000));
            bar.querySelector('[data-cursor]').disabled = false;
            const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(dayMs(this.cursor)).getUTCDay()];
            bar.querySelector('[data-cursor-label]').textContent = `${wd} ${this.fmtDay(this.cursor)}`;
            const tip = bar.querySelector('[data-slider-tip]');
            if (tip) {
                const w = this.weekOf(this.cursor), input = bar.querySelector('[data-cursor]'), f = (+input.value - +input.min) / Math.max(1, +input.max - +input.min);
                tip.innerHTML = `<b>${wd} ${this.fmtDay(this.cursor)}</b><span>Week ${w.week} · ${this.fmtDay(w.from).replace(/, \d{4}$/, '')} – ${this.fmtDay(w.to)}</span>`;
                tip.style.left = `calc(${(f * 100).toFixed(2)}% + ${(8 - f * 16).toFixed(1)}px)`;
                bar.querySelector('[data-slider]').style.setProperty('--fill', `calc(${(f * 100).toFixed(2)}% + ${(8 - f * 16).toFixed(1)}px)`);
            }
            bar.querySelector('[data-cursor-label]').classList.toggle('muted', !this.options.standalone && this.colorMode === 'actual');
            bar.querySelector('[data-play]').textContent = this.playTimer?(this.options.standalone?'Pause':'❚❚'):(this.options.standalone?'Play':'▶');
            this.renderColorLegend();
        }
        const line = this.panel.querySelector('.pg-g-bg .line.cursor');
        const at = `${ganttX(this.span, this.gantt.scale, this.cursor) + SCALES[this.gantt.scale].ppd / 2}px`;
        if (line) line.style.left = at;
        const head = this.panel.querySelector('[data-playhead]');
        if (head) { head.style.left = at; head.dataset.label = this.fmtDay(this.cursor); }
        this.panel.querySelectorAll('.pg-cal-day.sel').forEach(d => d.classList.remove('sel'));
        this.panel.querySelector(`.pg-cal-day[data-day="${this.cursor}"]`)?.classList.add('sel');
        if (move) this.scrollGanttTo(this.cursor);
    }

    renderColorLegend() {
        const el = this.panel.querySelector('[data-color-legend]');
        if (!el) return;
        const focus = this.focusActivity();
        if (this.options.standalone) {
            // The schedule's own stages: a toggle to show or hide each on the model, and a color picker.
            const off = this.hiddenStages || new Set(), counts = new Map();
            for (const a of this.reached?.values() || []) counts.set(a.stage, (counts.get(a.stage) || 0) + 1);
            el.innerHTML = `<b>Stages</b>${(this.stageNames || []).map((name, i) => `<span class="pg-stage-chip ${off.has(name) ? 'off' : ''}">
                    <input type="color" data-stage-color="${i}" value="${this.stageColorMap.get(name)}" aria-label="Color for ${escapeHtml(name)}" title="Change the color">
                    <label><input type="checkbox" data-stage-show="${i}" ${off.has(name) ? '' : 'checked'}>${escapeHtml(name)}</label>
                    <small>${(counts.get(name) || 0).toLocaleString()}</small></span>`).join('')}
                <span class="pg-stage-chip ghost"><i style="background:${GHOST_COLOR}"></i>Not started / other trades</span>
                ${focus ? `<span class="muted">Showing ${escapeHtml(focus.id)} only</span>` : ''}`;
            el.querySelectorAll('[data-stage-show]').forEach(c => c.onchange = () => this.setStageHidden(this.stageNames[+c.dataset.stageShow], !c.checked));
            el.querySelectorAll('[data-stage-color]').forEach(c => c.onchange = () => this.setStageColor(this.stageNames[+c.dataset.stageColor], c.value));
            return;
        }
        if (focus) {
            el.innerHTML = modelStatusLegend({colorMode:this.colorMode,playback:this.playbackMode,focusStage:focus.stage}).map(({label,color})=>`<span class="tk-key"><span class="swatch" style="background:${color}"></span>${escapeHtml(label)}</span>`).join('')
                + `<span class="muted">${escapeHtml(focus.level)} activity walls</span>`;
        } else if(this.playbackMode){
            el.innerHTML=STAGES.filter(s=>s.color).map(s=>`<span class="tk-key"><span class="swatch" style="background:${PLAYBACK_COLORS[s.name]}"></span>${s.name}</span>`).join('')+'<span class="muted">Walls appear at activity start · Installed restores the full model</span>';
        } else if (this.colorMode === 'compare') {
            const c = this.compareCounts || {};
            el.innerHTML = Object.entries(COMPARE).map(([k, v]) => `<span class="tk-key"><span class="swatch" style="background:${v.color}"></span>${v.label} ${c[k] ?? 0}</span>`).join('');
        } else {
            el.innerHTML = STAGES.filter(s => s.color).map(s => `<span class="tk-key"><span class="swatch" style="background:${s.color}"></span>${s.name}</span>`).join('')
                + (this.colorMode === 'planned' ? '<span class="muted">planned by the end of the day</span>' : '');
        }
    }

    // Day by day, one working day a step: the next step only once this one is drawn (the floor plans included, when they
    // are open), so the timeline never runs ahead of what the views show. At most one step every 280 ms.
    playbackRange() {
        const level=this.views.level?.name;
        const acts=this.linked.filter(a=>a.scope!=='other'&&isStage(a.stage)&&a.start&&(!level||a.level===level));
        return scheduleSpan(acts.map(a=>({start:a.start,finish:a.finish||a.start})));
    }

    play() {
        const range=this.playbackRange();
        if(!range){this.message('No wall activities are linked to this floor. Choose another floor or All levels.','warn');return;}
        // The schedule viewer plays from the shown date (walls ghosted until their work starts); the tracker hides them.
        const resume=(this.options.standalone||this.playbackMode)&&this.cursor<range[1];
        if(!this.options.standalone)this.playbackMode=true;this.colorMode='planned';
        this.setCursor(resume&&this.cursor>=range[0]?this.cursor:range[0]);
        const run = (this.playRun = (this.playRun || 0) + 1);
        const tick = async () => {
            if (run !== this.playRun || !this.playTimer) return;
            const t0 = performance.now();
            const range=this.playbackRange();
            if(!range){this.stopPlay();return;}
            let next = addDays(this.cursor, 1);
            if(next<range[0])next=range[0];
            while (next < range[1] && !this.cal.isWork(next)) next = addDays(next, 1);
            if (next >= range[1]) { this.setCursor(range[1]); this.stopPlay(); return; }
            this.setCursor(next, { move: true });
            if (this.allPlans.isOpen) await this.allPlans.settled();
            if (run !== this.playRun || !this.playTimer) return;
            this.playTimer = setTimeout(tick, Math.max(0, 280 - (performance.now() - t0)));
        };
        this.playTimer = setTimeout(async () => {
            if (this.allPlans.isOpen && this.allPlans.loading) {
                this.message('Waiting for the floor plans to load before playing…', 'warn');
                await this.allPlans.settled();
                this.message('');
            }
            tick();
        }, 0);
        this.updateCursorUi();
    }

    endPlayback() {
        this.stopPlay();this.playbackMode=false;
        this.views.setPlaybackWalls(null);this.allPlans.setVisibleWalls(null);
    }

    stopPlay() {
        clearTimeout(this.playTimer);
        this.playTimer = null;
        this.playRun = (this.playRun || 0) + 1;
        if (this.panel.querySelector('[data-play]')) this.updateCursorUi();
    }

    // Room for the selected activity beside the chart (a wide panel), or above it.
    get sideDetails() {
        return this.panel.clientWidth >= 1200;
    }

    renderBody() {
        const body = this.panel.querySelector('[data-body]');
        if (!body) return;
        this.renderRelated();
        const wide = this.tab !== 'stages' && !document.body.classList.contains('dock-bottom');
        if (this.panel.classList.contains('xwide') !== wide) { this.panel.classList.toggle('xwide', wide); requestAnimationFrame(() => this.views.resize()); }
        if (this.tab !== 'stages' && !this.schedule) {
            body.innerHTML = `<div class="pg-empty"><p>No schedule for this model yet.</p>
                ${this.sampleSchedule ? '<p><button data-sample2>Load the sample P6 schedule</button> <span class="muted">(made up, for the sample model)</span></p>' : ''}
                <p class="muted">Or upload your own P6 export above: an .xer file, or a layout exported to Excel (.xlsx) or CSV with Activity ID, Activity Name, Start and Finish columns.</p></div>`;
            const sample2 = body.querySelector('[data-sample2]');
            if (sample2) sample2.onclick = () => this.loadSample().then(() => this.saveSchedule()).catch(err => this.message(err.message, 'warn'));
            return;
        }
        if (this.tab === 'management'&&this.options.standalone)this.renderManagement(body);
        else if (this.tab === 'gantt') this.renderGantt(body);
        else if (this.tab === 'calendar') this.renderCalendar(body);
        else if (this.tab === 'lookahead'&&this.options.standalone) this.renderLookahead(body);
        else this.renderStages(body);
        this.renderInfo();
        if(this.options.standalone)document.dispatchEvent(new CustomEvent('dashboard-context',{detail:{tab:this.tab}}));
        if (this.tab !== 'stages') this.renderSearch(); // the match count follows the level and Show filters
    }

    // --- Stages tab (the tracker) ----------------------------------------------------------------------------------

    dashboardState(){
        this.counts=stageCounts(this.walls,w=>this.stageOf(w));
        return dashboardMetrics(this.linked.map(a=>({...a,modelPct:this.modelOf(a)?.pct??null})),{asOf:this.asOf||this.schedule?.project.dataDate||DEMO_DATE,demo:!!(this.schedule?.source.sample||this.schedule?.source.demo),reviewed:this.reviewed});
    }
    renderManagement(body){
        const state=this.dashboardState(),labour=labourSummary(),label=a=>{const action={Finished:'Finish closeout',Taped:'Complete taping',Boarded:'Finish boarding',Framed:'Finish framing'}[a.stage]||'Confirm work';return `${action} on ${a.level||'the project'}`;};
        body.innerHTML=`<section class="bim-overview" aria-label="BIM delivery"><header><b>BIM delivery</b><span class="demo-badge">Demo data</span><button data-bim-open>View BIM status</button></header><div>${[['Shop drawings issued',DEMO_BIM.shopIssued],['Prefab ready',DEMO_BIM.prefabReady],['Material delivered',DEMO_BIM.materialDelivered]].map(([label,count])=>`<p><span>${label}</span><b>${Math.round(count/DEMO_BIM.packages*100)}<small>%</small></b><progress value="${count}" max="${DEMO_BIM.packages}" aria-label="${label}"></progress><small>${count} / ${DEMO_BIM.packages} packages</small></p>`).join('')}</div><footer>Phase: ${DEMO_BIM.phase}</footer></section><section class="labour-overview" aria-label="Labour overview"><header><b>Labour this week</b><span class="demo-badge">Demo data</span><button data-labour-open>Labour & cost</button></header><div><p><b>${labour.crew}</b><span>people allocated</span><small>+4 vs last week · demo</small></p><p><b>${labour.weekHours.toLocaleString()} <small>hrs</small></b><span>of ${labour.plannedWeek.toLocaleString()} planned this week</span><small>${labour.overtime} overtime hrs included</small></p><p><b>${labour.forecastHours.toLocaleString()} <small>hrs</small></b><span>project labour forecast</span><small>+${labour.hourVariance.toLocaleString()} hrs over budget</small></p></div></section><section class="decisions-week"><header><h3>Decisions this week</h3><p>Ordered by schedule impact. Reviewed means acknowledged, not resolved.</p></header><div class="pg-main float"><div class="decision-groups">${['This week','Coming up'].map(group=>`<section><h4>${group}</h4>${state.decisions.filter(a=>a.group===group).map(a=>`<article class="decision-card ${a.reviewed?'reviewed':''}" data-severity="${a.severity}"><div class="decision-heading"><b>${escapeHtml(label(a))}</b><span class="status-word ${a.severity}">${a.reviewed?'Reviewed':a.overdue?'Overdue':a.critical?'No buffer':'Review'}</span></div><p class="decision-impact">${escapeHtml(a.reason)}${a.finish?' · due '+this.fmtDay(a.finish):''}</p><small>${escapeHtml(a.id)}${a.float>0?' · '+a.float+' days of schedule buffer':''}</small><div class="decision-actions"><button data-decision-model="${escapeHtml(a.id)}">Show on model</button><button data-decision-next="${escapeHtml(a.id)}">See in next 3 weeks</button><button data-decision-review="${escapeHtml(a.id)}" aria-pressed="${a.reviewed}">${a.reviewed?'Reviewed · undo':'Mark as reviewed'}</button></div></article>`).join('')||'<p class="management-clear">No decisions in this group.</p>'}</section>`).join('')}</div><div class="pg-side" data-details></div></div></section>`;
        body.querySelector('[data-bim-open]').onclick=()=>document.dispatchEvent(new CustomEvent('dashboard-integrations',{detail:{step:'revit'}}));
        body.querySelector('[data-labour-open]').onclick=()=>document.dispatchEvent(new CustomEvent('dashboard-integrations',{detail:{step:'labour'}}));
        body.querySelectorAll('[data-decision-model]').forEach(b=>b.onclick=async()=>{const a=this.activity(b.dataset.decisionModel);if(a?.level)await this.views.setLevel(a.level);if(this.selectedAct===b.dataset.decisionModel)this.selectedAct=null;this.selectActivity(b.dataset.decisionModel);});
        body.querySelectorAll('[data-decision-next]').forEach(b=>b.onclick=()=>{const id=b.dataset.decisionNext,a=this.activity(id);this.kw.active=[];this.kw.typed='';this.views.setLevel(null);const date=this.asOf||this.schedule.project.dataDate||DEMO_DATE;this.cursor=date;this.calMonth=this.cursor.slice(0,7);this.selectedAct=null;this.setTab('lookahead');this.selectActivity(id);});
        body.querySelectorAll('[data-decision-review]').forEach(b=>b.onclick=()=>{const id=b.dataset.decisionReview;if(this.reviewed[id])delete this.reviewed[id];else this.reviewed[id]=new Date().toISOString();this.saveReviewed();this.refresh();this.renderBody();});
        this.renderDetails(body.querySelector('[data-details]'));
    }

    renderLookahead(body) {
        if(this.options.standalone){this.renderLookaheadBoard(body);return;}
        const plan=this.options.standalone?lookaheadWeeks(this.visibleActivities('all'),this.cursor,{all:true}):lookaheadWeeks(this.visibleActivities('open'),this.cursor);const focus=this.selectedAct&&this.activity(this.selectedAct),outside=focus&&!plan.weeks.some(w=>w.activities.some(a=>a.id===focus.id));
        body.innerHTML=`<div class="lookahead-head"><div><span class="eyebrow">SHORT-INTERVAL PLANNING</span><h3>Three weeks ahead</h3><p class="muted">${plan.unique} ${this.options.standalone?'':'open '}activities · from ${this.fmtDay(this.cursor)}. Activities spanning weeks appear in each relevant week.</p></div><label>Start date <input type="date" data-lookahead-date value="${this.cursor}" min="${this.span[0]}" max="${this.span[1]}"></label></div>
            ${outside?`<article class="decision-outlook-focus"><b>${this.options.standalone?'Selected activity':'Decision to review in this outlook'}: ${escapeHtml(focus.name)}</b><p>Original schedule dates: ${this.fmtDay(focus.start)} – ${this.fmtDay(focus.finish)}. ${focus.pct===100?'Schedule says complete; field progress still needs review.':'The original dates fall outside these three weeks.'}</p><small>${escapeHtml(focus.id)} · original schedule dates are retained</small></article>`:''}<div class="pg-main float"><div class="lookahead-weeks">${plan.weeks.map((w,i)=>`<section class="lookahead-week"><header><span>WEEK ${i+1}</span><b>${this.fmtDay(w.start)} – ${this.fmtDay(w.finish)}</b><small>${w.activities.length} activities</small></header>${w.activities.map(a=>{const m=this.modelOf(a),c=compare(m,a.pct);return `<button class="lookahead-card ${a.id===this.selectedAct?'selected':''}" data-look-act="${escapeHtml(a.id)}" style="--stage-color:${this.colorOf(a)}"><small>${escapeHtml(a.level||'Project')} · ${escapeHtml(a.stage||'Coordination')}</small><b>${escapeHtml(a.name)}</b><span>${escapeHtml(a.id)} · ${this.fmtDay(a.start)} – ${this.fmtDay(a.finish)}</span><div><em>P6 ${a.pct??'–'}%</em>${this.options.standalone?'':`<em>Model ${m?m.pct+'%':'not linked'}</em>${c?.state==='behind'?'<em class="behind">Behind plan</em>':''}`}</div></button>`;}).join('')||`<p class="lookahead-empty">${this.options.standalone?'No activities':'No open activities'} in this week.</p>`}</section>`).join('')}</div><div class="pg-side" data-details></div></div>${plan.unscheduled?`<p class="note">${plan.unscheduled} open activities need valid start/finish dates and are not placed in a week.</p>`:''}`;
        body.querySelector('[data-lookahead-date]').onchange=e=>{if(e.target.value)this.setCursor(e.target.value,{move:true});};
        body.querySelectorAll('[data-look-act]').forEach(b=>b.onclick=()=>this.selectActivity(b.dataset.lookAct));
        this.renderDetails(body.querySelector('[data-details]'));
    }

    demoStageSnapshot(){
        // Public sample schedule order is stable even while model levels finish loading.
        return demoStagesFromSchedule(this.walls,this.schedule?.activities||[],this.levels);
    }

    async resetDemo(){
        if(!this.options.standalone)return;
        this.stopPlay();this.clearFocus();this.asOf=DEMO_DATE;
        this.viewingOriginal=false;this.adjustedSchedule=null;
        this.kw.active=[];this.kw.typed='';this.gantt.show='all';this.colorMode='actual';
        this.views.setLevel(null);await this.loadSample({quiet:true});
        if(!this.options.standalone)await this.setStages(this.demoStageSnapshot(),{undo:true});await this.saveSchedule();this.render();
    }

    renderStages(body) {
        const level = this.views.level?.name;
        body.innerHTML = `<p class="muted">Set a whole level from the table below, or select walls in 3D or on the plan (Ctrl+click for several) and press a stage.</p>
            <div class="row"><button data-select-level ${level ? '' : 'disabled'}>Select all walls on ${level ? escapeHtml(level) : 'the level'}</button>
                ${level ? '' : '<span class="muted">Pick a level in the header first.</span>'}</div>
            <p data-selection class="muted"></p>
            <div class="row">${STAGES.map(s => `<button data-stage="${s.name}" disabled><span class="swatch" style="background:${s.color || NEUTRAL_STATUS_COLOR}"></span>${s.name}</button>`).join('')}</div>
            <h3>Stage legend</h3><table><tbody data-legend></tbody></table>
            <h3>Progress by level <span class="muted">(click a level to view it; % = Finished ÷ all walls)</span></h3>
            <table><thead><tr><th>Level</th><th style="width:28%">Stages</th><th class="num">Finished</th><th>Set level</th></tr></thead><tbody data-levels></tbody></table>
            <div class="row"><button data-reset>Reset all stages…</button> <span class="muted" data-saved></span> <button data-undo hidden>Undo</button></div>
            <p class="note">${this.options.standalone?'Demonstration field snapshot. Your edits stay in this browser; export CSV to share them.':'Single user. Saved to a local JSON file (data/progress.json), not synced to any cloud system.'}</p>`;
        body.querySelectorAll('[data-stage]').forEach(b => b.onclick = () => this.setStage(b.dataset.stage));
        body.querySelector('[data-select-level]').onclick = () => {
            this.views.select(this.walls.filter(w => (w.level ?? NOT_SET) === level).map(w => w.dbId));
        };
        body.querySelector('[data-reset]').onclick = () => {
            if (confirm('Clear the install stage of every wall?')) this.setStages({}, { undo: true });
        };
        body.querySelector('[data-undo]').onclick = () => { if (this.undoStages) this.setStages(this.undoStages); };
        body.querySelector('[data-undo]').hidden = !this.undoStages;
        this.updateSelection();
        this.refresh();
    }

    updateSelection() {
        if (!this.walls) return;
        this.selected = this.viewer.getSelection().map(id => this.byDbId.get(id)).filter(Boolean);
        const out = this.panel.querySelector('[data-selection]');
        if (!out) return;
        const ignored = this.viewer.getSelection().length - this.selected.length;
        out.textContent = this.selected.length
            ? `${this.selected.length} wall(s) selected${ignored ? ` (${ignored} non-wall object(s) ignored)` : ''}.`
            : 'No walls selected.';
        this.panel.querySelectorAll('[data-stage]').forEach(b => { b.disabled = !this.selected.length; });
    }

    setStage(stage) {
        const next = { ...this.stages };
        for (const wall of this.selected) {
            if (!wall.externalId) continue; // can't be tracked across reloads
            if (stage === STAGES[0].name) delete next[wall.externalId];
            else next[wall.externalId] = stage;
        }
        this.setStages(next);
    }

    // Set every wall on a level (or the whole building when level is null) to one stage, with Undo.
    setLevelStage(level, stage) {
        const next = { ...this.stages };
        for (const wall of this.walls) {
            if (!wall.externalId || (level && (wall.level ?? NOT_SET) !== level)) continue;
            if (stage === STAGES[0].name) delete next[wall.externalId];
            else next[wall.externalId] = stage;
        }
        this.setStages(next, { undo: true });
    }

    async setStages(stages, { undo = false } = {}) {
        this.undoStages = undo ? this.stages : null;
        this.stages = stages;
        this.refresh();
        const saved = this.panel.querySelector('[data-saved]');
        const undoButton = this.panel.querySelector('[data-undo]');
        if (undoButton) undoButton.hidden = !this.undoStages;
        try {
            await saveState(this.stateName, { stages, ...(this.asOf ? { asOf: this.asOf } : {}), updatedAt: new Date().toISOString() });
            if (saved) saved.textContent = `Saved ${new Date().toLocaleTimeString()}`;
        } catch (err) {
            if (saved) saved.innerHTML = `<span class="warn">Not saved: ${escapeHtml(err.message)}</span>`;
        }
    }

    // The selected activity when its walls are shown (it has a level).
    focusActivity() {
        const a = this.selectedAct && this.activity(this.selectedAct);
        return a?.level && a.scope !== 'other' ? a : null; // MEP and other trades don't touch the walls
    }

    // Re-theme walls and rebuild the legend and per-level percentages (Stages tab).
    refresh() {
        if (!this.walls) return;
        if (this.options.standalone) { this.refreshSchedule(); return; }
        this.counts = stageCounts(this.walls, w => this.stageOf(w));
        const colors = new Map();
        const counts = Object.fromEntries(STAGES.map(s => [s.name, 0]));
        const perLevel = new Map(this.levels.map(l => [l, { total: 0, done: 0, stages: Object.fromEntries(STAGES.map(st => [st.name, 0])) }]));
        for (const wall of this.walls) {
            const stage = STAGES.find(s => s.name === this.stageOf(wall)) || STAGES[0];
            counts[stage.name]++;
            if (stage.color) colors.set(wall.dbId, stage.color);
            const lvl = perLevel.get(wall.level ?? NOT_SET);
            lvl.total++;
            lvl.stages[stage.name]++;
            if (stage.name === FINISHED) lvl.done++;
        }
        const focus = this.focusActivity();
        let planned = null; // wall -> the stage planned by the timeline's date (with a schedule)
        if(this.playbackMode&&this.schedule){
            colors.clear();planned=playbackStages(this.walls,this.linked,this.cursor);
            for(const [w,k] of planned)colors.set(w.dbId,PLAYBACK_COLORS[STAGE_NAMES[k]]);
            const ids=[...planned.keys()].map(w=>w.dbId);
            this.views.setPlaybackWalls(ids);this.allPlans.setVisibleWalls(ids);
        } else if (focus) {
            // Selection limits the walls; the chosen mode still determines their status colors.
            colors.clear();
            const k = STAGE_NAMES.indexOf(focus.stage), st = STAGES[k];
            // With the floors apart, every floor the schedule links to shows that stage, like the floor labels.
            const shown = this.views.apart && st?.color && !focus.demoWalls ? this.walls.filter(w => linkedLevelNames(this.linked).has(w.level)) : this.wallsOf(focus);
            if (st?.color) for (const w of shown) {
                const actual = this.stageIndex(w);
                const color = this.colorMode === 'planned' ? st.color : this.colorMode === 'compare'
                    ? COMPARE[actual < k ? 'behind' : actual > k ? 'ahead' : 'even'].color : STAGES[actual]?.color;
                if (color) colors.set(w.dbId, color);
            }
        } else if (this.schedule && this.colorMode !== 'actual') {
            colors.clear();
            // The plan says how many walls of a level should be at a stage, not which: the walls furthest along are
            // taken first, so a wall shows "behind" only when its level has fewer walls at that stage than planned.
            const ranked = [...this.wallOrder].sort((a, b) => this.stageIndex(b) - this.stageIndex(a));
            planned = plannedStages(ranked, this.linked.filter(a => !a.demoWalls), this.cursor, this.cal);
            const c = { behind: 0, even: 0, ahead: 0 };
            for (const [w, k] of planned) {
                if (this.colorMode === 'planned') { if (STAGES[k].color) colors.set(w.dbId, STAGES[k].color); continue; }
                const a = this.stageIndex(w);
                if (!a && !k) continue; // not started, and not planned to be yet: normal look
                const state = a < k ? 'behind' : a > k ? 'ahead' : 'even';
                c[state]++;
                colors.set(w.dbId, COMPARE[state].color);
            }
            this.compareCounts = c;
        }
        this.views.setColors(colors);
        if(this.options.standalone)document.dispatchEvent(new CustomEvent('progress-summary',{detail:{walls:this.walls.length,finished:counts[FINISHED],counts,levels:this.levels.filter(l=>l!==NOT_SET).length,activities:this.schedule?.activities.length||0,attention:this.linked.filter(a=>compare(this.modelOf(a),a.pct)?.state==='behind').length,asOf:this.asOf,dataDate:this.schedule?.project.dataDate,demo:!!(this.schedule?.source.sample||this.schedule?.source.demo),colorMode:this.colorMode,playback:!!this.playbackMode,focusStage:focus?.stage||null,dashboard:this.dashboardState()}}));
        if (this.allPlans.isOpen) this.allPlans.setColors(colors);
        if (this.views.apart) this.updateFloorLabels(planned);
        this.renderColorLegend();
        const legend = this.panel.querySelector('[data-legend]');
        if (!legend) return; // the Stages tab isn't showing
        legend.innerHTML = STAGES.map(s =>
            `<tr><td><span class="swatch" style="background:${s.color || NEUTRAL_STATUS_COLOR}"></span>${s.name}</td><td class="num">${counts[s.name]}</td></tr>`).join('');
        const pct = (done, total) => total ? Math.round((done / total) * 100) : 0;
        const rows = [...perLevel.entries()].map(([level, r]) => ({ level, ...r }));
        rows.push({ level: 'All levels', total: this.walls.length, done: counts[FINISHED], stages: counts, overall: true });
        const current = this.views.level?.name;
        // A bar split by stage (Not started = the empty part of the bar).
        const stack = (r) => `<div class="stack" style="background:${NEUTRAL_STATUS_COLOR}" title="${STAGES.map(st => `${st.name}: ${r.stages[st.name]}`).join(', ')}">${STAGES.filter(st => st.color && r.stages[st.name])
            .map(st => `<span style="width:${(r.stages[st.name] / r.total) * 100}%;background:${st.color}"></span>`).join('')}</div>`;
        const picker = `<option value="">Set all to…</option>${STAGES.map(st => `<option>${st.name}</option>`).join('')}`;
        const table = this.panel.querySelector('[data-levels]');
        table.innerHTML = rows.map(r => `<tr class="${r.overall ? 'total' : 'clickable'} ${r.level === current ? 'selected' : ''}" data-row-level="${r.overall ? '' : escapeHtml(r.level)}">
            <td>${escapeHtml(r.level)}</td><td>${stack(r)}</td><td class="num">${r.done}/${r.total} · ${pct(r.done, r.total)}%</td>
            <td><select data-set-level="${r.overall ? '' : escapeHtml(r.level)}" aria-label="Set every wall on ${escapeHtml(r.level)} to a stage">${picker}</select></td></tr>`).join('');
        // Click a level row to view that floor (3D section + its plan); the picker sets every wall on that level.
        table.querySelectorAll('tr.clickable').forEach(tr => tr.onclick = (e) => { if (e.target.tagName !== 'SELECT') this.views.setLevel(tr.dataset.rowLevel); });
        table.querySelectorAll('[data-set-level]').forEach(sel => {
            sel.onclick = (e) => e.stopPropagation();
            sel.onchange = () => {
                const level = sel.dataset.setLevel || null;
                if (!level && !confirm(`Set all ${this.walls.length} walls in the building to ${sel.value}?`)) { sel.value = ''; return; }
                this.setLevelStage(level, sel.value);
            };
        });
    }

    // Schedule viewer: the model on the timeline's date. Each wall takes the color of the latest wall activity started
    // by then (scheduleWallsAt); walls not reached yet are ghosted. A picked activity, hidden stages or a search narrow
    // which activities color the model (focus on what each user needs). Nothing here reads field progress.
    scheduleKeep() {
        const focus = this.focusActivity(), hits = this.keywordHits(), off = this.hiddenStages || new Set();
        const filters = this.gantt.filters;
        return (a) => (!focus || a.id === focus.id) && !off.has(a.stage) && (!hits || hits.ids.has(a.id)) && (!filters.size || passes(a, filters, this.colValue));
    }
    // A stage's color, saved with the schedule (the model, the Gantt and the legends follow).
    setStageColor(name, color) {
        if (!this.schedule || !/^#[0-9a-f]{6}$/i.test(color)) return;
        (this.schedule.map.colors ??= {})[name] = color;
        this.stageColorMap.set(name, color);
        this.saveSchedule();
        this.refresh(); this.renderBody();
    }

    // Hide or show one stage on the model (name null: show every stage again).
    setStageHidden(name, hidden) {
        this.hiddenStages ??= new Set();
        if (name == null) this.hiddenStages.clear(); else if (hidden) this.hiddenStages.add(name); else this.hiddenStages.delete(name);
        this.refresh();
    }
    reachedWalls() {
        return this.schedule ? scheduleWallsAt(this.walls, this.linked, this.cursor, { keep: this.scheduleKeep() }) : new Map();
    }
    // Planned wall length (LF) by the shown date, per stage, and the planned curve over the schedule (weekly). Lengths
    // and the curve are worked out once per schedule / link change (the linked list is rebuilt then).
    // With a level chosen, only that level's walls count (an assigned wall set counts its walls on that level). Only
    // the activities the model shows count (scheduleKeep: the picked activity, hidden stages, keywords, Gantt filters),
    // so the strip and the model agree; the time axis stays the whole schedule.
    plannedLf() {
        if (!this.schedule || !this.walls) return null;
        const linked = this.linked, names = this.stageNames || [], level = this.views.level?.name || null;
        const keep = this.scheduleKeep(), kept = linked.filter(keep), scope = kept.map(a => a.id).join('|');
        if (this.lfCache?.linked !== linked) this.lfCache = { linked, byLevel: new Map() };
        const key = level + '\n' + scope;
        if (!this.lfCache.byLevel.has(key)) {
            if (this.lfCache.byLevel.size > 40) this.lfCache.byLevel.clear();
            const walls = level ? this.walls.filter(w => w.level === level) : this.walls;
            const acts = level ? kept.map(a => (a.walls ? { ...a, walls: a.walls.filter(w => w.level === level) } : a)) : kept;
            const lengths = activityLengths(walls, acts), from = projectStart(this.schedule.activities) || this.span[0];
            const to = linked.map(a => a.finish).filter(Boolean).sort().at(-1) || this.span[1];
            this.lfCache.byLevel.set(key, { acts, lengths, from, to, curve: plannedCurve(acts, lengths, from, to, this.cal, names) });
        }
        const { acts, lengths, from, to, curve } = this.lfCache.byLevel.get(key), focus = this.focusActivity();
        const filtered = focus ? focus.id : kept.length < linked.length ? 'filtered' : null;
        return { ...plannedLengths(acts, lengths, this.cursor, this.cal, names), from, to, curve, level, filtered };
    }

    refreshSchedule() {
        const colors = new Map(), reached = this.reachedWalls(), focus = this.focusActivity();
        if (this.schedule) {
            for (const w of this.walls) colors.set(w.dbId, GHOST_COLOR);
            for (const [w, a] of reached) colors.set(w.dbId, this.stageColorMap?.get(a.stage) || OTHER);
            // A picked activity that hasn't started by this date still shows where it will be.
            if (focus && ![...reached.values()].some(a => a.id === focus.id)) { const pale = tint(this.stageColorMap?.get(focus.stage) || OTHER); for (const w of this.wallsOf(focus)) colors.set(w.dbId, pale); }
        }
        this.reached = reached;
        this.views.setColors(colors);
        if (this.allPlans.isOpen) this.allPlans.setColors(colors);
        if (this.views.apart) this.updateFloorLabels();
        this.renderColorLegend();
        const share = floorScheduleShare(this.walls, reached), total = this.walls.length, hit = reached.size;
        document.dispatchEvent(new CustomEvent('progress-summary', { detail: {
            walls: total, levels: this.levels.filter(l => l !== NOT_SET).length, activities: this.schedule?.activities.length || 0,
            dataDate: this.schedule?.project.dataDate, cursor: this.cursor, demo: !!(this.schedule?.source.sample || this.schedule?.source.demo),
            stages: (this.stageNames || []).map(name => ({ name, color: this.stageColorMap.get(name), hidden: !!this.hiddenStages?.has(name), count: [...reached.values()].filter(a => a.stage === name).length })),
            reachedPct: total ? Math.round((100 * hit) / total) : 0, floors: share, finish: this.schedule ? this.linked.map(a => a.finish).filter(Boolean).sort().at(-1) : null,
            start: this.schedule ? projectStart(this.schedule.activities) : null, schedule: true, lf: this.plannedLf(),
        } }));
    }

    // --- Activities: color, model progress, selection ---------------------------------------------------------------

    colorOf(a) {
        if (a.scope === 'other') return NOT_WALL;
        if (this.options.standalone) return this.stageColorMap?.get(a.stage) || OTHER;
        return STAGES.find(s => s.name === a.stage)?.color || OTHER;
    }
    wallsOf(a) {
        return a.walls || this.walls.filter(w => w.level === a.level);
    }

    modelOf(a) {
        if (a.walls) return wallProgress(a, (w) => this.stageIndex(w));
        return this.counts ? modelProgress(a, this.counts) : null;
    }

    // Activities on the header level (and the milestones), by the Gantt's Show filter.
    visibleActivities(show = 'all') {
        const level = this.views.level?.name, hits = this.keywordHits(), filters = this.gantt.filters;
        return this.linked.filter(a => {
            if (hits && !hits.ids.has(a.id)) return false;
            if (filters.size && !passes(a, filters, this.colValue)) return false;
            if (level && a.level !== level && !(a.type === 'start' || a.type === 'finish')) return false;
            if (show === 'walls') return a.scope !== 'other';
            if (show === 'active') return a.status === 'active';
            if (show === 'linked') return !!(a.level && a.stage);
            if (show === 'open') return a.status !== 'complete';
            if (show === 'critical') return a.status !== 'complete' && a.float != null && a.float <= 0;
            if (show === 'behind') return compare(this.modelOf(a), a.pct)?.state === 'behind';
            return true;
        });
    }

    // --- Schedule search (keywords, like the P6 Converter) ---------------------------------------------------------------

    // Keywords in use plus the ones being typed; null when not searching.
    keywordList() {
        return [...this.kw.active, ...parseKeywords(this.kw.typed).filter(k => !this.kw.active.some(a => same(a, k)))];
    }
    searchText(a) {
        this.searchTexts ??= new WeakMap();
        if (!this.searchTexts.has(a)) {
            // The whole WBS path (so "drywall" finds the activities under an "Interior framing & drywall" group).
            const wbs = new Map((this.schedule.wbs || []).map(w => [w.id, w])), path = [];
            for (let w = wbs.get(a.wbs); w && path.length < 20; w = wbs.get(w.parent)) path.push(w.name);
            this.searchTexts.set(a, [a.id, a.name, ...path, a.level, a.stage, a.scope === 'other' ? 'not wall work' : a.scope === 'wall' ? 'wall work' : '',
                ...Object.values(a.codes || {})].filter(Boolean).join(' | ').toLowerCase());
        }
        return this.searchTexts.get(a);
    }
    keywordHits() {
        const kws = this.keywordList();
        if (!kws.length || !this.schedule) return null;
        const key = `${kws.join('\u0001')}|${this.kw.all}`;
        if (this.hitCache?.key === key && this.hitCache.linked === this.linked) return this.hitCache.value;
        const texts = this.linked.map(a => this.searchText(a)), res = matchRows(texts, kws, { all: this.kw.all });
        const value = { kws, ids: new Set(this.linked.filter((a, i) => res[i]).map(a => a.id)), counts: keywordCounts(texts, kws) };
        this.hitCache = { key, linked: this.linked, value };
        return value;
    }

    wireSearch() {
        const row = this.panel.querySelector('[data-search]');
        if (!row) return;
        const input = row.querySelector('[data-kw]');
        const keep = () => {
            const list = parseKeywords(input.value);
            input.value = ''; this.kw.typed = '';
            if (!list.length) return;
            this.kw.active = [...this.kw.active, ...list.filter(k => !this.kw.active.some(a => same(a, k)))];
            this.kw.history = remember(this.kw.history, list);
            try { localStorage.setItem(KW_HISTORY, JSON.stringify(this.kw.history)); } catch { /* storage blocked */ }
            this.searchChanged();
        };
        input.oninput = () => { this.kw.typed = input.value; this.searchChanged(); };
        input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); keep(); } else if (e.key === 'Escape') { input.value = ''; this.kw.typed = ''; this.searchChanged(); } };
        row.querySelector('[data-kw-walls]').onclick = () => {
            const hits = this.keywordHits();
            const acts = hits ? this.visibleActivities(this.gantt.show).filter(a => a.type !== 'start' && a.type !== 'finish' && a.scope !== 'other' && a.level) : [];
            const ids = [...new Set(acts.flatMap(a => this.wallsOf(a).map(w => w.dbId)))];
            if (!ids.length) return;
            this.clearFocus();
            this.views.isolate(ids);
            this.views.showPlanFor(ids);
            this.isolatedBySchedule = true;
            this.refresh();
            this.renderBody();
            this.message(`Showing the walls of ${acts.length} matching activities (${ids.length} walls). Clear the search to show every wall.`);
        };
        this.renderSearch();
    }

    // Chips (keywords in use with their matches, the one being typed), the count, the history popover.
    renderSearch() {
        const row = this.panel.querySelector('[data-search]');
        if (!row) return;
        const hits = this.keywordHits(), counts = hits?.counts || new Map();
        const typed = parseKeywords(this.kw.typed).filter(k => !this.kw.active.some(a => same(a, k)));
        const chip = (k, on) => `<span class="pg-kchip ${on ? 'on' : 'typing'}" title="${on ? 'Keyword in use' : 'Being typed: Enter keeps it'}">${escapeHtml(k)} <span class="n">${(counts.get(k) || 0).toLocaleString()}</span>${on ? `<button data-kw-remove="${escapeHtml(k)}" aria-label="Remove ${escapeHtml(k)}">${this.options.standalone?'Close':'×'}</button>` : ''}</span>`;
        row.querySelector('[data-kw-chips]').innerHTML = this.kw.active.map(k => chip(k, true)).join('') + typed.map(k => chip(k, false)).join('')
            + (this.kw.active.length ? '<button class="pg-x" data-kw-clear title="Clear the search">Clear</button>' : '');
        row.querySelectorAll('[data-kw-remove]').forEach(b => b.onclick = () => { this.kw.active = this.kw.active.filter(k => !same(k, b.dataset.kwRemove)); this.searchChanged(); });
        const clear = row.querySelector('[data-kw-clear]');
        if (clear) clear.onclick = () => { this.kw.active = []; this.searchChanged(); };
        const shown = hits ? this.visibleActivities(this.gantt.show).filter(a => a.type !== 'start' && a.type !== 'finish') : null;
        row.querySelector('[data-kw-count]').textContent = hits ? `${shown.length.toLocaleString()} ${shown.length === 1 ? 'match' : 'matches'}${this.kw.all && hits.kws.length > 1 ? ' (all keywords)' : ''}` : '';
        const wallActs = hits ? shown.filter(a => a.scope !== 'other' && a.level).length : 0;
        const walls = row.querySelector('[data-kw-walls]');
        walls.hidden = !wallActs;
        walls.textContent = `Walls of all ${wallActs.toLocaleString()}`;
        // History: keywords used before (click to use), suggestions, any / all.
        const past = this.kw.history.filter(h => !this.kw.active.some(a => same(a, h.text)));
        const suggest = KW_SUGGEST.filter(k => !this.kw.active.some(a => same(a, k)) && !this.kw.history.some(h => same(h.text, k)));
        row.querySelector('[data-kw-history]').innerHTML = `
            <label class="pg-check"><input type="checkbox" data-kw-all ${this.kw.all ? 'checked' : ''}> Match all keywords</label>
            ${past.length ? `<b>Used before</b><div class="pg-hlist">${past.map(h => `<span class="pg-kchip past"><button data-kw-use="${escapeHtml(h.text)}" title="Used ${h.uses}×">${escapeHtml(h.text)}</button><button data-kw-forget="${escapeHtml(h.text)}" aria-label="Forget ${escapeHtml(h.text)}">${this.options.standalone?'Close':'×'}</button></span>`).join('')}</div>` : ''}
            ${suggest.length ? `<b>Suggestions</b><div class="pg-hlist">${suggest.map(k => `<span class="pg-kchip past"><button data-kw-use="${k}">${k}</button></span>`).join('')}</div>` : ''}
            ${this.kw.history.length ? '<button class="pg-x" data-kw-forget-all>Clear history</button>' : ''}`;
        const pop = row.querySelector('[data-kw-history]');
        pop.querySelector('[data-kw-all]').onchange = (e) => { this.kw.all = e.target.checked; this.searchChanged(); };
        pop.querySelectorAll('[data-kw-use]').forEach(b => b.onclick = () => {
            const k = b.dataset.kwUse;
            if (!this.kw.active.some(a => same(a, k))) this.kw.active = [...this.kw.active, k];
            this.kw.history = remember(this.kw.history, [k]);
            try { localStorage.setItem(KW_HISTORY, JSON.stringify(this.kw.history)); } catch { /* storage blocked */ }
            this.searchChanged();
        });
        const saveHist = () => { try { localStorage.setItem(KW_HISTORY, JSON.stringify(this.kw.history)); } catch { /* storage blocked */ } };
        pop.querySelectorAll('[data-kw-forget]').forEach(b => b.onclick = () => { this.kw.history = this.kw.history.filter(h => !same(h.text, b.dataset.kwForget)); saveHist(); this.renderSearch(); });
        const all = pop.querySelector('[data-kw-forget-all]');
        if (all) all.onclick = () => { this.kw.history = []; saveHist(); this.renderSearch(); };
    }

    searchChanged() {
        // The search's wall view ends when the search changes (unless an activity is picked).
        if (this.isolatedBySchedule && !this.selectedAct) { this.showDefault(); this.isolatedBySchedule = false; this.refresh(); }
        this.renderSearch();
        this.renderBody();
    }

    // Serialize floor/plan loading; a newer selection or manual level change wins.
    focusScheduleLevel(name) {
        if (!this.views.levels.some(l => l.name === name)) return;
        const version = this.scheduleFocusVersion = (this.scheduleFocusVersion || 0) + 1;
        this.views.cancelSelectionFollow();
        const selectionVersion = this.views.selectionFollowVersion;
        const current = () => version === this.scheduleFocusVersion && selectionVersion === this.views.selectionFollowVersion;
        this.scheduleFocusQueue = (this.scheduleFocusQueue || Promise.resolve()).then(async () => {
            if (!current()) return;
            this.views.setLayout('split', { open: false });
            if (this.views.apart) { await this.views.setLevelsApart(null); this.apartOn = false; }
            if (!current()) return;
            if (this.allPlans.isOpen) this.allPlans.close();
            this.views.showAll();
            this.isolatedBySchedule = false;
            await this.views.setLevel(name, { fit: 'now' });
            if (!current()) return;
            this.refresh();this.renderBody();
            document.dispatchEvent(new CustomEvent('dashboard-focus'));
        }).catch(err => this.message(`Floor context needs a retry: ${err.message || err}`, 'warn'));
        return this.scheduleFocusQueue;
    }

    setModelSelection(context) {
        this.modelSelectionIds = context.level ? context.ids.filter(id => this.byDbId?.has(id)) : [];
        this.modelSelectionRaw = context.level ? [...context.ids] : [];
        this.renderRelated();
    }

    renderRelated() {
        const el = this.panel.querySelector('[data-related-work]');
        if (!el) return;
        const walls = this.modelSelectionIds.map(id => this.byDbId?.get(id)).filter(w => w && w.level === this.views.level?.name);
        el.hidden = !walls.length;
        if (el.hidden) return;
        const related = relatedWallActivities(walls, this.linked);
        // Batch / single element assignment: the selected walls (by externalId) to one wall activity at its install stage.
        const targets = this.linked.filter(a => a.scope === 'wall' && isStage(a.stage))
            .sort((x, y) => (y.level === walls[0].level) - (x.level === walls[0].level) || STAGE_NAMES.indexOf(x.stage) - STAGE_NAMES.indexOf(y.stage) || x.id.localeCompare(y.id, undefined, { numeric: true }));
        if (!targets.some(a => a.id === this.assignActId)) this.assignActId = related[0]?.activity.id || targets[0]?.id || '';
        const live = this.selectionIsLive(), ids = walls.map(w => w.externalId).filter(Boolean), elements = this.schedule?.map.elements || {};
        const inTarget = (elements[this.assignActId] || []).filter(id => ids.includes(id)).length;
        const assign = this.schedule && targets.length ? `<div class="pg-assign"><label>Assign to <select data-assign-act aria-label="Activity for the selected walls">${targets.map(a => `<option value="${escapeHtml(a.id)}" ${a.id === this.assignActId ? 'selected' : ''}>${escapeHtml(a.stage)} · ${escapeHtml(a.id)} ${escapeHtml(a.name)}</option>`).join('')}</select></label>
            <button data-assign-add ${ids.length && live ? '' : 'disabled'}>Assign ${ids.length} selected</button><button data-assign-remove ${inTarget && live ? '' : 'disabled'}>Remove ${inTarget || ''}</button>${live ? '' : '<span class="muted">Select the walls again in the model or plan to assign.</span>'}</div>` : '';
        el.innerHTML = `<span><b>Related P6 work</b> · ${walls.length} selected · ${escapeHtml(walls[0].level)}</span><div>${related.map(({activity:a,count,basis}) => `<button data-related-act="${escapeHtml(a.id)}" title="${escapeHtml(a.name)} · ${count} selected wall(s) · ${basis} · ${activityLinkState(a,this.levels).label}">${escapeHtml(a.stage)} <b>${escapeHtml(a.id)}</b>${a.assignedWalls ? ' · assigned' : ''}</button>`).join('') || '<span class="muted">No linked activity. Review Activity links.</span>'}</div>${assign}<small>Open a task to see its link basis and wall scope.${walls.length > ids.length ? ` ${walls.length - ids.length} selected wall(s) have no stable element ID and can't be assigned.` : ''}</small>`;
        el.querySelectorAll('[data-related-act]').forEach(b => b.onclick = () => this.openScheduleActivity(b.dataset.relatedAct));
        const pick = el.querySelector('[data-assign-act]');
        if (pick) pick.onchange = () => { this.assignActId = pick.value; this.renderRelated(); };
        el.querySelector('[data-assign-add]')?.addEventListener('click', () => this.assignSelected(this.assignActId, ids));
        el.querySelector('[data-assign-remove]')?.addEventListener('click', () => this.assignSelected(this.assignActId, ids, { remove: true }));
    }

    // Assignment acts only while the model or plan still holds exactly the selection shown (opening a task clears it,
    // and a whole-floor plan highlight is not a wall selection).
    selectionIsLive() {
        const want = new Set(this.modelSelectionRaw || []);
        return !!want.size && [this.views.viewer3d, this.views.viewer2d].filter(v => v?.model)
            .some(v => { const sel = v.getSelection(); return sel.length === want.size && sel.every(id => want.has(id)); });
    }

    // Saves (or removes) an exact element assignment. Floor/stage links stay as they were for every other activity.
    assignSelected(id, externalIds, { remove = false } = {}) {
        const a = this.activity(id);
        if (!a || !externalIds.length) return;
        if (!this.selectionIsLive()) { this.renderRelated(); this.message('Those walls are no longer selected. Select them again in the model or plan, then assign.', 'warn'); return; }
        if (this.viewingOriginal) { this.message('Viewing the original dates: switch back to the adjusted dates to change links.', 'warn'); return; }
        const map = this.schedule.map, overlaps = remove ? [] : stageOverlaps(a, externalIds, map.elements, this.linked);
        map.elements = assignElements(map.elements, id, externalIds, { remove });
        if (!Object.keys(map.elements).length) delete map.elements;
        this.linksChanged();
        this.renderRelated();
        const total = map.elements?.[id]?.length || 0;
        this.message(`${remove ? 'Removed' : 'Assigned'} ${externalIds.length} wall${externalIds.length === 1 ? '' : 's'} ${remove ? 'from' : 'to'} ${id} (${a.stage}). ${total} element${total === 1 ? '' : 's'} assigned to it now.${overlaps.length ? ` Also assigned at ${a.stage} to ${overlaps.map(o => `${o.activity.id} (${o.count})`).join(', ')}: check for double counting.` : ''}`, overlaps.length ? 'warn' : '');
    }

    async openScheduleActivity(id, {review = false} = {}) {
        if (!this.activity(id)) return;
        const version = this.linkOpenVersion = (this.linkOpenVersion || 0) + 1;
        this.kw.active = []; this.kw.typed = '';
        this.gantt.show = 'all'; this.gantt.collapsed = new Set();
        this.selectedAct = null;
        const level = this.activity(id).level;
        if (this.views.level && this.views.level.name !== level) await this.views.setLevel(null);
        if (version !== this.linkOpenVersion) return;
        const links = this.panel.querySelector('[data-links]');
        if (links) links.hidden = true;
        this.panel.querySelector('[data-links-toggle]')?.classList.remove('active');
        this.setTab('gantt'); this.selectActivity(id);
        await this.scheduleFocusQueue;
        if (version !== this.linkOpenVersion || this.selectedAct !== id) return;
        if (review) {
            const settings = this.panel.querySelector('.activity-mapping');
            if (settings) { settings.open = true; settings.querySelector('[data-own="level"]')?.focus(); }
        }
    }

    selectActivity(id) {
        this.scheduleFocusVersion = (this.scheduleFocusVersion || 0) + 1;
        if(this.playbackMode)this.endPlayback();
        this.selectedAct = this.selectedAct === id ? null : id;
        this.reveal = !!this.selectedAct;
        const a = this.focusActivity();
        if (this.options.standalone) {
            const selected = this.selectedAct && this.activity(this.selectedAct);
            // With every floor in view (Floors apart, All plans) the activity is highlighted where it is; switching
            // to its floor would close (or cut short the loading of) those views.
            if (selected?.level && !this.apartOn && !this.allPlans.isOpen) this.focusScheduleLevel(selected.level);
        } else if (a) {
            const ids = this.wallsOf(a).map(w => w.dbId);
            // With the floors apart every floor stays in view, colored by the activity's stage (refresh).
            if (!this.views.apart) { this.views.isolate(ids); this.isolatedBySchedule = true; }
            this.views.showPlanFor(ids);
        } else if (this.isolatedBySchedule) {
            this.showDefault();
            this.isolatedBySchedule = false;
        }
        this.refresh();
        this.renderBody();
        if(this.options.standalone&&this.selectedAct)document.dispatchEvent(new CustomEvent('dashboard-focus'));
    }

    clearFocus() {
        this.scheduleFocusVersion = (this.scheduleFocusVersion || 0) + 1;
        if (!this.selectedAct) return;
        this.selectedAct = null;
        if (this.isolatedBySchedule) { this.showDefault(); this.isolatedBySchedule = false; }
    }

    // --- Gantt tab -----------------------------------------------------------------------------------------------------

    // The schedule viewer's lookahead: 3, 6 or 12 weeks as a compact board, one slim row per activity with its bar
    // across the week columns (the tracker keeps the week cards above).
    syncLookQuick() { this.panel?.querySelectorAll('[data-la-quick]').forEach(b => b.setAttribute('aria-pressed', this.tab === 'lookahead' && +b.dataset.laQuick === this.lookWeeks)); }

    renderLookaheadBoard(body) {
        const n=this.lookWeeks||3,plan=lookaheadWeeks(this.visibleActivities('all'),this.cursor,{all:true,weeks:n});
        const from=this.cursor,days=n*7,end=plan.weeks.at(-1).finish,focus=this.selectedAct&&this.activity(this.selectedAct);
        const seen=new Set(),acts=plan.weeks.flatMap(w=>w.activities).filter(a=>!seen.has(a.id)&&seen.add(a.id)).sort((a,b)=>a.start.localeCompare(b.start)||a.id.localeCompare(b.id));
        const outside=focus&&!seen.has(focus.id),short=d=>new Date(dayMs(d)).toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'UTC'});
        const month=d=>new Date(dayMs(d)).toLocaleDateString('en-US',{month:'short',timeZone:'UTC'});
        const pos=d=>Math.min(days,Math.max(0,(dayMs(d)-dayMs(from))/864e5));
        const stats=[['Activities',acts.length],['Starting',acts.filter(a=>a.start>=from).length],['Finishing',acts.filter(a=>a.finish<=end).length],['In progress',acts.filter(a=>(a.pct??0)>0&&(a.pct??0)<100).length]];
        // The length and start date sit on the title line, beside "Next N weeks"; the counts go to the right.
        body.innerHTML=`<div class="la-head"><div><span class="eyebrow">LOOKAHEAD</span><div class="la-title"><h3>Next ${n} weeks</h3><div class="la-controls"><div class="la-range" role="group" aria-label="Lookahead length">${[3,6,12].map(w=>`<button data-look-weeks="${w}" aria-pressed="${w===n}">${w} wk</button>`).join('')}</div><label>From <input type="date" data-lookahead-date value="${from}" min="${this.span[0]}" max="${this.span[1]}"></label></div></div><p>${this.fmtDay(from)} – ${this.fmtDay(end)}</p></div>
            <div class="la-stats">${stats.map(([k,v])=>`<span><b>${v}</b>${k}</span>`).join('')}</div></div>
            ${outside?`<p class="la-focus"><b>${escapeHtml(focus.name)}</b> (${this.fmtDay(focus.start)} – ${this.fmtDay(focus.finish)}) falls outside these ${n} weeks.</p>`:''}
            <div class="pg-main float"><div class="la-board" style="--weeks:${n}">
                <div class="la-row la-top"><span class="la-name">${acts.length} activities</span><div class="la-weeks">${plan.weeks.map((w,i)=>`<div class="lookahead-week" title="Week ${i+1}: ${this.fmtDay(w.start)} – ${this.fmtDay(w.finish)} · ${w.activities.length} activities"><small>${i===0||month(w.start)!==month(plan.weeks[i-1].start)?month(w.start):'&nbsp;'}</small><b>${short(w.start)}</b><i>${w.activities.length}</i></div>`).join('')}</div></div>
                ${acts.map(a=>{const l=pos(a.start)/days*100,r=pos(addDays(a.finish,1))/days*100,pct=a.pct??0;return `<button class="la-row lookahead-card ${a.id===this.selectedAct?'selected':''}" data-look-act="${escapeHtml(a.id)}" style="--stage-color:${this.colorOf(a)}" title="${escapeHtml(a.name)} · ${escapeHtml(a.id)} · ${this.fmtDay(a.start)} – ${this.fmtDay(a.finish)} · P6 ${pct}%"><span class="la-name"><b>${escapeHtml(a.name)}</b><small>${escapeHtml(a.level||'Project')} · ${short(a.start)} – ${short(a.finish)}</small></span><span class="la-weeks"><i class="la-bar ${a.start<from?'from-before':''} ${a.finish>end?'past-end':''}" style="left:${l}%;width:${Math.max(1.5,r-l)}%"><i style="width:${pct}%"></i></i><em>${pct}%</em></span></button>`;}).join('')||'<p class="lookahead-empty">No activities in these weeks.</p>'}
            </div><div class="pg-side" data-details></div></div>${plan.unscheduled?`<p class="note">${plan.unscheduled} activities need valid start/finish dates and are not shown.</p>`:''}`;
        body.querySelector('[data-lookahead-date]').onchange=e=>{if(e.target.value)this.setCursor(e.target.value,{move:true});};
        body.querySelectorAll('[data-look-weeks]').forEach(b=>b.onclick=()=>{this.lookWeeks=+b.dataset.lookWeeks;try{localStorage.setItem('cas-project-dashboard:lookahead-weeks',String(this.lookWeeks));}catch{}this.renderBody();this.syncLookQuick();});
        body.querySelectorAll('[data-look-act]').forEach(b=>b.onclick=()=>this.selectActivity(b.dataset.lookAct));
        this.renderDetails(body.querySelector('[data-details]'));
    }

    // --- Excel-style column filters (Gantt headers; they also slice the Calendar, lookahead and the model) ------------

    // A column's value as the Gantt prints it (dates in the shown format), so filters and sorts match what users see.
    colValue = (a, key) => key === 'id' ? a.id : key === 'name' ? a.name : key === 'start' ? this.fmtDay(a.start) : key === 'finish' ? this.fmtDay(a.finish)
        : key === 'dur' ? (a.type === 'start' || a.type === 'finish' ? '' : String(Math.round(a.dur ?? 0))) : key === 'pct' ? (a.pct == null ? '' : `${a.pct}%`) : '';

    filterChipsHtml() {
        const f = this.gantt.filters;
        if (!f.size && !this.gantt.sort) return '';
        const shown = this.visibleActivities(this.gantt.show).filter(a => a.type !== 'start' && a.type !== 'finish').length, all = this.linked.filter(a => a.type !== 'start' && a.type !== 'finish').length;
        return `<div class="pg-filter-chips">${f.size ? `<b class="pg-filter-count">Filtered: ${shown.toLocaleString()} of ${all.toLocaleString()} activities</b>` : ''}${[...f].map(([k, set]) => { const v = [...set].map(x => x || '(Blanks)'); return `<span class="pg-fchip" title="${escapeHtml(v.join(', '))}"><b>${COLUMN_LABELS[k]}:</b> ${escapeHtml(v.slice(0, 2).join(', '))}${v.length > 2 ? ` +${v.length - 2}` : ''}<button data-unfilter="${k}" aria-label="Remove the ${COLUMN_LABELS[k]} filter">×</button></span>`; }).join('')}
            ${this.gantt.sort ? `<span class="pg-fchip"><b>Sorted:</b> ${COLUMN_LABELS[this.gantt.sort.key]} ${this.gantt.sort.dir === 'desc' ? '↓' : '↑'}</span>` : ''}<button class="pg-btn" data-clear-filters>Clear filters</button></div>`;
    }

    setColumnFilter(key, set) {
        if (set) this.gantt.filters.set(key, set); else this.gantt.filters.delete(key);
        this.filtersChanged();
    }
    filtersChanged() {
        this.closeColumnMenu();
        this.refresh();
        this.renderBody();
    }
    closeColumnMenu() {
        this.colMenu?.remove(); this.colMenu = null;
        document.removeEventListener('pointerdown', this.colMenuAway, true);
    }

    // The column menu, as in Excel and the P6 Converter: sort, hide (schedule viewer), a value search and the value list
    // with counts. The list holds the values of the activities the other filters, the search and the floor show. OK keeps
    // the checked values (while searching: the checked values the search finds, as in Excel).
    openColumnMenu(key, button) {
        this.closeColumnMenu();
        const label = COLUMN_LABELS[key], level = this.views.level?.name, hits = this.keywordHits();
        const base = this.linked.filter(a => (!hits || hits.ids.has(a.id)) && (!level || a.level === level || a.type === 'start' || a.type === 'finish') && passes(a, this.gantt.filters, this.colValue, key));
        const values = distinctValues(base, key, this.colValue), allowed = this.gantt.filters.get(key), max = 500;
        let pick = new Set(values.filter(v => !allowed || allowed.has(v.value)).map(v => v.value)), query = '', found = values, pickFound = null;
        const menu = this.colMenu = document.createElement('div');
        menu.className = 'pg-col-menu'; menu.setAttribute('role', 'dialog'); menu.setAttribute('aria-label', `${label} filter`);
        menu.innerHTML = `<div class="pg-cm-head"><b>${label}</b><button data-cm-close aria-label="Close">×</button></div>
            <div class="pg-cm-actions"><button data-cm-sort="asc">↑ Sort ascending</button><button data-cm-sort="desc">↓ Sort descending</button>
                ${this.gantt.sort?.key === key ? '<button data-cm-sort="">↺ Schedule order</button>' : ''}${this.options.standalone && key !== 'name' ? '<button data-cm-hide>Hide column</button>' : ''}</div>
            <input type="search" class="pg-cm-search" placeholder="Search" aria-label="Search ${label} values">
            <label class="pg-cm-all"><input type="checkbox" data-cm-all> <span>(Select all)</span></label>
            <div class="pg-cm-values" role="group" aria-label="${label} values"></div><p class="pg-cm-note"></p>
            <div class="pg-cm-foot"><button data-cm-clear ${allowed ? '' : 'disabled'}>Clear filter</button><span></span><button data-cm-close>Cancel</button><button class="primary" data-cm-ok>OK</button></div>`;
        document.body.append(menu);
        const list = menu.querySelector('.pg-cm-values'), all = menu.querySelector('[data-cm-all]'), ok = menu.querySelector('[data-cm-ok]'), current = () => (query ? pickFound : pick);
        const sync = () => { const set = current(), on = found.filter(v => set.has(v.value)).length; all.checked = on === found.length && on > 0; all.indeterminate = on > 0 && on < found.length; ok.disabled = !set.size; };
        const draw = () => {
            const set = current();
            list.innerHTML = found.slice(0, max).map((v, n) => `<label><input type="checkbox" data-cm-v="${n}" ${set.has(v.value) ? 'checked' : ''}> <span class="${v.value ? '' : 'muted'}">${escapeHtml(v.value || '(Blanks)')}</span> <span class="n">${v.count}</span></label>`).join('') || '<p class="muted">No values match.</p>';
            list.querySelectorAll('[data-cm-v]').forEach(i => i.onchange = () => { const v = found[+i.dataset.cmV].value; if (i.checked) set.add(v); else set.delete(v); sync(); });
            menu.querySelector('.pg-cm-note').textContent = found.length > max ? `Showing ${max} of ${found.length.toLocaleString()} values. Search to find the rest.` : '';
            menu.querySelector('.pg-cm-all span').textContent = query ? '(Select all search results)' : '(Select all)';
            sync();
        };
        all.onchange = () => { const set = current(); for (const v of found) if (all.checked) set.add(v.value); else set.delete(v.value); draw(); };
        const search = menu.querySelector('.pg-cm-search');
        search.oninput = () => { query = search.value; found = searchValues(values, query); pickFound = new Set(found.map(v => v.value)); draw(); };
        const apply = () => { const set = current(); this.setColumnFilter(key, !query && values.every(v => set.has(v.value)) ? null : new Set(set)); };
        ok.onclick = apply;
        search.onkeydown = (e) => { if (e.key === 'Enter' && !ok.disabled) apply(); };
        menu.onkeydown = (e) => { if (e.key === 'Escape') { e.stopPropagation(); this.closeColumnMenu(); button.focus(); } };
        menu.querySelector('[data-cm-clear]').onclick = () => this.setColumnFilter(key, null);
        menu.querySelectorAll('[data-cm-close]').forEach(b => b.onclick = () => this.closeColumnMenu());
        menu.querySelectorAll('[data-cm-sort]').forEach(b => b.onclick = () => { this.gantt.sort = b.dataset.cmSort ? { key, dir: b.dataset.cmSort } : null; this.filtersChanged(); });
        menu.querySelector('[data-cm-hide]')?.addEventListener('click', () => {
            this.gantt.hiddenCols.add(key);
            try { localStorage.setItem('cas-project-dashboard:gantt-columns', JSON.stringify([...this.gantt.hiddenCols])); } catch {}
            this.closeColumnMenu(); this.renderBody();
        });
        draw();
        // Under the button, kept on screen.
        const r = button.getBoundingClientRect(), w = Math.min(300, innerWidth - 16);
        menu.style.width = `${w}px`;
        menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
        const below = innerHeight - r.bottom - 12, top = below >= 280 ? r.bottom + 4 : Math.max(8, innerHeight - Math.min(480, innerHeight - 16) - 8);
        menu.style.top = `${top}px`; menu.style.maxHeight = `${innerHeight - top - 8}px`;
        this.colMenuAway = (e) => { if (!menu.contains(e.target) && e.target !== button) this.closeColumnMenu(); };
        document.addEventListener('pointerdown', this.colMenuAway, true);
        search.focus();
    }

    renderGantt(body) {
        const old = body.querySelector('[data-gantt]'), keep = old ? [old.scrollLeft, old.scrollTop] : null;
        this.counts ??= stageCounts(this.walls, w => this.stageOf(w));
        const level = this.views.level?.name;
        const sort = this.gantt.sort, order = sort ? (x, y) => compareValues(this.colValue(x, sort.key), this.colValue(y, sort.key), sort.dir) || (x.start || '').localeCompare(y.start || '') : null;
        const rows = ganttRows(this.visibleActivities(this.gantt.show), this.schedule, { order, collapsed: this.keywordHits() || this.gantt.filters.size ? new Set() : this.gantt.collapsed });
        const html = ganttHtml({
            floorGroups: this.options.standalone,
            formatDay:d=>this.fmtDay(d),rows, span: this.span, scale: this.gantt.scale, cal: this.cal, dataDate: this.schedule.project.dataDate, today: this.options.standalone ? null : localToday(),
            cursor: this.colorMode === 'actual' && !this.options.standalone ? null : this.cursor, modelColumn: !this.options.standalone, scrub: !!this.options.standalone, selectedId: this.selectedAct, linkMode: this.gantt.links, links: this.schedule.links,
            colorOf: (a) => this.colorOf(a), modelOf: (a) => this.modelOf(a), cmpOf: (a) => compare(this.modelOf(a), a.pct),
            columnMenu: { filtered: new Set(this.gantt.filters.keys()), sort: this.gantt.sort },
        });
        body.innerHTML = `<div class="pg-tools">
                <div class="tk-tabs">${Object.entries(SCALES).map(([k, s]) => `<button data-scale="${k}" class="${k === this.gantt.scale ? 'active' : ''}">${s.label}</button>`).join('')}</div>
                <select data-show title="Which activities">${Object.entries(SHOW).filter(([k]) => !this.options.standalone || !['behind', 'linked'].includes(k)).map(([k, l]) => `<option value="${k}" ${k === this.gantt.show ? 'selected' : ''}>${l}</option>`).join('')}</select>
                <select data-linkmode title="Relationship lines">${[['selected', 'Links: selected'], ['all', 'Links: all'], ['none', 'Links: none']].map(([k, l]) => `<option value="${k}" ${k === this.gantt.links ? 'selected' : ''}>${l}</option>`).join('')}</select>
                <select data-fold title="Fold WBS groups (click a group's row to fold or open just that one)">${Object.entries(FOLD).map(([k, l]) => `<option value="${k}" ${k === this.gantt.fold ? 'selected' : ''}>${l}</option>`).join('')}</select>
                ${this.options.standalone ? `<details class="pg-keybox pg-cols"><summary class="pg-btn" title="Choose the columns">Columns</summary><div class="pg-keypop">${[['id', 'Activity ID'], ['start', 'Start'], ['finish', 'Finish'], ['dur', 'Duration'], ['pct', 'P6 %']].map(([k, l]) => `<label><input type="checkbox" data-gantt-col="${k}" ${this.gantt.hiddenCols?.has(k) ? '' : 'checked'}> ${l}</label>`).join('')}</div></details>` : ''}${this.options.standalone ? '<button class="pg-btn" data-fold-all="open" title="Open every group">Expand all</button><button class="pg-btn" data-fold-all="all" title="Fold every group">Collapse all</button><button class="pg-btn" data-today title="Scroll to the date the model shows">Shown date</button>' : '<button class="pg-btn" data-today title="Scroll to today">Today</button>'}
                <span class="pg-level muted">${level ? `Level ${escapeHtml(level)} · <a href="#" data-all-levels>all levels</a>` : 'All levels'}</span>
                <details class="pg-keybox"><summary class="pg-btn" title="What the bars and marks mean">Key</summary><div class="pg-keypop">
                    <span><i class="k-bl"></i>planned</span><span><i class="k-bar"></i>current</span><span><i class="k-done"></i>P6 % done</span>
                    ${this.options.standalone ? '' : '<span><i class="k-model"></i>model %</span>'}<span><i class="k-crit"></i>critical</span><span><b>◆</b> milestone</span></div></details>
            </div>
            ${this.filterChipsHtml()}
            <div class="pg-main ${this.sideDetails ? 'side' : 'float'}">
                <div class="pg-g-scroll" data-gantt>${rows.length ? html : '<p class="muted pg-empty">No activities to show with this filter.</p>'}</div>
                <div class="pg-side" data-details></div></div>`;
        body.querySelectorAll('[data-scale]').forEach(b => b.onclick = () => { this.gantt.scale = b.dataset.scale; this.scrolled = false; this.renderBody(); });
        body.querySelector('[data-show]').onchange = (e) => { this.gantt.show = e.target.value; this.renderBody(); };
        body.querySelector('[data-linkmode]').onchange = (e) => { this.gantt.links = e.target.value; this.renderBody(); };
        body.querySelector('[data-today]').onclick = () => this.scrollGanttTo(this.options.standalone ? this.cursor : localToday(), { always: true });
        body.querySelectorAll('[data-col-menu]').forEach(b => b.onclick = (e) => { e.stopPropagation(); this.openColumnMenu(b.dataset.colMenu, b); });
        body.querySelectorAll('[data-unfilter]').forEach(b => b.onclick = () => this.setColumnFilter(b.dataset.unfilter, null));
        body.querySelector('[data-clear-filters]')?.addEventListener('click', () => { this.gantt.filters.clear(); this.gantt.sort = null; this.filtersChanged(); });
        body.querySelectorAll('[data-gantt-col]').forEach(c => c.onchange = () => {
            this.gantt.hiddenCols ??= new Set();
            if (c.checked) this.gantt.hiddenCols.delete(c.dataset.ganttCol); else this.gantt.hiddenCols.add(c.dataset.ganttCol);
            try { localStorage.setItem('cas-project-dashboard:gantt-columns', JSON.stringify([...this.gantt.hiddenCols])); } catch {}
            this.fitGantt();
        });
        body.querySelectorAll('[data-fold-all]').forEach(b => b.onclick = () => { this.gantt.fold = b.dataset.foldAll === 'open' ? 'none' : 'all'; this.gantt.collapsed = this.foldSet(this.gantt.fold); this.renderBody(); });
        // Scrub: the Gantt's date scale moves the model's date (video-editor style), dragging included.
        const scrub = body.querySelector('[data-scrub]');
        if (scrub) {
            const dayAt = (e) => { const r = scrub.getBoundingClientRect(), n = Math.floor((e.clientX - r.left) / SCALES[this.gantt.scale].ppd); return addDays(this.span[0], Math.max(0, Math.min(Math.round((dayMs(this.span[1]) - dayMs(this.span[0])) / 86400000), n))); };
            scrub.onpointerdown = (e) => { if (e.button !== 0) return; this.stopPlay(); scrub.setPointerCapture(e.pointerId); this.setCursor(dayAt(e)); };
            scrub.onpointermove = (e) => { if (scrub.hasPointerCapture(e.pointerId)) { const d = dayAt(e); if (d !== this.cursor) this.setCursor(d); } };
        }
        body.querySelector('[data-fold]').onchange = (e) => {
            this.gantt.fold = e.target.value;
            this.gantt.collapsed = this.foldSet(this.gantt.fold);
            this.renderBody();
        };
        const all = body.querySelector('[data-all-levels]');
        if (all) all.onclick = (e) => { e.preventDefault(); this.views.setLevel(null); };
        const g = body.querySelector('[data-gantt]');
        g.onclick = (e) => {
            const w = e.target.closest('[data-wbs]');
            if (w) {
                if (this.options.standalone && w.dataset.groupLevel && !e.target.closest('[data-toggle-wbs]')) {
                    if (this.playbackMode) this.endPlayback();
                    this.clearFocus();this.focusScheduleLevel(w.dataset.groupLevel);return;
                }
                const id = w.dataset.wbs; this.gantt.collapsed.has(id) ? this.gantt.collapsed.delete(id) : this.gantt.collapsed.add(id); this.renderBody(); return;
            }
            const r = e.target.closest('[data-act]');
            if (r) this.selectActivity(r.dataset.act);
        };
        this.renderDetails(body.querySelector('[data-details]'));
        this.fitGantt();
        if (keep) { g.scrollLeft = keep[0]; g.scrollTop = keep[1]; }
        else if (!this.scrolled) {
            // First view: the timeline's date (the data date, or the day the field progress was recorded) a third of the
            // way across, and the first work in progress (with its group) at the top: in progress in P6, else wall work
            // under way on that date.
            this.scrollGanttTo(this.cursor, { always: true });
            let row = g.querySelector('.pg-g-row.st-active') || [...g.querySelectorAll('.pg-g-row.act:not(.other)')].find(r => {
                const a = this.activity(r.dataset.act);
                return a && a.start <= this.cursor && a.finish >= this.cursor;
            });
            while (row && !row.classList.contains('wbs')) row = row.previousElementSibling;
            if (row) g.scrollTop = row.offsetTop;
            this.scrolled = true;
        }
        if (this.reveal) { this.reveal = false; this.revealSelected(g); }
    }

    // Keep the selected activity's row (and the start of its bar) in view after it was picked.
    revealSelected(g) {
        const row = g.querySelector('.pg-g-row.sel');
        if (!row) return;
        const head = g.querySelector('.pg-g-head')?.offsetHeight || 0;
        const r = row.getBoundingClientRect(), box = g.getBoundingClientRect();
        if (r.top < box.top + head || r.bottom > box.bottom - 14) g.scrollTop += r.top - (box.top + head + (box.height - head) / 3);
        const a = this.activity(this.selectedAct);
        if (a) this.scrollGanttTo(a.start);
    }

    scrollGanttTo(day, { always = false } = {}) {
        const g = this.panel.querySelector('[data-gantt]');
        if (!g || !this.span) return;
        const cells = g.querySelector('.pg-g-head .pg-g-cells')?.offsetWidth || 0;
        const x = ganttX(this.span, this.gantt.scale, day);
        const view = g.clientWidth - cells;
        if (always || x < g.scrollLeft + 20 || x > g.scrollLeft + view - 20) g.scrollLeft = Math.max(0, x - view * 0.4);
    }

    // The chart fills the panel's height (in dock-bottom mode the panel is what's left under the viewers).
    // Schedule viewer: the Gantt's columns the user keeps (Columns menu), narrower charts dropping the date columns.
    applyGanttColumns(chart, compact) {
        if (!chart) return;
        const widths = { id: 84, name: 0, start: 100, finish: 100, dur: 52, pct: 62 }, off = this.gantt.hiddenCols || new Set();
        const shown = Object.keys(widths).filter(k => !off.has(k) && !(compact && ['start', 'finish', 'dur'].includes(k)));
        const name = compact ? 170 : 240;
        chart.style.setProperty('--cols', shown.map(k => (k === 'name' ? '1fr' : `${widths[k]}px`)).join(' '));
        chart.style.setProperty('--cells', `${name + shown.reduce((t, k) => t + widths[k], 0)}px`);
        chart.querySelectorAll('[data-c]').forEach(c => { c.style.display = shown.includes(c.dataset.c) ? '' : 'none'; });
        // A group's name spans the ID column too, when there is one.
        chart.querySelectorAll('.pg-g-row.wbs [data-c="name"]').forEach(c => { c.style.gridColumn = shown.includes('id') ? '1 / 3' : '1 / 2'; });
    }

    fitGantt() {
        const main = this.panel.querySelector('.pg-main');
        if (main && main.classList.contains('side') !== this.sideDetails) {
            main.classList.toggle('side', this.sideDetails);
            main.classList.toggle('float', !this.sideDetails);
            this.renderDetails(main.querySelector('[data-details]'));
        }
        const g = this.panel.querySelector('[data-gantt]');
        if (!g) return;
        // A narrow chart drops the Start, Finish and Dur columns (the bars show the dates) to leave room for the bars.
        g.querySelector('.pg-gantt')?.classList.toggle('compact', g.clientWidth < 1150);
        if (this.options.standalone) this.applyGanttColumns(g.querySelector('.pg-gantt'), g.clientWidth < 1150);
        const room = `${Math.max(180, this.panel.getBoundingClientRect().bottom - g.getBoundingClientRect().top - 22)}px`;
        g.style.maxHeight = room;
        const side = this.panel.querySelector('.pg-main.side .pg-side');
        if (side) side.style.maxHeight = room;
    }

    // --- Calendar tab -------------------------------------------------------------------------------------------------

    renderCalendar(body) {
        this.counts ??= stageCounts(this.walls, w => this.stageOf(w));
        const acts = this.visibleActivities(this.gantt.show === 'behind' || this.gantt.show === 'critical' ? this.gantt.show : 'all');
        const level = this.views.level?.name;
        body.innerHTML = `<div class="pg-tools">
                <button class="pg-btn" data-month="-1" aria-label="Previous month">${this.options.standalone?'Previous month':'‹'}</button><b class="pg-month">${monthName(`${this.calMonth}-01`)}</b><button class="pg-btn" data-month="1" aria-label="Next month">${this.options.standalone?'Next month':'›'}</button>
                <button class="pg-btn" data-cal-today>${this.options.standalone ? 'Shown date' : 'Today'}</button><button class="pg-btn" data-cal-dd>Data date</button>
                <span class="pg-level muted" title="Click a day to see the model as planned that day; click an activity for its walls">${level ? `Level ${escapeHtml(level)} · <a href="#" data-all-levels>all levels</a>` : 'All levels'}</span>
                <details class="pg-keybox"><summary class="pg-btn" title="Colors">Key</summary><div class="pg-keypop">
                    ${this.options.standalone ? (this.stageNames || []).map(n => `<span><i style="background:${this.stageColorMap.get(n)}"></i>${escapeHtml(n)}</span>`).join('') : STAGES.filter(s => s.color).map(s => `<span><i style="background:${s.color}"></i>${s.name}</span>`).join('')}<span><i style="background:${OTHER}"></i>other</span><span><b>◆</b> milestone</span></div></details>
            </div>
            <div class="pg-main ${this.sideDetails ? 'side' : 'float'}"><div class="pg-cal-wrap">
            ${calendarHtml({formatDay:d=>this.fmtDay(d), month: this.calMonth, activities: acts, cal: this.cal, dataDate: this.schedule.project.dataDate, today: localToday(), cursor: this.cursor, selectedId: this.selectedAct, colorOf: (a) => this.colorOf(a) })}
            <div data-daylist class="pg-daylist"></div></div><div class="pg-side" data-details></div></div>`;
        const move = (n) => {
            const [y, m] = this.calMonth.split('-').map(Number);
            const d = new Date(Date.UTC(y, m - 1 + n, 1));
            this.calMonth = d.toISOString().slice(0, 7);
            this.renderBody();
        };
        body.querySelectorAll('[data-month]').forEach(b => b.onclick = () => move(Number(b.dataset.month)));
        body.querySelector('[data-cal-today]').onclick = () => { this.calMonth = (this.options.standalone ? this.cursor : localToday()).slice(0, 7); this.renderBody(); };
        body.querySelector('[data-cal-dd]').onclick = () => this.setCursor(this.schedule.project.dataDate || localToday(), { move: true });
        const all = body.querySelector('[data-all-levels]');
        if (all) all.onclick = (e) => { e.preventDefault(); this.views.setLevel(null); };
        body.querySelector('.pg-cal').onclick = (e) => {
            const ev = e.target.closest('[data-act]');
            if (ev) { this.selectActivity(ev.dataset.act); return; }
            const day = e.target.closest('[data-day]');
            if (day) this.setCursor(day.dataset.day);
        };
        this.renderDetails(body.querySelector('[data-details]'));
        this.renderDayList();
    }

    // What the schedule has on the selected day.
    renderDayList() {
        const el = this.panel.querySelector('[data-daylist]');
        if (!el) return;
        const d = this.cursor;
        const acts = this.visibleActivities().filter(a => a.start <= d && a.finish >= d);
        const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(dayMs(d)).getUTCDay()];
        el.innerHTML = `<h3>${wd} ${this.fmtDay(d)} <span class="muted">${this.cal.isWork(d) ? `${acts.length} activities in progress` : `not a working day${this.cal.isHoliday(d) ? ' (holiday)' : ''}`}</span></h3>
            ${acts.length ? `<table><thead><tr><th>Activity</th><th>Level</th><th>Stage</th><th>Start</th><th>Finish</th><th class="num">Planned by this day</th><th class="num">P6 %</th><th class="num">Model %</th></tr></thead><tbody>
            ${acts.map(a => {
                const m = this.modelOf(a), c = compare(m, a.pct);
                return `<tr class="clickable ${a.id === this.selectedAct ? 'selected' : ''}" data-act="${escapeHtml(a.id)}"><td><span class="swatch" style="background:${this.colorOf(a)}"></span>${escapeHtml(a.id)} ${escapeHtml(a.name)}</td>
                    <td>${escapeHtml(a.level || '–')}</td><td>${escapeHtml(a.stage || '–')}</td><td>${this.fmtDay(a.start)}</td><td>${this.fmtDay(a.finish)}</td>
                    <td class="num">${expectedPct(a, d, this.cal)}%</td><td class="num">${a.pct == null ? 'not printed' : a.pct + '%'}</td><td class="num">${m ? `<span class="pg-cmp ${c.state}">${m.pct}%</span>` : '–'}</td></tr>`;
            }).join('')}</tbody></table>` : ''}`;
        el.querySelectorAll('[data-act]').forEach(tr => tr.onclick = () => this.selectActivity(tr.dataset.act));
    }

    // --- The selected activity ------------------------------------------------------------------------------------------

    // What an activity covers in the model: walls, length and wall types (the model's own properties).
    quantitiesHtml(a) {
        if (a.scope !== 'wall' || !(a.walls || a.level)) return '';
        const q = activityQuantities(this.wallsOf(a)), u = q.units ? ` ${escapeHtml(q.units)}` : '';
        if (!q.count) return '<section class="activity-quantities"><b>Model quantities</b><p class="muted">No walls found for this activity in the model.</p></section>';
        return `<section class="activity-quantities"><b>Model quantities</b> <span class="muted">${a.walls ? 'assigned walls' : `all walls on ${escapeHtml(a.level)}`}</span>
            <p><b>${q.count.toLocaleString()}</b> walls${q.measured ? ` · <b>${q.length.toLocaleString()}${u}</b> long` : ''}${q.measured < q.count ? ` <span class="muted">(${(q.count - q.measured).toLocaleString()} without a length)</span>` : ''}</p>
            <details><summary>${q.types.length} wall type${q.types.length === 1 ? '' : 's'}</summary><table><thead><tr><th>Wall type</th><th class="num">Walls</th><th class="num">Length${u}</th></tr></thead><tbody>
            ${q.types.map(t => `<tr><td>${escapeHtml(t.type)}</td><td class="num">${t.count.toLocaleString()}</td><td class="num">${t.length ? t.length.toLocaleString() : '–'}</td></tr>`).join('')}</tbody></table></details></section>`;
    }

    renderDetails(el) {
        const a = this.selectedAct && this.activity(this.selectedAct);
        if (!el) return;
        if (!a) {
            el.innerHTML = el.closest('.pg-main.side') && !this.options.standalone ? '<div class="pg-details empty"><b>No activity picked</b><span class="muted">Click a bar or a row to see its walls in the model, its dates, progress and links.</span></div>' : '';
            return;
        }
        const m = this.options.standalone ? null : this.modelOf(a), c = compare(m, a.pct), v = finishVariance(a, this.cal), insight=activityInsight(a,m);
        const dd = this.schedule.project.dataDate;
        const plannedByDd = dd ? expectedPct(a, addDays(dd, -1), this.cal, { planned: true }) : null;
        const name = (id) => escapeHtml(this.activity(id)?.name || '');
        const rel = (l, id) => `<a href="#" data-goto="${escapeHtml(id)}" title="${name(id)}">${escapeHtml(id)}</a> <span class="muted">${l.type}${l.lag ? `${l.lag > 0 ? '+' : ''}${l.lag}d` : ''}</span>`;
        const preds = this.schedule.links.filter(l => l.to === a.id), succs = this.schedule.links.filter(l => l.from === a.id);
        const ms = a.type === 'start' || a.type === 'finish';
        const status = a.status === 'complete' ? '<span class="tk-src ok">Complete</span>' : a.status === 'active' ? '<span class="tk-src manual">In progress</span>' : '<span class="tk-src">Not started</span>';
        const own = this.schedule.map.activities?.[a.id] || {};
        const linkState = activityLinkState(a, this.levels), assignedCount = this.schedule.map.elements?.[a.id]?.length || 0;
        const levelOptions = `<option value="__auto">Auto${own.level === undefined ? `: ${escapeHtml(a.level || 'none')}` : ''}</option>${this.levels.map(l => `<option ${own.level === l ? 'selected' : ''}>${escapeHtml(l)}</option>`).join('')}<option value="" ${own.level === '' ? 'selected' : ''}>Not in the model</option>`;
        const stageOptions = `<option value="__auto">Auto${own.stage === undefined ? `: ${escapeHtml(a.stage || 'none')}` : ''}</option>${(this.options.standalone ? this.stageNames || [] : STAGE_NAMES.slice(1)).map(s => `<option ${own.stage === s ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('')}<option value="" ${own.stage === '' ? 'selected' : ''}>No stage</option>`;
        const linkFacts=`                ${ms ? '' : `<dt>Scope</dt><dd><select data-own="scope"><option value="__auto">Auto: ${a.scope === 'other' ? 'not wall work' : 'wall work'}</option><option value="wall" ${own.scope === 'wall' ? 'selected' : ''}>Wall work</option><option value="other" ${own.scope === 'other' ? 'selected' : ''}>Not wall work</option></select><span class="muted pg-how">${escapeHtml(a.scopeHow || '')}</span></dd>`}
                <dt>Level</dt><dd><select data-own="level">${levelOptions}</select><span class="muted pg-how">${escapeHtml(a.levelHow || '')}</span></dd>
                ${ms ? '' : `<dt>Stage</dt><dd><select data-own="stage">${stageOptions}</select><span class="muted pg-how">${escapeHtml(a.stageHow || '')}</span></dd>`}
`;
        el.innerHTML = `<div class="pg-details">
            <div class="pg-d-head"><span class="swatch" style="background:${this.colorOf(a)}"></span><b class="pg-d-name" title="${escapeHtml(`${a.id} ${a.name}`)}">${escapeHtml(a.id)} · ${escapeHtml(a.name)}</b>
                <button class="pg-x" data-clear-act aria-label="Close activity details" title="Close and show every wall again">${this.options.standalone?dashboardIcon('close'):'✕'}</button></div>
            <div class="pg-d-tags">${status}${a.scope === 'other' ? `<span class="tk-src" title="${escapeHtml(a.scopeHow || '')}">not wall work</span>` : ''}${a.float != null && a.status !== 'complete' ? `<span class="tk-src ${a.float <= 0 ? 'bad' : ''}">float ${a.float} d${a.float <= 0 ? ' · critical' : ''}</span>` : ''}
                ${m ? `<span class="pg-cmp ${c.state}" title="Model: ${m.done} of ${m.total} walls ${escapeHtml(a.stage)} or later">model ${m.pct}%</span>` : ''}
                ${a.level && a.scope !== 'other' ? '<span class="pg-d-acts"><button class="pg-btn" data-show-level title="Cut the model at this level and open its plan">Level</button><button class="pg-btn" data-select-walls title="Select the activity walls in the model and plan">Select walls</button></span>' : ''}</div>
            ${this.options.standalone ? this.quantitiesHtml(a) : ''}
            ${this.options.standalone ? `<p class="pg-link-basis"><b>${escapeHtml(linkState.label)}</b> · ${escapeHtml(linkState.basis)}<br>${linkState.kind === 'context' || linkState.kind === 'unlinked' ? 'No resolved wall assignment.' : a.assignedWalls ? `Exact element assignment: ${a.walls.length} model element${a.walls.length === 1 ? '' : 's'} at ${escapeHtml(a.stage)}.` : a.demoWalls ? 'Demo wall set; not a source P6 assignment.' : a.walls ? 'Assigned wall set.' : 'Whole floor + install stage; not an individual wall assignment.'}</p>` : ''}
            <dl class="pg-d-facts">
                <dt>Dates</dt><dd>${this.fmtDay(a.start)}${a.actualStart ? ' A' : ''} → ${this.fmtDay(a.finish)}${a.actualFinish ? ' A' : ''}${ms ? '' : ` · ${Math.round(a.dur)} d${a.status === 'active' ? `, ${Math.round(a.rem)} left` : ''}`}</dd>
                <dt>Planned</dt><dd>${this.fmtDay(a.plannedStart)} → ${this.fmtDay(a.plannedFinish)} · ${v > 0 ? `<span class="warn">${v} d late</span>` : v < 0 ? `${-v} d early` : 'on time'}</dd>
                ${ms ? '' : `<dt>Progress</dt><dd>P6 ${a.pct == null ? 'not printed' : a.pct + '%'}${plannedByDd != null ? ` <span class="muted">(plan ${plannedByDd}%)</span>` : ''}${this.options.standalone ? '' : ` · model ${m ? `${m.pct}% <span class="muted">(${m.done}/${m.total} walls)</span>${c.state === 'behind' ? ` <span class="warn">${-c.delta} pts behind</span>` : c.state === 'ahead' ? ` <span class="muted">${c.delta} pts ahead</span>` : ''}` : '<span class="muted">not linked</span>'}`}</dd>`}
                ${this.options.standalone?`<dt>Location</dt><dd>${escapeHtml(a.level||'Unlinked')}</dd><dt>Work stage</dt><dd>${escapeHtml(a.stage||'Unlinked')}</dd>`:linkFacts}
                ${Object.keys(a.codes || {}).length ? `<dt>Codes</dt><dd>${Object.entries(a.codes).map(([k, val]) => `${escapeHtml(k)}: ${escapeHtml(val)}`).join(' · ')}</dd>` : ''}
                ${this.pdfBytes && this.schedule.source.pdfRows?.[a.id] ? `<dt>Source</dt><dd>PDF page ${this.schedule.source.pdfRows[a.id][0]} <button class="pg-btn" data-in-pdf title="The page of the imported PDF, this activity's row highlighted">Show in the PDF</button></dd>` : ''}
                <dt>Before</dt><dd>${preds.map(l => rel(l, l.from)).join(', ') || '<span class="muted">none</span>'}</dd>
                <dt>After</dt><dd>${succs.map(l => rel(l, l.to)).join(', ') || '<span class="muted">none</span>'}</dd>
            </dl>${this.options.standalone?`<details class="activity-mapping"><summary>Link settings</summary><dl class="pg-d-facts">${linkFacts}${ms ? '' : `<dt>Elements</dt><dd>${assignedCount ? `${assignedCount} assigned${a.missingElements ? ` · ${a.missingElements} not in this model` : ''} <button class="pg-btn" data-clear-elements>Clear element assignment</button>` : '<span class="muted">None. Select walls in the model, then Assign.</span>'}</dd>`}</dl></details>`:''}</div>`;
        el.querySelectorAll('[data-goto]').forEach(x => x.onclick = (e) => { e.preventDefault(); this.selectActivity(x.dataset.goto); });
        el.querySelector('[data-clear-act]').onclick = () => this.selectActivity(a.id);
        el.querySelector('[data-in-pdf]')?.addEventListener('click', () => this.showInPdf(a));
        const show = el.querySelector('[data-show-level]');
        if (show) show.onclick = () => this.views.setLevel(a.level);
        const sel = el.querySelector('[data-select-walls]');
        if (sel) sel.onclick = () => { this.views.select(this.wallsOf(a).map(w => w.dbId)); if (!this.options.standalone) this.setTab('stages'); };
        el.querySelector('[data-clear-elements]')?.addEventListener('click', () => {
            if (this.viewingOriginal) { this.message('Viewing the original dates: switch back to the adjusted dates to change links.', 'warn'); return; }
            const map = this.schedule.map;
            map.elements = assignElements(map.elements, a.id, map.elements?.[a.id] || [], { remove: true });
            if (!Object.keys(map.elements).length) delete map.elements;
            this.linksChanged();
            this.message(`${a.id}: element assignment cleared; its floor / stage link applies again.`);
        });
        el.querySelectorAll('[data-own]').forEach(s => s.onchange = () => {
            const own = (this.schedule.map.activities ??= {});
            const entry = { ...own[a.id] };
            if (s.value === '__auto') delete entry[s.dataset.own]; else entry[s.dataset.own] = s.value;
            if (Object.keys(entry).length) own[a.id] = entry; else delete own[a.id];
            this.linksChanged();
        });
    }

    // --- Links: P6 locations -> model levels, stage codes -> install stages ----------------------------------------------

    renderLinks() {
        const el = this.panel.querySelector('[data-links]');
        if (!el || el.hidden || !this.schedule) return;
        const map = this.schedule.map;
        const group = (key) => {
            const out = new Map();
            for (const a of this.linked) if (a[key]) out.set(a[key], (out.get(a[key]) || 0) + 1);
            return [...out.entries()];
        };
        const locs = group('locationKey'), stageKeys = group('stageKey');
        const levelSelect = (key) => {
            const set = map.levels[key], auto = matchLevel(key, this.levels);
            return `<select data-map-level="${escapeHtml(key)}"><option value="__auto">Auto: ${escapeHtml(auto || 'no match')}</option>
                ${this.levels.map(l => `<option ${set === l ? 'selected' : ''}>${escapeHtml(l)}</option>`).join('')}<option value="" ${set === '' ? 'selected' : ''}>Not in the model</option></select>`;
        };
        const stageSelect = (key) => {
            const set = map.stages[key], auto = matchStage(key);
            return `<select data-map-stage="${escapeHtml(key)}"><option value="__auto">Auto: ${escapeHtml(auto || 'no stage')}</option>
                ${STAGE_NAMES.slice(1).map(s => `<option ${set === s ? 'selected' : ''}>${s}</option>`).join('')}<option value="" ${set === '' ? 'selected' : ''}>No stage</option></select>`;
        };
        const linked = this.linked.filter(a => a.level && a.stage).length, own = Object.keys(map.activities || {}).length;
        const states = this.linked.map(a => ({a, state: activityLinkState(a,this.levels)}));
        const filter = this.linkReviewFilter || 'review';
        const review = this.options.standalone ? `<header class="pg-review-head"><b>Model / P6 link review</b><label>Show <select data-link-review-filter><option value="review" ${filter === 'review' ? 'selected' : ''}>Needs review</option><option value="unlinked" ${filter === 'unlinked' ? 'selected' : ''}>Unlinked</option><option value="assigned" ${filter === 'assigned' ? 'selected' : ''}>Element assignments</option><option value="all" ${filter === 'all' ? 'selected' : ''}>All activities</option></select></label></header><div class="pg-link-counts">${[['assigned','Element assignment'],['mapped','Mapped'],['suggested','Check link'],['demo','Demo assignment'],['unlinked','Unlinked'],['context','Schedule only']].map(([kind,label]) => `<span>${label} <b>${states.filter(x => x.state.kind === kind).length}</b></span>`).join('')}</div><p class="muted">Mapped describes the link source, not approval. Floor / stage matches do not establish individual wall assignments.</p><div class="pg-link-review"><table><thead><tr><th>Activity</th><th>Floor / stage</th><th>Link basis</th><th></th></tr></thead><tbody>${states.filter(x => filter === 'all' || filter === 'unlinked' && x.state.kind === 'unlinked' || filter === 'assigned' && x.state.kind === 'assigned' || filter === 'review' && ['suggested','demo','unlinked'].includes(x.state.kind)).map(({a,state}) => `<tr><td><b>${escapeHtml(a.id)}</b><span>${escapeHtml(a.name)}</span></td><td>${escapeHtml(a.level || 'No floor')}<span>${escapeHtml(a.stage || 'No stage')}</span></td><td><b>${escapeHtml(state.label)}</b><span>${escapeHtml(state.basis)}</span></td><td><button data-review-act="${escapeHtml(a.id)}" aria-label="Review ${escapeHtml(a.id)} link">Review</button></td></tr>`).join('') || '<tr><td colspan="4">No activities in this filter.</td></tr>'}</tbody></table></div>${this.elementSheetHtml()}<details class="pg-bulk-links"><summary>Bulk location and stage mappings</summary>` : '';
        el.innerHTML = `<div class="tk-settings pg-links">
            ${review}
            <div><b>Link the schedule to the model.</b> <span class="muted">A wall activity needs a level (from a Location/Level activity code, the WBS or the name) and an install stage
                (an Install Stage code, or words in the name: frame, board/hang, tape/mud, finish/sand/punch). ${linked} of ${this.linked.length} activities are linked to walls.</span></div>
            <table><thead><tr><th>P6 location</th><th class="num">Activities</th><th>Model level</th></tr></thead><tbody>
                ${locs.map(([k, n]) => `<tr><td>${escapeHtml(k)}</td><td class="num">${n}</td><td>${levelSelect(k)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No locations: levels come from the activity names.</td></tr>'}</tbody></table>
            <table><thead><tr><th>P6 stage</th><th class="num">Activities</th><th>Install stage</th></tr></thead><tbody>
                ${stageKeys.map(([k, n]) => `<tr><td>${escapeHtml(k)}</td><td class="num">${n}</td><td>${stageSelect(k)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No stage codes: stages come from the activity names.</td></tr>'}</tbody></table>
            ${own ? `<div>${own} activities set one by one. <button data-clear-own>Clear those</button></div>` : ''}
            ${this.options.standalone ? '</details>' : ''}
        </div>`;
        el.querySelector('[data-link-review-filter]')?.addEventListener('change', e => { this.linkReviewFilter = e.target.value; this.renderLinks(); this.fitGantt(); });
        el.querySelectorAll('[data-review-act]').forEach(b => b.onclick = () => this.openScheduleActivity(b.dataset.reviewAct, {review:true}));
        const update = (kind, key, value) => {
            if (value === '__auto') delete map[kind][key]; else map[kind][key] = value;
            this.linksChanged();
        };
        el.querySelectorAll('[data-map-level]').forEach(s => s.onchange = () => update('levels', s.dataset.mapLevel, s.value));
        el.querySelectorAll('[data-map-stage]').forEach(s => s.onchange = () => update('stages', s.dataset.mapStage, s.value));
        this.bindElementSheet(el);
        const clear = el.querySelector('[data-clear-own]');
        if (clear) clear.onclick = () => { map.activities = {}; this.linksChanged(); };
    }

    // --- Element link spreadsheet: Model | Element ID | Activity ID | Stage rows, previewed before anything is saved ---

    elementSheetHtml() {
        const p = this.elementPreview, n = Object.values(this.schedule.map.elements || {}).reduce((t, ids) => t + ids.length, 0);
        const preview = p ? `<div class="pg-sheet-preview" data-sheet-preview><b>${escapeHtml(p.file)}</b>: ${p.assigned} assignment${p.assigned === 1 ? '' : 's'} for ${p.activities} activit${p.activities === 1 ? 'y' : 'ies'} ready · ${p.problems.length} row${p.problems.length === 1 ? '' : 's'} skipped${p.blank ? ` · ${p.blank} without an Activity ID ignored` : ''}${p.overlaps.length ? ` · <span class="warn">${p.overlaps.length} element${p.overlaps.length === 1 ? '' : 's'} on two activities at one stage</span>` : ''}
            ${p.problems.length ? `<ul>${p.problems.slice(0, 8).map(r => `<li>Row ${r.line}: ${escapeHtml(r.activity || '–')} / ${escapeHtml(r.element || '–')} · ${escapeHtml(r.problem)}</li>`).join('')}${p.problems.length > 8 ? `<li>… ${p.problems.length - 8} more</li>` : ''}</ul>` : ''}
            <span class="muted">Applying replaces the element assignment of the ${p.activities} activit${p.activities === 1 ? 'y' : 'ies'} in the file; other activities keep theirs.</span>
            <div><button data-sheet-apply ${p.activities ? '' : 'disabled'}>Apply ${p.assigned}</button><button data-sheet-cancel>Cancel</button></div></div>` : '';
        return `<details class="pg-element-sheet" ${p || this.elementSheetOpen ? 'open' : ''}><summary>Element link spreadsheet <span class="muted">${n} element assignment${n === 1 ? '' : 's'} saved</span></summary>
            <p class="muted">One row per model element and P6 activity: Model, Element ID (the model's stable element ID), Activity ID, and optionally Stage to check. Rows are checked before anything is saved.</p>
            <div class="pg-sheet-actions"><button data-sheet-template>Download template</button><label class="pg-btn">Import CSV / XLSX<input type="file" accept=".csv,.xlsx,.txt" data-sheet-file hidden></label></div>${preview}</details>`;
    }

    bindElementSheet(el) {
        const box = el.querySelector('.pg-element-sheet');
        if (!box) return;
        box.ontoggle = () => { this.elementSheetOpen = box.open; this.fitGantt(); };
        box.querySelector('[data-sheet-template]').onclick = () => {
            const level = this.views.level?.name, blank = level ? this.walls.filter(w => w.level === level) : [];
            const rows = elementLinkTemplate({ model: this.modelNames[0] || '', linked: this.linked, elements: this.schedule.map.elements, walls: this.walls, blankWalls: blank });
            downloadCsv(`${(this.schedule.project.id || 'schedule').replace(/[^\w-]+/g, '_')}-element-links-${localToday()}.csv`, rows);
            const saved = rows.filter((r, i) => i && r[2]).length;
            this.message(`Template: ${saved} saved assignment row(s)${level ? ` and ${rows.length - 1 - saved} unassigned wall(s) of ${level} with a blank Activity ID` : '. Open a floor to add its unassigned walls'}.`);
        };
        box.querySelector('[data-sheet-file]').onchange = async (e) => {
            const file = e.target.files[0];
            e.target.value = '';
            if (!file) return;
            try {
                const ext = file.name.split('.').pop().toLowerCase();
                let read, firstError;
                if (ext === 'xlsx') {
                    for (const sheet of await readXlsx(await file.arrayBuffer())) { try { read = readElementLinkRows(sheet.rows); break; } catch (err) { firstError ??= err; } }
                    if (!read) throw firstError || new Error('The workbook has no sheets');
                } else read = readElementLinkRows(parseCsv(decodeText(await file.arrayBuffer())));
                this.elementPreview = { file: file.name, ...previewElementLinks(read.rows, { linked: this.linked, externalIds: this.wallsByExternalId.keys(), models: this.modelNames }) };
            } catch (err) { this.elementPreview = null; this.message(`${file.name}: ${err.message}`, 'warn'); }
            this.renderLinks(); this.fitGantt();
        };
        box.querySelector('[data-sheet-cancel]')?.addEventListener('click', () => { this.elementPreview = null; this.renderLinks(); this.fitGantt(); });
        box.querySelector('[data-sheet-apply]')?.addEventListener('click', () => {
            const p = this.elementPreview;
            if (this.viewingOriginal) { this.message('Viewing the original dates: switch back to the adjusted dates to change links.', 'warn'); return; }
            this.schedule.map.elements = { ...(this.schedule.map.elements || {}), ...p.elements };
            this.elementPreview = null; this.elementSheetOpen = true;
            this.linksChanged();
            this.message(`${p.file}: ${p.assigned} element assignment${p.assigned === 1 ? '' : 's'} saved for ${p.activities} activit${p.activities === 1 ? 'y' : 'ies'}.${p.problems.length ? ` ${p.problems.length} row(s) skipped.` : ''}`);
        });
    }

    linksChanged() {
        const mappingOpen = this.panel.querySelector('.activity-mapping')?.open;
        this.linkedCache = null;
        this.saveSchedule();
        const focus = this.focusActivity();
        if (!focus && this.isolatedBySchedule) { this.showDefault(); this.isolatedBySchedule = false; }
        this.refresh();
        this.renderInfo();
        this.renderLinks();
        this.renderBody();
        if (mappingOpen) { const settings = this.panel.querySelector('.activity-mapping'); if (settings) settings.open = true; }
    }

    exportCsv() {
        this.counts ??= stageCounts(this.walls, w => this.stageOf(w));
        const rows = [['Activity ID', 'Activity Name', 'Level', 'Install stage', 'Status', 'Start', 'Finish', 'Planned Start', 'Planned Finish', 'Finish variance (d)', 'Total float (d)',
            'P6 % complete', 'Model % complete', 'Walls at stage', 'Walls on level', 'Model - P6 (pts)', 'Scope']];
        for (const a of this.linked) {
            const m = this.modelOf(a), c = compare(m, a.pct);
            rows.push([a.id, a.name, a.level || '', a.stage || '', a.status, a.start, a.finish, a.plannedStart, a.plannedFinish, finishVariance(a, this.cal), a.float ?? '',
                a.pct, m ? m.pct : '', m ? m.done : '', m ? m.total : '', c ? c.delta : '', a.scope === 'other' ? 'Not wall work' : a.scope === 'wall' ? 'Wall work' : 'Milestone']);
        }
        const name = (this.schedule.project.id || 'schedule').replace(/[^\w-]+/g, '_');
        downloadCsv(`${name}-progress-${localToday()}.csv`, rows);
    }
}

Autodesk.Viewing.theExtensionManager.registerExtension(EXTENSION_ID, ProgressExtension);
