export const HEATING_LIMITS = Object.freeze({
  tariffNightStart: 1,
  tariffNightEnd: 8,
  currentNightP: 15.56,
  currentDayP: 32.04,
  standingP: 13.33,
  auditNightP: 17.19,
  auditDayP: 36.49,
  libbiCapacityKwh: 20.4,
  libbiPowerKw: 5,
  batteryRoundTrip: 0.9,
  zendureCapacityKwh: 8.16,
  zendurePowerKw: 0.8,
  emitterCoefficient: 0.108,
  minThermalKwMedian: 5.53,
  minThermalKwP10: 4.90,
  ashpMaxThermalKw: 15,
  dtHours: 0.25
});

const FIVE_KEYS = [
  't','source','freq','freqMin','freqMax','power','powerMin','powerMax','netHeat',
  'heatOutput','dhw','dhwMin','dhwMax','outlet','outletMin','outletMax','inlet',
  'flow','flowMin','flowMax','ambient','room','roomMin','roomMax','target'
];
const cv=(x)=>Number.isFinite(Number(x))?Number(x):null;
export let historicHours = [], recentHours = [], allHours = [], fiveMinute = [];
let MODEL = [];

export function useReplay(bundle){
  historicHours = [...bundle.historicHours].sort((a,b)=>Date.parse(a.z)-Date.parse(b.z));
  recentHours = bundle.recentHours;
  allHours = [...historicHours,...recentHours].sort((a,b)=>Date.parse(a.z)-Date.parse(b.z));
  fiveMinute = bundle.fiveMinute.map(asPoint);
  MODEL = bundle.fit.params;
}

export function replayTargetDays(){
  const days = new Set(fiveMinute.filter(p=>p.source==='ha-history').map(p=>p.t.slice(0,10)));
  return allReplayDays().filter(day=>days.has(day));
}

const clamp=(n,lo,hi)=>Math.max(lo,Math.min(hi,n));
const mean=a=>a.length?a.reduce((s,v)=>s+v,0)/a.length:null;
const rms=a=>a.length?Math.sqrt(a.reduce((s,v)=>s+v*v,0)/a.length):null;
const averageRoom=rooms=>mean(rooms.filter(Number.isFinite));
const hourOf=t=>Number(t.slice(11,13));
const toMinutes=(a,b)=>(Date.parse(b)-Date.parse(a))/60000;

export function allReplayDays(){
  return [...new Set(allHours.map(r=>r.day))].sort();
}

export function dailyMeasurements(day, limitHours=24){
  const rows=allHours.filter(r=>r.day===day&&r.hr<limitHours);
  const complete=new Set(rows.map(r=>r.hr)).size===limitHours;
  const first=rows.find(r=>r.hr===0)||rows[0];
  return {
    day, rows, complete, hours:rows.length,
    startRooms:first?.rooms||[],
    meanOutdoor:mean(rows.map(r=>r.outdoor).filter(Number.isFinite)),
    meanWind:mean(rows.map(r=>r.wind).filter(Number.isFinite)),
    meanWindMax:mean(rows.map(r=>r.windMax).filter(Number.isFinite)),
    meanIrradiance:mean(rows.map(r=>r.irradiance).filter(Number.isFinite)),
    electricKwh:rows.reduce((s,r)=>s+(r.electricKwh||0),0),
    thermalKwh:rows.reduce((s,r)=>s+(r.thermalKwh||0),0),
    spaceThermalKwh:rows.reduce((s,r)=>s+(r.spaceThermalKwh??r.thermalKwh??0),0),
    spaceElectricKwh:rows.reduce((s,r)=>s+(r.spaceElectricKwh??r.electricKwh??0),0),
    houseKwh:rows.reduce((s,r)=>s+(r.houseKwh||0),0),
    solarKwh:rows.reduce((s,r)=>s+(r.solarKwh||0),0),
    gridKwh:rows.reduce((s,r)=>s+Math.max(0,r.gridKwh??((r.libbiGridW||0)/1000)),0),
    gridNightKwh:rows.reduce((s,r)=>s+((r.hr>=1&&r.hr<8)?Math.max(0,r.gridKwh??((r.libbiGridW||0)/1000)):0),0),
    sunroomMin:Math.min(...rows.map(r=>r.rooms?.[0]).filter(Number.isFinite)),
    sunroomMax:Math.max(...rows.map(r=>r.rooms?.[0]).filter(Number.isFinite)),
    socStart:first?.libbiSoc??null,
    socEnd:rows.at(-1)?.libbiSoc??null,
    libbiChargeKwh:rows.reduce((s,r)=>s+(r.libbiChargeKwh||0),0),
    libbiDischargeKwh:rows.every(r=>Number.isFinite(r.libbiDischargeKwh))&&rows.length
      ?rows.reduce((sum,row)=>sum+row.libbiDischargeKwh,0):null,
    // Recent HA history exposes grid power at the Libbi, not a validated whole-home import meter.
    measuredGridCost:rows.reduce((s,r)=>s+Math.max(0,r.gridKwh??((r.libbiGridW||0)/1000))*((r.hr>=1&&r.hr<8)?HEATING_LIMITS.auditNightP:HEATING_LIMITS.auditDayP)/100,0),
    libbiDepletionKwh:((first?.libbiSoc??0)-(rows.at(-1)?.libbiSoc??0))*HEATING_LIMITS.libbiCapacityKwh/100
  };
}

