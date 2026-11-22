# Donaghcloney Energy Lab

## Install and open

1. Sign in to Home Assistant OS as an administrator. Open **Settings → Apps → Install app** or **App Store**.
2. Open **⋮ → Repositories**, paste the approved hosted Git repository URL and select **Add**.
3. Find **Donaghcloney Energy Lab**, select **Install**, then **Start**.
4. Select **Open Web UI**. Enable **Show in sidebar** if you want direct access from the sidebar.
5. Confirm the daily simulator opens. To enable replay, select your private `replay-bundle.json` under **Heating replay** and choose **Import or replace replay**. Reload the page and check that the replay still opens.

The app has no configuration options. Home Assistant authenticates the Ingress session and provides the administrator-only panel. No port is published.

## Private replay data

The importer accepts the existing Energy Lab export format, up to 8 MiB. It expects `historicHours`, `recentHours`, `fiveMinute` and `fit.params`. Hourly rows use UTC timestamps, UTC date and hour, four room temperatures in model order, and numeric energy and weather fields. Five-minute samples can use named fields or the original packed arrays. The four room fits have seven coefficients each. A generic Recorder CSV export needs conversion before import.

An accepted import replaces the previous replay in the app’s private `/data/replay-bundle.json` using a single file replacement. If validation fails, the previous replay remains available. The browser reads historical data through Ingress as needed. Only replay input fields and coefficients are stored. Keep the original bundle for provenance and re-import.

Make a Home Assistant backup that includes this app before updating or replacing its data. Treat the backup as private because it contains app data. Start the updated app and check the simulator and replay. To roll back, restore the app and its data from a compatible pre-update backup, keeping the original code package and private bundle separately. Scenario settings are browser-local and CSV export is a record of inputs and calculations.

## Interpreting replay

The daily simulator estimates flows and costs for a repeating day. Replay presents historical measurements, calculated summaries and heating-strategy estimates. Compare weather over windows with equal hourly coverage. Matching considers outdoor temperature, wind speed, available wind maxima and irradiance, and starting room temperatures. Wind direction requires additional measurements and modelling.

Compressor stop labels are heuristic. The 15-minute holdout supplies measured heat output and weather to test conditional room response. The battery estimate uses a simplified dispatch rule. Use the correct meter for each energy flow. A CT repurposed to measure the heat pump belongs in the heat-pump input and cannot supply battery discharge measurements.
