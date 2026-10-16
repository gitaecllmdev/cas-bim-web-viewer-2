import {addDays,dayMs,STAGE_NAMES,makeCalendar,scheduleFromRows} from './p6.mjs';
export const DEMO_DATE='2026-10-12';
export const DEMO_VERSION=2; // 2: activity-named stages with another trade's rough-in (saved older demo copies are replaced)
// Synthetic hotel plan uses exact model level names; no client schedule or invented wall links.
export function hotelDemoSchedule(levels){
    const rank=name=>/ground/i.test(name)?0:/roof/i.test(name)?1000:Number(/\d+/.exec(name)?.[0]||999);
    const ordered=[...new Set(levels.filter(Boolean))].sort((a,b)=>rank(a)-rank(b)||a.localeCompare(b,undefined,{numeric:true}));
    if(!ordered.length)throw Error('No model levels are available for the demonstration schedule.');
    // Per floor, a GC-style sequence: our layout, framing and board, with another trade's in-wall rough-in between.
    // No Install Stage code: the schedule viewer names the stages from the activities themselves.
    const work=[['L','Layout & top track',3],['F','Frame walls',7],['M','In-wall MEP rough-in',5],['B','Hang drywall',6]];
    const cal=makeCalendar(),rows=[['Activity ID','Activity Name','Start','Finish','Activity % Complete','Location','WBS','Original Duration','Predecessors','Total Float','Activity Status']];
    for(const [i,level] of ordered.entries()){
        let start=cal.add(addDays(DEMO_DATE,-45+i*6),0),previous='';
        for(const [code,name,duration] of work){
            const id=`WH${String(i+1).padStart(2,'0')}${code}`,finish=cal.add(start,duration-1);
            const pct=finish<DEMO_DATE?100:start>DEMO_DATE?0:Math.min(90,Math.max(10,Math.round((dayMs(DEMO_DATE)-dayMs(start))/(dayMs(finish)-dayMs(start)+86400000)*100)));
            rows.push([id,`${name} · ${level}`,start,finish,String(pct),level,level,String(duration),previous,String(i%3===0?0:5),pct===100?'Complete':pct>0?'In progress':'Not started']);
            previous=id;start=cal.add(finish,1);
        }
    }
    const schedule=scheduleFromRows(rows,{file:'wilton-hotel-demo.csv',dataDate:DEMO_DATE,importedAt:DEMO_DATE+'T12:00:00.000Z'});
    schedule.project.id='WILTON-DEMO';schedule.project.name='Wilton Hotel';schedule.source.sample=true;schedule.source.demoVersion=DEMO_VERSION;
    return schedule;
}
export function demoStages(walls,levels){
    const grouped=new Map();for(const w of walls)if(w.externalId){const level=w.level||'Not set';if(!grouped.has(level))grouped.set(level,[]);grouped.get(level).push(w);}
    const order=[...levels.filter(l=>grouped.has(l)),...[...grouped.keys()].filter(l=>!levels.includes(l)).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}))];
    const out={};order.forEach((level,i)=>{const group=grouped.get(level).sort((a,b)=>a.externalId.localeCompare(b.externalId)),fraction=i/Math.max(1,order.length);
        group.forEach((w,j)=>{const part=j/group.length;const k=fraction<.25?(part<.8?4:3):fraction<.5?(part<.45?3:part<.9?2:1):fraction<.75?(part<.3?2:part<.85?1:0):(part<.2?1:0);if(k)out[w.externalId]=STAGE_NAMES[k];});});return out;
}
export function demoStagesFromSchedule(walls,activities,knownLevels){
    const ordered=[...new Set(activities.map(a=>a.codes?.Location).filter(Boolean))];
    return demoStages(walls,[...ordered,...knownLevels.filter(l=>!ordered.includes(l)).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}))]);
}
// The work an activity covers in the model: wall count, total length, and per wall type (longest first). Length is the
// model's own Length property (missing lengths are counted as walls without a length, never guessed).
export function activityQuantities(walls){
    const types=new Map();let length=0,measured=0,units='';
    for(const w of walls){
        const type=String(w.wallType||'No wall type'),n=Number(w.length),has=Number.isFinite(n)&&n>0;
        const t=types.get(type)||types.set(type,{type,count:0,length:0}).get(type);t.count++;
        if(has){t.length+=n;length+=n;measured++;units||=String(w.lengthUnits||'');}
    }
    const round=n=>Math.round(n*10)/10;
    return{count:walls.length,length:round(length),measured,units:/^ft|feet/i.test(units)?'ft':/^m$|meter/i.test(units)?'m':units,
        types:[...types.values()].map(t=>({...t,length:round(t.length)})).sort((a,b)=>b.length-a.length||b.count-a.count||a.type.localeCompare(b.type))};
}
// all: every activity in those weeks (the schedule viewer), not only open ones (the tracker).
export function lookaheadWeeks(activities,from,{all=false}={}){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(from||'')||!Number.isFinite(dayMs(from))||new Date(dayMs(from)).toISOString().slice(0,10)!==from)throw Error('Choose a lookahead start date.');
    const open=all?activities:activities.filter(a=>(a.pct??0)<100),scheduled=open.filter(a=>a.start&&a.finish&&a.start<=a.finish),weeks=[];
    for(let i=0;i<3;i++){const start=addDays(from,i*7),finish=addDays(start,6);weeks.push({start,finish,activities:scheduled.filter(a=>a.start<=finish&&a.finish>=start).sort((a,b)=>a.start.localeCompare(b.start)||a.id.localeCompare(b.id))});}
    return{weeks,unscheduled:open.length-scheduled.length,unique:new Set(weeks.flatMap(w=>w.activities.map(a=>a.id))).size};
}