function dayFeatureVector(d){
  const rooms=Array.from({length:4},(_,i)=>d.startRooms[i]);
  return [d.meanOutdoor,d.meanWind,d.meanWindMax,d.meanIrradiance,...rooms];
}
function normalizedDistance(a,b){
  const scales=[2.5,4,6,0.15,1.5,1.5,1.5,1.5];
  const x=dayFeatureVector(a),y=dayFeatureVector(b);
  let sum=0,n=0;
  for(let i=0;i<x.length;i++)if(Number.isFinite(x[i])&&Number.isFinite(y[i])){sum+=((x[i]-y[i])/scales[i])**2;n++;}
  return n?Math.sqrt(sum/n):Infinity;
}
export function weatherMatchedDays(day, limit=5, hours=Math.min(24,allHours.filter(r=>r.day===day).length || 24)){
  const target=dailyMeasurements(day,hours);
  const candidates=allReplayDays().filter(other=>other!==day).map(other=>{
    const d=dailyMeasurements(other,hours);
    return {...d,distance:target.complete&&d.complete?normalizedDistance(target,d):Infinity};
  }).filter(d=>Number.isFinite(d.distance)).sort((a,b)=>a.distance-b.distance).slice(0,limit);
  return {target,matches:candidates};
}

function asPoint(row){
  if(!Array.isArray(row))return row;
  return Object.fromEntries(FIVE_KEYS.map((k,i)=>[k,row[i]??null]));
}
function defrostEvidence(prev, off, next){
  if(!off.length)return {score:0,evidence:[],dropC:null,powerW:null,heatKw:null,flow:null};
  const outlet0=prev?.outlet, outlet1=next?.outlet;
  const dropC=Number.isFinite(outlet0)&&Number.isFinite(outlet1)?outlet0-outlet1:null;
  const powerW=mean(off.map(r=>r.power).filter(Number.isFinite));
  const heatKw=mean(off.map(r=>r.netHeat??r.heatOutput).filter(Number.isFinite));
  const flow=mean(off.map(r=>r.flow).filter(Number.isFinite));
  const dhw0=prev?.dhw,dhw1=next?.dhw;
  const dhwRise=Number.isFinite(dhw0)&&Number.isFinite(dhw1)?dhw1-dhw0:0;
  let score=0;const evidence=[];
  if(Number.isFinite(powerW)&&powerW>=500){score+=0.2;evidence.push(`electrical draw continued during frequency dip (${powerW.toFixed(0)} W mean)`);}
  if(Number.isFinite(dropC)&&dropC>=3){score+=dropC>=6?0.38:0.27;evidence.push(`outlet water fell ${dropC.toFixed(1)}°C across the event`);}
  if(Number.isFinite(heatKw)&&heatKw<=0.6){score+=0.18;evidence.push(`net heat output was low (${heatKw.toFixed(2)} kW)`);}
  if(Number.isFinite(flow)&&flow>=0.7){score+=0.12;evidence.push(`water flow continued (${flow.toFixed(2)} m³/h)`);}
  if(dhwRise>1.2){score-=0.22;evidence.push('DHW temperature rose, so hot-water operation is an alternative explanation');}
  return {score:clamp(score,0,0.9),evidence,dropC,powerW,heatKw,flow};
}

