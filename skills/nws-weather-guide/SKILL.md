---
name: nws-weather-guide
description: Reconcile nws_* forecasts, active alerts, station trends, and forecaster discussions for a time-and-location weather decision. Use when planning outdoor activity, checking a claimed all-clear, comparing an alert update, or explaining changing conditions across these sources.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

Use this workflow when a conclusion depends on several NWS products agreeing on the place and time being discussed.

## Gates

- Before reporting no hazards, check what the alert search actually covered. An empty point search means no active alerts matched that point and the applied filters. Check the forecast or county zone returned by `nws_get_forecast`, or a broader area, in separate searches when assessing local hazards; inspect each broader match's affected area before applying it to the point. State the scope and filters checked; an empty result is not a forecast of safe conditions.
- Before combining precipitation amounts for an activity window, inspect each native interval and its unit. Amount intervals cover the full grid feed independently of the forecast period page, so another hourly page can repeat the same amount intervals. Do not add those copies, treat a whole interval as a total for only part of it, or add overlapping station 1-, 3-, and 6-hour accumulations as independent increments. Report unavailable or insufficient window coverage instead of inventing a total.
- Before comparing changing conditions, align the forecast period, observation timestamp, and discussion issuance with the requested time. Keep a station trend on one station ID. If stale or sparse observations require another station, start a separate series and identify the change rather than splicing the readings into a trend.
- Before using a forecaster discussion to explain a local decision, check its issuance and the locations and times its selected text discusses. An office discussion supplies reasoning across the office's area; retain the local forecast and active alert instructions as separate evidence.

## Workflows

### Plan an activity window

Read the forecast periods that overlap the activity, then check alerts for that location. Use observations for measured conditions near the station, and the office discussion when the decision needs an explanation of uncertainty or changing weather. Report the relevant time window and any stale or missing evidence. For an amount question, apply the interval gate before calculating anything.

### Check an all-clear or changed alert

For an all-clear claim, apply the geographic search gate before concluding no active alerts matched. For “what changed,” start from the current search result and use `nws_get_alert` to read the referenced prior messages. Compare the affected area, hazard timing, instructions, and reported hazard tags. Keep superseded messages separate from current active-alert evidence; a prior message's disappearance from active search does not by itself show that its hazard ended.

### Explain a station trend

Use the station ID from `nws_get_observations` for `nws_get_observation_history`, or select a station with `nws_find_stations` first. Read the actual timestamps across the requested window rather than treating a number of records as a duration. Compare reported measurements within that station's series; missing readings do not establish a rise, fall, or dry interval. Add the relevant office discussion for the forecaster's explanation, clearly separated from the measured trend.
