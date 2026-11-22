"""Read-only pull client for the local Energy Lab Home Assistant bridge."""
import json
import os
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener

DATA = Path('/data')
DEFAULT_DAYS = 180
HTTP_TIMEOUT = 90


def _read_options():
    """Read the runtime app options provided under /data."""
    try:
        options = json.loads((DATA / 'options.json').read_text())
        return options if isinstance(options, dict) else {}
    except (OSError, ValueError):
        return {}


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


def _bridge_get(base_url, secret, path, query=None):
    url = base_url.rstrip('/') + '/' + path.lstrip('/')
    if query:
        url += '?' + urlencode(query)
    request = Request(url, headers={'X-Energy-Lab-Key': secret, 'Accept': 'application/json'})
    with build_opener(NoRedirects()).open(request, timeout=HTTP_TIMEOUT) as response:
        return json.loads(response.read())


def _as_utc(value):
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, tz=timezone.utc)
    if isinstance(value, str):
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)
    return None


def _numeric(row, *keys):
    for key in keys:
        value = row.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return float(value)
    return None


def _choose(entities, role):
    candidates = entities.get(role, [])
    if not candidates:
        return None
    def score(item):
        entity_id = item.get('entity_id', '')
        name = str(item.get('name', '')).lower()
        points = 0
        if entity_id.endswith(f'{role}_temperature') or entity_id.endswith(f'{role}_soc'):
            points += 8
        if 'ikea' in entity_id or 'ikea' in name:
            points -= 4
        if role == 'ashp_energy' and 'heat_pump_electric_energy_total' in entity_id:
            points += 12
        if role == 'thermal_energy' and 'heat_pump_thermal_energy_total' in entity_id:
            points += 12
        if role == 'solar_energy' and entity_id == 'sensor.total_solar_energy':
            points += 12
        if role == 'solar_forecast_daily' and entity_id == 'sensor.solar_trial_forecast_tomorrow':
            points += 12
        if item.get('state_class') in ('measurement', 'total', 'total_increasing'):
            points += 2
        return points
    return max(candidates, key=score)['entity_id']


def _period_map(payload):
    result = {}
    for entity_id, rows in payload.get('statistics', {}).items():
        points = {}
        for row in rows:
            timestamp = _as_utc(row.get('start'))
            if timestamp is None:
                continue
            key = timestamp.strftime('%Y-%m-%dT%H:%M:%SZ')
            points[key] = row
        result[entity_id] = points
    return result


def _point(series, entity_id, timestamp, *keys):
    row = series.get(entity_id, {}).get(timestamp, {})
    return _numeric(row, *keys)


def _save_replay(raw):
    DATA.mkdir(mode=0o700, parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=DATA, prefix='.replay-', delete=False) as file:
        temporary = Path(file.name)
        try:
            file.write(raw)
            file.flush()
            os.fsync(file.fileno())
            file.close()
            temporary.replace(DATA / 'recorder-replay.json')
        finally:
            temporary.unlink(missing_ok=True)


def _load_private_json(name):
    try:
        return json.loads((DATA / name).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None


def _merge_bundle(previous, incoming, history_days):
    if not isinstance(previous, dict):
        return incoming
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=history_days)
    old_hours = previous.get('historicHours', []) + previous.get('recentHours', [])
    merged_hours = {row.get('z'): row for row in old_hours if _as_utc(row.get('z')) and _as_utc(row['z']) >= cutoff}
    merged_hours.update({row.get('z'): row for row in incoming.get('historicHours', []) + incoming.get('recentHours', [])})
    hours = sorted(merged_hours.values(), key=lambda row: row['z'])
    split = now - timedelta(days=10)
    five_rows = {row.get('t'): row for row in previous.get('fiveMinute', []) if _as_utc(row.get('t')) and _as_utc(row['t']) >= now - timedelta(days=10)}
    five_rows.update({row.get('t'): row for row in incoming.get('fiveMinute', [])})
    five = sorted(five_rows.values(), key=lambda row: row['t'])
    return {
        'historicHours': [row for row in hours if _as_utc(row['z']) < split],
        'recentHours': [row for row in hours if _as_utc(row['z']) >= split],
        'fiveMinute': five,
        'fit': {'params': []},
        'liveSnapshot': incoming.get('liveSnapshot', previous.get('liveSnapshot', {})),
        'forecastHours': incoming.get('forecastHours', []),
        'forecastMeta': incoming.get('forecastMeta', {}),
    }