export function classifyCompressorEvents(input=fiveMinute){
  const rows=input.map(asPoint).filter(r=>r?.t).sort((a,b)=>Date.parse(a.t)-Date.parse(b.t));
  const runs=[],events=[];let block=[];
  const flush=()=>{
    if(!block.length)return;
    let i=0;
    while(i<block.length){
      const f=block[i].freq;
      if(!Number.isFinite(f)||f<5){i++;continue;}
      let j=i;
      while(j+1<block.length&&Number.isFinite(block[j+1].freq)&&block[j+1].freq>=5)j++;
      runs.push({rows:block,startIndex:i,endIndex:j,start:block[i].t,end:block[j].t,minutes:(j-i+1)*5,
        frequencies:block.slice(i,j+1).map(x=>x.freq).filter(Number.isFinite)});
      i=j+1;
    }
    block=[];
  };
  for(const row of rows){
    if(block.length&&toMinutes(block.at(-1).t,row.t)>7)flush();
    block.push(row);
  }
  flush();
  for(let ix=0;ix<runs.length;ix++){
    const run=runs[ix],blockRows=run.rows;
    const prev=blockRows[run.startIndex-1]||null;
    const nextRun=runs[ix+1]&&runs[ix+1].rows===blockRows?runs[ix+1]:null;
    const offEnd=nextRun?.startIndex??Math.min(blockRows.length-1,run.endIndex+1);
    const off=blockRows.slice(run.endIndex+1,offEnd);
    const next=nextRun?blockRows[nextRun.startIndex]:null;
    const offMinutes=next?Math.max(0,toMinutes(run.end,next.t)-5):null;
    const evidence=defrostEvidence(blockRows[run.endIndex],off,next);
    const shortStartCount=runs.filter(r=>r.rows===blockRows&&r.minutes<=15&&Math.abs(toMinutes(r.start,run.start))<=60).length;
    const defrostCandidate=offMinutes!==null&&offMinutes>=5&&offMinutes<=15&&evidence.score>=0.52;
    const shortCycling=run.minutes<=15&&shortStartCount>=3&&!defrostCandidate;
    const room=blockRows[run.endIndex].room,target=blockRows[run.endIndex].target;
    const comfortGap=Number.isFinite(room)&&Number.isFinite(target)?room-target:null;
    let stopClass='Compressor stop · cause unresolved',stopConfidence=0.32;
    if(shortCycling){stopClass='Genuine short-cycling pattern';stopConfidence=0.72;}
    else if(defrostCandidate){stopClass='Possible defrost';stopConfidence=Math.min(0.82,0.5+evidence.score*0.38);}
    else if(Number.isFinite(comfortGap)&&comfortGap>=-0.2&&(evidence.powerW===null||evidence.powerW<350)&&(evidence.score<0.52)&&offMinutes>=10){
      stopClass='Likely thermostat / demand shutdown';stopConfidence=clamp(0.58+Math.min(0.15,comfortGap*0.04),0.58,0.73);
    }
    const modulationSpan=Math.max(...run.frequencies)-Math.min(...run.frequencies);
    events.push({
      start:run.start,end:run.end,minutes:run.minutes,starts:1,
      label:run.minutes>=10?'Normal compressor modulation':'Brief compressor run',
      confidence:run.minutes>=10?0.85:0.62,
      frequencyMin:Math.min(...run.frequencies),frequencyMax:Math.max(...run.frequencies),modulationSpan,
      stopClass,stopConfidence,offMinutes,roomC:room,targetC:target,comfortGapC:comfortGap,
      defrostScore:evidence.score,defrostEvidence:evidence.evidence,
      missingEvidence:['No outdoor-coil temperature or reversing-valve state','No manufacturer defrost flag/event log','5-minute recorder aggregation can miss short transitions']
    });
  }
  return {events,starts:runs.length,stops:events.filter(e=>e.offMinutes!==null).length,
    possibleDefrost:events.filter(e=>e.stopClass==='Possible defrost'),
    thermostatShutdown:events.filter(e=>e.stopClass==='Likely thermostat / demand shutdown'),
    shortCycling:events.filter(e=>e.stopClass==='Genuine short-cycling pattern'),
    normalModulation:events.filter(e=>e.label==='Normal compressor modulation')};
}

