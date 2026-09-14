/**
 * One request, start to finish (D§4.1): resolve the town, get a forecast for it, work out
 * what "today" means there, and rank the days.
 *
 * Deliberately thin. Every decision worth making has already been made by the two
 * services below it; this one only puts the answer together.
 */
import type { Activity, DaySummary, ForecastData } from '../domain/forecast/types.js';
import { ACTIVITIES } from '../domain/forecast/types.js';
import { summariseDays } from '../domain/forecast/features.js';
import type { Location } from '../domain/location.js';
import type { ActivityRanking } from '../domain/scoring/index.js';
import { rankActivities } from '../domain/scoring/index.js';
import type { Clock } from './clock.js';
import { locationNotFound } from './errors.js';
import type { ForecastBundle, ForecastService } from './forecastService.js';
import { todayIn } from './localDate.js';
import type { LocationService } from './locationService.js';
import { NOT_FOUND } from './locationService.js';

/** What the API reports about the data behind an answer (D§8.1 `ForecastMeta`). */
export interface ForecastMeta {
  readonly source: 'open-meteo';
  readonly weatherFetchedAt: string;
  readonly marineFetchedAt?: string | undefined;
  /** True when either served snapshot is past its TTL (D-012). */
  readonly stale: boolean;
  readonly marineAvailable: boolean;
  readonly marineCellDistanceKm?: number | undefined;
  readonly timezone: string;
}

export interface RankingResult {
  readonly location: Location;
  readonly forecast: ForecastMeta;
  readonly days: readonly DaySummary[];
  readonly rankings: readonly ActivityRanking[];
}

export interface RankingService {
  rank(city: string, countryCode?: string, activities?: readonly Activity[]): Promise<RankingResult>;
}

export interface RankingServiceOptions {
  readonly locations: LocationService;
  readonly forecasts: ForecastService;
  readonly clock: Clock;
}

/**
 * Why surfing cannot be judged, in words that name the place. The domain cannot write
 * this because it does not know where it is (D§7.4).
 */
function surfingNote(location: Location, reason: 'no-coverage' | 'outage'): string {
  return reason === 'no-coverage'
    ? `No wave-model coverage near ${location.name}; Open-Meteo's marine grid returns no data for inland locations.`
    : 'Wave data is temporarily unavailable, so surfing cannot be assessed right now.';
}

function metaOf(bundle: ForecastBundle): ForecastMeta {
  const { location, weather, marine } = bundle;
  const marineOk = marine.kind === 'ok';

  return {
    source: 'open-meteo',
    weatherFetchedAt: weather.snapshot.fetchedAt,
    marineFetchedAt: marineOk ? marine.snapshot.fetchedAt : undefined,
    stale: weather.stale || (marineOk && marine.stale),
    marineAvailable: marineOk,
    marineCellDistanceKm: marineOk ? marine.cellDistanceKm : undefined,
    timezone: location.timezone,
  };
}

export function createRankingService(options: RankingServiceOptions): RankingService {
  const { locations, forecasts, clock } = options;

  return {
    async rank(city, countryCode, activities = ACTIVITIES) {
      const location = await locations.resolve(city, countryCode);
      if (location === NOT_FOUND) throw locationNotFound(city);

      // Their today, not the server's: someone in Sydney asking at breakfast means
      // Sydney's date, and at that moment UTC is still on yesterday (Q1).
      const todayLocal = todayIn(clock.now(), location.timezone);
      const bundle = await forecasts.getBundle(location, todayLocal);

      const data: ForecastData = {
        weather: bundle.weather.payload,
        marine: bundle.marine.kind === 'ok' ? bundle.marine.payload : undefined,
      };

      const rankings = rankActivities(data, todayLocal, activities, {
        surfingUnavailableNote:
          bundle.marine.kind === 'ok' ? undefined : surfingNote(location, bundle.marine.reason),
      });

      return {
        location,
        forecast: metaOf(bundle),
        days: summariseDays(data, todayLocal),
        rankings,
      };
    },
  };
}
