import voluptuous as vol
from homeassistant import config_entries
from homeassistant.core import callback
from homeassistant.helpers import selector
from .const import CONF_SECRET, DOMAIN


_shared_key = vol.All(
    selector.TextSelector(selector.TextSelectorConfig(type=selector.TextSelectorType.PASSWORD)),
    vol.Match(r"^[A-Za-z0-9_-]{32,128}$"),
)


class EnergyLabBridgeConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input=None):
        if user_input is not None:
            await self.async_set_unique_id("energy-lab-local-bridge")
            self._abort_if_unique_id_configured()
            return self.async_create_entry(title="Energy Lab read-only bridge", data=user_input)
        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema({vol.Required(CONF_SECRET): _shared_key}),
            description_placeholders={"scope": "Read-only Energy Lab history access"},
        )

    @staticmethod
    @callback
    def async_get_options_flow(config_entry):
        return EnergyLabBridgeOptionsFlow()


class EnergyLabBridgeOptionsFlow(config_entries.OptionsFlow):
    async def async_step_init(self, user_input=None):
        if user_input is not None:
            return self.async_create_entry(title="", data=user_input)
        return self.async_show_form(
            step_id="init", data_schema=vol.Schema({vol.Required(CONF_SECRET): _shared_key})
        )
