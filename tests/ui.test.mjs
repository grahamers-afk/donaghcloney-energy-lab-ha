// Minimal DOM contract checks. This exercises real event handlers, not visual browser QA.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const elements=new Map(),downloads=[];
class Element{
 constructor(tag='div',attrs=''){
  this.tagName=tag.toUpperCase();this.attrs={};this.dataset={};this.handlers={};this.children=[];this.style={setProperty(){}};
  this.hidden=/\bhidden(?:\s|$)/.test(attrs);this.disabled=/\bdisabled(?:\s|$)/.test(attrs);this.value='';this.textContent='';this._html='';
  this.classList={values:new Set(),add(...x){x.forEach(v=>this.values.add(v));},remove(...x){x.forEach(v=>this.values.delete(v));},toggle(v,on){if(on??!this.values.has(v))this.values.add(v);else this.values.delete(v);},contains(v){return this.values.has(v);}};
  for(const a of attrs.matchAll(/([\w-]+)(?:="([^"]*)")?/g)){
   const k=a[1],v=a[2]??'';this.attrs[k]=v;
   if(k.startsWith('data-'))this.dataset[k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=v;
   if(['id','value','min','max','step','type'].includes(k))this[k]=v;
  }
  if(this.id)elements.set(this.id,this);
 }
 set innerHTML(v){this._html=v;this.children=[];for(const m of v.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g))this.children.push(new Element(m[1],m[2]));}
 get innerHTML(){return this._html;}
 addEventListener(type,fn){(this.handlers[type]??=[]).push(fn);}
 fire(type,target=this,rest={}){for(const fn of this.handlers[type]||[])fn({target,preventDefault(){},...rest});}
 setAttribute(k,v){this.attrs[k]=String(v);}
 getAttribute(k){return this.attrs[k];}
 querySelectorAll(sel){return this.children.filter(e=>e.tagName.toLowerCase()===sel);}
 closest(sel){const key=sel.match(/^\[data-(.+)\]$/)?.[1];return key&&key in this.dataset?this:sel==='button'&&this.tagName==='BUTTON'?this:null;}
 focus(){}
 showModal(){this.open=true;}
 close(){this.open=false;}
 getBoundingClientRect(){return {left:0,right:810,top:0,bottom:260,width:810};}
 checkValidity(){
  if(!this.value)return true;
  if(this.type==='time')return /^\d\d:(00|15|30|45)$/.test(this.value);
  const v=Number(this.value);if(!Number.isFinite(v))return false;
  if(this.min!==undefined&&v<Number(this.min)||this.max!==undefined&&v>Number(this.max))return false;
  const step=Number(this.step);return !step||Math.abs((v-Number(this.min||0))/step-Math.round((v-Number(this.min||0))/step))<1e-7;
 }
 click(){if(this.tagName==='A')downloads.push(this);else this.fire('click');}
}
const html=fs.readFileSync(new URL('../donaghcloney_energy_lab/app/dist/index.html',import.meta.url),'utf8');
new Element('body').innerHTML=html;
const storage=new Map();
globalThis.document={getElementById:id=>elements.get(id)||null,createElement:tag=>new Element(tag)};
globalThis.localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)};
globalThis.window={};
const replayCalls=[];
const hour={day:'2000-01-01',hr:0,z:'2000-01-01T00:00:00Z',rooms:[20,20,20,20]};
const bundle={historicHours:[hour],recentHours:[],fiveMinute:[],fit:{params:Array.from({length:4},()=>Array(7).fill(0))}};
globalThis.fetch=async (path,options)=>{
 replayCalls.push({path,options});
 return options?{ok:true,json:async()=>bundle}:{status:404};
};
await import('../donaghcloney_energy_lab/app/dist/app.mjs');
const $=id=>elements.get(id);
const fire=(id,event,target,rest)=>$(id).fire(event,target,rest);
const button=(key,val)=>new Element('button',`data-${key}="${val}"`);
const state=()=>JSON.parse(storage.get('donaghcloney-energy-lab-v1'));
test('application boots, persists defaults, renders all scenarios and complete interval data',()=>{
 assert.equal($('costValue').textContent,'£6.79');
 assert.equal(state().scenarios.length,4);
 assert.equal(($('intervalRows').innerHTML.match(/<tr>/g)||[]).length,96);
 assert.ok($('chart').innerHTML.includes('<svg'));
 assert.ok($('comparisonRows').innerHTML.includes('£9.58'));
});
test('range input recalculates results and persisted parameters',()=>{
 const el=$('r-capacity');el.value='0';fire('controlFields','input',el);
 assert.equal($('costValue').textContent,'£9.58');assert.equal(state().scenarios[0].p.capacity,0);
});
test('category tabs and number inputs change household demand',()=>{
 fire('controlTabs','click',button('tab','home'));
 const el=$('n-base');el.value='1.25';fire('controlFields','input',el);
 assert.equal(state().scenarios[0].p.base,1.25);assert.notEqual($('costValue').textContent,'£9.58');
 el.value='-1';fire('controlFields','input',el);assert.equal(state().scenarios[0].p.base,1.25);
 fire('controlFields','focusout',el);assert.equal(Number(el.value),1.25);
});
test('scenario duplication creates an independent editable copy and reference can change',()=>{
 fire('addScenario','click');assert.equal(state().scenarios.length,5);
 const el=$('n-base');el.value='.5';fire('controlFields','input',el);
 assert.equal(state().scenarios[0].p.base,1.25);assert.equal(state().scenarios[4].p.base,.5);
 fire('setReference','click');assert.equal(state().referenceIndex,4);assert.equal($('costDelta').textContent,'Your comparison reference');
});
test('GMT selection aligns tariff, battery, EV and DHW, leaving heating local times',()=>{
 fire('controlTabs','click',button('tab','tariff'));
 const el=$('clockSelect');el.value='GMT';fire('controlFields','change',el);
 const p=state().scenarios[4].p;
 assert.equal(p.clock,'GMT');assert.equal(p.nightStart,1);assert.equal(p.nightEnd,8);assert.equal(p.chargeStart,1);assert.equal(p.chargeEnd,8);assert.equal(p.evStart,1);assert.equal(p.dhwStart,1);assert.equal(p.soakStart,5);
 assert.ok($('cheapCaption').textContent.includes('01:00–08:00 GMT'));
});
test('time control accepts quarter-hour input and stores it as decimal hours',()=>{
 const el=$('t-nightStart');el.value='01:15';fire('controlFields','input',el);assert.equal(state().scenarios[4].p.nightStart,1.25);
});
test('battery chart, keyboard inspection, assumption and validation dialogs work',()=>{
 fire('chartModes','click',button('mode','battery'));assert.ok($('chartLegend').innerHTML.includes('Stored energy'));
 fire('chart','keydown',undefined,{key:'End'});assert.ok($('chartReadout').innerHTML.includes('23:45'));
 fire('assumptionsButton','click');assert.ok($('infoDialog').open);assert.ok($('dialogContent').innerHTML.includes('90% round-trip'));
 fire('closeDialog','click');assert.ok(!$('infoDialog').open);
 fire('validationButton','click');assert.ok($('dialogContent').innerHTML.includes('✓ Pass'));assert.ok(!$('dialogContent').innerHTML.includes('>Failed<'));
});
test('CSV export creates a download; deleting selected reference keeps valid reference',()=>{
 fire('exportCsv','click');assert.equal(downloads.length,1);assert.equal(downloads[0].download,'donaghcloney-energy-scenarios.csv');
 fire('deleteScenario','click');assert.equal(state().scenarios.length,4);assert.equal(state().referenceIndex,0);
});
test('HTML uses local assets, correct module paths, no remote telemetry or duplicate IDs',()=>{
 const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);assert.equal(ids.length,new Set(ids).size);
 for(const m of html.matchAll(/(?:src|href)="(\.\/[^\"]+)"/g)){if(m[1]==='./')continue;assert.ok(fs.existsSync(new URL(m[1],new URL('../donaghcloney_energy_lab/app/dist/',import.meta.url))));}
 const js=fs.readFileSync(new URL('../donaghcloney_energy_lab/app/dist/app.mjs',import.meta.url),'utf8');assert.deepEqual([...js.matchAll(/\bfetch\(([^,)]+)/g)].map(match=>match[1]),["'api/replay'","'api/replay'"]);assert.doesNotMatch(js,/XMLHttpRequest|sendBeacon|WebSocket/);
});

test('simulator starts before replay and accepts a private bundle through the import form',async()=>{
 assert.match($('replayStatus').textContent,/simulator is ready/);
 assert.equal($('replayViews').hidden,true);
 const file={name:'replay-bundle.json'};
 $('replayFile').files=[file];
 fire('replayImport','submit',$('replayImport'));
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal($('replayViews').hidden,false);
 assert.equal($('replayDay').value,'2000-01-01');
 assert.match($('replayContent').innerHTML,/Measured ASHP electricity/);
 assert.equal(replayCalls[1].path,'api/replay');
 assert.equal(replayCalls[1].options.body,file);
 assert.equal(replayCalls[1].options.headers['X-Energy-Lab-Import'],'1');
});
