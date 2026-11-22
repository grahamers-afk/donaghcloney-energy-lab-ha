"""Local, read-only statistics bridge for the Donaghcloney Energy Lab."""

from homeassistant.components.http import HomeAssistantView
from homeassistant.components.recorder.statistics import statistics_during_period
from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util
from datetime import datetime, timedelta, timezone
import hmac
import ipaddress
import re

from .const import CONF_SECRET, DOMAIN, ROLE_MATCHES, TEMPERATURE_ROLES

MAX_HOURLY_DAYS = 400
MAX_FIVE_MINUTE_DAYS = 10
ROLE_DEVICE_CLASS = {
    **{role: "temperature" for role in TEMPERATURE_ROLES},
    "wind": "wind_speed", "gust": "wind_speed", "wind_direction": "wind_direction",
    "irradiance": "irradiance", "solar_power": "power", "house_power": "power",
    "ashp_power": "power", "heat_output": "power", "flow_temperature": "temperature",
    "return_temperature": "temperature", "dhw_temperature": "temperature",
}


def _iso(value):
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if result.tzinfo is None:
        return None
    return result.astimezone(timezone.utc)


def _role_for(entity_id, state):
    if state is None:
        return None
    attrs = state.attributes
    friendly = str(attrs.get("friendly_name", "")).lower()
    full = f"{entity_id.lower()} {friendly}"
    device_class = attrs.get("device_class")
    for role, needles in ROLE_MATCHES.items():
        if not any(needle in full for needle in needles):
            continue
        expected = ROLE_DEVICE_CLASS.get(role)
        if expected and device_class not in (expected, None):
            continue
        if role == "upstairs" and device_class != "temperature":
            continue
        if role in {"solar_energy", "ashp_energy", "thermal_energy", "libbi_charge", "libbi_discharge"}:
            if attrs.get("state_class") not in {"total", "total_increasing"}:
                continue
        return role
    # Capture other temperature sensors as extra room inputs, excluding weather,
    # outdoor, garden, and plumbing measurements.
    if device_class == "temperature" and any(word in full for word in ("temperature", "temp")):
        if not any(word in full for word in ("outdoor", "ambient", "garden", "water", "coil", "exhaust", "dew point", "wet bulb")):
            if any(word in full for word in ("room", "bedroom", "hall", "kitchen", "sunroom", "living", "bathroom")):
                return "other_room"
    return None


def _discover(hass):
    matches = {}
    labels = {}
    state_class = {}
    for state in hass.states.async_all("sensor"):
        role = _role_for(state.entity_id, state)
        if role is None:
            continue
        matches.setdefault(role, []).append(state.entity_id)
        labels[state.entity_id] = {
            "name": state.attributes.get("friendly_name", state.entity_id),
            "unit": state.attributes.get("unit_of_measurement"),
            "device_class": state.attributes.get("device_class"),
            "state_class": state.attributes.get("state_class"),
            "state": state.state,
            "last_changed": state.last_changed.isoformat(),
        }
        if role == "solar_forecast_daily":
            for key in ("forecast_date", "fetched_at", "status", "east_kwh", "west_kwh", "garage_kwh"):
                if key in state.attributes:
                    labels[state.entity_id][key] = state.attributes[key]
        state_class[state.entity_id] = state.attributes.get("state_class")
    for role in matches:
        matches[role].sort()
    return matches, labels, state_class


