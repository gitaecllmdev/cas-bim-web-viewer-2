// Spreadsheet view for the P6 Converter: Excel-style column filters (value lists), sorting that keeps the source order
// by default, and the P6 outline (WBS heading rows grouping the activities under them). No DOM: tested in Node.
// Rows are the converter's rows ({ kind: 'Activity' | 'Summary', wbs, cells, ... }), in source (PDF) order.

export const valueText = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const heading = (r) => r.kind === 'Summary';

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
// Sort key of a printed P6 value: a date (01-Oct-26, 01-Oct-26 A, 23-Nov-26*), a number (10, -17, 45%, 5d) or text.
// Blank is null.
export function sortKey(value) {
    const s = valueText(value);
    if (!s) return null;
    const d = /^(\d{1,2})[-/ ]([A-Za-z]{3})[A-Za-z]*,?[-/ ](\d{4}|\d{2})\b/.exec(s);
    if (d && d[2].toLowerCase() in MONTHS) return { type: 0, v: Date.UTC(d[3].length === 2 ? 2000 + +d[3] : +d[3], MONTHS[d[2].toLowerCase()], +d[1]) };
    const n = /^-?\d+(?:\.\d+)?(?=\s*(?:%|d|days?|h|hrs?|w|wks?)?$)/i.exec(s.replace(/,/g, ''));
    if (n) return { type: 1, v: parseFloat(n[0]) };
    return { type: 2, v: s.toLowerCase() };
}
// Ascending order of two values; blanks always last, dates before numbers before text (a column is normally one type).
export function compareValues(a, b, dir = 'asc') {
    const x = sortKey(a), y = sortKey(b);
    if (!x || !y) return !x && !y ? 0 : x ? -1 : 1;
    const c = x.type !== y.type ? x.type - y.type : x.type === 2 ? x.v.localeCompare(y.v, undefined, { numeric: true }) : x.v - y.v;
    return dir === 'desc' ? -c : c;
}

// The outline: for each row, its heading (parent index, -1 at the top) and its depth. A heading's WBS is its own path
// ("Project / Milestones"); an activity's is the path of the heading it sits under. Works on the rows as imported.
export function outline(rows) {
    const out = [], open = [];
    rows.forEach((r, i) => {
        const path = valueText(r.wbs);
        const inside = (h) => path === h.path ? !heading(r) : path.startsWith(h.path + ' / ');
        while (open.length && !inside(open.at(-1))) open.pop();
        out.push({ parent: open.length ? open.at(-1).index : -1, depth: open.length });
        if (heading(r)) open.push({ index: i, path });
    });
    return out;
}
// Every row under heading i (any depth), in source order.
export function descendants(tree, i) {
    const out = [];
    for (let j = i + 1; j < tree.length; j++) {
        let p = tree[j].parent;
        while (p > i) p = tree[p].parent;
        if (p === i) out.push(j);
    }
    return out;
}

// Display order (row indices). Source order unless a sort is given. Grouped: the outline is kept, and a sort only
// reorders the activities within each heading (headings stay where the schedule put them). Flat: activities only.
export function arrange(rows, tree, { sort = null, valueOf = (r, k) => r.cells?.[k], grouped = true } = {}) {
    const cmp = sort ? (a, b) => compareValues(valueOf(rows[a], sort.key), valueOf(rows[b], sort.key), sort.dir) || a - b : null;
    if (!grouped) {
        const acts = rows.map((_, i) => i).filter(i => !heading(rows[i]));
        return cmp ? acts.sort(cmp) : acts;
    }
    const kids = rows.map(() => []), roots = [], order = [];
    tree.forEach((t, i) => (t.parent < 0 ? roots : kids[t.parent]).push(i));
    const walk = (list) => {
        let slots = list;
        if (cmp) {
            const acts = list.filter(i => !heading(rows[i])).sort(cmp);
            let k = 0;
            slots = list.map(i => heading(rows[i]) ? i : acts[k++]);
        }
        for (const i of slots) { order.push(i); walk(kids[i]); }
    };
    walk(roots);
    return order;
}

// Column filters: Map(key -> Set of allowed value texts, '' for blanks). A row passes when its value is allowed in
// every filtered column (`except` skips one column, for that column's own value list).
export function passes(row, filters, valueOf, except = null) {
    for (const [key, allowed] of filters) if (key !== except && !allowed.has(valueText(valueOf(row, key)))) return false;
    return true;
}
// The values of a column with how many rows have each, in sort order, blank ('') last.
export function distinctValues(rows, key, valueOf) {
    const counts = new Map();
    for (const r of rows) { const v = valueText(valueOf(r, key)); counts.set(v, (counts.get(v) || 0) + 1); }
    return [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => compareValues(a.value, b.value));
}
export const searchValues = (values, query) => {
    const q = valueText(query).toLowerCase();
    return q ? values.filter(v => v.value.toLowerCase().includes(q)) : values;
};

// The rows to show, in display order: activities that `shows(i)` (keywords and column filters), and the headings above
// them. While filtering, a heading with no matching activity under it is left out; collapsed headings hide their rows.
// Each entry: { index, depth, heading, count (matching activities under a heading), total, collapsed }.
export function outlineView(rows, tree, order, { shows = () => true, filtering = false, collapsed = new Set(), flat = false } = {}) {
    const count = rows.map(() => 0), total = rows.map(() => 0), match = rows.map((r, i) => !heading(r) && shows(i));
    rows.forEach((r, i) => {
        if (heading(r)) return;
        for (let p = tree[i].parent; p >= 0; p = tree[p].parent) { total[p]++; if (match[i]) count[p]++; }
    });
    const folded = (i) => { for (let p = tree[i].parent; p >= 0; p = tree[p].parent) if (collapsed.has(p)) return true; return false; };
    const out = [];
    for (const i of order) {
        const h = heading(rows[i]);
        if (h ? flat || (filtering && !count[i]) : !match[i]) continue;
        if (!flat && folded(i)) continue;
        out.push({ index: i, depth: flat ? 0 : tree[i].depth, heading: h, count: count[i], total: total[i], collapsed: collapsed.has(i) });
    }
    return out;
}
