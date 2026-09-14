/**
 * The API, as SDL (D§8.1). Embedded as a string rather than a `.graphql` file so `tsc`
 * output needs no asset-copy step and `npm start` cannot fail on a missing file (D-009).
 * Editors still highlight it through the `/* GraphQL *\/` marker.
 */

export const typeDefs = /* GraphQL */ `
  """
  Calendar date in the location's local timezone, YYYY-MM-DD.
  """
  scalar Date
  """
  ISO-8601 instant in UTC.
  """
  scalar DateTime

  enum Activity {
    SKIING
    SURFING
    OUTDOOR_SIGHTSEEING
    INDOOR_SIGHTSEEING
  }

  enum Suitability {
    EXCELLENT
    GOOD
    FAIR
    POOR
    UNSUITABLE
    NOT_APPLICABLE
  }

  enum FactorKind {
    CRITERION
    GATE
  }

  type Query {
    """
    Rank the next 7 days (today + 6, local time) for each activity at a city or town.
    """
    activityRankings(
      city: String!
      "ISO 3166-1 alpha-2 (e.g. \\"US\\") to disambiguate names like Paris or Springfield."
      countryCode: String
      "Defaults to all four."
      activities: [Activity!]
    ): ActivityRankings!

    """
    Candidate places for a name, in the geocoder's relevance order. Use to disambiguate.
    """
    searchLocations(query: String!, countryCode: String, limit: Int = 5): [Location!]!
  }

  type ActivityRankings {
    location: Location!
    forecast: ForecastMeta!
    "Chronological weather summary for the 7 days."
    days: [DaySummary!]!
    "One entry per requested activity."
    rankings: [ActivityRanking!]!
  }

  type Location {
    "GeoNames id from the geocoder; stable across databases."
    id: ID!
    name: String!
    country: String
    countryCode: String
    admin1: String
    latitude: Float!
    longitude: Float!
    elevationM: Float
    timezone: String!
  }

  type ForecastMeta {
    "Always \\"open-meteo\\"."
    source: String!
    weatherFetchedAt: DateTime!
    marineFetchedAt: DateTime
    "True when either served snapshot is past its freshness TTL (a refresh is in progress, or upstream was unavailable)."
    stale: Boolean!
    marineAvailable: Boolean!
    "Distance from the town to the wave-model cell used, when marine data exists."
    marineCellDistanceKm: Float
    timezone: String!
  }

  """
  Plain weather for one day. Every measurement is nullable: Open-Meteo may leave any
  value out for some models or regions (D§2.2), and one gap should cost that value
  rather than the whole response (D-022).
  """
  type DaySummary {
    date: Date!
    weatherCode: Int
    "Human summary of the WMO code, e.g. \\"Light rain\\"."
    summary: String!
    tempMaxC: Float
    tempMinC: Float
    precipitationMm: Float
    precipitationProbabilityMax: Int
    snowfallCm: Float
    windMaxKmh: Float
    sunshineHours: Float
    waveHeightMaxM: Float
  }

  type ActivityRanking {
    activity: Activity!
    applicable: Boolean!
    "Why the activity cannot be assessed here, or a general caveat."
    note: String
    "Best day first."
    days: [ActivityDayScore!]!
  }

  type ActivityDayScore {
    date: Date!
    rank: Int!
    "0–100."
    score: Int!
    suitability: Suitability!
    "0–1; decays with forecast lead time and missing data."
    confidence: Float!
    "Most influential first."
    factors: [ScoreFactor!]!
  }

  type ScoreFactor {
    name: String!
    kind: FactorKind!
    "Human-readable value with units, e.g. \\"1.4 m mean wave height\\"."
    value: String!
    "Criterion desirability or gate multiplier, 0–1."
    effect: Float!
    weight: Float
    note: String
  }
`;
