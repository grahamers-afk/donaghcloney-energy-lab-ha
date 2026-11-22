import test from 'node:test';
import assert from 'node:assert/strict';
import {allReplayDays, replayTargetDays, useReplay, dailyMeasurements, weatherMatchedDays,
  classifyCompressorEvents, compareHeatingStrategies, heldOutTemperatureValidation,
  heldOut15MinuteSunroomValidation} from '../donaghcloney_energy_lab/app/dist/heating.mjs';

test('replay starts empty and uses supplied measurements and room fits', () => {
  assert.deepEqual(allReplayDays(), []);
  const days = ['2000-01-01', '2000-01-02', '2000-01-03'];
  const hourly = (day, count) => Array.from({length:count}, (_, hr) => ({
    day, hr, z:`${day}T${String(hr).padStart(2, '0')}:00:00Z`, rooms:[20,20,20,20],
    outdoor:5, wind:3, irradiance:0, houseKwh:0.5, electricKwh:1,
    thermalKwh:3, spaceThermalKwh:3, libbiSoc:50,
  }));
  const points = Array.from({length:36}, (_, i) => ({
    t:new Date(Date.UTC(2000,0,2,0,i*5)).toISOString(),
    source:'ha-history', freq:i<12?30:0, room:20, heatOutput:0, power:0,
  }));
  useReplay({
    historicHours:hourly(days[0], 24),
    recentHours:[...hourly(days[1], 24), ...hourly(days[2], 1)],
    fiveMinute:points,
    fit:{params:Array.from({length:4},()=>[0,0,0,0,0,0,0.05])},
  });
  assert.deepEqual(allReplayDays(), days);
  assert.deepEqual(replayTargetDays(), [days[1]]);
  assert.equal(dailyMeasurements(days[1]).electricKwh, 24);
  assert.deepEqual(weatherMatchedDays(days[1], 5, 7).matches.map(row=>row.day), [days[0]]);
  assert.equal(classifyCompressorEvents().starts, 1);
  assert.equal(compareHeatingStrategies(days[1]).length, 6);
  assert.equal(heldOutTemperatureValidation().length, 4);
  assert.equal(heldOut15MinuteSunroomValidation().n, 12);
});
