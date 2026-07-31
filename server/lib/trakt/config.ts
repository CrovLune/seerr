import type {
  TraktAllowedOrigin,
  TraktPublicSettings,
} from '@server/interfaces/api/traktInterfaces';
import type { TraktSettings } from '@server/lib/settings';

export const TRAKT_CALLBACK_URL =
  'https://overseerr.pixeltrophies.com/api/v1/auth/trakt/callback';

const TRAKT_ALLOWED_ORIGINS: readonly TraktAllowedOrigin[] = [
  'https://overseerr.pixeltrophies.com',
  'https://overseerr.local.pixeltrophies.com',
];

export const getAllowedTraktOrigins = (): TraktAllowedOrigin[] => [
  ...TRAKT_ALLOWED_ORIGINS,
];

export const isAllowedTraktOrigin = (
  origin: string
): origin is TraktAllowedOrigin =>
  TRAKT_ALLOWED_ORIGINS.includes(origin as TraktAllowedOrigin);

export const isTraktConfigured = (settings: TraktSettings): boolean =>
  settings.clientId.trim().length > 0 && settings.clientSecret.length > 0;

export const getSafeTraktSettings = (
  settings: TraktSettings
): TraktPublicSettings => ({
  clientId: settings.clientId,
  clientSecretConfigured: settings.clientSecret.length > 0,
  callbackUrl: TRAKT_CALLBACK_URL,
});