function dot(a,b){return a.reduce((s,v,i)=>s+v*(b[i]||0),0);}
function roomFeatures(rooms,conditions,j){
  const avg=averageRoom(rooms),other=rooms.filter((_,i)=>i!==j),cross=j===0?0.7*rooms[1]+0.3*averageRoom(other):averageRoom(other);
  const outdoor=conditions.outdoor??5,wind=Math.min(conditions.wind??0,16),irradiance=conditions.irradiance??0;
  return [1,-(rooms[j]-outdoor)/10,-wind*(rooms[j]-outdoor)/100,cross-rooms[j],irradiance,(conditions.hour>=10&&conditions.hour<=21)?1:0];
}
export function temperatureStep(rooms,conditions,heatKwh,dt=0.25){
  return rooms.map((value,j)=>value+dot(roomFeatures(rooms,conditions,j),MODEL[j].slice(0,6))*dt+MODEL[j][6]*heatKwh);
}

function fit(samples){
  const X=samples.map(s=>s.x),Y=samples.map(s=>s.y);
  const p=[0,.2,.1,.10,.02,.04,.07],lo=[-.2,.04,0,0,0,-.12,.014],hi=[.35,.8,.8,.65,.35,.25,.24];
  let pred=X.map(x=>dot(x,p));
  for(let epoch=0;epoch<320;epoch++)for(let k=0;k<p.length;k++){
    let num=0,den=0;
    for(let i=0;i<X.length;i++){const error=Y[i]-pred[i],weight=Math.min(1,.27/Math.max(1e-9,Math.abs(error)));num+=weight*X[i][k]*error;den+=weight*X[i][k]**2;}
    const updated=clamp(p[k]+num/(den+1e-9),lo[k],hi[k]),move=updated-p[k];p[k]=updated;
    if(move)for(let i=0;i<X.length;i++)pred[i]+=X[i][k]*move;
  }
  return p;
}
function trainingRows(roomIndex){
  const limits=[1.45,.6,.65,.75];
  return historicHours.slice(0,-1).flatMap((r,i)=>{
    const n=historicHours[i+1];if(Date.parse(n.z)-Date.parse(r.z)!==3600000)return [];
    const y=n.rooms[roomIndex]-r.rooms[roomIndex];if(!Number.isFinite(y)||Math.abs(y)>limits[roomIndex])return [];
    const q=(r.spaceThermalKwh+n.spaceThermalKwh)/2;
    return [{day:r.day,x:[...roomFeatures(r.rooms,{outdoor:(r.outdoor+n.outdoor)/2,wind:(r.wind+n.wind)/2,irradiance:(r.irradiance+n.irradiance)/2,hour:r.hr},roomIndex),q],y}];
  });
}
function seeded(seed){let s=seed>>>0;return ()=>{s=(1664525*s+1013904223)>>>0;return s/4294967296;};}
function bootstrapRmseByDay(residuals,seed=20261122){
  const groups=[...new Set(residuals.map(x=>x.day))].map(day=>residuals.filter(x=>x.day===day).map(x=>x.error));
  if(groups.length<2)return [null,null];
  const rng=seeded(seed),vals=[];
  for(let b=0;b<1200;b++){
    const draw=[];for(let i=0;i<groups.length;i++)draw.push(...groups[Math.floor(rng()*groups.length)]);
    vals.push(rms(draw));
  }
  vals.sort((a,b)=>a-b);return [vals[Math.floor(.025*vals.length)],vals[Math.floor(.975*vals.length)]];
}
export function heldOutTemperatureValidation(){
  const roomNames=['Sunroom','Kitchen','Living room','Hallway'];
  return roomNames.map((name,j)=>{
    const rows=trainingRows(j),weeks=[...new Set(rows.map(r=>Math.floor((Date.parse(r.day)-Date.parse(historicHours[0].day))/604800000)))];
    const residuals=[];
    for(const week of weeks){
      const train=rows.filter(r=>Math.floor((Date.parse(r.day)-Date.parse(historicHours[0].day))/604800000)!==week);
      const p=fit(train);
      for(const r of rows.filter(v=>Math.floor((Date.parse(v.day)-Date.parse(historicHours[0].day))/604800000)===week))residuals.push({day:r.day,error:r.y-dot(r.x,p)});
    }
    const errors=residuals.map(r=>r.error),ci=bootstrapRmseByDay(residuals,20261122+j);
    return {room:name,n:errors.length,mae:mean(errors.map(Math.abs)),rmse:rms(errors),rmseCI:ci};
  });
}

