export const DT = 0.25;
export const DEFAULTS = Object.freeze({
  capacity:20, chargePower:5, dischargePower:5, efficiency:90, reserve:0, target:100,
  chargeStart:1, chargeEnd:8, dischargeStart:8, dischargeEnd:1,
  base:0.6, evening:0.5, appliance:2.5, applianceStart:3, applianceEnd:6,
  solar:8, sunrise:8, sunset:18, pvPeak:5.8,
  heat:80, soakShare:55, soakStart:5, soakEnd:9, heatStart:9, heatEnd:22.5,
  soakCop:3, dayCop:3.8, dhw:2.8, dhwStart:1, dhwEnd:3, immersion:1.9, immersionStart:5.75,
  ev:0, evPower:7, evStart:1, evEnd:8,
  nightRate:15.56, dayRate:32.04, standing:13.33, exportRate:0, nightStart:1, nightEnd:8, clock:'GMT'
});
export function inWindow(t,start,end){
  // Equal endpoints explicitly represent a full 24 hours. End is exclusive.
  if(start===end) return true;
  return start<end ? t>=start && t<end : t>=start || t<end;
}
export function timeLabel(t){
  const m=Math.round(t*60);return `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
}
const sum=a=>a.reduce((x,y)=>x+y,0);
function distribute(total,weights){
  const s=sum(weights);return weights.map(w=>s>0?total*w/s:0);
}
export function profiles(p){
  const times=Array.from({length:96},(_,i)=>i*DT);
  const w=(a,b)=>times.map(t=>inWindow(t,a,b)?1:0);
  const base=times.map(t=>(p.base+(inWindow(t,17,23)?p.evening:0))*DT);
  const appliance=distribute(p.appliance,w(p.applianceStart,p.applianceEnd));
  const soak=distribute(p.heat*p.soakShare/100,w(p.soakStart,p.soakEnd));
  const dayHeat=distribute(p.heat*(1-p.soakShare/100),w(p.heatStart,p.heatEnd));
  const heat=times.map((_,i)=>soak[i]/p.soakCop+dayHeat[i]/p.dayCop);
  const dhw=distribute(p.dhw,w(p.dhwStart,p.dhwEnd));
  // Immersion is spread across one hour; its input is measured electricity, not heat.
  const immersion=distribute(p.immersion,w(p.immersionStart,(p.immersionStart+1)%24));
  const evWeights=w(p.evStart,p.evEnd).map((v,i)=>v && inWindow(times[i],p.nightStart,p.nightEnd)?1:0);
  const evDelivered=Math.min(p.ev,sum(evWeights)*DT*p.evPower);
  const ev=distribute(evDelivered,evWeights);
  const duration=p.sunset-p.sunrise;
  const solarWeights=times.map(t=>{
    const x=(t+DT/2-p.sunrise)/duration;
    return duration>0 && x>0 && x<1 ? Math.pow(Math.sin(Math.PI*x),1.5)*(0.65+0.7*x):0;
  });
  const possible=solarWeights.filter(v=>v>0).length*DT*p.pvPeak;
  const wanted=Math.min(p.solar,possible);
  let lo=0,hi=1;
  const pvTotal=s=>sum(solarWeights.map(v=>Math.min(p.pvPeak*DT,v*s)));
  while(pvTotal(hi)<wanted-1e-10 && hi<1e12) hi*=2;
  for(let i=0;i<65;i++){const mid=(lo+hi)/2;if(pvTotal(mid)<wanted)lo=mid;else hi=mid;}
  const solar=solarWeights.map(v=>Math.min(p.pvPeak*DT,v*(lo+hi)/2));
  return {times,base,appliance,heat,dhw,immersion,ev,solar,evUnmet:p.ev-evDelivered,solarUnmet:p.solar-wanted};
}
function runDay(p,f,start){
  const eta=Math.sqrt(p.efficiency/100), floor=p.capacity*p.reserve/100;
  const target=Math.max(floor,p.capacity*p.target/100);
  let soc=start;
  const rows=f.times.map((t,i)=>{
    const before=soc, load=f.base[i]+f.appliance[i]+f.heat[i]+f.dhw[i]+f.immersion[i]+f.ev[i];
    const solar=f.solar[i], direct=Math.min(solar,load);
    let deficit=load-direct, surplus=solar-direct;
    const solarCharge=Math.max(0,Math.min(surplus,p.chargePower*DT,(p.capacity-soc)/eta));
    soc+=solarCharge*eta;surplus-=solarCharge;
    const chargeWindow=inWindow(t,p.chargeStart,p.chargeEnd);
    let gridCharge=0,discharge=0;
    if(chargeWindow){
      gridCharge=Math.max(0,Math.min(p.chargePower*DT-solarCharge,(target-soc)/eta));
      soc+=gridCharge*eta;
    } else if(inWindow(t,p.dischargeStart,p.dischargeEnd)){
      discharge=Math.max(0,Math.min(deficit,p.dischargePower*DT,(soc-floor)*eta));
      soc-=discharge/eta;deficit-=discharge;
    }
    const imported=deficit+gridCharge, exported=surplus;
    const loss=(solarCharge+gridCharge)*(1-eta)+discharge*(1/eta-1);
    const night=inWindow(t,p.nightStart,p.nightEnd),rate=night?p.nightRate:p.dayRate;
    const cost=imported*rate/100-exported*p.exportRate/100;
    const balance=imported+solar-load-exported-loss-(soc-before);
    return {t,load,solar,base:f.base[i],appliance:f.appliance[i],heat:f.heat[i],dhw:f.dhw[i],immersion:f.immersion[i],ev:f.ev[i],direct,solarCharge,gridCharge,discharge,imported,exported,loss,soc,before,night,rate,cost,balance};
  });
  return {rows,start,end:soc};
}
export function simulate(p){
  const f=profiles(p),floor=p.capacity*p.reserve/100;
  let lo=floor,hi=p.capacity;
  // Solve end SOC = start SOC; each simulated day funds its own charging.
  if(runDay(p,f,lo).end-lo>1e-9){
    for(let i=0;i<60;i++){const m=(lo+hi)/2;const delta=runDay(p,f,m).end-m;if(delta>0)lo=m;else hi=m;}
  }else hi=lo;
  const r=runDay(p,f,(lo+hi)/2);
  const total=k=>sum(r.rows.map(x=>x[k]));
  const nightImport=sum(r.rows.filter(x=>x.night).map(x=>x.imported));
  const dayImport=total('imported')-nightImport;
  const importCost=nightImport*p.nightRate/100+dayImport*p.dayRate/100;
  const exportCredit=total('exported')*p.exportRate/100;
  const warnings=[];
  if(f.evUnmet>1e-6)warnings.push(`${f.evUnmet.toFixed(2)} kWh of requested EV charging does not fit in the overlap of the EV and cheap-rate windows. Costs include delivered EV energy only.`);
  if(f.solarUnmet>1e-6)warnings.push(`${f.solarUnmet.toFixed(2)} kWh of requested solar cannot fit within the daylight window and AC power ceiling. The chart uses achievable generation.`);
  if(p.sunset<=p.sunrise)warnings.push('Sunset must be after sunrise; solar generation is zero until corrected.');
  if(p.target<p.reserve)warnings.push('Grid charge target is below reserve; the reserve is used as the minimum target.');
  const cheapOverlap=r.rows.filter(x=>x.gridCharge>1e-8 && !x.night);
  if(cheapOverlap.length)warnings.push('Part of battery grid charging occurs at the day rate with these timings.');
  // Exact thermal demand profile, including overlapping and overnight windows.
  const soakThermal=distribute(p.heat*p.soakShare/100,f.times.map(t=>inWindow(t,p.soakStart,p.soakEnd)?1:0));
  const dayThermal=distribute(p.heat*(1-p.soakShare/100),f.times.map(t=>inWindow(t,p.heatStart,p.heatEnd)?1:0));
  const peakThermal=Math.max(...soakThermal.map((v,i)=>(v+dayThermal[i])/DT));
  if(peakThermal>15+1e-8)warnings.push(`Space-heating profile requests ${peakThermal.toFixed(1)} kW thermal, above the approximate 15 kW Zeno maximum. Increase heating hours or reduce demand; this is an unconstrained demand estimate.`);
  const peak=Math.max(...r.rows.map(x=>x.imported/DT));
  const chargeEndRows=r.rows.filter((x,i)=>inWindow(x.t,p.chargeStart,p.chargeEnd)&&!inWindow((x.t+DT)%24,p.chargeStart,p.chargeEnd));
  if(p.capacity>0&&chargeEndRows.some(x=>x.soc<Math.max(floor,p.capacity*p.target/100)-0.05))warnings.push('Battery does not reach its grid-charge target by the end of the charging window.');
  return {...r,warnings,evUnmet:f.evUnmet,peakThermal,load:total('load'),solar:total('solar'),imported:total('imported'),exported:total('exported'),nightImport,dayImport,importCost,exportCredit,cost:importCost-exportCredit+p.standing/100,standing:p.standing/100,loss:total('loss'),charge:total('gridCharge')+total('solarCharge'),gridCharge:total('gridCharge'),solarCharge:total('solarCharge'),discharge:total('discharge'),heat:total('heat'),dhw:total('dhw'),immersion:total('immersion'),ev:total('ev'),house:total('base')+total('appliance'),peak,cycleError:Math.abs(r.end-r.start),balanceError:Math.max(...r.rows.map(x=>Math.abs(x.balance)))};
}
