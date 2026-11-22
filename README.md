# Donaghcloney Energy Lab for Home Assistant OS

An energy planning simulator with a separate historical heating replay. The daily simulator has editable tariff, heating, solar, battery and EV scenarios, charts, energy-balance checks and CSV export. It runs independently of historical data.

The app accepts a private replay bundle through Home Assistant Ingress. Imported data and fitted room coefficients are stored on the Home Assistant host. The app requires no Home Assistant API access or credentials. Scenario edits are stored in the current browser.

See [app documentation](donaghcloney_energy_lab/DOCS.md) for installation, import, backups and model limits.

## Local tests

Run from the repository root with Node.js and Python 3.

```sh
node --test tests/*.mjs
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -v
```

The HTTP tests use an ephemeral loopback server and temporary storage. Set `ENERGY_LAB_PRIVATE_REPLAY` to an absolute path outside this repository to additionally exercise upload of an existing bundle. The standard tests use synthetic data. A real Supervisor and Ingress are required to verify installation, browser rendering through Home Assistant and role enforcement.