// True temporal hold-out on later HA days. Measured heat output and weather are
// supplied as inputs, so this tests room response conditionally, not control strategy.
export function heldOut15MinuteSunroomValidation(){
  const days=replayTargetDays(),perDay=[];
  for(const day of days){
    const points=fiveMinute.filter(p=>p.source==='ha-history'&&p.t.startsWith(day)&&Number.isFinite(p.room));
    if(points.length<36)continue;
    const startHour=Number(points[0].t.slice(11,13)),daily=allHours.filter(r=>r.day===day);
    const base=daily.find(r=>r.hr===startHour)?.rooms;
    if(!base||!Number.isFinite(base[0]))continue;
    let rooms=[...base];rooms[0]=points[0].room;const residuals=[];
    for(let i=0;i+2<points.length;i+=3){
      const batch=points.slice(i,i+3);
      if(batch.some((p,j)=>j>0&&Date.parse(p.t)-Date.parse(batch[j-1].t)!==300000))continue;
      const t=Date.parse(batch[0].t),date=new Date(t),hour=date.getUTCHours()+date.getUTCMinutes()/60;
      const weather=daily.find(r=>r.hr===Math.floor(hour));
      if(!weather||batch.some(p=>!Number.isFinite(p.heatOutput)))continue;
      const heatKwh=batch.reduce((s,p)=>s+p.heatOutput/12,0);
      rooms=temperatureStep(rooms,{outdoor:weather.outdoor,wind:weather.wind,irradiance:weather.irradiance,hour},heatKwh,0.25);
      const actual=batch[2].room;
      if(Number.isFinite(actual))residuals.push({time:batch[2].t,error:rooms[0]-actual});
    }
    if(residuals.length)perDay.push({day,n:residuals.length,mae:mean(residuals.map(x=>Math.abs(x.error))),rmse:rms(residuals.map(x=>x.error)),bias:mean(residuals.map(x=>x.error)),maxLeadHours:residuals.length*0.25,residuals});
  }
  const errors=perDay.flatMap(d=>d.residuals.map(x=>x.error)),groups=perDay.map(d=>d.residuals.map(x=>x.error)),rng=seeded(2026112201),boot=[];
  if(groups.length>1)for(let b=0;b<1200;b++){const e=[];for(let i=0;i<groups.length;i++)e.push(...groups[Math.floor(rng()*groups.length)]);boot.push(rms(e));}
  boot.sort((a,b)=>a-b);
  return {days:perDay.map(({day,n,mae,rmse,bias,maxLeadHours})=>({day,n,mae,rmse,bias,maxLeadHours})),n:errors.length,mae:mean(errors.map(Math.abs)),rmse:rms(errors),bias:mean(errors),rmseCI:boot.length?[boot[Math.floor(.025*boot.length)],boot[Math.floor(.975*boot.length)]]:null,method:'15-minute steps on later imported days; measured 5-minute heat output and hourly weather drive the model. This is conditional room-response validation, not closed-loop strategy validation.'};
}

function climateRowFor(day,hour){return allHours.find(r=>r.day===day&&r.hr===hour);}
function sunroomTarget(hour,target){return target;}
function heatingFlow(mode,hour,outdoor,flowC,offset){
  const wc=clamp(offset-0.8*outdoor,33,50);
  if(mode==='full-soak'&&hour>=4&&hour<8)return flowC;
  if(mode.startsWith('boost-')){
    const minutes=Number(mode.slice(6));
    if(hour>=8-minutes/60&&hour<8)return flowC;
  }
  return wc;
}
function thermalCapacity(flow,rooms,outdoor,coefficient){
  const kw=coefficient*Math.pow(Math.max(0,flow-1.9-averageRoom(rooms)),1.3)*(outdoor<4?0.92:1);
  return Math.min(HEATING_LIMITS.ashpMaxThermalKw,kw);
}
function roomTargetFor(hour,target){return target;}
function forecastHour(row,rooms,mode,flowC,target,offset,coefficient,dt=0.25){
  const conditions={outdoor:row.outdoor,wind:row.wind,irradiance:row.irradiance,hour:row.hr};
  const noHeat=temperatureStep(rooms,conditions,0,dt),setpoint=roomTargetFor(row.hr,target);
  const requested=Math.max(0,(setpoint-noHeat[0]+0.22*dt*(setpoint-rooms[0]))/MODEL[0][6]);
  const flow=heatingFlow(mode,row.hr,row.outdoor,flowC,offset);
  const capacity=thermalCapacity(flow,rooms,row.outdoor,coefficient)*dt;
  const heatKwh=Math.min(requested,capacity);
  const next=temperatureStep(rooms,conditions,heatKwh,dt);
  const cop=clamp((3.75+0.081*((row.outdoor??5)-5)-0.065*(flow-43)),2.73,4.8);
  return {next,heatKwh,heatElectricKwh:heatKwh/cop+0.035*dt,flow,cop,capacityKwh:capacity,requestedKwh:requested};
}

