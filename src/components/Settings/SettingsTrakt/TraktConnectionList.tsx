import Alert from '@app/components/Common/Alert';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import ConfirmButton from '@app/components/Common/ConfirmButton';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import TraktOAuthModal from '@app/components/Trakt/TraktOAuthModal';
import defineMessages from '@app/utils/defineMessages';
import { ArrowPathIcon, LinkIcon, TrashIcon } from '@heroicons/react/24/solid';
import type { TraktConnectionResponse } from '@server/interfaces/api/traktInterfaces';
import type { UserResultsResponse } from '@server/interfaces/api/userInterfaces';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages(
  'components.Settings.SettingsTrakt.TraktConnectionList',
  {
    title: 'Household connections',
    description:
      'Connect a separate Trakt account for each Seerr user in this household.',
    connected: 'Connected',
    reconnectRequired: 'Reconnect required',
    notConnected: 'Not connected',
    connect: 'Connect',
    reconnect: 'Reconnect',
    unlink: 'Unlink',
    unlinking: 'Unlinking…',
    unlinkConfirm: 'Confirm unlink',
    unlinkFailed: 'The Trakt connection could not be removed.',
    revokeWarning:
      'The local connection was removed, but Trakt could not revoke its token. Revoke Seerr from the Trakt website.',
    loadFailed: 'Trakt household connections could not be loaded.',
    unnamedAccount: 'Trakt account',
  }
);

interface TraktConnectionActionsProps {
  targetUserId: number;
  connection: TraktConnectionResponse | null;
  applicationConfigured: boolean;
  onRefresh: () => void | Promise<unknown>;
  className?: string;
  showOAuthActions?: boolean;
}

export const TraktConnectionActions = ({
  targetUserId,
  connection,
  applicationConfigured,
  onRefresh,
  className,
  showOAuthActions = true,
}: TraktConnectionActionsProps) => {
  const intl = useIntl();
  const [oauthModal, setOAuthModal] = useState<{
    targetUserId: number;
    initialPopup: Window | null;
  } | null>(null);
  const [unlinkError, setUnlinkError] = useState(false);
  const [revokeWarning, setRevokeWarning] = useState(false);
  const [unlinking, setUnlinking] = useState(false);

  const startOAuth = () => {
    const popup = window.open(
      'about:blank',
      'trakt-oauth',
      'popup,width=640,height=760'
    );
    setOAuthModal({ targetUserId, initialPopup: popup });
  };

  const unlink = async () => {
    setUnlinking(true);
    setUnlinkError(false);
    setRevokeWarning(false);
    try {
      const { data } = await axios.delete<{
        remoteRevocationSucceeded: boolean;
      }>(`/api/v1/user/${targetUserId}/settings/trakt`);
      if (!data.remoteRevocationSucceeded) {
        setRevokeWarning(true);
      }
      await onRefresh();
    } catch {
      setUnlinkError(true);
    } finally {
      setUnlinking(false);
    }
  };

  const accountName =
    connection?.traktUsername ??
    connection?.displayName ??
    connection?.traktSlug ??
    intl.formatMessage(messages.unnamedAccount);

  return (
    <div className={className}>
      {oauthModal && (
        <TraktOAuthModal
          targetUserId={oauthModal.targetUserId}
          initialPopup={oauthModal.initialPopup}
          onConnected={() => {
            setOAuthModal(null);
            void onRefresh();
          }}
          onCancel={() => setOAuthModal(null)}
        />
      )}
      {unlinkError && (
        <Alert title={intl.formatMessage(messages.unlinkFailed)} type="error" />
      )}
      {revokeWarning && (
        <Alert
          title={intl.formatMessage(messages.revokeWarning)}
          type="warning"
        />
      )}
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          {connection ? (
            <div className="truncate font-medium text-white">{accountName}</div>
          ) : (
            <div className="text-gray-300">
              {intl.formatMessage(messages.notConnected)}
            </div>
          )}
          {connection?.status === 'active' && (
            <Badge badgeType="success">
              {intl.formatMessage(messages.connected)}
            </Badge>
          )}
          {connection?.status === 'reconnect_required' && (
            <Badge badgeType="warning">
              {intl.formatMessage(messages.reconnectRequired)}
            </Badge>
          )}
        </div>
        {!connection && showOAuthActions && (
          <Button
            buttonType="primary"
            onClick={startOAuth}
            disabled={!applicationConfigured}
          >
            <LinkIcon />
            <span>{intl.formatMessage(messages.connect)}</span>
          </Button>
        )}
        {connection?.status === 'reconnect_required' && showOAuthActions && (
          <Button
            buttonType="warning"
            onClick={startOAuth}
            disabled={!applicationConfigured}
          >
            <ArrowPathIcon />
            <span>{intl.formatMessage(messages.reconnect)}</span>
          </Button>
        )}
        {connection && (
          <ConfirmButton
            onClick={() => void unlink()}
            confirmText={intl.formatMessage(messages.unlinkConfirm)}
          >
            <TrashIcon />
            <span>
              {intl.formatMessage(
                unlinking ? messages.unlinking : messages.unlink
              )}
            </span>
          </ConfirmButton>
        )}
      </div>
    </div>
  );
};