class EnergyLabBridgeView(HomeAssistantView):
    url = "/api/energy_lab_bridge/{endpoint}"
    name = "api:energy_lab_bridge"
    requires_auth = False

    def __init__(self, hass, entry):
        self.hass = hass
        self.entry = entry

    def _authorized(self, request):
        supplied = request.headers.get("X-Energy-Lab-Key", "")
        try:
            peer_is_local = ipaddress.ip_address(request.remote) in ipaddress.ip_network("172.30.0.0/16")
        except (ValueError, TypeError):
            peer_is_local = False
        secret = self.entry.options.get(CONF_SECRET, self.entry.data.get(CONF_SECRET, ""))
        return peer_is_local and bool(secret) and supplied.isascii() and hmac.compare_digest(supplied, secret)

    async def get(self, request, endpoint):
        if not self._authorized(request):
            return self.json_message("Unauthorized", status_code=401)
        if endpoint == "health":
            return self.json({"ok": True, "bridge": DOMAIN, "ha_time": dt_util.utcnow().isoformat()})
        if endpoint == "forecast":
            weather_entities = [
                state.entity_id for state in self.hass.states.async_all("weather")
                if self.hass.states.get(state.entity_id) is not None
            ]
            requested_weather = request.query.get("entity_id", "")
            if not requested_weather:
                return self.json({"entities": weather_entities})
            if requested_weather not in weather_entities:
                return self.json_message("Select a Home Assistant weather entity", status_code=400)
            try:
                result = await self.hass.services.async_call(
                    "weather", "get_forecasts",
                    {"entity_id": requested_weather, "type": "hourly"},
                    blocking=True, return_response=True,
                )
            except Exception as error:
                return self.json({"entities": weather_entities, "error": str(error)[:200]})
            forecast = (result or {}).get(requested_weather, {}).get("forecast", [])
            weather_state = self.hass.states.get(requested_weather)
            return self.json({
                "entity_id": requested_weather, "forecast": forecast,
                "wind_speed_unit": weather_state.attributes.get("wind_speed_unit"),
                "temperature_unit": weather_state.attributes.get("temperature_unit"),
            })
        matches, labels, _ = _discover(self.hass)
        if endpoint == "entities":
            data = {}
            missing = []
            for role, ids in matches.items():
                data[role] = [{"entity_id": entity_id, **labels[entity_id]} for entity_id in ids]
            required = {"sunroom", "kitchen", "living_room", "hallway", "outdoor", "ashp_power"}
            missing = sorted(required - matches.keys())
            return self.json({"entities": data, "missing_roles": missing})
        if endpoint != "statistics":
            return self.json_message("Not found", status_code=404)

        start = _iso(request.query.get("start", ""))
        end = _iso(request.query.get("end", ""))
        period = request.query.get("period", "hour")
        if start is None or end is None or end <= start:
            return self.json_message("Use timezone-aware start and end timestamps", status_code=400)
        if period not in {"hour", "5minute"}:
            return self.json_message("Supported periods: hour, 5minute", status_code=400)
        max_days = MAX_FIVE_MINUTE_DAYS if period == "5minute" else MAX_HOURLY_DAYS
        if end - start > timedelta(days=max_days) or end > dt_util.utcnow() + timedelta(minutes=1):
            return self.json_message("Requested period exceeds the read-only bridge limit", status_code=400)
        requested = {value for value in request.query.get("entities", "").split(",") if value}
        allowed = {entity_id for values in matches.values() for entity_id in values}
        if not requested or len(requested) > 80 or not requested <= allowed:
            return self.json_message("Select only discovered Energy Lab entities", status_code=400)
        # No calls to services or state-changing APIs exist in this bridge. The
        # Recorder query is executed using Home Assistant's read-only session.
        query = {
            "start_time": start,
            "end_time": end,
            "statistic_ids": requested,
            "period": period,
            "units": None,
            "types": {"mean", "min", "max", "sum", "state", "change"},
        }
        result = await self.hass.async_add_executor_job(
            statistics_during_period,
            self.hass,
            query["start_time"], query["end_time"], query["statistic_ids"],
            query["period"], query["units"], query["types"],
        )
        cleaned = {}
        for entity_id, rows in result.items():
            cleaned[entity_id] = [
                {key: value for key, value in row.items() if key in {"start", "end", "mean", "min", "max", "sum", "change", "state"}}
                for row in rows
            ]
        return self.json({"period": period, "start": start.isoformat(), "end": end.isoformat(), "statistics": cleaned})


async def async_setup_entry(hass: HomeAssistant, entry):
    secret = entry.options.get(CONF_SECRET, entry.data.get(CONF_SECRET, ""))
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", secret):
        return False
    hass.http.register_view(EnergyLabBridgeView(hass, entry))
    return True