function stepBattery({soc,homeKwh,solarKwh,ashpKwh,hour,libbi,zendure}){
  const eta=Math.sqrt(HEATING_LIMITS.batteryRoundTrip),dt=0.25;
  let demand=homeKwh+ashpKwh,solar=Math.max(0,solarKwh),net=Math.max(0,demand-solar),surplus=Math.max(0,solar-demand),exported=0;
  let gridCharge=0,solarCharge=0,libbiDischarge=0,zendureDischarge=0,zendureGridCharge=0;
  const inCheap=hour>=1&&hour<8;
  solarCharge=Math.min(surplus,libbi.powerKw*dt,(libbi.capacityKwh-soc)/eta);soc+=solarCharge*eta;surplus-=solarCharge;
  let zSoc=zendure.soc;
  if(zendure.enabled&&inCheap){
    zendureGridCharge=Math.min(zendure.powerKw*dt,(zendure.capacityKwh-zSoc)/eta);
    zSoc+=zendureGridCharge*eta;
  }
  if(inCheap){
    gridCharge=Math.min(Math.max(0,libbi.powerKw*dt-solarCharge),(libbi.capacityKwh-soc)/eta,Math.max(0,HEATING_LIMITS.libbiCapacityKwh-soc)/eta);
    soc=Math.min(HEATING_LIMITS.libbiCapacityKwh,soc+gridCharge*eta);
  }else{
    if(zendure.enabled){zendureDischarge=Math.min(net,zendure.powerKw*dt,zSoc*eta);zSoc-=zendureDischarge/eta;net-=zendureDischarge;}
    libbiDischarge=Math.min(net,libbi.powerKw*dt,Math.max(0,soc-libbi.reserveKwh)*eta);soc-=libbiDischarge/eta;net-=libbiDischarge;
  }
  exported=surplus;
  const imported=net+gridCharge+zendureGridCharge;
  const night=hour>=1&&hour<8;
  const cost=imported*(night?libbi.nightRate:libbi.dayRate)/100-exported*libbi.exportRate/100;
  return {soc,zendureSoc:zSoc,imported,exported,gridCharge,zendureGridCharge,solarCharge,libbiDischarge,zendureDischarge,cost,night};
}

