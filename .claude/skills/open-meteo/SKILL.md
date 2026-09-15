---
name: open-meteo
description: The things that bite when working with the three Open-Meteo endpoints this service uses (geocoding, forecast, marine) and where the verified facts live. Use when writing or changing adapters, zod schemas, fixtures, feature extraction, or anything that parses an Open-Meteo payload.
---

The facts are in D§2 of `docs/DESIGN.md`, verified with live calls on 2026-09-10. Read that section; do not work from memory. This file is only the list of things that bite.

- Geocoding: `results` is absent, not `[]`, on a miss. `countryCode` filters server-side. Admin regions are not searchable, so pass the user's text through trimmed. `id` is the GeoNames id and the natural key.
- Marine: inland places get HTTP 200 with every value null. That, and only that, means "surfing not applicable". Coastal places get a nearby sea cell; report the haversine distance, never threshold on it.
- Time: pass the geocoder's IANA timezone explicitly (D-012). `hourly.time` is a local wall-clock string with no offset; local hour is `t.slice(11, 13)`, local date `t.slice(0, 10)`. DST days have 23 or 25 rows, so prefix-match the date and never assume 24.
- Every array element may be null. Type `number | null`; skip nulls when aggregating.
- Units: snowfall cm, snow depth metres, visibility metres, wind km/h, sunshine and daylight in seconds. Liquid rain is `max(0, precipitation − snowfall / 0.7)`: precipitation is mm of water and snowfall is cm of snow, so the 7:1 ratio is 0.7 across those units. Measured at −20 °C, 0.1 mm of precipitation is 0.07 cm of snow (D-029).
- Weather and marine snapshots may start on different dates. Join rows by the `time` string, never by index.
- Fixtures live in `test/fixtures/open-meteo/`; the README there has the capture date, the query strings, and each fixture's first daily date (tests use it as "today"). Chamonix and Denver marine files are the all-null case. Re-capture only when the user asks.
- Failures (D§6.4): timeout; one retry on network error or 5xx; none on 4xx or 429; a zod failure is an UpstreamError too. A marine outage degrades only surfing.
