import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULTS,DT,simulate,inWindow,profiles} from '../donaghcloney_energy_lab/app/dist/model.mjs';
const close=(a,b,epsilon=1e-7)=>assert.ok(Math.abs(a-b)<epsilon,`${a} != ${b}`);
const empty={...DEFAULTS,capacity:0,base:0,evening:0,appliance:0,solar:0,heat:0,dhw:0,immersion:0,ev:0,standing:0};
test('zero energy means zero imports, cost and losses',()=>{
 const r=simulate(empty);for(const k of ['cost','load','solar','imported','exported','loss','start','end'])close(r[k],0);
});
test('24 kWh constant load: 7 night hours and 17 day hours, VAT-inclusive rates and one standing charge',()=>{
 const r=simulate({...empty,base:1,nightRate:10,dayRate:30,standing:20});
 close(r.nightImport,7);close(r.dayImport,17);close(r.imported,24);close(r.cost,6);
});
test('overnight window includes start, excludes end; equal endpoints mean all day',()=>{
 assert.ok(inWindow(23,22,2));assert.ok(inWindow(0,22,2));assert.ok(inWindow(22,22,2));assert.ok(!inWindow(2,22,2));assert.ok(inWindow(7,2,2));
 const r=simulate({...empty,base:1,nightStart:22,nightEnd:2});close(r.nightImport,4);close(r.dayImport,20);
});
const battery={...empty,base:1,capacity:8,efficiency:100,chargePower:1,dischargePower:1,chargeStart:0,chargeEnd:8,dischargeStart:8,dischargeEnd:0,nightStart:0,nightEnd:8,nightRate:10,dayRate:30};
test('perfect battery shifts exactly 8 kWh from day to night, with no free initial charge',()=>{
 const r=simulate(battery);close(r.nightImport,16);close(r.dayImport,8);close(r.cost,4);close(r.start,0);close(r.end,0);close(r.loss,0);
});
test('reserve reduces accessible energy',()=>{
 const r=simulate({...battery,reserve:25});close(r.start,2);close(r.end,2);close(r.nightImport,14);close(r.dayImport,10);close(r.cost,4.4);
});
test('81% round trip uses two 90% legs, accounting independently for every loss',()=>{
 const r=simulate({...battery,capacity:4,efficiency:81});
 close(r.charge,4/.9);close(r.discharge,4*.9);close(r.loss,4/.9-3.6);
 close(r.nightImport,8+4/.9);close(r.dayImport,16-3.6);close(r.cost,(8+4/.9)*.1+(16-3.6)*.3);
 close(r.imported,24+r.loss);
});
test('charging power and window limit capacity; unmet target warning',()=>{
 const r=simulate({...battery,capacity:20,chargeEnd:2,dischargeStart:2,nightEnd:2});
 close(r.charge,2);close(r.discharge,2);close(r.nightImport,4);close(r.dayImport,20);assert.ok(r.warnings.some(x=>x.includes('target')));
});
test('discharging power limit leaves grid demand supplied',()=>{
 const r=simulate({...battery,dischargePower:.1});close(r.discharge,1.6);close(r.dayImport,14.4);close(r.charge,1.6);
});
test('pure export earns only configured export credit; standing is charged once',()=>{
 const r=simulate({...empty,solar:10,exportRate:5,standing:20});close(r.solar,10);close(r.exported,10);close(r.imported,0);close(r.cost,-.3);
});
test('solar charges storage despite grid charge target zero; no simultaneous export and import',()=>{
 const r=simulate({...empty,solar:10,base:.3,capacity:5,target:0});assert.ok(r.solarCharge>0);close(r.gridCharge,0);assert.ok(r.rows.every(x=>!(x.imported>1e-8&&x.exported>1e-8)));
});
test('thermal heat / COP and direct hot-water/immersion electricity stay distinct',()=>{
 const r=simulate({...empty,heat:100,soakShare:60,soakCop:3,dayCop:4,dhw:2.8,immersion:1.9});close(r.heat,30);close(r.load,34.7);close(r.imported,34.7);
});
test('default household excludes ASHP and EV; heating-off window represented',()=>{
 const r=simulate(DEFAULTS);close(r.house,.6*24+.5*6+2.5);close(r.heat,80*.55/3+80*.45/3.8);close(r.load,r.house+r.heat+2.8+1.9);
 assert.ok(r.rows.filter(x=>x.t>=22.5).every(x=>x.heat===0));
});
test('short EV window limits delivered energy and flags comparison issue',()=>{
 const r=simulate({...empty,ev:21,evPower:7,evStart:0,evEnd:4,nightStart:2,nightEnd:4});close(r.ev,14);close(r.evUnmet,7);assert.ok(r.rows.every(x=>!x.ev||x.night));assert.ok(r.warnings.some(x=>x.includes('EV')));
});
test('no cheap/EV overlap delivers zero EV energy and flags all unmet demand',()=>{
 const r=simulate({...empty,ev:20,evStart:12,evEnd:14});close(r.ev,0);close(r.evUnmet,20);
});
test('PV AC ceiling and daylight constrain generation without fabricated energy',()=>{
 const p={...empty,solar:30,sunrise:10,sunset:12,pvPeak:2};const r=simulate(p);close(r.solar,4);assert.ok(r.warnings.some(x=>x.includes('solar')));assert.ok(r.rows.every(x=>x.solar/DT<=2+1e-7));
});
test('invalid daylight interval warns and produces no solar',()=>{
 const r=simulate({...empty,solar:10,sunrise:18,sunset:8});close(r.solar,0);assert.ok(r.warnings.length>0);
});
test('overlapping overnight heating windows retain thermal energy and trigger capacity warnings',()=>{
 const r=simulate({...empty,heat:150,soakStart:22,soakEnd:2,soakShare:100,soakCop:3});close(r.heat,50);close(r.peakThermal,37.5);assert.ok(r.warnings.some(x=>x.includes('thermal')));
});
test('charging overlap wins over discharge, even with an all-day discharge window',()=>{
 const r=simulate({...battery,dischargeStart:0,dischargeEnd:0});assert.ok(r.rows.filter(x=>inWindow(x.t,0,8)).every(x=>x.discharge===0));
});
test('at a repeating state more capacity need not save more, with default load',()=>{
 const a=simulate(DEFAULTS),b=simulate({...DEFAULTS,capacity:30});close(a.cost,b.cost);close(a.dayImport,0);close(a.start,a.end);close(b.start,b.end);
});
test('representative randomized scenarios conserve energy and obey bounds',()=>{
 let seed=9142;const rng=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/2**32;};const hour=()=>Math.floor(rng()*96)/4;
 for(let k=0;k<350;k++){
  const p={...DEFAULTS,capacity:rng()*60,chargePower:rng()*10,dischargePower:rng()*10,efficiency:50+rng()*50,reserve:rng()*50,target:50+rng()*50,base:rng()*2,evening:rng(),solar:rng()*40,heat:rng()*250,soakShare:rng()*100,soakCop:1+rng()*5,dayCop:1+rng()*5,chargeStart:hour(),chargeEnd:hour(),dischargeStart:hour(),dischargeEnd:hour(),nightStart:hour(),nightEnd:hour(),soakStart:hour(),soakEnd:hour(),heatStart:hour(),heatEnd:hour(),ev:rng()*60,evStart:hour(),evEnd:hour()};
  const r=simulate(p),floor=p.capacity*p.reserve/100;
  assert.ok(r.balanceError<1e-7);assert.ok(r.cycleError<1e-7);close(r.imported+r.solar,r.load+r.exported+r.loss,1e-6);
  close(r.cost,r.nightImport*p.nightRate/100+r.dayImport*p.dayRate/100+p.standing/100-r.exported*p.exportRate/100);
  for(const x of r.rows){
   assert.ok(x.soc>=floor-1e-7&&x.soc<=p.capacity+1e-7);
   assert.ok(x.imported>=-1e-8&&x.exported>=-1e-8);
   assert.ok(x.gridCharge+x.solarCharge<=p.chargePower*DT+1e-7);
   assert.ok(x.discharge<=p.dischargePower*DT+1e-7);
   assert.ok(!(x.discharge>1e-8&&x.gridCharge+x.solarCharge>1e-8));
   assert.ok(!(x.imported>1e-8&&x.exported>1e-8));
   assert.ok(!x.ev||x.night);
  }
 }
});