function interpolateEnergy(row,step){
  return (row.houseKwh||0)/4;
}
export function simulateHeatingStrategy(day,mode,{flowC=50,targetC=21.5,offset=48,coefficient=HEATING_LIMITS.emitterCoefficient,battery=true,zendureEnabled=false,nightRate=HEATING_LIMITS.currentNightP,dayRate=HEATING_LIMITS.currentDayP}={}){
  const rows=allHours.filter(r=>r.day===day).sort((a,b)=>a.hr-b.hr);
  if(!rows.length)return null;
  const first=rows.find(r=>r.hr===0)||rows[0];let rooms=[...first.rooms];
  let soc=clamp((first.libbiSoc||0)/100*HEATING_LIMITS.libbiCapacityKwh,0,HEATING_LIMITS.libbiCapacityKwh);
  // A new Zendure starts empty; its off-peak grid charge is modelled explicitly.
  let zSoc=0;
  const libbi={capacityKwh:HEATING_LIMITS.libbiCapacityKwh,powerKw:HEATING_LIMITS.libbiPowerKw,reserveKwh:0,nightRate,dayRate,exportRate:0};
  const zendure={enabled:zendureEnabled,capacityKwh:HEATING_LIMITS.zendureCapacityKwh,powerKw:HEATING_LIMITS.zendurePowerKw,soc:zSoc};
  const intervals=[];let compressorOn=false,starts=0,totalHeat=0,totalHeatElectric=0,totalCost=0,totalGrid=0,totalLibbiDischarge=0,totalZendureDischarge=0,totalZendureCharge=0,minSoc=soc;
  for(const row of rows){
    for(let q=0;q<4;q++){
      const hour=row.hr+q*0.25;
      const env={...row,hr:hour};
      const r=forecastHour(env,rooms,mode,flowC,targetC,offset,coefficient,0.25);
      const start=rooms[0];rooms=r.next;
      const heatKw=r.heatKwh/0.25;
      const shouldRun=heatKw>0.12;
      if(shouldRun&&!compressorOn){starts++;compressorOn=true;}else if(!shouldRun)compressorOn=false;
      totalHeat+=r.heatKwh;totalHeatElectric+=r.heatElectricKwh;
      const auxiliary=row.ashpGridKwh!=null||row.ashpLibbiKwh!=null||row.ashpSolarKwh!=null
        ? Math.max(0,(row.electricKwh||0)-(row.spaceElectricKwh||row.electricKwh||0))/4
        : 0;
      const solar=row.solarKwh||0,home=interpolateEnergy(row,q);
      const batteryRow=battery?stepBattery({soc,homeKwh:home,solarKwh:solar/4,ashpKwh:r.heatElectricKwh+auxiliary,hour,libbi,zendure:{...zendure,soc:zSoc}})
        : {soc,zendureSoc:zSoc,imported:home+r.heatElectricKwh+auxiliary-solar/4,exported:0,gridCharge:0,solarCharge:0,libbiDischarge:0,zendureDischarge:0,cost:0,night:hour>=1&&hour<8};
      soc=batteryRow.soc;zSoc=batteryRow.zendureSoc;
      totalLibbiDischarge+=batteryRow.libbiDischarge||0;totalZendureDischarge+=batteryRow.zendureDischarge||0;totalZendureCharge+=batteryRow.zendureGridCharge||0;minSoc=Math.min(minSoc,soc);
      const cost=battery?batteryRow.cost:batteryRow.imported*(hour>=1&&hour<8?nightRate:dayRate)/100;
      totalCost+=cost;totalGrid+=batteryRow.imported;
      intervals.push({time:`${row.day}T${String(Math.floor(hour)).padStart(2,'0')}:${(hour%1)*60===0?'00':'15'}:00Z`,hour,startC:start,sunroomC:rooms[0],rooms:[...rooms],heatKwh:r.heatKwh,heatElectricKwh:r.heatElectricKwh,flowC:r.flow,cop:r.cop,compressorOn:shouldRun,...batteryRow,cost});
    }
  }
  const minSunroom=Math.min(...intervals.map(x=>x.sunroomC)),meanSunroom=mean(intervals.map(x=>x.sunroomC));
  const unmetIntervals=intervals.filter(x=>x.sunroomC<targetC-0.25).length;
  const endSoc=intervals.at(-1)?.soc??soc,startSoc=clamp((first.libbiSoc||0)/100*HEATING_LIMITS.libbiCapacityKwh,0,HEATING_LIMITS.libbiCapacityKwh);
  return {day,mode,flowC,targetC,complete:rows.length===24,intervals,starts,totalHeat,totalHeatElectric,totalCost:totalCost+HEATING_LIMITS.standingP/100*rows.length/24,totalGrid,
    minSunroom,meanSunroom,unmetIntervals,socStart:startSoc,socEnd:endSoc,minSoc,libbiDepletionKwh:Math.max(0,startSoc-endSoc),libbiDischargedKwh:totalLibbiDischarge,zendureDischargedKwh:totalZendureDischarge,zendureGridChargeKwh:totalZendureCharge,
    zendureStart:0,zendureEnd:zSoc,
    measuredDaily:dailyMeasurements(day,rows.length).electricKwh};
}

export function compareHeatingStrategies(day,options={}){
  const strategies=['wc-only','full-soak','boost-45','boost-60','boost-90','boost-120'];
  return strategies.map(mode=>simulateHeatingStrategy(day,mode,options)).filter(Boolean);
}

