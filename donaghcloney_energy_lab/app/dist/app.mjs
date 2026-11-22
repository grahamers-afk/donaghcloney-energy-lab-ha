import {DEFAULTS,simulate,DT,timeLabel,inWindow} from './model.mjs';
import {useReplay,replayTargetDays,allReplayDays,dailyMeasurements,weatherMatchedDays,classifyCompressorEvents,compareHeatingStrategies,heldOutTemperatureValidation,heldOut15MinuteSunroomValidation,validateMeasuredReplay,HEATING_LIMITS} from './heating.mjs';
const $=id=>document.getElementById(id), money=v=>new Intl.NumberFormat('en-GB',{style:'currency',currency:'GBP'}).format(v), num=(v,n=1)=>v.toFixed(n);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const STORAGE='donaghcloney-energy-lab-v1';
const originalScenarios=()=>[
 {id:'home',name:'Your setup',p:{...DEFAULTS}},
 {id:'more',name:'+10 kWh storage',p:{...DEFAULTS,capacity:30}},
 {id:'lean',name:'Leaner evenings',p:{...DEFAULTS,evening:0.2}},
 {id:'none',name:'Without a battery',p:{...DEFAULTS,capacity:0}}
];
let scenarios=originalScenarios(),selected='home',reference='home',tab='battery',chartMode='power',chartIndex=72,results=new Map(),saveAvailable=true;
let replayTab='weather';
const domains={capacity:[0,100],chargePower:[0,20],dischargePower:[0,20],efficiency:[50,100],reserve:[0,100],target:[0,100],base:[0,5],evening:[0,5],appliance:[0,30],solar:[0,80],pvPeak:[0,20],heat:[0,300],soakShare:[0,100],soakCop:[1,7],dayCop:[1,7],dhw:[0,20],immersion:[0,20],ev:[0,100],evPower:[0,22],nightRate:[0,150],dayRate:[0,150],standing:[0,300],exportRate:[0,100]};
try{
 const saved=JSON.parse(localStorage.getItem(STORAGE)||'null');
 if(saved?.scenarios?.length&&saved.scenarios.length<=8){
   scenarios=saved.scenarios.map((s,i)=>{
    const p={...DEFAULTS};
    for(const k in p){
      if(k==='clock'){p[k]=s.p?.[k]==='GMT'?'GMT':'BST';continue;}
      const v=Number(s.p?.[k]);const bounds=domains[k]||[0,23.75];
      if(Number.isFinite(v)&&v>=bounds[0]&&v<=bounds[1])p[k]=domains[k]?v:Math.round(v*4)/4;
    }
    return {id:`saved${i}`,name:String(s.name||'Scenario').slice(0,40),p};
   });
   selected=scenarios[Math.max(0,Math.min(scenarios.length-1,saved.selectedIndex||0))].id;
   reference=scenarios[Math.max(0,Math.min(scenarios.length-1,saved.referenceIndex||0))].id;
 }
}catch{saveAvailable=false;}
function current(){return scenarios.find(s=>s.id===selected);}
function save(){
 try{localStorage.setItem(STORAGE,JSON.stringify({scenarios,selectedIndex:scenarios.findIndex(s=>s.id===selected),referenceIndex:scenarios.findIndex(s=>s.id===reference)}));saveAvailable=true;}
 catch{saveAvailable=false;}
 $('saveStatus').textContent=saveAvailable?'Saved in this browser':'Session only · browser storage unavailable';
}
let toastTimer;
function toast(msg){$('toast').textContent=msg;$('toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('visible'),2600);}
const sections=[['battery','Battery'],['solar','Solar'],['heat','Heating'],['home','Household'],['ev','EV'],['tariff','Tariff']];
function field(key,label,unit,min,max,step,hint='',tag='assumed'){
 const value=current().p[key],fill=(value-min)/(max-min)*100;
 return `<div class="field"><div class="fieldline"><label for="n-${key}">${label}</label><div class="numberwrap"><input type="number" id="n-${key}" data-key="${key}" min="${min}" max="${max}" step="${step}" value="${value}" aria-label="${label} (${unit})"><span>${unit}</span></div></div><input type="range" id="r-${key}" aria-label="${label} slider (${unit})" data-key="${key}" min="${min}" max="${max}" step="${step}" value="${value}" style="--fill:${fill}%">${hint?`<p class="fieldhint"><span class="${tag}">${tag==='recorded'?'Recorded':'Assumed'}.</span> ${hint}</p>`:''}</div>`;
}
function times(key1,key2,label1='From',label2='Until'){
 const p=current().p;return `<div class="timepair">${[[key1,label1],[key2,label2]].map(([k,label])=>`<div class="timefield"><label for="t-${k}">${label}</label><input type="time" step="900" id="t-${k}" data-key="${k}" value="${timeLabel(p[k])}"></div>`).join('')}</div>`;
}
const group=s=>`<div class="fieldgroup"><p class="grouphead">${s}</p>`;
function renderControls(){
 $('editingTitle').textContent=current().name;
 $('controlTabs').innerHTML=sections.map(([id,label])=>`<button role="tab" id="tab-${id}" aria-controls="controlFields" aria-selected="${tab===id}" tabindex="${tab===id?0:-1}" class="${tab===id?'selected':''}" data-tab="${id}">${label}</button>`).join('');
 $('controlFields').setAttribute('aria-labelledby',`tab-${tab}`);
 const p=current().p;let h='';
 if(tab==='battery'){
  h='<p class="fieldintro">Adjust usable capacity and scheduling. The scenario treats extra capacity as part of a single battery.</p>';
  h+=field('capacity','Battery capacity','kWh',0,100,1,'20 kWh example usable capacity.');
  h+=field('chargePower','Maximum charge','kW',0,20,0.1,'5 kW placeholder; match your inverter setting.');
  h+=field('dischargePower','Maximum discharge','kW',0,20,0.1,'Shared system limit; adding capacity does not increase it.');
  h+=group('Grid charging window')+times('chargeStart','chargeEnd')+'<p class="fieldhint">Solar can charge the battery at any time. Grid charging fills to target and takes priority over discharge.</p></div>';
  h+=group('Allow discharge')+times('dischargeStart','dischargeEnd')+'<p class="fieldhint">Battery follows unmet home demand, up to its power limit. Equal start and end means all day.</p></div>';
  h+=group('Battery behaviour')+field('efficiency','Round-trip efficiency','%',50,100,0.1,'90% round trip; equal charge/discharge efficiencies of √0.90.')+field('reserve','Minimum reserve','%',0,100,1,'0% example reserve.')+field('target','Grid-charge target','%',0,100,1,'Solar may charge above this target up to full capacity.')+'</div>';
 }else if(tab==='solar'){
  h='<p class="fieldintro">Enter the combined daily generation from all arrays once.</p><div class="chiprow"><button data-solar="3">Dull · 3 kWh</button><button data-solar="8">Mixed · 8 kWh</button><button data-solar="16.6">Bright · 16.6 kWh</button></div>';
  h+=field('solar','Daily solar generation','kWh',0,80,0.1,'8 kWh is an illustrative mixed day, not a live forecast.');
  h+=group('Synthetic daylight profile')+times('sunrise','sunset','Starts','Ends')+field('pvPeak','Combined AC ceiling','kW',0,20,0.1,'5.8 kW example combined limit.')+'</div><div class="note">A smooth, afternoon-weighted curve distributes generation across daylight hours. No cloud forecast, shading model or measured generation trace is used. Roof bearings are not used in a physical irradiance calculation.</div>';
 }else if(tab==='heat'){
  h='<p class="fieldintro">Enter useful heat first. The simulator converts heat to electricity using COP and has a separate morning soak schedule.</p>';
  h+=field('heat','Space-heating demand','kWh heat',0,300,1,'80 kWh thermal is a representative day, not a measured heat loss.')+field('soakShare','Heat delivered in soak','%',0,100,1,'55% allocated to the soak; the rest to daytime heating.');
  h+=group('Morning soak')+times('soakStart','soakEnd')+field('soakCop','Soak COP','×',1,7,0.1,'3.0 placeholder for higher-temperature operation; no automatic temperature-to-COP conversion.')+'</div>';
  h+=group('Remaining space heating')+times('heatStart','heatEnd')+field('dayCop','Daytime COP','×',1,7,0.1,'3.8 illustrative lower-temperature COP; edit from your readings.')+'</div>';
  h+=group('DHW & immersion')+field('dhw','ASHP hot-water electricity','kWh',0,20,0.1,'2.8 kWh example hot-water electricity.')+times('dhwStart','dhwEnd')+field('immersion','Immersion electricity','kWh',0,20,0.1,'1.9 kWh example immersion electricity.')+`<div class="timefield"><label for="t-immersionStart">Immersion starts · runs for 1 modelled hour</label><input type="time" step="900" id="t-immersionStart" data-key="immersionStart" value="${timeLabel(p.immersionStart)}"></div>`+'</div><div class="note">This is an electrical energy model. It does not predict room temperature, comfort, cycling or defrost. A demand above 15 kW thermal is flagged. DHW is added separately; overlapping schedules are not a compressor-control simulation.</div>';
 }else if(tab==='home'){
  h='<p class="fieldintro">Keep these loads <b>separate from heating and EV charging</b>. Include cameras, fridges and always-on equipment in the base load.</p>';
  h+=field('base','Continuous base load','kW',0,5,0.05,'0.60 kW example continuous load.')+field('evening','Extra evening load','kW',0,5,0.05,'Added between 17:00 and 23:00.')+group('Appliances')+field('appliance','Daily appliance energy','kWh',0,30,0.1,'2.5 kWh for laundry/dishwasher etc, on top of base and evening loads.')+times('applianceStart','applianceEnd')+'</div><div class="note">Avoid double counting: include each load once across the base and evening inputs. Appliance energy is spread evenly over its selected window.</div>';
 }else if(tab==='ev'){
  h='<p class="fieldintro">EV charging is scheduled within the cheap-rate window.</p>';
  h+=field('ev','Requested EV charging','kWh',0,100,0.5,'0 means a day with no EV charging. Enter wall-side electricity, including charging losses.')+field('evPower','Charger power ceiling','kW',0,22,0.1,'7 kW example charger power limit.')+group('Preferred charging window')+times('evStart','evEnd')+'</div><div class="chiprow"><button data-ev="0">No charge</button><button data-ev="14">14 kWh</button><button data-ev="28">28 kWh</button></div><div class="note">Energy is spread across the overlap with your cheap window. If it cannot fit, a warning shows unmet energy. EV charging is part of home demand, so the battery can support it if your discharge schedule allows this.</div>';
 }else{
  h='<p class="fieldintro">Enter the rates including VAT from your current bill.</p><label class="grouphead" for="clockSelect">Clock & standard cheap window</label><select id="clockSelect"><option value="BST" '+(p.clock==='BST'?'selected':'')+'>Summer / BST · 02:00–09:00</option><option value="GMT" '+(p.clock==='GMT'?'selected':'')+'>Winter / GMT · 01:00–08:00</option></select><p class="fieldhint">Changing season also aligns battery charge/discharge, EV and DHW windows. Space heating and appliance times remain local-clock settings.</p>';
  h+=group('Rates')+field('nightRate','Night unit rate','p/kWh',0,150,0.01,'15.56p example off-peak rate.')+field('dayRate','Day unit rate','p/kWh',0,150,0.01,'32.04p example daytime rate.')+field('standing','Daily standing charge','p/day',0,300,0.01,'13.33p example standing charge.')+field('exportRate','Export payment','p/kWh',0,100,0.01,'0p example export payment.')+'</div>';
  h+=group('Actual cheap-rate window')+times('nightStart','nightEnd')+'</div><div class="note">All times are local wall-clock times for a normal 24-hour day. BST/GMT is selected manually; clock-change days are not modelled. Rates do not update automatically.</div>';
 }
 $('controlFields').innerHTML=h;
}
function renderScenarioTabs(){
 $('scenarioTabs').innerHTML=scenarios.map(s=>`<button class="scenariobutton ${s.id===selected?'selected':''}" data-scenario="${esc(s.id)}" aria-pressed="${s.id===selected}"><span class="scenarioDot"></span>${esc(s.name)}</button>`).join('');
 $('scenarioName').value=current().name;
 $('referenceBadge').hidden=selected!==reference;$('setReference').hidden=selected===reference;
 $('deleteScenario').disabled=scenarios.length<=1;$('addScenario').disabled=scenarios.length>=8;
}
const colors={load:'#6e7f75',solar:'#d8aa59',grid:'#8978b2',discharge:'#447f5f',soc:'#537b43'};
const replayMoney=v=>Number.isFinite(v)?money(v):'—',replayNum=(v,n=2)=>Number.isFinite(v)?v.toFixed(n):'—';
const replayDayLabel=d=>new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB',{day:'numeric',month:'short',timeZone:'UTC'});
const replayDay=()=>$('replayDay').value;
function renderReplay(){
 const content=$('replayContent');if(!content||!replayDay())return;
 const day=replayDay(),target=Number($('comfortTarget').value)||21.5,flow=Number($('flowTarget').value)||50,zendure=$('includeZendure').checked;
 if(replayTab==='weather'){
  const availableDays=allReplayDays(),targetDays=replayTargetDays();
  const {target:t,matches}=weatherMatchedDays(day,availableDays.length,7);
  const dates=[...new Set([day,...targetDays])].sort();
  const rows=dates.map(d=>{const x=dailyMeasurements(d,7),distance=matches.find(m=>m.day===d)?.distance;
   return `<tr><td><b>${replayDayLabel(d)}</b>${!dailyMeasurements(d).complete?' · partial':''}</td><td>${replayNum(x.meanOutdoor,1)}°C</td><td>${replayNum(x.meanWind,1)} mph</td><td>${x.startRooms?.[0]==null?'—':replayNum(x.startRooms[0],1)+'°C'}</td><td>${replayNum(x.spaceThermalKwh,1)} kWh</td><td>${distance==null?'—':replayNum(distance,2)}</td><td>${replayNum(x.electricKwh,1)} kWh</td><td>${replayNum(x.libbiDischargeKwh,1)} kWh</td><td>${replayNum(x.socStart,0)} → ${replayNum(x.socEnd,0)}%</td></tr>`;
  }).join('');
  content.innerHTML=`<div class="replaymetrics"><article><span>Measured ASHP electricity · selected 00–07 window</span><b>${replayNum(t.electricKwh,1)} kWh</b></article><article><span>Measured mean outdoor · wind</span><b>${replayNum(t.meanOutdoor,1)}°C · ${replayNum(t.meanWind,1)} mph</b></article><article><span>Measured sunroom range</span><b>${replayNum(t.sunroomMin,1)}–${replayNum(t.sunroomMax,1)}°C</b></article><article><span>Measured Libbi discharge</span><b>${replayNum(t.libbiDischargeKwh,1)} kWh</b></article><article><span>Calculated Libbi SOC change</span><b>${replayNum(t.socStart,0)}% → ${replayNum(t.socEnd,0)}%</b></article></div><h3>Automatic weather matches</h3><p>Distance combines outdoor temperature, wind, available gust and irradiance readings, and starting-room temperatures. The target and every date in the table use the same 00:00–07:00 GMT window. Lower distance is a closer match. Partial days are marked.</p><div class="tablewrap"><table><thead><tr><th>Day</th><th>Outdoor</th><th>Wind</th><th>Start sunroom</th><th>Estimated space heat</th><th>Match distance</th><th>Measured ASHP electricity</th><th>Measured Libbi discharge</th><th>Libbi SOC</th></tr></thead><tbody>${rows}</tbody></table></div><p class="tablefoot">Measured values are recorder summaries. “Space heat” is an estimated split of ASHP heat output after applying the replay’s DHW estimate. Distance is calculated, not a statistical probability. Nearest: ${matches.slice(0,3).map(x=>`${replayDayLabel(x.day)} (${replayNum(x.distance,2)})`).join(' · ')||'no complete matches'}.</p>`;
 }else if(replayTab==='strategies'){
  const scenarios=compareHeatingStrategies(day,{flowC:flow,targetC:target,zendureEnabled:zendure}),measured=dailyMeasurements(day),val=heldOutTemperatureValidation().find(x=>x.room==='Sunroom'),rmse15=heldOut15MinuteSunroomValidation(),measuredRuns=classifyCompressorEvents().events.filter(x=>x.start.startsWith(day)).length;
  content.innerHTML=`<div class="note"><b>Same comfort requirement:</b> every option uses ${target.toFixed(1)}°C sunroom target and the same observed weather, starting temperatures and household load. Flow/boost input is ${flow.toFixed(1)}°C; WC-only uses a 48°C offset (estimated target is offset − 0.8 × outdoor temperature). Scenarios are model estimates, not counterfactual measurements. Modelled “heat-call transitions” are not compressor starts.</div><div class="tablewrap"><table><thead><tr><th>Strategy</th><th>Modelled min sunroom</th><th>Hours below target −0.25°C</th><th>Heat-pump electric</th><th>Calculated whole-home cost</th><th>Heat-call transitions</th><th>Model Libbi discharge</th><th>Model minimum SOC</th><th>Zendure charge / discharge</th></tr></thead><tbody>${scenarios.map(x=>`<tr><td>${x.mode==='wc-only'?'WC-only':x.mode==='full-soak'?'Full soak':`${x.mode.slice(6)}-minute boost`}</td><td>${replayNum(x.minSunroom,2)}°C</td><td>${replayNum(x.unmetIntervals/4,1)} h</td><td>${replayNum(x.totalHeatElectric,1)} kWh</td><td>${replayMoney(x.totalCost)}</td><td>${x.starts}</td><td>${replayNum(x.libbiDischargedKwh,1)} kWh</td><td>${replayNum(x.minSoc/HEATING_LIMITS.libbiCapacityKwh*100,0)}%</td><td>${replayNum(x.zendureGridChargeKwh,1)} / ${replayNum(x.zendureDischargedKwh,1)} kWh</td></tr>`).join('')}</tbody></table></div><div class="replaymetrics"><article><span>Measured ASHP electricity · selected day</span><b>${replayNum(measured.electricKwh,1)} kWh</b></article><article><span>Measured sunroom min / max</span><b>${replayNum(measured.sunroomMin,1)} / ${replayNum(measured.sunroomMax,1)}°C</b></article><article><span>Measured compressor run segments</span><b>${measuredRuns}</b></article><article><span>Measured Libbi discharge</span><b>${replayNum(measured.libbiDischargeKwh,1)} kWh</b></article><article><span>Held-out hourly room RMSE</span><b>${replayNum(val?.rmse,2)}°C</b></article><article><span>Held-out 15-min conditional RMSE</span><b>${replayNum(rmse15.rmse,2)}°C</b></article></div><p class="tablefoot">Measured ASHP energy is shown separately from modeled space-heating electricity; DHW/auxiliary splitting is uncertain. Cost includes hourly house-load and modelled ASHP demand, modeled battery dispatch, 15.56/32.04p rates and 13.33p/day standing charge apportioned to the simulated period. Zendure, when enabled, starts empty and can only charge from grid 01:00–08:00. Costs are estimates, not a bill. The measured compressor run segments above are the comparator; modelled heat-call transitions are not predicted compressor starts. The held-out error gives a reference for the uncertainty in these comfort estimates.</p>`;
 }else if(replayTab==='events'){
  const r=classifyCompressorEvents(),examples=[...r.possibleDefrost.slice(0,2),...r.thermostatShutdown.slice(0,2),...r.shortCycling.slice(0,2)],dayEvents=r.events.filter(x=>x.start.startsWith(day));
  const events=examples.map(e=>`<tr><td>${e.start.replace('T',' ').slice(0,16)} UTC</td><td>${e.stopClass}</td><td>${Math.round(e.stopConfidence*100)}% heuristic confidence</td><td>${e.minutes} min</td><td>${e.defrostEvidence.join('; ')||'No strong defrost signature in available channels'}</td></tr>`).join('');
  content.innerHTML=`<div class="replaymetrics"><article><span>Observed compressor run segments</span><b>${r.starts}</b></article><article><span>Normal modulation segments</span><b>${r.normalModulation.length}</b></article><article><span>Possible defrost stops</span><b>${r.possibleDefrost.length}</b></article><article><span>Likely demand shutdowns</span><b>${r.thermostatShutdown.length}</b></article><article><span>Genuine short-cycle clusters</span><b>${r.shortCycling.length}</b></article></div><h3>How the classifier decides</h3><p>Frequency ≥5 Hz defines a compressor-on sample. Short cycling requires at least three runs each ≤15 minutes within a rolling hour; a stop is marked possible defrost only when power continues and measured heat/output-water/flow evidence supports it. Demand shutdown requires the room near/above target, low stop-period power, no strong defrost signature, and at least ten minutes off. “Normal modulation” means a run lasting at least ten minutes; it does not claim the compressor was optimally controlled.</p><div class="tablewrap"><table><thead><tr><th>Event · UTC</th><th>Classification</th><th>Confidence</th><th>Run</th><th>Evidence</th></tr></thead><tbody>${events||'<tr><td colspan="5">No high-confidence example of defrost, demand shutdown or short cycling found in the available sampled trace.</td></tr>'}</tbody></table></div><p class="tablefoot">Selected day ${replayDayLabel(day)}: ${dayEvents.length} detected runs. Confidence is a heuristic score, not calibrated probability. No reversing-valve state, coil temperature or manufacturer defrost flag is available. Five-minute statistics can hide brief stops. Genuine short cycling is not inferred when a defrost-like interruption is present.</p>`;
 }else{
  const cv=heldOutTemperatureValidation(),v15=heldOut15MinuteSunroomValidation(),measured=validateMeasuredReplay();
  content.innerHTML=`<h3>Held-out temperature prediction checks</h3><p>The hourly fit uses leave-one-week-block-out checks. The 15-minute check uses later days in the imported history. At each 15-minute step, observed heat output and weather are supplied; only the room response is predicted. These checks do not establish reliable strategy comfort predictions.</p><div class="tablewrap"><table><thead><tr><th>Test</th><th>Samples</th><th>MAE</th><th>RMSE</th><th>Bias</th><th>95% interval</th></tr></thead><tbody><tr><td>15-minute sunroom conditional holdout</td><td>${v15.n}</td><td>${replayNum(v15.mae,3)}°C</td><td>${replayNum(v15.rmse,3)}°C</td><td>${replayNum(v15.bias,3)}°C</td><td>${v15.rmseCI?`${replayNum(v15.rmseCI[0],3)}–${replayNum(v15.rmseCI[1],3)}°C`:'not estimable'}</td></tr>${cv.map(x=>`<tr><td>Hourly ${x.room} · week holdout</td><td>${x.n}</td><td>${replayNum(x.mae,3)}°C</td><td>${replayNum(x.rmse,3)}°C</td><td>—</td><td>${x.rmseCI?`${replayNum(x.rmseCI[0],3)}–${replayNum(x.rmseCI[1],3)}°C`:'not estimable'}</td></tr>`).join('')}</tbody></table></div><h3>Measured replay component checks</h3><p>These are conditional checks, not full-strategy validation. ASHP electricity uses recorded heat output, outlet water and ambient temperature as inputs to the model COP curve. Battery results feed recorded ASHP, household and solar energy through the dispatch rule. Actual and predicted values are therefore not independent of measured inputs.</p><div class="replaymetrics"><article><span>ASHP electricity absolute error · 4 dates</span><b>${replayNum(measured.summary.asHpAbsoluteErrorKwh.mae,2)} kWh MAE</b><small>95% day bootstrap ${measured.summary.asHpAbsoluteErrorKwh.ci.map(x=>replayNum(x,2)).join('–')}</small></article><article><span>Libbi discharge absolute error · 4 dates</span><b>${replayNum(measured.summary.libbiDischargeAbsoluteErrorKwh.mae,2)} kWh MAE</b><small>95% day bootstrap ${measured.summary.libbiDischargeAbsoluteErrorKwh.ci.map(x=>replayNum(x,2)).join('–')}</small></article></div><div class="tablewrap"><table><thead><tr><th>Day</th><th>Hours</th><th>Measured ASHP electricity</th><th>Model ASHP electricity</th><th>Error</th><th>Measured Libbi discharge</th><th>Model Libbi discharge</th><th>Error</th><th>Actual / model end SOC</th></tr></thead><tbody>${measured.days.map(x=>`<tr><td>${replayDayLabel(x.day)}${x.complete?'':' · partial'}</td><td>${x.hours}</td><td>${replayNum(x.measuredAsHpKwh,2)} kWh</td><td>${replayNum(x.predictedAsHpKwh,2)} kWh</td><td>${replayNum(x.asHpErrorKwh,2)} kWh</td><td>${replayNum(x.measuredLibbiDischargeKwh,2)} kWh</td><td>${replayNum(x.predictedLibbiDischargeKwh,2)} kWh</td><td>${replayNum(x.libbiDischargeErrorKwh,2)} kWh</td><td>${replayNum(x.measuredSocEnd,0)}% / ${replayNum(x.predictedSocEndPct,0)}%</td></tr>`).join('')}</tbody></table></div><h3>15-minute held-out days</h3><div class="tablewrap"><table><thead><tr><th>Day</th><th>15-min points</th><th>MAE</th><th>RMSE</th><th>Bias</th><th>Max horizon</th></tr></thead><tbody>${v15.days.map(x=>`<tr><td>${replayDayLabel(x.day)}</td><td>${x.n}</td><td>${replayNum(x.mae,3)}°C</td><td>${replayNum(x.rmse,3)}°C</td><td>${replayNum(x.bias,3)}°C</td><td>${replayNum(x.maxLeadHours,1)} h</td></tr>`).join('')}</tbody></table></div><p class="tablefoot">Intervals resample whole dates and use at most four days, so they are broad and fragile and are not guaranteed 95% coverage. ${esc(v15.method)} ${esc(measured.method)}</p>`;
 }
}
function replayTabChange(tabName){replayTab=tabName;for(const b of $('replayTabs').querySelectorAll('[data-replay-tab]')){const active=b.dataset.replayTab===tabName;b.classList.toggle('selected',active);b.setAttribute('aria-selected',String(active));}renderReplay();}
function renderResults(){
 results=new Map(scenarios.map(s=>[s.id,simulate(s.p)]));
 const r=results.get(selected),ref=results.get(reference),p=current().p,delta=r.cost-ref.cost;
 $('costValue').textContent=money(r.cost);
 $('costDelta').textContent=selected===reference?'Your comparison reference':Math.abs(delta)<0.005?'Same estimated cost as reference':`${money(Math.abs(delta))} ${delta<0?'less':'more'} than reference / day`;
 $('costDelta').className=selected===reference?'':delta<-.005?'positive':delta>.005?'negative':'';
 $('importValue').innerHTML=`${num(r.imported)} <small>kWh</small>`;
 $('importDetail').textContent=`${num(r.nightImport)} kWh at night rate`;
 $('dayValue').innerHTML=`${num(r.dayImport)} <small>kWh</small>`;
 $('dayDetail').textContent=`${money(r.dayImport*p.dayRate/100)} at ${num(p.dayRate,2)}p/kWh`;
 const solarUsed=Math.max(0,r.solar-r.exported),solarPct=r.solar?100*solarUsed/r.solar:0;
 $('solarValue').innerHTML=`${num(solarPct,0)}<small> %</small>`;
 $('solarDetail').textContent=`${num(solarUsed)} of ${num(r.solar)} kWh retained*`;
 $('warnings').innerHTML=r.warnings.map(x=>`<div class="warning">${esc(x)}</div>`).join('');
 $('cheapCaption').textContent=`Cheap rate · ${timeLabel(p.nightStart)}–${timeLabel(p.nightEnd)} ${p.clock}`;
 $('comparisonRows').innerHTML=scenarios.map(s=>{
  const x=results.get(s.id),d=x.cost-ref.cost;
  return `<tr class="${s.id===selected?'active':''}"><td><button class="rowbutton" data-scenario="${esc(s.id)}">${esc(s.name)}</button>${s.id===reference?'<span class="reference">REF</span>':''}${x.warnings.length?' <span title="This scenario has model warnings">⚠</span>':''}</td><td>${num(x.imported)} kWh</td><td>${num(x.dayImport)} kWh</td><td>${money(x.cost)}</td><td class="${s.id===reference?'':d<-.005?'saving':d>.005?'extra':''}">${s.id===reference?'—':Math.abs(d)<.005?'£0.00':`${d<0?'−':'+'}${money(Math.abs(d))}`}</td></tr>`;
 }).join('');
 $('loadTotal').textContent=`${num(r.load)} kWh`;
 $('loadBreakdown').innerHTML=[['Household',r.house,'#8fa17c'],['Space heating',r.heat,'#c3a273'],['ASHP hot water',r.dhw,'#d4b995'],['Immersion',r.immersion,'#d3c7b2'],['EV charging',r.ev,'#9a8ab5']].map(([name,value,color])=>`<div class="breakdownrow"><span>${name}</span><div class="bartrack"><div style="width:${r.load?100*value/r.load:0}%;background:${color}"></div></div><b>${num(value)} kWh</b></div>`).join('');
 const ok=r.balanceError<1e-7 && r.cycleError<1e-7;
 $('balanceBadge').textContent=ok?'✓ Balanced':'Check failed';
 $('balanceDetails').innerHTML=`<div class="balancerow"><span>Grid + solar</span><b>${num(r.imported+r.solar,2)} kWh</b></div><div class="balancerow"><span>Home + export + battery losses</span><b>${num(r.load+r.exported+r.loss,2)} kWh</b></div><div class="balancerow total"><span>Battery start → end</span><b>${num(r.start,2)} → ${num(r.end,2)} kWh</b></div><div class="balancerow"><span>Battery losses · peak import</span><b>${num(r.loss)} kWh · ${num(r.peak)} kW</b></div>`;
 $('intervalRows').innerHTML=r.rows.map(x=>`<tr><td>${timeLabel(x.t)} ${x.night?'☾':''}</td><td>${num(x.load/DT,2)}</td><td>${num(x.solar/DT,2)}</td><td>${num(x.imported/DT,2)}</td><td>${num((x.solarCharge+x.gridCharge)/DT,2)}</td><td>${num(x.discharge/DT,2)}</td><td>${num(x.soc,2)}</td><td>${money(x.cost)}</td></tr>`).join('');
 renderChart();save();
}
function renderChart(){
 const r=results.get(selected),p=current().p,W=810,H=260,L=39,R=17,T=17,B=30,pw=W-L-R,ph=H-T-B;
 const isBat=chartMode==='battery';
 const series=isBat?[{name:'Stored energy',key:'soc',color:colors.soc}]:[{name:'Home demand',key:'load',color:colors.load},{name:'Solar',key:'solar',color:colors.solar},{name:'Grid import',key:'imported',color:colors.grid},{name:'Battery → home',key:'discharge',color:colors.discharge}];
 $('chartLegend').innerHTML=series.map(s=>`<span class="legenditem"><i style="background:${s.color}"></i>${s.name}</span>`).join('');
 const values=isBat?[r.start,...r.rows.map(x=>x.soc)]:r.rows.flatMap(x=>series.map(s=>x[s.key]/DT));
 const rawMax=Math.max(1,...values),ymax=isBat?Math.max(p.capacity,1):Math.ceil(rawMax/2)*2;
 const x=t=>L+t/24*pw,y=v=>T+ph-v/ymax*ph;
 let svg=`<svg viewBox="0 0 ${W} ${H}" aria-hidden="true"><defs><linearGradient id="gridFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${colors.grid}" stop-opacity=".17"/><stop offset="100%" stop-color="${colors.grid}" stop-opacity=".015"/></linearGradient><linearGradient id="socFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#a4bb7d" stop-opacity=".35"/><stop offset="100%" stop-color="#a4bb7d" stop-opacity=".04"/></linearGradient></defs>`;
 for(let i=0;i<96;i++){const t=i*DT;if(inWindow(t,p.nightStart,p.nightEnd))svg+=`<rect x="${x(t)}" y="${T}" width="${pw/96+.1}" height="${ph}" fill="#eef3e5"/>`;}
 for(let i=0;i<=4;i++){const v=ymax*i/4;svg+=`<path d="M${L},${y(v)}H${W-R}" stroke="#e9ede6" stroke-dasharray="3 4"/><text x="${L-9}" y="${y(v)+3}" text-anchor="end" fill="#96a193" font-size="9" font-family="sans-serif">${num(v,v%1?1:0)}</text>`;}
 for(let t=0;t<=24;t+=3)svg+=`<text x="${x(t)}" y="${H-9}" text-anchor="middle" fill="#96a193" font-size="9" font-family="sans-serif">${String(t).padStart(2,'0')}:00</text>`;
 svg+=`<text x="${L}" y="9" fill="#96a193" font-size="8" font-family="sans-serif">${isBat?'kWh stored':'kW'}</text>`;
 for(const s of series){
  let points=[];
  if(isBat)points=[[x(0),y(r.start)],...r.rows.map((a,i)=>[x((i+1)*DT),y(a.soc)])];
  else {for(const a of r.rows)points.push([x(a.t),y(a[s.key]/DT)],[x(a.t+DT),y(a[s.key]/DT)]);}
  const path=points.map(([a,b],i)=>`${i?'L':'M'}${num(a,2)},${num(b,2)}`).join('');
  if(isBat||s.key==='imported')svg+=`<path d="${path}L${x(24)},${y(0)}L${x(0)},${y(0)}Z" fill="url(#${isBat?'socFill':'gridFill'})"/>`;
  svg+=`<path d="${path}" fill="none" stroke="${s.color}" stroke-width="${s.key==='solar'?2.5:1.8}" stroke-linejoin="round"/>`;
 }
 if(isBat&&p.capacity>0){const floor=p.capacity*p.reserve/100;svg+=`<path d="M${L},${y(floor)}H${W-R}" stroke="#aaa085" stroke-width="1" stroke-dasharray="4 4"/>`;}
 svg+=`<line id="hoverLine" x1="${x(chartIndex*DT)}" x2="${x(chartIndex*DT)}" y1="${T}" y2="${T+ph}" stroke="#7c8c72" stroke-dasharray="3 3"/></svg>`;
 $('chart').innerHTML=svg;
 $('chart').setAttribute('aria-label',isBat?'Battery stored energy over the day, in kWh. Left and right arrows inspect intervals.':'Daily power chart: home demand, solar, grid import and battery discharge in kW. Left and right arrows inspect intervals.');
 updateReadout();
}
function updateReadout(){
 const r=results.get(selected),v=r.rows[chartIndex],p=current().p;
 const xpos=39+v.t/24*(810-39-17),line=$('hoverLine');if(line){line.setAttribute('x1',xpos);line.setAttribute('x2',xpos);}
 $('chartReadout').innerHTML=`<b>${timeLabel(v.t)}–${timeLabel(v.t+DT)}</b>${chartMode==='battery'?`<span>Stored ${num(v.before,2)} → ${num(v.soc,2)} kWh</span><span>${p.capacity?num(v.soc/p.capacity*100,0):0}% full</span><span>Charging ${num((v.solarCharge+v.gridCharge)/DT,2)} kW</span>`:`<span>Home ${num(v.load/DT,2)}</span><span>Solar ${num(v.solar/DT,2)}</span><span>Import ${num(v.imported/DT,2)}</span><span>Battery ${num(v.discharge/DT,2)} kW</span>`}`;
}
function chooseScenario(id){selected=id;renderScenarioTabs();renderControls();renderResults();}
function applyValue(key,value){
 current().p[key]=value;
 for(const prefix of ['n-','r-']){const el=$(prefix+key);if(el){el.value=value;if(prefix==='r-')el.style.setProperty('--fill',`${(value-Number(el.min))/(Number(el.max)-Number(el.min))*100}%`);}}
 renderResults();
}
function assumptions(){
 return `<h2>Model and assumptions</h2><p>Set up a scenario using your own meter readings and tariff. The starting values are editable examples.</p>
 <h3>Starting inputs</h3><ul><li><b>Battery:</b> 20 kWh usable, 5 kW charge and discharge limits, 90% round-trip efficiency and a 100% grid-charge target. Extra storage uses the same aggregate power limit and efficiency.</li><li><b>Solar:</b> 8 kWh/day with an afternoon-weighted synthetic 08:00–18:00 profile and 5.8 kW AC limit. Include each array once in the total.</li><li><b>Space heating:</b> 80 kWh thermal/day, 55% in a 05:00–09:00 soak at COP 3.0 and the balance between 09:00 and 22:30 at COP 3.8.</li><li><b>Household:</b> 600 W continuous, another 500 W between 17:00 and 23:00, and 2.5 kWh for appliances from 03:00 to 06:00. Heating, immersion and EV charging are separate.</li><li><b>Hot water:</b> 2.8 kWh heat pump electricity between 01:00 and 03:00 GMT plus 1.9 kWh immersion electricity over one hour from 05:45.</li><li><b>Tariff:</b> 15.56p/kWh off-peak, 32.04p/kWh daytime, 13.33p/day standing and zero export credit. The historical grid-cost estimate uses its separate audit rates.</li></ul>
 <h3>How the energy moves</h3><p>Solar supplies demand first, then charges the battery within its power and capacity limits; the remainder is exported. In the grid-charge window, the grid supplies unmet demand and charges the battery to its target. Outside that window, permitted battery discharge follows unmet demand, respecting reserve and power limits. Remaining demand is imported. The battery never exports.</p>
 <div class="formula">Heat-pump electricity = useful heat ÷ COP<br>Charge efficiency = discharge efficiency = √(round-trip efficiency)<br>Grid + solar = home + export + battery losses + change in stored energy<br>Cost = night imports × night rate + day imports × day rate<br>+ standing charge − export payment</div>
 <p>The model finds a repeating daily battery state, with end-of-day storage equal to the start. This avoids using unpaid initial stored energy. It uses 96 quarter-hour intervals; timelines are approximations. Equal window endpoints mean a full day; overnight windows wrap across midnight.</p>
 <h3>What the result can tell you</h3><p>Compare daily imports, daytime exposure, export and electricity cost for each chosen set of assumptions. “Solar used at home” means solar not exported, including solar sent into the battery; some of it is later lost in conversion. It is not all useful energy delivered to appliances. The demand breakdown excludes battery losses, which are shown separately.</p>
 <p>The daily simulator estimates energy use. The heating replay adds a separate room response model, event heuristic and battery estimates. The replay is not a controller model. Its 15-minute temperature holdout uses measured heat output and weather, and therefore does not validate predicted heat demand or counterfactual strategy performance. DHW splitting, whole-home import allocation, Zendure charge policy, room-to-room coupling and compressor event classifications have limited evidence. The approximate 15 kW thermal warning relates to the original panel only. No grid fuse or detailed device controller is simulated.</p>
 <p>EV energy is wall-side electricity, spread only over the cheap-window overlap. A shortfall is excluded from costs and prominently flagged; scenarios with unmet EV energy are not directly comparable. All other demand is supplied by the grid if the battery or solar is insufficient.</p>
 <h3>Privacy and persistence</h3><p>Scenarios stay in this browser. Historical replay is saved in the app’s local storage on Home Assistant. The simulator uses a typical 24-hour day with manually selected GMT or BST. Replay timestamps use UTC.</p>`;
}
function validation(){
 const r=results.get(selected),p=current().p;
 const checks=[
 ['AC energy balance per interval',r.balanceError<1e-7,`${r.balanceError.toExponential(2)} kWh maximum residual`],
 ['Battery repeats without free initial energy',r.cycleError<1e-7,`${r.cycleError.toExponential(2)} kWh start/end difference`],
 ['Battery stays inside reserve and capacity',r.rows.every(x=>x.soc>=p.capacity*p.reserve/100-1e-7&&x.soc<=p.capacity+1e-7),'Every 15-minute boundary checked'],
 ['Charge power limit',r.rows.every(x=>x.gridCharge+x.solarCharge<=p.chargePower*DT+1e-7),`${num(p.chargePower,2)} kW AC maximum`],
 ['Discharge power limit',r.rows.every(x=>x.discharge<=p.dischargePower*DT+1e-7),`${num(p.dischargePower,2)} kW AC maximum`],
 ['No simultaneous charge and discharge',r.rows.every(x=>!(x.discharge>1e-8&&x.solarCharge+x.gridCharge>1e-8)),'Grid-charge window has priority'],
 ['EV charging only at night',r.rows.every(x=>x.ev<1e-8||x.night),'Actual tariff window checked'],
 ['Cost reconciles',Math.abs(r.cost-(r.nightImport*p.nightRate/100+r.dayImport*p.dayRate/100+p.standing/100-r.exported*p.exportRate/100))<1e-9,'Unit charges + standing charge − export payment']
 ];
 return `<h2>Calculations you can inspect.</h2><p>These checks run on the active scenario’s result. They verify numerical accounting and model constraints, not the accuracy of estimated inputs or the suitability of hardware settings.</p><table><thead><tr><th>Check</th><th>Result</th><th>Detail</th></tr></thead><tbody>${checks.map(([name,ok,detail])=>`<tr><td>${name}</td><td class="${ok?'testpass':'extra'}">${ok?'✓ Pass':'Failed'}</td><td>${detail}</td></tr>`).join('')}</tbody></table><div class="formula">${num(r.imported,4)} grid + ${num(r.solar,4)} solar<br>= ${num(r.load,4)} demand + ${num(r.exported,4)} export<br>+ ${num(r.loss,4)} battery losses + ${num(r.end-r.start,7)} stored change</div><p>Costs include ${money(r.importCost)} imports + ${money(r.standing)} standing charge − ${money(r.exportCredit)} export credit = <b>${money(r.cost)}</b>. Rounding is for display only.</p><p>The underlying engine was also tested against independent hand-calculated cases, zero-battery and zero-load cases, tariff boundaries, overnight schedules, loss accounting, EV shortfalls and randomized scenario invariants.</p>`;
}
function openInfo(content){$('dialogContent').innerHTML=content;$('infoDialog').showModal();}
function exportCsv(){
 const cell=v=>{let s=String(v??'');if(typeof v==='string'&&/^[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
 const rows=[['Donaghcloney Home Energy Lab','Normal repeated 24-hour day; local times; estimates'],[],['Summary','Scenario','Grid import kWh','Night import kWh','Day import kWh','Export kWh','Demand kWh','Solar kWh','Battery losses kWh','Cost GBP/day','Warning']];
 for(const s of scenarios){const r=results.get(s.id);rows.push(['Summary',s.name,r.imported,r.nightImport,r.dayImport,r.exported,r.load,r.solar,r.loss,r.cost,r.warnings.join(' | ')]);}
 rows.push([],['Input','Scenario','Key','Value']);for(const s of scenarios)for(const [k,v] of Object.entries(s.p))rows.push(['Input',s.name,k,v]);
 rows.push([],['Interval','Scenario','Time','Tariff p/kWh','Load kWh','Solar kWh','Grid import kWh','Export kWh','Grid to battery kWh','Solar to battery kWh','Battery to home kWh','Battery loss kWh','SOC start kWh','SOC end kWh','Net interval cost GBP (ex standing)']);
 for(const s of scenarios)for(const x of results.get(s.id).rows)rows.push(['Interval',s.name,timeLabel(x.t),x.rate,x.load,x.solar,x.imported,x.exported,x.gridCharge,x.solarCharge,x.discharge,x.loss,x.before,x.soc,x.cost]);
 const csv='\uFEFF'+rows.map(r=>r.map(cell).join(',')).join('\r\n'),url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8;'}));
 const a=document.createElement('a');a.href=url;a.download='donaghcloney-energy-scenarios.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Scenarios and interval calculations exported');
}
$('controlTabs').addEventListener('click',e=>{const b=e.target.closest('[data-tab]');if(b){tab=b.dataset.tab;renderControls();$('tab-'+tab).focus();}});
$('controlTabs').addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();let i=sections.findIndex(x=>x[0]===tab);i=e.key==='Home'?0:e.key==='End'?sections.length-1:(i+(e.key==='ArrowRight'?1:-1)+sections.length)%sections.length;tab=sections[i][0];renderControls();$('tab-'+tab).focus();});
$('controlFields').addEventListener('input',e=>{
 const el=e.target,key=el.dataset.key;if(!key)return;
 if(el.type==='time'){
  if(!el.value||!el.checkValidity())return;const [h,m]=el.value.split(':').map(Number);applyValue(key,h+m/60);
 }else if(el.type==='range'||el.type==='number'){
  if(el.value===''||!el.checkValidity())return;applyValue(key,Number(el.value));
 }
});
$('controlFields').addEventListener('focusout',e=>{const el=e.target;if(el.dataset.key&&(el.value===''||!el.checkValidity())){el.value=el.type==='time'?timeLabel(current().p[el.dataset.key]):current().p[el.dataset.key];toast('Use a value within the shown range and step.');}});
$('controlFields').addEventListener('change',e=>{
 if(e.target.id!=='clockSelect')return;
 const mode=e.target.value,p=current().p,start=mode==='BST'?2:1,end=start+7;
 Object.assign(p,{clock:mode,nightStart:start,nightEnd:end,chargeStart:start,chargeEnd:end,dischargeStart:end,dischargeEnd:start,evStart:start,evEnd:end,dhwStart:start,dhwEnd:start+2});
 renderControls();renderResults();toast(`Aligned tariff, battery, EV and DHW to ${mode}`);
});
$('controlFields').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.solar){applyValue('solar',Number(b.dataset.solar));}if(b.dataset.ev!==undefined){applyValue('ev',Number(b.dataset.ev));}});
for(const id of ['scenarioTabs','comparisonRows'])$(id).addEventListener('click',e=>{const b=e.target.closest('[data-scenario]');if(b)chooseScenario(b.dataset.scenario);});
$('scenarioName').addEventListener('change',e=>{current().name=e.target.value.trim()||'Untitled scenario';renderScenarioTabs();renderControls();renderResults();});
$('addScenario').addEventListener('click',()=>{if(scenarios.length>=8)return;const s={id:'s'+Date.now(),name:(current().name+' copy').slice(0,40),p:{...current().p}};scenarios.push(s);chooseScenario(s.id);toast('Scenario duplicated — change its settings to compare');});
$('deleteScenario').addEventListener('click',()=>{if(scenarios.length<=1)return;const index=scenarios.findIndex(s=>s.id===selected);scenarios.splice(index,1);if(reference===selected)reference=scenarios[0].id;chooseScenario(scenarios[Math.min(index,scenarios.length-1)].id);toast('Scenario removed');});
$('setReference').addEventListener('click',()=>{reference=selected;renderScenarioTabs();renderResults();toast('Comparison reference updated');});
$('resetScenario').addEventListener('click',()=>{current().p={...DEFAULTS};renderControls();renderResults();toast('Scenario inputs reset to your starting defaults');});
$('chartModes').addEventListener('click',e=>{const b=e.target.closest('[data-mode]');if(!b)return;chartMode=b.dataset.mode;for(const el of $('chartModes').querySelectorAll('button')){el.classList.toggle('selected',el===b);el.setAttribute('aria-pressed',el===b);}renderChart();});
$('chart').addEventListener('pointermove',e=>{const rect=$('chart').getBoundingClientRect(),x=(e.clientX-rect.left)/rect.width*810;chartIndex=Math.max(0,Math.min(95,Math.floor((x-39)/(810-39-17)*96)));updateReadout();});
$('chart').addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();chartIndex=e.key==='Home'?0:e.key==='End'?95:Math.max(0,Math.min(95,chartIndex+(e.key==='ArrowRight'?1:-1)));updateReadout();});
for(const id of ['assumptionsButton','footerAssumptions'])$(id).addEventListener('click',()=>openInfo(assumptions()));
$('validationButton').addEventListener('click',()=>openInfo(validation()));
$('closeDialog').addEventListener('click',()=>$('infoDialog').close());
$('infoDialog').addEventListener('click',e=>{if(e.target===$('infoDialog')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close();}});
$('exportCsv').addEventListener('click',exportCsv);
renderScenarioTabs();renderControls();renderResults();
for(const event of ['change','input'])for(const id of ['replayDay','comfortTarget','flowTarget','includeZendure'])$(id).addEventListener(event,renderReplay);
$('replayTabs').addEventListener('click',e=>{const b=e.target.closest('[data-replay-tab]');if(b)replayTabChange(b.dataset.replayTab);});