def _history_profile(rows):
    profile = {}
    for hour in range(24):
        values = [max(0.0, row.get('solarKwh') or 0.0) for row in rows if row.get('hr') == hour]
        profile[str(hour)] = sorted(values)[len(values) // 2] if values else 0.0
    return profile


def _build_forecast_rows(payload, target_day, history_rows, solar_total):
    forecast = payload.get('forecast', []) if isinstance(payload, dict) else []
    rows = []
    wind_unit = str(payload.get('wind_speed_unit') or 'mph').lower()
    temp_unit = str(payload.get('temperature_unit') or '°c').lower()
    for item in forecast:
        stamp = _as_utc(item.get('datetime'))
        if stamp is None or stamp.strftime('%Y-%m-%d') not in {datetime.now(timezone.utc).strftime('%Y-%m-%d'), target_day}:
            continue
        temp = item.get('temperature')
        if isinstance(temp, (int, float)) and temp_unit in {'°f', 'f', 'fahrenheit'}:
            temp = (temp - 32) * 5 / 9
        wind = item.get('wind_speed')
        if isinstance(wind, (int, float)):
            if wind_unit in {'km/h', 'kmh', 'kph'}:
                wind *= 0.621371
            elif wind_unit in {'m/s', 'mps'}:
                wind *= 2.23694
        hour = stamp.hour
        same_hour = [row for row in history_rows if row.get('hr') == hour]
        irradiances = sorted(row['irradiance'] for row in same_hour if isinstance(row.get('irradiance'), (int, float)))
        irradiance = item.get('solar_irradiance')
        cloud = item.get('cloud_coverage')
        if irradiance is None and irradiances:
            irradiance = irradiances[len(irradiances) // 2]
            if isinstance(cloud, (int, float)):
                irradiance *= max(0.0, min(1.0, 1 - cloud / 100))
        loads = sorted(row['houseKwh'] for row in same_hour if isinstance(row.get('houseKwh'), (int, float)))
        load = loads[len(loads) // 2] if loads else None
        rows.append({
            'z': stamp.strftime('%Y-%m-%dT%H:%M:%SZ'), 'day': stamp.strftime('%Y-%m-%d'),
            'hr': hour, 'rooms': [], 'outdoor': temp, 'wind': wind,
            'windMax': item.get('wind_gust_speed'), 'windDirection': item.get('wind_bearing'),
            'cloudCoverage': cloud, 'irradiance': irradiance, 'houseKwh': load,
            'solarKwh': 0.0, 'forecast': True,
        })
    rows.sort(key=lambda row: row['z'])
    target_rows = [row for row in rows if row['day'] == target_day]
    profile = _history_profile(history_rows)
    weights = [profile[str(row['hr'])] for row in target_rows]
    total_weight = sum(weights)
    if isinstance(solar_total, (int, float)) and solar_total >= 0 and target_rows and total_weight > 0:
        for row, weight in zip(target_rows, weights):
            row['solarKwh'] = float(solar_total) * weight / total_weight
    return rows, profile


def build_replay(entities, hourly_data, recent_data):
    selected = {role: _choose(entities, role) for role in entities}
    hourly = _period_map(hourly_data)
    recent = _period_map(recent_data)
    room_roles = ('sunroom', 'kitchen', 'living_room', 'hallway')
    missing_roles = [role for role in room_roles + ('outdoor', 'ashp_power') if not selected.get(role)]
    missing_entities = [
        entity_id for role, entity_id in selected.items()
        if role != 'solar_forecast_daily' and entity_id and entity_id not in hourly and entity_id not in recent
    ]
    timestamps = sorted(set().union(*(set(rows) for rows in hourly.values())))
    rows = []
    for stamp in timestamps:
        date_value = stamp[:10]
        hour = int(stamp[11:13])
        rooms = [_point(hourly, selected.get(role), stamp, 'mean', 'state') if selected.get(role) else None for role in room_roles]
        if any(value is None for value in rooms):
            continue
        outdoor = _point(hourly, selected.get('outdoor'), stamp, 'mean', 'state') if selected.get('outdoor') else None
        wind = _point(hourly, selected.get('wind'), stamp, 'mean', 'state') if selected.get('wind') else None
        solar_energy = _point(hourly, selected.get('solar_energy'), stamp, 'change') if selected.get('solar_energy') else None
        if solar_energy is None and selected.get('solar_power'):
            power = _point(hourly, selected['solar_power'], stamp, 'mean', 'state')
            solar_energy = max(0.0, power) / 1000 if power is not None else None
        electric = _point(hourly, selected.get('ashp_energy'), stamp, 'change') if selected.get('ashp_energy') else None
        if electric is None and selected.get('ashp_power'):
            power = _point(hourly, selected['ashp_power'], stamp, 'mean', 'state')
            electric = max(0.0, power) / 1000 if power is not None else None
        house_power = _point(hourly, selected.get('house_power'), stamp, 'mean', 'state') if selected.get('house_power') else None
        row = {
            'z': stamp, 'day': date_value, 'hr': hour, 'rooms': rooms,
            'outdoor': outdoor, 'wind': wind,
            'windMax': _point(hourly, selected.get('gust'), stamp, 'max', 'mean') if selected.get('gust') else None,
            'windDirection': _point(hourly, selected.get('wind_direction'), stamp, 'mean', 'state') if selected.get('wind_direction') else None,
            'irradiance': _point(hourly, selected.get('irradiance'), stamp, 'mean', 'state') if selected.get('irradiance') else None,
            'electricKwh': electric,
            'thermalKwh': _point(hourly, selected.get('thermal_energy'), stamp, 'change') if selected.get('thermal_energy') else None,
            'spaceThermalKwh': _point(hourly, selected.get('thermal_energy'), stamp, 'change') if selected.get('thermal_energy') else None,
            'spaceElectricKwh': electric,
            'houseKwh': house_power / 1000 if house_power is not None else None,
            'solarKwh': solar_energy,
            'libbiSoc': _point(hourly, selected.get('libbi_soc'), stamp, 'mean', 'state') if selected.get('libbi_soc') else None,
            'libbiChargeKwh': _point(hourly, selected.get('libbi_charge'), stamp, 'change') if selected.get('libbi_charge') else None,
            'libbiDischargeKwh': _point(hourly, selected.get('libbi_discharge'), stamp, 'change') if selected.get('libbi_discharge') else None,
            'gridKwh': None,
            'solarPowerW': _point(hourly, selected.get('solar_power'), stamp, 'mean', 'state') if selected.get('solar_power') else None,
            'ashpPowerW': _point(hourly, selected.get('ashp_power'), stamp, 'mean', 'state') if selected.get('ashp_power') else None,
            'compressorHz': _point(hourly, selected.get('compressor_frequency'), stamp, 'mean', 'state') if selected.get('compressor_frequency') else None,
            'flowC': _point(hourly, selected.get('flow_temperature'), stamp, 'mean', 'state') if selected.get('flow_temperature') else None,
            'returnC': _point(hourly, selected.get('return_temperature'), stamp, 'mean', 'state') if selected.get('return_temperature') else None,
            'dhwC': _point(hourly, selected.get('dhw_temperature'), stamp, 'mean', 'state') if selected.get('dhw_temperature') else None,
            'thermostatTargetC': _point(hourly, selected.get('thermostat_target'), stamp, 'mean', 'state') if selected.get('thermostat_target') else None,
        }
        rows.append(row)

    five = []
    recent_stamps = sorted(set().union(*(set(values) for values in recent.values())))
    for stamp in recent_stamps:
        room = _point(recent, selected.get('sunroom'), stamp, 'mean', 'state') if selected.get('sunroom') else None
        if room is None:
            continue
        five.append({
            't': stamp, 'source': 'ha-history',
            'freq': _point(recent, selected.get('compressor_frequency'), stamp, 'mean', 'state') if selected.get('compressor_frequency') else None,
            'power': _point(recent, selected.get('ashp_power'), stamp, 'mean', 'state') if selected.get('ashp_power') else None,
            'netHeat': _point(recent, selected.get('heat_output'), stamp, 'mean', 'state') if selected.get('heat_output') else None,
            'heatOutput': _point(recent, selected.get('heat_output'), stamp, 'mean', 'state') if selected.get('heat_output') else None,
            'outlet': _point(recent, selected.get('flow_temperature'), stamp, 'mean', 'state') if selected.get('flow_temperature') else None,
            'inlet': _point(recent, selected.get('return_temperature'), stamp, 'mean', 'state') if selected.get('return_temperature') else None,
            'ambient': _point(recent, selected.get('outdoor'), stamp, 'mean', 'state') if selected.get('outdoor') else None,
            'room': room,
            'target': _point(recent, selected.get('thermostat_target'), stamp, 'mean', 'state') if selected.get('thermostat_target') else None,
            'dhw': _point(recent, selected.get('dhw_temperature'), stamp, 'mean', 'state') if selected.get('dhw_temperature') else None,
            'flow': None,
        })

    if not rows:
        raise ValueError('The Recorder bridge returned no hourly sunroom readings.')
    split = datetime.now(timezone.utc) - timedelta(days=10)
    historic = [row for row in rows if _as_utc(row['z']) < split]
    recent_hours = [row for row in rows if _as_utc(row['z']) >= split]
    if not historic:
        historic = rows[:-1]
        recent_hours = rows[-1:]
    if not recent_hours:
        historic, recent_hours = rows[:-1], rows[-1:]
    warnings = []
    if missing_roles:
        warnings.append('No matching Home Assistant entities found for: ' + ', '.join(missing_roles))
    if missing_entities:
        warnings.append('Recorder statistics are unavailable for: ' + ', '.join(sorted(set(missing_entities))))
    if len(rows) < 24 * 14:
        warnings.append(f'Only {len(rows)} hourly rows are available; temperature model fitting may be weak.')
    if not any(row.get('thermalKwh') is not None for row in rows):
        warnings.append('No long-term thermal-energy statistic was found; room heat response cannot be fitted reliably.')
    if not any(point.get('heatOutput') is not None for point in five):
        warnings.append('No five-minute thermal-output series was found; strategy validation will be incomplete.')
    if any(row.get('solarKwh') is None for row in rows):
        warnings.append('Solar energy is missing for some intervals; solar contribution may be undercounted.')
    if any(row.get('libbiSoc') is None for row in rows):
        warnings.append('Libbi state of charge is missing for some intervals; depletion estimates are unavailable or weak.')
    if selected.get('thermal_energy'):
        warnings.append('The thermal meter may include DHW output; Recorder does not provide a validated DHW/space-heat split.')
    if any(row.get('houseKwh') is None for row in rows):
        warnings.append('Whole-home electric demand is missing for some intervals; projected cost and Libbi dispatch are incomplete.')
    live_snapshot = {}
    for role, entity_id in selected.items():
        if not entity_id:
            continue
        item = next((entry for entry in entities.get(role, []) if entry.get('entity_id') == entity_id), {})
        try:
            value = float(item.get('state'))
        except (TypeError, ValueError):
            value = None
        live_snapshot[role] = {
            'entity_id': entity_id, 'value': value, 'unit': item.get('unit'),
            'last_changed': item.get('last_changed'), 'name': item.get('name'),
        }
        if role == 'solar_forecast_daily':
            live_snapshot[role].update({key: item.get(key) for key in ('forecast_date', 'fetched_at', 'status', 'east_kwh', 'west_kwh', 'garage_kwh') if item.get(key) is not None})
    bundle = {
        'historicHours': historic, 'recentHours': recent_hours, 'fiveMinute': five,
        'liveSnapshot': live_snapshot,
        # The existing room-response fitting code will derive these coefficients
        # from imported historic rows when no pre-fitted private bundle is present.
        'fit': {'params': []},
    }
    covered = [row['z'] for row in rows]
    return bundle, {
        'entity_roles': {role: selected[role] for role in selected if selected[role]},
        'missing_roles': missing_roles,
        'missing_entities': sorted(set(missing_entities)),
        'warnings': warnings,
        'covered_from': min(covered), 'covered_to': max(covered),
        'hourly_rows': len(rows), 'five_minute_rows': len(five),
        'live_snapshot': live_snapshot,
    }


def sync_once():
    options = _read_options()
    base_url = str(options.get('bridge_url', '')).strip()
    secret = str(options.get('bridge_secret', '')).strip()
    if base_url != 'http://homeassistant:8123/api/energy_lab_bridge' or not secret:
        return {'ok': False, 'error': 'Configure the local read-only bridge URL and shared key in the Energy Lab app settings.'}
    try:
        history_days = min(400, max(30, int(options.get('history_days', DEFAULT_DAYS))))
    except (TypeError, ValueError):
        history_days = DEFAULT_DAYS
    end = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    cutoff = end - timedelta(days=history_days)
    try:
        health = _bridge_get(base_url, secret, 'health')
        if not health.get('ok'):
            raise ValueError('The Home Assistant bridge did not confirm readiness.')
        discovered = _bridge_get(base_url, secret, 'entities')
        allowed = discovered.get('entities', {})
        ids = sorted({entity['entity_id'] for role, values in allowed.items() if role != 'solar_forecast_daily' for entity in values})
        if not ids:
            raise ValueError('The read-only bridge found no matching Home Assistant measurements.')
        previous_bundle = _load_private_json('recorder-replay.json')
        previous_status = _load_private_json('import-status.json') or {}
        previous_roles = previous_status.get('entity_roles', {})
        current_selected = {role: _choose(allowed, role) for role in allowed}
        same_entities = previous_bundle and previous_roles == {r: e for r, e in current_selected.items() if e}
        previous_time = _as_utc(previous_status.get('last_success'))
        incremental = bool(same_entities and previous_time and end - previous_time < timedelta(hours=24))
        start = cutoff
        if incremental:
            prior_covered = _as_utc(previous_status.get('covered_to'))
            if prior_covered is not None:
                start = max(cutoff, prior_covered - timedelta(hours=2))
        params = {
            'start': start.isoformat(), 'end': end.isoformat(), 'period': 'hour',
            'entities': ','.join(ids),
        }
        hourly = _bridge_get(base_url, secret, 'statistics', params)
        old_five = previous_bundle.get('fiveMinute', []) if isinstance(previous_bundle, dict) else []
        last_five = _as_utc(old_five[-1].get('t')) if old_five else None
        recent_start = max(end - timedelta(days=10), last_five - timedelta(minutes=10) if incremental and last_five else end - timedelta(days=10))
        recent = _bridge_get(base_url, secret, 'statistics', {
            **params, 'start': recent_start.isoformat(), 'period': '5minute',
        })
        discovered_warnings = [
            f"No Home Assistant entity matched the {role} category."
            for role in discovered.get('missing_roles', [])
        ]
        bundle, summary = build_replay(allowed, hourly, recent)
        old_hours = (previous_bundle or {}).get('historicHours', []) + (previous_bundle or {}).get('recentHours', [])
        new_hours = bundle['historicHours'] + bundle['recentHours']
        profile_rows = [row for row in old_hours + new_hours if _as_utc(row.get('z')) and _as_utc(row['z']) >= cutoff]
        weather_info = _bridge_get(base_url, secret, 'forecast')
        weather_entities = weather_info.get('entities', [])
        weather_entity = next((value for value in weather_entities if 'forecast' in value.lower()), weather_entities[0] if weather_entities else None)
        forecast_meta = {'weather_entity': weather_entity, 'target_day': (end + timedelta(days=1)).strftime('%Y-%m-%d')}
        if weather_entity:
            forecast_payload = _bridge_get(base_url, secret, 'forecast', {'entity_id': weather_entity})
            target_day = forecast_meta['target_day']
            live = bundle.get('liveSnapshot', {})
            daily = live.get('solar_forecast_daily', {})
            solar_total = daily.get('value')
            if daily.get('forecast_date') and str(daily['forecast_date'])[:10] != target_day:
                solar_total = None
            forecast_rows, solar_profile = _build_forecast_rows(forecast_payload, target_day, profile_rows, solar_total)
            bundle['forecastHours'] = forecast_rows
            forecast_meta.update({
                'hourly_forecast_rows': len(forecast_rows),
                'target_day_rows': sum(row.get('day') == target_day for row in forecast_rows),
                'solar_forecast_kwh': solar_total,
                'solar_profile_source': 'measured Home Assistant hourly solar history, scaled to the daily Home Assistant forecast',
                'weather_error': forecast_payload.get('error'),
            })
            if forecast_meta['target_day_rows'] < 24:
                summary['warnings'].append(f"Home Assistant weather forecast covers only {forecast_meta['target_day_rows']} of 24 hours on {target_day}.")
            if solar_total is None:
                summary['warnings'].append(f'No matching Home Assistant daily solar forecast was available for {target_day}; future solar gain is incomplete.')
            if not any(row.get('irradiance') is not None for row in forecast_rows if row.get('day') == target_day):
                summary['warnings'].append('Home Assistant weather provides no usable cloud/irradiance forecast; solar gain is not modelled for the target day.')
            elif forecast_payload.get('forecast') and not any(item.get('solar_irradiance') is not None for item in forecast_payload['forecast']):
                summary['warnings'].append('Hourly irradiance is estimated by scaling measured local irradiance by forecast cloud cover; it is not a direct forecast measurement.')
        else:
            bundle['forecastHours'] = []
            forecast_meta['target_day_rows'] = 0
            summary['warnings'].append('Home Assistant has no weather entity with an hourly forecast; a future-day strategy simulation cannot be produced.')
        bundle['forecastMeta'] = forecast_meta
        bundle.setdefault('liveSnapshot', {})['captured_at'] = end.isoformat()
        summary['warnings'] = discovered_warnings + summary['warnings']
        bundle = _merge_bundle(previous_bundle, bundle, history_days)
        combined_hours = bundle['historicHours'] + bundle['recentHours']
        if combined_hours:
            summary['covered_from'] = min(row['z'] for row in combined_hours)
            summary['covered_to'] = max(row['z'] for row in combined_hours)
            summary['hourly_rows'] = len(combined_hours)
        summary['five_minute_rows'] = len(bundle['fiveMinute'])
        summary['live_snapshot'] = bundle.get('liveSnapshot', {})
        summary['forecast'] = forecast_meta
        raw = json.dumps(bundle, separators=(',', ':'), allow_nan=False).encode()
        if len(raw) > 8 * 1024 * 1024:
            raise ValueError('Imported history exceeds the current private replay storage limit.')
        _save_replay(raw)
        return {
            'ok': True, 'last_success': datetime.now(timezone.utc).isoformat(),
            'source': 'Home Assistant Recorder statistics via local read-only bridge',
            **summary,
        }
    except HTTPError as error:
        return {'ok': False, 'error': f'Home Assistant bridge returned HTTP {error.code}.'}
    except (URLError, TimeoutError, ValueError, OSError, json.JSONDecodeError) as error:
        return {'ok': False, 'error': str(error)[:400] or 'The Home Assistant history sync failed.'}