interface HouseholdUser {
  id: number;
  displayName: string;
  email: string;
}

const fetchAllUsers = async (): Promise<HouseholdUser[]> => {
  const users = new Map<number, HouseholdUser>();
  let skip = 0;
  let page = 0;
  let pages = 1;

  do {
    const { data } = await axios.get<UserResultsResponse>(
      `/api/v1/user?take=50&skip=${skip}`
    );
    data.results.forEach((user) =>
      users.set(user.id, {
        id: user.id,
        displayName: user.displayName,
        email: user.email,
      })
    );
    page = data.pageInfo.page;
    pages = data.pageInfo.pages;
    skip += 50;
  } while (page < pages);

  return [...users.values()];
};

interface TraktConnectionListProps {
  applicationConfigured: boolean;
}

const TraktConnectionList = ({
  applicationConfigured,
}: TraktConnectionListProps) => {
  const intl = useIntl();
  const { data: users, error: usersError } = useSWR(
    'trakt:all-users',
    fetchAllUsers
  );
  const {
    data: connections,
    error: connectionsError,
    mutate: refreshConnections,
  } = useSWR<TraktConnectionResponse[]>('/api/v1/settings/trakt/connections');

  if ((!users && !usersError) || (!connections && !connectionsError)) {
    return <LoadingSpinner />;
  }

  if (usersError || connectionsError || !users || !connections) {
    return (
      <Alert title={intl.formatMessage(messages.loadFailed)} type="error" />
    );
  }

  const connectionsByUser = new Map(
    connections.map((item) => [item.userId, item])
  );

  return (
    <div className="section">
      <div className="mb-6">
        <h3 className="heading">{intl.formatMessage(messages.title)}</h3>
        <p className="description">
          {intl.formatMessage(messages.description)}
        </p>
      </div>
      <ul className="space-y-3">
        {users.map((user) => (
          <li
            key={user.id}
            data-testid="trakt-user-row"
            className="rounded-lg bg-gray-800/50 px-4 py-4 shadow ring-1 ring-gray-700"
          >
            <div className="mb-3 min-w-0">
              <div className="truncate font-semibold text-white">
                {user.displayName}
              </div>
              <div className="truncate text-sm text-gray-400">{user.email}</div>
            </div>
            <TraktConnectionActions
              targetUserId={user.id}
              connection={connectionsByUser.get(user.id) ?? null}
              applicationConfigured={applicationConfigured}
              onRefresh={refreshConnections}
            />
          </li>
        ))}
      </ul>
    </div>
  );
};

export default TraktConnectionList;
