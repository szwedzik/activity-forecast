# Questions I would have asked a PM, and what I assumed instead

Q1 · does "the next 7 days" include today, and whose today?
Assumed today plus six, in the town's own timezone. Switching to tomorrow-plus-six is one line; we fetch 8 days so both readings are covered. D§1.

Q2 · rank the days within an activity, or the activities within a day?
Assumed days within an activity, best first, each with an absolute 0–100 score. The other view can be derived from the same response. If they wanted that one, a bestActivityPerDay field from the same scores would do it. D§1, D§8.1.

Q3 · which "Paris"?
Assumed the geocoder's top hit; it orders by prominence, so Paris, France before Paris, Texas. An optional country code narrows it, and searchLocations lists candidates. D§2.1.

Q4 · the town itself, or the nearest resort or beach?
Assumed the town's own grid cell. Skiing for Chamonix means the valley floor; surfing needs a wave-model cell nearby, otherwise it is "not applicable". A resort or beach lookup is a separate data source and out of scope. D§1, D§7.3–7.4.

Q5 · how does weather affect indoor sightseeing at all?
Assumed it does not, except that a bad outdoor day makes an indoor day more attractive, and a storm makes getting between venues harder. Opening days and hours are ignored. D§7.6.

Q6 · are scores comparable across towns?
Assumed yes: the same curves everywhere, and the rank is only a sort within one request. D§7.2.

Q7 · what scale, what deployment?
Assumed one instance at evaluation scale on Open-Meteo's non-commercial tier. Multi-instance would need Postgres and a jobs table D§6.2, D§5.4.

Q8 · omit surfing inland, or return it?
Assumed return it, with applicable: false, a reason, and seven NOT_APPLICABLE days, so the shape is stable for clients. D§7.4.

Q9 · is serving slightly stale data acceptable, and should the client know?
Assumed yes, up to 24 h while a refresh runs, and the response says stale true plus when the data was fetched. D§6.1.

Q10 · does "persist it" mean keep history?
Assumed no: the newest snapshot per location and source, older ones pruned after 48 h. Immutability is there for correctness under concurrent refresh, not for analytics. D§5.3.
