# Open-Meteo fixtures

Captured from the live API on **2026-09-14** (`2026-09-14T18:12:23.778Z`) by
`npm run capture-fixtures`. Tests read these files instead of the network (AGENTS.md),
and they pin the dates below, so re-capturing means fixing tests up afterwards.

| Town | Geocoder top hit | Coordinates | Timezone | First `daily.time` | Marine |
|---|---|---|---|---|---|
| Chamonix | Chamonix, FR | 45.92375, 6.86933 | Europe/Paris | `2026-09-14` | all null (inland) |
| Lisbon | Lisbon, PT | 38.72509, -9.1498 | Europe/Lisbon | `2026-09-14` | has data (coastal) |
| Denver | Denver, US | 39.73915, -104.9847 | America/Denver | `2026-09-14` | all null (inland) |

**Use the first `daily.time` as "today" in tests.** The payload covers that date and the
seven after it; the service reports today plus six (Q1), so injecting that date exercises a
full window with a day to spare.

Marine coverage is the "surfing not applicable" signal: an inland town returns HTTP 200 with
every value `null` rather than an error (D§2.3). Here Chamonix and Denver are the inland
cases and Lisbon the coastal one.

## Geocoding fixtures

| File | Query | Why |
|---|---|---|
| `geocoding.chamonix.json` | `name=Chamonix&count=5` | alpine town |
| `geocoding.lisbon.json` | `name=Lisbon&count=5` | coastal city |
| `geocoding.denver.json` | `name=Denver&count=5` | inland city |
| `geocoding.springfield.json` | `name=Springfield&count=10` | ambiguous name, for disambiguation |
| `geocoding.nomatch.json` | `name=zzqqxwv-not-a-place&count=5` | no match: `results` is absent, not an empty array |

Every geocoding request also carries `language=en&format=json`.

## Endpoints

```
geocoding: https://geocoding-api.open-meteo.com/v1/search
forecast:  https://api.open-meteo.com/v1/forecast
marine:    https://marine-api.open-meteo.com/v1/marine
```

## Forecast and marine queries

Both take `latitude`, `longitude`, `forecast_days=8` and the town's IANA
`timezone` passed explicitly rather than `auto`, so local dates line up by construction
(D-012).

```
forecast hourly: temperature_2m,apparent_temperature,precipitation,precipitation_probability,snowfall,snow_depth,weather_code,cloud_cover,visibility,wind_speed_10m,wind_gusts_10m,is_day
forecast daily:  sunrise,sunset,sunshine_duration,daylight_duration,uv_index_max,weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,precipitation_sum,rain_sum,snowfall_sum,precipitation_hours,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,cloud_cover_mean
marine hourly:   wave_height,wave_direction,wave_period,wind_wave_height,wind_wave_period,swell_wave_height,swell_wave_period,swell_wave_direction,sea_surface_temperature
marine daily:    wave_height_max,wave_period_max,swell_wave_height_max,swell_wave_period_max
```
