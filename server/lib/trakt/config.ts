import type {
  TraktAllowedOrigin,
  TraktPublicSettings,
} from '@server/interfaces/api/traktInterfaces';
import type { TraktSettings } from '@server/lib/settings';

const TRAKT_CALLBACK_PATH = '/api/v1/auth/trakt/callback';

const TRAKT_PRODUCTION_ORIGINS: readonly TraktAllowedOrigin[] = [
  'https://overseerr.pixeltrophies.com',
  'https://overseerr.local.pixeltrophies.com',
];

const TRAKT_CANONICAL_ORIGIN = TRAKT_PRODUCTION_ORIGINS[0];

/**
 * A development server answers on neither production origin, so local work would fail
 * the origin check and hand Trakt a `redirect_uri` it cannot return to. Setting
 * `TRAKT_DEV_ORIGIN` (for example `http://localhost:5055`) admits that origin and
 * moves the OAuth round-trip onto it; Trakt must have the matching redirect URI
 * registered. Ignored under `NODE_ENV=production`, so the deployed allowlist and
 * canonical callback cannot be widened by the environment.
 */
const getDevelopmentOrigin = (): string | null => {
  if (process.env.NODE_ENV === 'production') {
    return null;
  }

  const origin = process.env.TRAKT_DEV_ORIGIN?.trim().replace(/\/+$/, '');

  return origin ? origin : null;
};

export const getAllowedTraktOrigins = (): TraktAllowedOrigin[] => {
  const developmentOrigin = getDevelopmentOrigin();

  return developmentOrigin
    ? [...TRAKT_PRODUCTION_ORIGINS, developmentOrigin]
    : [...TRAKT_PRODUCTION_ORIGINS];
};

export const isAllowedTraktOrigin = (
  origin: string
): origin is TraktAllowedOrigin => getAllowedTraktOrigins().includes(origin);

/**
 * Trakt requires an identical `redirect_uri` on the authorize call and every later
 * token call, so the callback is resolved from configuration rather than from
 * whichever request happens to be in flight.
 */
export const getTraktCallbackUrl = (): string =>
  `${getDevelopmentOrigin() ?? TRAKT_CANONICAL_ORIGIN}${TRAKT_CALLBACK_PATH}`;

export const isTraktConfigured = (settings: TraktSettings): boolean =>
  settings.clientId.trim().length > 0 && settings.clientSecret.length > 0;

export const getSafeTraktSettings = (
  settings: TraktSettings
): TraktPublicSettings => ({
  clientId: settings.clientId,
  clientSecretConfigured: settings.clientSecret.length > 0,
  callbackUrl: getTraktCallbackUrl(),
});