// Conditional component checks using measured heat, power and household flows.
// These do not validate a complete counterfactual heating strategy.
export function validateMeasuredReplay(days=replayTargetDays()){
  const results=[];
  for(const day of days){
    const hourly=allHours.filter(r=>r.day===day).sort((a,b)=>a.hr-b.hr);
    const points=fiveMinute.filter(p=>p.source==='ha-history'&&p.t.startsWith(day)).sort((a,b)=>Date.parse(a.t)-Date.parse(b.t));
    let predictedAsHpKwh=0,measuredAsHpKwh=0,heatKwh=0,copN=0,coverage=0;
    for(const p of points){
      if(!Number.isFinite(p.power)||!Number.isFinite(p.heatOutput))continue;
      const thermal=Math.max(0,p.heatOutput)/12,actual=Math.max(0,p.power)/12000;
      const flow=Number.isFinite(p.outlet)?p.outlet:45,outdoor=Number.isFinite(p.ambient)?p.ambient:5;
      const cop=clamp(3.75+0.081*(outdoor-5)-0.065*(flow-43),2.73,4.8);
      predictedAsHpKwh+=thermal/cop+0.035/12;measuredAsHpKwh+=actual;heatKwh+=thermal;copN++;
      if(Number.isFinite(p.ambient)&&Number.isFinite(p.outlet))coverage++;
    }
    if(!hourly.length)continue;
    const first=hourly.find(r=>r.hr===0)||hourly[0],last=hourly.at(-1);
    let soc=clamp((first.libbiSoc||0)/100*HEATING_LIMITS.libbiCapacityKwh,0,HEATING_LIMITS.libbiCapacityKwh),discharge=0;
    const libbi={capacityKwh:HEATING_LIMITS.libbiCapacityKwh,powerKw:HEATING_LIMITS.libbiPowerKw,reserveKwh:0,nightRate:HEATING_LIMITS.currentNightP,dayRate:HEATING_LIMITS.currentDayP,exportRate:0};
    for(const r of hourly)for(let q=0;q<4;q++){
      const point=points.filter(p=>p.t.startsWith(day)&&Number(p.t.slice(11,13))===r.hr&&Math.floor(Number(p.t.slice(14,16))/15)===q&&Number.isFinite(p.power));
      const ashp=point.length?point.reduce((s,p)=>s+Math.max(0,p.power)/12000,0):(r.electricKwh||0)/4;
      const batteryRow=stepBattery({soc,homeKwh:(r.houseKwh||0)/4,solarKwh:(r.solarKwh||0)/4,ashpKwh:ashp,hour:r.hr+q*.25,libbi,zendure:{enabled:false,soc:0,capacityKwh:HEATING_LIMITS.zendureCapacityKwh,powerKw:HEATING_LIMITS.zendurePowerKw}});
      soc=batteryRow.soc;discharge+=batteryRow.libbiDischarge;
    }
    const actualElectric=hourly.reduce((s,r)=>s+(r.electricKwh||0),0),actualDischarge=hourly.reduce((s,r)=>s+(r.libbiDischargeKwh||0),0);
    results.push({day,hours:hourly.length,complete:hourly.length===24,heatKwh,measuredAsHpKwh,predictedAsHpKwh,asHpErrorKwh:predictedAsHpKwh-measuredAsHpKwh,asHpMeterDifferenceKwh:measuredAsHpKwh-actualElectric,coveragePoints:copN,measuredLibbiDischargeKwh:actualDischarge,predictedLibbiDischargeKwh:discharge,libbiDischargeErrorKwh:discharge-actualDischarge,measuredSocStart:first.libbiSoc??null,measuredSocEnd:last.libbiSoc??null,predictedSocEndPct:soc/HEATING_LIMITS.libbiCapacityKwh*100,socEndErrorPp:soc/HEATING_LIMITS.libbiCapacityKwh*100-(last.libbiSoc??0)});
  }
  const bootstrapMae=key=>{
    if(results.length<2)return {mae:null,ci:null};
    const values=results.map(r=>Math.abs(r[key])),rng=seeded(2026112202+key.length),samples=[];
    for(let i=0;i<2000;i++){let total=0;for(let j=0;j<values.length;j++)total+=values[Math.floor(rng()*values.length)];samples.push(total/values.length);}
    samples.sort((a,b)=>a-b);return {mae:mean(values),ci:[samples[Math.floor(.025*samples.length)],samples[Math.floor(.975*samples.length)]]};
  };
  return {days:results,summary:{asHpAbsoluteErrorKwh:bootstrapMae('asHpErrorKwh'),libbiDischargeAbsoluteErrorKwh:bootstrapMae('libbiDischargeErrorKwh')},method:'ASHP electricity estimate uses measured five-minute thermal output, outlet temperature and ambient temperature with the model COP curve; Libbi check uses measured hourly house, ASHP and solar energy with the simple 01:00–08:00 charge/after-hours discharge rule. Both are conditional component checks. They do not validate heating strategy predictions, and sensor coverage/semantics may differ.'};
}

export function confidenceBand(value,rmse,leadIntervals=1){
  const sd=rmse*Math.sqrt(Math.max(1,leadIntervals));
  return {low:value-1.96*sd,high:value+1.96*sd,method:'Approximate normal band using held-out hourly RMSE; multi-step propagation is not fully calibrated.'};
}
