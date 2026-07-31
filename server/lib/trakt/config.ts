import type {
  TraktAllowedOrigin,
  TraktPublicSettings,
} from '@server/interfaces/api/traktInterfaces';
import type { TraktSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';

const TRAKT_CALLBACK_PATH = '/api/v1/auth/trakt/callback';

const toOrigin = (value: string | undefined): string | null => {
  const trimmed = value?.trim();

  if (!trimmed) {
    return null;
  }

  try {
    return new URL(trimmed).origin;
  } catch {
    return null;
  }
};

/**
 * A development server answers on a different host than the configured application URL,
 * so local work would fail the origin check and hand Trakt a `redirect_uri` it cannot
 * return to. Setting `TRAKT_DEV_ORIGIN` (for example `http://localhost:5055`) admits that
 * origin and moves the OAuth round-trip onto it; Trakt must have the matching redirect
 * URI registered. Ignored under `NODE_ENV=production`, so a deployed allowlist cannot be
 * widened by the environment.
 */
const getDevelopmentOrigin = (): string | null => {
  if (process.env.NODE_ENV === 'production') {
    return null;
  }

  return toOrigin(process.env.TRAKT_DEV_ORIGIN);
};

/**
 * The origin Trakt returns to. A development origin takes precedence so that a local
 * round-trip does not depend on rewriting the saved application URL.
 */
const getCanonicalTraktOrigin = (): string | null =>
  getDevelopmentOrigin() ?? toOrigin(getSettings().main.applicationUrl);

export const getAllowedTraktOrigins = (): TraktAllowedOrigin[] => {
  const origins = new Set<string>();

  const applicationOrigin = toOrigin(getSettings().main.applicationUrl);
  if (applicationOrigin) {
    origins.add(applicationOrigin);
  }

  const developmentOrigin = getDevelopmentOrigin();
  if (developmentOrigin) {
    origins.add(developmentOrigin);
  }

  return [...origins];
};

export const isAllowedTraktOrigin = (
  origin: string
): origin is TraktAllowedOrigin => getAllowedTraktOrigins().includes(origin);

/**
 * Trakt requires an identical `redirect_uri` on the authorize call and on every later
 * token call, so the callback is resolved from configuration rather than from whichever
 * request happens to be in flight. Null until an application URL is configured.
 */
export const getTraktCallbackUrl = (): string | null => {
  const origin = getCanonicalTraktOrigin();

  return origin ? `${origin}${TRAKT_CALLBACK_PATH}` : null;
};

/**
 * Trakt rejects a token exchange whose `redirect_uri` differs from the one used to
 * authorize, so the OAuth calls need a definite callback rather than a nullable one.
 */
export const requireTraktCallbackUrl = (): string => {
  const callbackUrl = getTraktCallbackUrl();

  if (!callbackUrl) {
    throw new Error(
      'Trakt requires a valid Application URL to be configured in Seerr settings'
    );
  }

  return callbackUrl;
};

export const isTraktConfigured = (settings: TraktSettings): boolean =>
  settings.clientId.trim().length > 0 && settings.clientSecret.length > 0;

export const getSafeTraktSettings = (
  settings: TraktSettings
): TraktPublicSettings => ({
  clientId: settings.clientId,
  clientSecretConfigured: settings.clientSecret.length > 0,
  callbackUrl: getTraktCallbackUrl(),
});
