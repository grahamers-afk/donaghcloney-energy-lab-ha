DOMAIN = "energy_lab_bridge"
PLATFORMS = []
CONF_SECRET = "shared_secret"

# Friendly-name/object-id matching is deliberately confined to the small set of
# measurements the Energy Lab consumes. The bridge never enumerates or returns
# the full Home Assistant state machine.
ROLE_MATCHES = {
    "sunroom": ("sunroom",),
    "kitchen": ("kitchen",),
    "living_room": ("living room", "snug"),
    "hallway": ("hallway",),
    "dining_room": ("heating - dining room", "dining room temperature"),
    "thermostat_target": ("heating - downstairs target", "downstairs target"),
    "downstairs_target": ("downstairs target",),
    "upstairs": ("upstairs", "bedroom"),
    "outdoor": ("outdoor temperature", "ambient temp [t04]"),
    "wind": ("outdoor wind speed", "wind speed average"),
    "gust": ("outdoor wind gust", "wind gust"),
    "wind_direction": ("outdoor wind direction",),
    "irradiance": ("solar irradiance"),
    "ashp_power": ("heat pump true power", "heat pump electric power"),
    "ashp_energy": ("heat pump electric energy total", "heat pump electricity total", "heat pump daily electric consumption"),
    "thermal_energy": ("heat pump thermal energy total", "thermal energy total", "heat pump daily heat output"),
    "heat_output": ("heat pump output", "thermal power"),
    "compressor_frequency": ("warmlink compressor freq [t30]", "compressor frequency"),
    "flow_temperature": ("warmlink outlet water temp [t02]", "heat pump flow temperature"),
    "return_temperature": ("warmlink inlet water temp [t01]", "heat pump return temperature"),
    "dhw_temperature": ("warmlink dhw temp [t08]", "hot water temperature"),
    "solar_power": ("total solar generation", "total pv generation"),
    "solar_energy": ("total solar energy", "solar generation total"),
    "solar_forecast_daily": ("solar forecast tomorrow adjusted", "solar trial forecast tomorrow", "estimated energy production - tomorrow"),
    "house_power": ("home consumption", "house consumption"),
    "libbi_soc": ("soc", "libbi soc", "libbi state of charge"),
    "libbi_capacity": ("battery size", "libbi battery capacity"),
    "libbi_charge_target": ("charge target", "libbi charge target"),
    "libbi_charge": ("battery charge today", "libbi battery charge"),
    "libbi_discharge": ("battery discharge today", "libbi battery discharge"),
    "libbi_grid_power": ("power grid", "libbi grid power"),
}

TEMPERATURE_ROLES = {
    "sunroom", "kitchen", "living_room", "hallway", "dining_room", "upstairs",
    "outdoor", "flow_temperature", "return_temperature", "dhw_temperature",
}
