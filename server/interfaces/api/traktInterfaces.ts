export interface TraktPublicSettings {
  clientId: string;
  clientSecretConfigured: boolean;
  callbackUrl: string;
}

export interface TraktSettingsUpdate {
  clientId: string;
  clientSecret?: string;
  confirmReconnectAll?: boolean;
}

export type TraktAllowedOrigin =
  | 'https://overseerr.pixeltrophies.com'
  | 'https://overseerr.local.pixeltrophies.com';

export type TraktSafeResultCode =
  | 'access_denied'
  | 'actor_not_authorized'
  | 'client_id_changed'
  | 'confirm_reconnect_all_required'
  | 'invalid_state'
  | 'oauth_interrupted'
  | 'state_expired'
  | 'state_replayed'
  | 'target_has_different_trakt_account'
  | 'target_missing'
  | 'token_exchange_failed'
  | 'trakt_account_owned_by_another_user'
  | 'trakt_application_not_configured';

export interface TraktConnectionResponse {
  userId: number;
  traktUserId: string;
  traktUsername: string | null;
  traktSlug: string | null;
  displayName: string | null;
  status: 'active' | 'reconnect_required';
  connectedByUserId: number | null;
  lastValidatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TraktAuthorizationResponse {
  transactionId: string;
  authorizationUrl: string;
  callbackOrigin: TraktAllowedOrigin;
  expiresAt: string;
}

export interface TraktUserSettingsResponse {
  applicationConfigured: boolean;
  connection: TraktConnectionResponse | null;
}

export interface TraktOAuthStatusResponse {
  status: 'pending' | 'succeeded' | 'failed';
  resultCode: TraktSafeResultCode | null;
}

export interface TraktWatchStatusItem {
  userId: number;
  displayName: string;
  traktUsername: string | null;
  watched: boolean;
  watchedAt: string | null;
  status: 'ok' | 'temporarily_unavailable';
}

export interface TraktWatchStatusResponse {
  mediaType: 'movie' | 'tv';
  tmdbId: number;
  items: TraktWatchStatusItem[];
}
