import { FormEvent, useEffect, useMemo, useState } from 'react';
import { onAuthStateChanged, signInWithPopup, signOut, type User } from 'firebase/auth';
import {
  EMPTY_ADMIN_ACCESS,
  getBootstrapAdminUsers,
  grantAdminAccess,
  listAdminUsers,
  resolveAdminAccess,
  revokeAdminAccess,
  type AdminAccess,
  type AdminClaims,
  type AdminUser,
} from './adminAccess';
import {
  addSavedParticipant,
  listSavedParticipants,
  removeSavedParticipant,
} from './adminParticipants';
import { auth, googleProvider } from './firebase';
import {
  getFixedParticipantUserId,
  getLookupErrorMessage,
  lookupParticipantTracking,
  type ParticipantTrackingSummary,
  type TrackingActivity,
  type TrackingAlert,
  type TrackingMetric,
  type TrackingTone,
} from './participantTracking';

const toneLabels: Record<TrackingTone, string> = {
  good: 'Good',
  warning: 'Watch',
  critical: 'Needs attention',
  neutral: 'Info',
};

const toneClass: Record<TrackingTone, string> = {
  good: 'tone-good',
  warning: 'tone-warning',
  critical: 'tone-critical',
  neutral: 'tone-neutral',
};

type ParticipantRosterRow = {
  participantId: string;
  status: 'loading' | 'loaded' | 'error';
  summary?: ParticipantTrackingSummary;
  message?: string;
};

type MainView = 'participants' | 'settings';

function findMetric(metrics: TrackingMetric[], label: string): TrackingMetric | null {
  return metrics.find((metric) => metric.label === label) ?? null;
}

function getParticipantStatusTone(summary: ParticipantTrackingSummary): TrackingTone {
  if (summary.alerts.some((alert) => alert.tone === 'critical')) return 'critical';
  if (summary.alerts.length > 0) return 'warning';
  return 'good';
}

function getLatestActivityTime(summary: ParticipantTrackingSummary): Date | null {
  return summary.recentActivity.reduce<Date | null>((latest, item) => {
    if (!item.timestamp) return latest;
    if (!latest || item.timestamp.getTime() > latest.getTime()) return item.timestamp;
    return latest;
  }, null);
}