function showReplay(bundle){
 const daySelect=$('replayDay'), previous=daySelect.value;
 useReplay(bundle);
 const days=allReplayDays();
 daySelect.innerHTML=days.map(day=>`<option value="${esc(day)}">${replayDayLabel(day)}${dailyMeasurements(day).complete?'':' · partial'}</option>`).join('');
 daySelect.value=days.includes(previous)?previous:(replayTargetDays()[0]??days[0]);
 $('replayViews').hidden=false;
 $('replayStatus').textContent='Private replay loaded from the app’s local storage.';
 renderReplay();
}

async function loadReplay(){
 try{
  const response=await fetch('api/replay');
  if(response.status===404){
   $('replayStatus').textContent='Import a private replay bundle to use historical analysis. The simulator is ready.';
   return;
  }
  if(!response.ok)throw new Error();
  showReplay(await response.json());
 }catch{
  $('replayStatus').textContent='Replay could not be loaded. You can import a valid bundle to replace it.';
 }
}

async function startReplay(){
 await loadReplay();
 $('replayUpload').disabled=false;
 $('replayImport').addEventListener('submit',async event=>{
  event.preventDefault();
  const input=$('replayFile'), file=input.files[0], button=$('replayUpload');
  if(!file)return;
  button.disabled=true;
  $('replayStatus').textContent='Importing replay…';
  try{
   const response=await fetch('api/replay',{
    method:'POST',headers:{'Content-Type':'application/json','X-Energy-Lab-Import':'1'},body:file
   });
   const result=await response.json();
   if(!response.ok){$('replayStatus').textContent=result.error;return;}
   showReplay(result);
   input.value='';
  }catch{
   $('replayStatus').textContent='Import could not be confirmed. Reload to check the saved replay.';
  }finally{
   button.disabled=false;
  }
 });
}
if(typeof window!=='undefined')void startReplay();