function formatDateTime(date: Date | null): string {
  if (!date) return 'No timestamp';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function formatDate(date: Date | null): string {
  if (!date) return 'Not set';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

function getInitialParticipantId(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get('participant') ?? params.get('participantId') ?? '';
}

function getAuthErrorMessage(error: unknown): string {
  const record = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown } : {};
  const code = typeof record.code === 'string' ? record.code : '';
  const message = typeof record.message === 'string' ? record.message : '';

  if (code === 'auth/unauthorized-domain') {
    return 'Google sign-in is blocked for this hostname. Open http://localhost:5174 or add this hostname in Firebase Auth authorized domains.';
  }
  if (code === 'auth/popup-blocked') {
    return 'The Google sign-in popup was blocked. Allow popups for this site, then try again.';
  }
  if (code === 'auth/popup-closed-by-user') {
    return 'The Google sign-in popup was closed before sign-in finished.';
  }
  if (code === 'auth/cancelled-popup-request') {
    return 'A previous Google sign-in popup was cancelled. Try the sign-in button again.';
  }
  if (code === 'auth/network-request-failed') {
    return 'Google sign-in could not reach Firebase. Check your network connection and try again.';
  }
  if (code === 'auth/operation-not-allowed') {
    return 'Google sign-in is not enabled for this Firebase project. Enable Google as a provider in Firebase Authentication.';
  }
  if (code === 'auth/operation-not-supported-in-this-environment') {
    return 'Google popup sign-in is not supported in this browser context. Open the dashboard in Chrome/Safari at http://localhost:5174.';
  }

  return message || 'Google sign-in failed. Check the browser console for details.';
}

function getLocalhostAuthUrl(): string | null {
  if (window.location.hostname !== '127.0.0.1') return null;
  const port = window.location.port ? `:${window.location.port}` : '';
  return `${window.location.protocol}//localhost${port}${window.location.pathname}${window.location.search}`;
}

function StatusDot({ tone }: { tone: TrackingTone }) {
  return <span aria-label={toneLabels[tone]} className={`status-dot ${toneClass[tone]}`} />;
}

function UserIcon() {
  return (
    <svg aria-hidden="true" className="icon" viewBox="0 0 24 24">
      <path d="M12 12.2a4.4 4.4 0 1 0 0-8.8 4.4 4.4 0 0 0 0 8.8Z" />
      <path d="M4.2 20.2c1.1-3.6 4-5.4 7.8-5.4s6.7 1.8 7.8 5.4" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg aria-hidden="true" className="button-icon" viewBox="0 0 24 24">
      <path d="m20 20-4.2-4.2" />
      <circle cx="10.8" cy="10.8" r="6" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg aria-hidden="true" className="button-icon" viewBox="0 0 24 24">
      <path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z" />
      <path d="M19.2 13.4c.1-.5.1-.9.1-1.4s0-.9-.1-1.4l2-1.5-2-3.4-2.4 1a7.4 7.4 0 0 0-2.4-1.4L14 2.8h-4l-.4 2.5a7.4 7.4 0 0 0-2.4 1.4l-2.4-1-2 3.4 2 1.5c-.1.5-.1.9-.1 1.4s0 .9.1 1.4l-2 1.5 2 3.4 2.4-1a7.4 7.4 0 0 0 2.4 1.4l.4 2.5h4l.4-2.5a7.4 7.4 0 0 0 2.4-1.4l2.4 1 2-3.4-2-1.5Z" />
    </svg>
  );
}

function PanelIcon({ children }: { children: string }) {
  return <span className="panel-icon" aria-hidden="true">{children}</span>;
}

function MetricPanel({
  title,
  icon,
  metrics,
}: {
  title: string;
  icon: string;
  metrics: TrackingMetric[];
}) {
  return (
    <section className="panel" aria-labelledby={`${title.replace(/\s+/g, '-').toLowerCase()}-title`}>
      <div className="panel-header">
        <PanelIcon>{icon}</PanelIcon>
        <h2 id={`${title.replace(/\s+/g, '-').toLowerCase()}-title`}>{title}</h2>
      </div>
      <div className="metric-list">
        {metrics.map((metric) => (
          <div className="metric-row" key={metric.label}>
            <div>
              <div className="metric-label">{metric.label}</div>
              {metric.detail ? <div className="metric-detail">{metric.detail}</div> : null}
            </div>
            <div className={`metric-value ${toneClass[metric.tone]}`}>
              <StatusDot tone={metric.tone} />
              <span>{metric.value}</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function AlertsPanel({ alerts }: { alerts: TrackingAlert[] }) {
  return (
    <section className="panel panel-large" aria-labelledby="alerts-title">
      <div className="panel-header">
        <PanelIcon>!</PanelIcon>
        <h2 id="alerts-title">Alerts</h2>
        <span className="count-chip">{alerts.length}</span>
      </div>
      {alerts.length === 0 ? (
        <div className="empty-state">No active alerts for this participant.</div>
      ) : (
        <div className="alert-list">
          {alerts.map((alert) => (
            <div className="alert-row" key={`${alert.title}-${alert.detail}`}>
              <StatusDot tone={alert.tone} />
              <div>
                <div className="alert-title">{alert.title}</div>
                <div className="metric-detail">{alert.detail}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ActivityPanel({ activity }: { activity: TrackingActivity[] }) {
  return (
    <section className="panel panel-large" aria-labelledby="activity-title">
      <div className="panel-header">
        <PanelIcon>#</PanelIcon>
        <h2 id="activity-title">Recent Activity</h2>
      </div>
      <div className="activity-table-wrap">
        <table className="activity-table">
          <thead>
            <tr>
              <th>Event</th>
              <th>Details</th>
              <th>Time</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {activity.map((item) => (
              <tr key={`${item.label}-${item.detail}`}>
                <td>{item.label}</td>
                <td>{item.detail}</td>
                <td>{formatDateTime(item.timestamp)}</td>
                <td>
                  <span className={`table-status ${toneClass[item.tone]}`}>
                    <StatusDot tone={item.tone} />
                    {toneLabels[item.tone]}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ParticipantOverview({ summary }: { summary: ParticipantTrackingSummary }) {
  const criticalCount = summary.alerts.filter((alert) => alert.tone === 'critical').length;
  const statusTone: TrackingTone = criticalCount > 0 ? 'critical' : summary.alerts.length > 0 ? 'warning' : 'good';

  return (
    <>
      <section className="participant-band" aria-label="Participant summary">
        <div className="avatar" aria-hidden="true">
          <UserIcon />
        </div>
        <div className="participant-copy">
          <h1>{summary.participantId}</h1>
          <p>
            {summary.displayName} <span aria-hidden="true">/</span> {summary.email}
          </p>
          <p>
            Cohort {summary.cohort} <span aria-hidden="true">/</span> Started {formatDate(summary.startDate)}
          </p>
        </div>
        <div className="participant-status">
          <span>Status</span>
          <strong className={toneClass[statusTone]}>
            <StatusDot tone={statusTone} />
            {criticalCount > 0 ? 'Action needed' : summary.alerts.length > 0 ? 'Watch' : 'Healthy'}
          </strong>
        </div>
      </section>

      <div className="dashboard-grid">
        <MetricPanel title="Setup" icon="1" metrics={summary.setup} />
        <MetricPanel title="Data Flow" icon="2" metrics={summary.dataFlow} />
        <MetricPanel title="Daily Compliance" icon="3" metrics={summary.dailyCompliance} />
        <AlertsPanel alerts={summary.alerts} />
        <ActivityPanel activity={summary.recentActivity} />
      </div>
    </>
  );
}

function ParticipantRosterPanel({
  rows,
  selectedParticipantId,
  busy,
  onSelect,
  onRefresh,
  onRemove,
}: {
  rows: ParticipantRosterRow[];
  selectedParticipantId: string;
  busy: boolean;
  onSelect: (row: ParticipantRosterRow) => void;
  onRefresh: () => void;
  onRemove: (participantId: string) => void;
}) {
  return (
    <section className="panel roster-panel" aria-labelledby="participant-roster-title">
      <div className="panel-header roster-header">
        <div className="panel-header-main">
          <PanelIcon>P</PanelIcon>
          <h2 id="participant-roster-title">Your Participants</h2>
          <span className="count-chip">{rows.length}</span>
        </div>
        <button className="ghost-button compact-button" type="button" disabled={busy} onClick={onRefresh}>
          Refresh
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="empty-state">Add participants above to build your tracking table.</div>
      ) : (
        <div className="participant-table-wrap">
          <table className="participant-table">
            <thead>
              <tr>
                <th>Participant</th>
                <th>Name</th>
                <th>Onboarding</th>
                <th>Fitbit</th>
                <th>Rehearsal</th>
                <th>Reflection</th>
                <th>Alerts</th>
                <th>Last Activity</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const summary = row.summary;
                const statusTone = summary ? getParticipantStatusTone(summary) : row.status === 'error' ? 'critical' : 'neutral';
                const onboarding = summary ? findMetric(summary.setup, 'Onboarding') : null;
                const fitbit = summary ? findMetric(summary.dataFlow, 'Fitbit') : null;
                const rehearsal = summary ? findMetric(summary.dailyCompliance, 'Daily rehearsal') : null;
                const reflection = summary ? findMetric(summary.dailyCompliance, 'Daily reflection') : null;
                const isSelected = selectedParticipantId === row.participantId;

                return (
                  <tr
                    className={isSelected ? 'selected-row' : undefined}
                    key={row.participantId}
                    onClick={() => onSelect(row)}
                  >
                    <td>
                      <button className="table-link" type="button" onClick={() => onSelect(row)}>
                        <StatusDot tone={statusTone} />
                        {row.participantId}
                      </button>
                      {row.status === 'error' ? <div className="row-error">{row.message}</div> : null}
                    </td>
                    <td>{summary?.displayName ?? (row.status === 'loading' ? 'Loading...' : 'Not found')}</td>
                    <td>{onboarding?.value ?? '-'}</td>
                    <td>{fitbit?.value ?? '-'}</td>
                    <td>{rehearsal?.value ?? '-'}</td>
                    <td>{reflection?.value ?? '-'}</td>
                    <td>{summary ? summary.alerts.length : '-'}</td>
                    <td>{summary ? formatDateTime(getLatestActivityTime(summary)) : '-'}</td>
                    <td>
                      <button
                        className="danger-button compact-button"
                        type="button"
                        disabled={busy}
                        onClick={(event) => {
                          event.stopPropagation();
                          onRemove(row.participantId);
                        }}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function AuthControl({
  user,
  authReady,
  adminAccess,
  adminAccessReady,
  settingsActive,
  onAuthError,
  onOpenSettings,
}: {
  user: User | null;
  authReady: boolean;
  adminAccess: AdminAccess;
  adminAccessReady: boolean;
  settingsActive: boolean;
  onAuthError: (message: string) => void;
  onOpenSettings: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function handleSignIn() {
    setBusy(true);
    onAuthError('');
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      onAuthError(getAuthErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleSignOut() {
    setBusy(true);
    onAuthError('');
    try {
      await signOut(auth);
    } catch (error) {
      onAuthError(getAuthErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  if (!authReady) {
    return <div className="auth-pill">Checking session...</div>;
  }

  if (!user) {
    return (
      <div className="account-area">
        <button className="secondary-button" type="button" onClick={handleSignIn} disabled={busy}>
          Sign in with Google
        </button>
      </div>
    );
  }

  return (
    <div className="account-area">
      <div className="account-control">
        <div>
          <strong>{user.displayName ?? user.email ?? 'Signed in'}</strong>
          <span>{adminAccessReady ? adminAccess.label : 'Checking access...'}</span>
        </div>
        <button className="ghost-button" type="button" onClick={handleSignOut} disabled={busy}>
          Sign out
        </button>
      </div>
      <button
        aria-label="Open settings"
        className={`icon-button ${settingsActive ? 'active-icon-button' : ''}`}
        disabled={!adminAccessReady || !adminAccess.isAdmin}
        title={adminAccess.isAdmin ? 'Settings' : 'Settings require admin access'}
        type="button"
        onClick={onOpenSettings}
      >
        <SettingsIcon />
      </button>
    </div>
  );
}

function AdminAccessPanel({
  currentUser,
  isAdmin,
}: {
  currentUser: User | null;
  isAdmin: boolean;
}) {
  const [admins, setAdmins] = useState<AdminUser[]>(() => getBootstrapAdminUsers());
  const [newEmail, setNewEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function loadAdmins() {
    if (!currentUser || !isAdmin) return;
    setBusy(true);
    setError('');
    try {
      setAdmins(await listAdminUsers());
    } catch (loadError) {
      setAdmins(getBootstrapAdminUsers());
      setError(`Showing fixed admins only. Could not load website-added admins: ${getLookupErrorMessage(loadError)}`);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void loadAdmins();
  }, [currentUser?.uid, isAdmin]);

  async function handleGrant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!currentUser || !isAdmin) return;

    setBusy(true);
    setError('');
    setMessage('');
    try {
      const email = await grantAdminAccess(newEmail, currentUser);
      setNewEmail('');
      setMessage(`${email} can now access the admin dashboard.`);
      setAdmins(await listAdminUsers());
    } catch (grantError) {
      setError(getLookupErrorMessage(grantError));
    } finally {
      setBusy(false);
    }
  }

  async function handleRevoke(email: string) {
    if (!currentUser || !isAdmin) return;

    setBusy(true);
    setError('');
    setMessage('');
    try {
      const revokedEmail = await revokeAdminAccess(email);
      setMessage(`${revokedEmail} was removed from the admin allowlist.`);
      setAdmins(await listAdminUsers());
    } catch (revokeError) {
      setError(getLookupErrorMessage(revokeError));
    } finally {
      setBusy(false);
    }
  }

  if (!currentUser || !isAdmin) return null;

  return (
    <section className="settings-section" aria-labelledby="admin-access-title">
      <div className="settings-section-header">
        <PanelIcon>A</PanelIcon>
        <h2 id="admin-access-title">Admin Access</h2>
      </div>
      <div className="admin-panel-body">
        <form className="admin-access-form" onSubmit={handleGrant}>
          <label htmlFor="admin-email">Add admin email</label>
          <div className="admin-access-controls">
            <input
              id="admin-email"
              autoComplete="email"
              placeholder="name@example.com"
              value={newEmail}
              onChange={(event) => setNewEmail(event.target.value)}
            />
            <button className="primary-button" type="submit" disabled={busy || !newEmail.trim()}>
              Add admin
            </button>
          </div>
        </form>

        {message ? <div className="inline-message">{message}</div> : null}
        {error ? <div className="inline-message inline-error">{error}</div> : null}

        <section className="admin-list-block" aria-labelledby="approved-admins-title">
          <div className="admin-list-header">
            <div>
              <h3 id="approved-admins-title">Approved Admins</h3>
              <p>These emails can open settings and search participant backend records.</p>
            </div>
            <span className="count-chip">{admins.length}</span>
          </div>

          <div className="admin-list" aria-label="Approved admin emails">
            {busy && admins.length === 0 ? (
              <div className="empty-state">Loading approved admins...</div>
            ) : admins.length > 0 ? (
              admins.map((admin) => (
                <div className="admin-row" key={admin.email}>
                  <div>
                    <div className="metric-label">{admin.email}</div>
                    <div className="metric-detail">
                      {admin.source === 'bootstrap'
                        ? 'Fixed bootstrap admin'
                        : 'Added from website settings'}
                    </div>
                  </div>
                  {admin.removable ? (
                    <button
                      className="danger-button"
                      type="button"
                      disabled={busy}
                      onClick={() => void handleRevoke(admin.email)}
                    >
                      Remove
                    </button>
                  ) : (
                    <span className="fixed-chip">Fixed</span>
                  )}
                </div>
              ))
            ) : (
              <div className="empty-state">No approved admins yet.</div>
            )}
          </div>
        </section>
      </div>
    </section>
  );
}

function SettingsWorkspace({
  onBack,
  currentUser,
  isAdmin,
}: {
  onBack: () => void;
  currentUser: User | null;
  isAdmin: boolean;
}) {
  return (
    <section className="settings-workspace" aria-labelledby="settings-title">
      <header className="settings-workspace-header">
        <div>
          <h1 id="settings-title">Settings</h1>
          <p>Manage access for the participant tracking dashboard.</p>
        </div>
        <button className="ghost-button" type="button" onClick={onBack}>
          Back to Participants
        </button>
      </header>

      {isAdmin ? (
        <AdminAccessPanel currentUser={currentUser} isAdmin={isAdmin} />
      ) : (
        <div className="settings-locked">
          <h3>Admin access required</h3>
          <p>Only current admins can view or change the admin access list.</p>
        </div>
      )}
    </section>
  );
}

export default function App() {
  const [participantId, setParticipantId] = useState(getInitialParticipantId);
  const [submittedId, setSubmittedId] = useState('');
  const [summary, setSummary] = useState<ParticipantTrackingSummary | null>(null);
  const [lookupState, setLookupState] = useState<'idle' | 'loading' | 'loaded' | 'empty' | 'error'>('idle');
  const [lookupMessage, setLookupMessage] = useState('');
  const [rosterRows, setRosterRows] = useState<ParticipantRosterRow[]>([]);
  const [rosterBusy, setRosterBusy] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authError, setAuthError] = useState('');
  const [adminAccess, setAdminAccess] = useState<AdminAccess>(EMPTY_ADMIN_ACCESS);
  const [adminAccessReady, setAdminAccessReady] = useState(false);
  const [mainView, setMainView] = useState<MainView>('participants');

  const isAdmin = adminAccess.isAdmin;
  const canSearch = Boolean(
    user
      && adminAccessReady
      && isAdmin
      && participantId.trim().length > 0
      && lookupState !== 'loading'
      && !rosterBusy,
  );
  const localhostAuthUrl = useMemo(getLocalhostAuthUrl, []);

  async function resolveParticipantRows(participantIds: string[]): Promise<ParticipantRosterRow[]> {
    return Promise.all(
      participantIds.map(async (id) => {
        try {
          const nextSummary = await lookupParticipantTracking(id);
          if (!nextSummary) {
            const fixedUserId = getFixedParticipantUserId(id);
            return {
              participantId: id,
              status: 'error' as const,
              message: fixedUserId
                ? `Recognized as ${fixedUserId}, but the user document was not found or readable.`
                : 'No matching participant record found.',
            };
          }

          return {
            participantId: nextSummary.participantId,
            status: 'loaded' as const,
            summary: nextSummary,
          };
        } catch (error) {
          return {
            participantId: id,
            status: 'error' as const,
            message: getLookupErrorMessage(error),
          };
        }
      }),
    );
  }

  async function loadRoster(nextUser = user) {
    if (!nextUser || !isAdmin) {
      setRosterRows([]);
      return;
    }

    setRosterBusy(true);
    try {
      const saved = await listSavedParticipants(nextUser);
      const participantIds = saved.map((item) => item.participantId);
      setRosterRows(participantIds.map((id) => ({ participantId: id, status: 'loading' })));
      const rows = await resolveParticipantRows(participantIds);
      setRosterRows(rows);

      if (summary) {
        const refreshedSelected = rows.find((row) => row.summary?.participantId === summary.participantId);
        if (refreshedSelected?.summary) setSummary(refreshedSelected.summary);
      }
    } catch (error) {
      setLookupState('error');
      setLookupMessage(getLookupErrorMessage(error));
    } finally {
      setRosterBusy(false);
    }
  }

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (nextUser) => {
      setUser(nextUser);
      setSummary(null);
      setLookupState('idle');
      setLookupMessage('');
      setRosterRows([]);
      setAuthError('');
      setAdminAccess(EMPTY_ADMIN_ACCESS);
      setAdminAccessReady(false);
      setMainView('participants');

      if (!nextUser) {
        setAdminAccessReady(true);
        setAuthReady(true);
        return;
      }

      try {
        const token = await nextUser.getIdTokenResult();
        const nextClaims = token.claims as AdminClaims;
        setAdminAccess(await resolveAdminAccess(nextUser, nextClaims));
      } catch (accessError) {
        setAuthError(getLookupErrorMessage(accessError));
      } finally {
        setAdminAccessReady(true);
        setAuthReady(true);
      }
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!adminAccessReady || !user || !isAdmin) {
      setRosterRows([]);
      return;
    }

    void loadRoster(user);
  }, [adminAccessReady, user?.uid, isAdmin]);

  useEffect(() => {
    const nextParams = new URLSearchParams(window.location.search);
    if (submittedId) {
      nextParams.set('participant', submittedId);
    } else {
      nextParams.delete('participant');
    }
    const nextQuery = nextParams.toString();
    window.history.replaceState(null, '', nextQuery ? `?${nextQuery}` : window.location.pathname);
  }, [submittedId]);

  const authNotice = useMemo(() => {
    if (!authReady || !adminAccessReady) return null;
    if (!user) return 'Sign in to search participant records.';
    if (!isAdmin) return 'This account is signed in but is not on the admin allowlist.';
    return null;
  }, [adminAccessReady, authReady, isAdmin, user]);

  async function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedId = participantId.trim();
    if (!normalizedId || !user) return;

    setLookupState('loading');
    setLookupMessage('');
    setSummary(null);
    setSubmittedId(normalizedId);

    try {
      await addSavedParticipant(user, normalizedId);
      const result = await lookupParticipantTracking(normalizedId);
      if (!result) {
        const fixedUserId = getFixedParticipantUserId(normalizedId);
        setLookupState('empty');
        setLookupMessage(
          fixedUserId
            ? `Recognized "${normalizedId}" as ${fixedUserId}, but that user document was not found or readable. Seed the test user and confirm admin Firestore rules are deployed.`
            : `No participant found for "${normalizedId}".`,
        );
        await loadRoster(user);
        return;
      }
      setSummary(result);
      setLookupState('loaded');
      setParticipantId('');
      await loadRoster(user);
    } catch (error) {
      setLookupState('error');
      setLookupMessage(getLookupErrorMessage(error));
    }
  }

  function handleSelectRosterRow(row: ParticipantRosterRow) {
    setSubmittedId(row.participantId);
    if (row.summary) {
      setSummary(row.summary);
      setLookupState('loaded');
      setLookupMessage('');
      return;
    }

    setLookupState('error');
    setLookupMessage(row.message ?? `Could not load ${row.participantId}.`);
  }

  async function handleRemoveRosterParticipant(nextParticipantId: string) {
    if (!user) return;

    setRosterBusy(true);
    setLookupMessage('');
    try {
      await removeSavedParticipant(user, nextParticipantId);
      if (summary?.participantId === nextParticipantId) {
        setSummary(null);
        setSubmittedId('');
      }
      await loadRoster(user);
    } catch (error) {
      setLookupState('error');
      setLookupMessage(getLookupErrorMessage(error));
    } finally {
      setRosterBusy(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="top-bar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">V</div>
          <div>
            <div className="brand-title">Value Vis Admin</div>
            <div className="brand-subtitle">Participant Tracking</div>
          </div>
        </div>
        <AuthControl
          user={user}
          authReady={authReady}
          adminAccess={adminAccess}
          adminAccessReady={adminAccessReady}
          settingsActive={mainView === 'settings'}
          onAuthError={setAuthError}
          onOpenSettings={() => setMainView('settings')}
        />
      </header>

      {localhostAuthUrl ? (
        <div className="notice">
          Google sign-in works best from Firebase&apos;s local authorized domain. Open{' '}
          <a href={localhostAuthUrl}>localhost</a> instead of 127.0.0.1.
        </div>
      ) : null}
      {authError ? <div className="notice notice-error">{authError}</div> : null}

      {mainView === 'settings' ? (
        <SettingsWorkspace
          currentUser={user}
          isAdmin={isAdmin}
          onBack={() => setMainView('participants')}
        />
      ) : (
        <>
          <section className="search-band" aria-labelledby="participant-search-title">
            <div>
              <h1 id="participant-search-title">Add Participants</h1>
              <p>Add participant IDs to your tracking table, then click a row to inspect the full backend status.</p>
            </div>
            <form className="search-form" onSubmit={handleSearch}>
              <label htmlFor="participant-id">Participant ID</label>
              <div className="search-controls">
                <input
                  id="participant-id"
                  autoComplete="off"
                  placeholder="P12345"
                  value={participantId}
                  onChange={(event) => setParticipantId(event.target.value)}
                />
                <button className="primary-button" type="submit" disabled={!canSearch}>
                  <SearchIcon />
                  {lookupState === 'loading' ? 'Adding' : 'Add Participant'}
                </button>
              </div>
            </form>
          </section>

          {authNotice ? <div className="notice">{authNotice}</div> : null}
          {lookupMessage ? <div className={`notice ${lookupState === 'error' ? 'notice-error' : ''}`}>{lookupMessage}</div> : null}

          {user && isAdmin ? (
            <ParticipantRosterPanel
              rows={rosterRows}
              selectedParticipantId={summary?.participantId ?? submittedId}
              busy={rosterBusy}
              onSelect={handleSelectRosterRow}
              onRefresh={() => void loadRoster(user)}
              onRemove={(nextParticipantId) => void handleRemoveRosterParticipant(nextParticipantId)}
            />
          ) : null}

          {summary ? (
            <ParticipantOverview summary={summary} />
          ) : (
            <section className="empty-dashboard" aria-label="No participant selected">
              <div className="empty-illustration" aria-hidden="true">ID</div>
              <h2>No participant selected</h2>
              <p>Add participants above, then select a row to load the detailed backend tracking view.</p>
            </section>
          )}
        </>
      )}
    </main>
  );
}
