import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  where,
  type DocumentData,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { db } from './firebase';

const fixedParticipantUserIds: Record<string, string> = {
  'PT-MAYA-7KQ4Z2': 'test-personal-maya',
  'PT-BOB-9N3X8R': 'test-personal-bob',
};

export function getFixedParticipantUserId(participantId: string): string | null {
  return fixedParticipantUserIds[participantId.trim().toUpperCase()] ?? null;
}

export type TrackingTone = 'good' | 'warning' | 'critical' | 'neutral';

export type TrackingMetric = {
  label: string;
  value: string;
  detail?: string;
  tone: TrackingTone;
};

export type TrackingAlert = {
  title: string;
  detail: string;
  tone: Exclude<TrackingTone, 'neutral'>;
};

export type TrackingActivity = {
  label: string;
  detail: string;
  timestamp: Date | null;
  tone: TrackingTone;
};

export type ParticipantTrackingSummary = {
  participantId: string;
  userId: string;
  displayName: string;
  email: string;
  cohort: string;
  startDate: Date | null;
  setup: TrackingMetric[];
  dataFlow: TrackingMetric[];
  dailyCompliance: TrackingMetric[];
  alerts: TrackingAlert[];
  recentActivity: TrackingActivity[];
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const timestamp = value as { toDate?: () => Date; seconds?: number };
  if (typeof timestamp.toDate === 'function') return timestamp.toDate();
  if (typeof timestamp.seconds === 'number') return new Date(timestamp.seconds * 1000);
  return null;
}

export function formatDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dateKeyToDate(dateKey: string): Date | null {
  const match = dateKey.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function getRecentDateKeys(todayKey: string, count: number): string[] {
  const start = dateKeyToDate(todayKey) ?? new Date();
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() - index);
    return formatDateKey(date);
  });
}

function daysSince(date: Date | null): number | null {
  if (!date) return null;
  return Math.max(0, Math.floor((Date.now() - date.getTime()) / (24 * 60 * 60 * 1000)));
}

function formatRelativeDate(date: Date | null): string {
  if (!date) return 'No record';
  const diffDays = daysSince(date);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return `${diffDays} days ago`;
}

function toneFromBoolean(value: boolean): TrackingTone {
  return value ? 'good' : 'critical';
}

function statusFromBoolean(value: boolean, ok = 'Complete', missing = 'Missing'): string {
  return value ? ok : missing;
}

async function findUserByParticipantId(
  participantId: string,
): Promise<{ id: string; data: () => DocumentData } | null> {
  const usersRef = collection(db, 'users');
  const fields = ['demo.participant_id', 'demo.participantId'];
  const participantIdCandidates = Array.from(new Set([
    participantId,
    participantId.toUpperCase(),
    participantId.toLowerCase(),
  ]));

  const fixedUserId = getFixedParticipantUserId(participantId);
  if (fixedUserId) {
    const fixedDoc = await getDoc(doc(db, 'users', fixedUserId));
    if (fixedDoc.exists()) return fixedDoc;
  }

  for (const field of fields) {
    for (const candidate of participantIdCandidates) {
      const snapshot = await getDocs(query(usersRef, where(field, '==', candidate), limit(1)));
      const match: QueryDocumentSnapshot<DocumentData> | undefined = snapshot.docs[0];
      if (match) return match;
    }
  }

  for (const candidate of participantIdCandidates) {
    const directDoc = await getDoc(doc(db, 'users', candidate));
    if (directDoc.exists()) return directDoc;
  }
  return null;
}

async function getLatestCollectionDocs(userId: string, collectionName: string, maxCount: number) {
  const snapshot = await getDocs(
    query(collection(db, 'users', userId, collectionName), orderBy('date', 'desc'), limit(maxCount)),
  );
  return snapshot.docs.map((item) => ({ id: item.id, data: item.data() }));
}

function completionRate(completedDates: Set<string>, todayKey: string, days: number): number {
  const keys = getRecentDateKeys(todayKey, days);
  return Math.round((keys.filter((key) => completedDates.has(key)).length / days) * 100);
}

function streakDays(completedDates: Set<string>, todayKey: string): number {
  let streak = 0;
  for (const key of getRecentDateKeys(todayKey, 30)) {
    if (!completedDates.has(key)) break;
    streak += 1;
  }
  return streak;
}

function buildAlerts(params: {
  onboardingComplete: boolean;
  fitbitConnected: boolean;
  latestHealthDate: Date | null;
  rehearsalToday: boolean;
  reflectionToday: boolean;
}): TrackingAlert[] {
  const alerts: TrackingAlert[] = [];
  const healthAge = daysSince(params.latestHealthDate);

  if (!params.onboardingComplete) {
    alerts.push({
      title: 'Onboarding incomplete',
      detail: 'Required setup steps still outstanding.',
      tone: 'warning',
    });
  }
  if (!params.fitbitConnected) {
    alerts.push({
      title: 'Fitbit disconnected',
      detail: 'No connected Fitbit flag is present.',
      tone: 'critical',
    });
  } else if (healthAge === null || healthAge > 2) {
    alerts.push({
      title: 'Fitbit data stale',
      detail: healthAge === null ? 'No health day document found.' : `Latest health data is ${healthAge} days old.`,
      tone: 'warning',
    });
  }
  if (!params.rehearsalToday) {
    alerts.push({
      title: 'Daily rehearsal missing',
      detail: 'No completed daily schedule record for today.',
      tone: 'warning',
    });
  }
  if (!params.reflectionToday) {
    alerts.push({
      title: 'Daily reflection missing',
      detail: 'No completed value reflection record for today.',
      tone: 'warning',
    });
  }

  return alerts;
}

export function getLookupErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : '';
  if (message.includes('Missing or insufficient permissions')) {
    return 'Firestore denied access. If this account is shown as an admin, deploy the latest Firestore rules and refresh the dashboard.';
  }
  return message || 'Could not load participant tracking data.';
}

export async function lookupParticipantTracking(
  participantId: string,
  todayKey = formatDateKey(new Date()),
): Promise<ParticipantTrackingSummary | null> {
  const normalizedParticipantId = participantId.trim();
  if (!normalizedParticipantId) return null;

  const userDoc = await findUserByParticipantId(normalizedParticipantId);
  if (!userDoc) return null;

  const userId = userDoc.id;
  const userData = userDoc.data();
  const demo = asRecord(userData.demo);
  const onboarding = asRecord(userData.onboarding);
  const integrations = asRecord(userData.integrations);

  const [todayScheduleDoc, todayReflectionDoc, recentSchedules, recentReflections, latestHealthDocs] =
    await Promise.all([
      getDoc(doc(db, 'users', userId, 'daily_schedules', todayKey)),
      getDoc(doc(db, 'users', userId, 'value_reflections', `reflection-daily-${todayKey}`)),
      getLatestCollectionDocs(userId, 'daily_schedules', 14),
      getLatestCollectionDocs(userId, 'value_reflections', 14),
      getLatestCollectionDocs(userId, 'health_days', 1),
    ]);

  const todaySchedule = todayScheduleDoc.exists() ? todayScheduleDoc.data() : null;
  const todayReflection = todayReflectionDoc.exists() ? todayReflectionDoc.data() : null;
  const latestHealth = latestHealthDocs[0]?.data ?? null;
  const latestHealthDate = latestHealth
    ? dateKeyToDate(asString(latestHealth.date, asString(latestHealth.snapshot_date, latestHealthDocs[0]?.id ?? '')))
    : null;
  const latestHealthSyncedAt =
    toDate(asRecord(latestHealth).synced_at) ?? toDate(asRecord(latestHealth).updatedAt);

  const completedScheduleDates = new Set(
    recentSchedules
      .filter((item) => asString(item.data.status) === 'completed')
      .map((item) => asString(item.data.date, item.id))
      .filter(Boolean),
  );
  const completedReflectionDates = new Set(
    recentReflections
      .filter((item) => asString(item.data.scope) === 'daily')
      .map((item) => asString(item.data.date, item.id.replace(/^reflection-daily-/, '')))
      .filter(Boolean),
  );

  const onboardingComplete = asBoolean(onboarding.onboarding_complete);
  const demographicsComplete = asBoolean(onboarding.demographics_completed);
  const valueQuizComplete = asBoolean(onboarding.value_quiz_completed);
  const smartGoalComplete = asBoolean(onboarding.SMART_goal_complete);
  const fitbitConnected = asBoolean(integrations.fitbit_connected);
  const rehearsalToday = asString(todaySchedule?.status) === 'completed';
  const reflectionToday = todayReflectionDoc.exists();
  const sleep = asRecord(latestHealth?.sleep);
  const activity = asRecord(latestHealth?.activity);
  const vitals = asRecord(latestHealth?.vitals);

  const setup: TrackingMetric[] = [
    {
      label: 'Onboarding',
      value: statusFromBoolean(onboardingComplete),
      detail: formatRelativeDate(toDate(onboarding.onboarding_completed_at)),
      tone: toneFromBoolean(onboardingComplete),
    },
    {
      label: 'Demographics',
      value: statusFromBoolean(demographicsComplete),
      detail: asString(demo.participant_id, asString(demo.participantId, normalizedParticipantId)),
      tone: toneFromBoolean(demographicsComplete),
    },
    {
      label: 'Baseline values',
      value: statusFromBoolean(valueQuizComplete),
      detail: formatRelativeDate(toDate(onboarding.value_quiz_completed_at)),
      tone: toneFromBoolean(valueQuizComplete),
    },
    {
      label: 'Goal setup',
      value: statusFromBoolean(smartGoalComplete),
      detail: asString(onboarding.SMART_goal_stage, 'not_started'),
      tone: toneFromBoolean(smartGoalComplete),
    },
  ];

  const sleepHours = asNumber(sleep.hours);
  const sleepEfficiency = asNumber(sleep.efficiency);
  const steps = asNumber(activity.steps);
  const restingHeartRate = asNumber(vitals.resting_heart_rate);
  const healthFresh = latestHealthDate && (daysSince(latestHealthDate) ?? 99) <= 2;

  const dataFlow: TrackingMetric[] = [
    {
      label: 'Fitbit',
      value: fitbitConnected ? 'Connected' : 'Disconnected',
      detail: latestHealthSyncedAt ? `Synced ${formatRelativeDate(latestHealthSyncedAt).toLowerCase()}` : 'No sync record',
      tone: fitbitConnected ? 'good' : 'critical',
    },
    {
      label: 'Health data date',
      value: latestHealthDate ? formatDateKey(latestHealthDate) : 'Missing',
      detail: formatRelativeDate(latestHealthDate),
      tone: healthFresh ? 'good' : 'warning',
    },
    {
      label: 'Sleep',
      value: sleepHours !== null ? `${sleepHours.toFixed(1)}h` : 'Missing',
      detail: sleepEfficiency !== null ? `${sleepEfficiency}% efficiency` : undefined,
      tone: sleepHours !== null ? 'good' : 'warning',
    },
    {
      label: 'Activity/vitals',
      value: steps !== null ? `${Math.round(steps).toLocaleString()} steps` : 'Missing',
      detail: restingHeartRate !== null ? `${Math.round(restingHeartRate)} bpm resting HR` : 'Resting HR missing',
      tone: steps !== null || restingHeartRate !== null ? 'good' : 'warning',
    },
  ];

  const rehearsalRate = completionRate(completedScheduleDates, todayKey, 7);
  const reflectionRate = completionRate(completedReflectionDates, todayKey, 7);
  const reflectionWords = todayReflection
    ? [
        asString(todayReflection.went_well, asString(todayReflection.wentWell)),
        asString(todayReflection.could_improve, asString(todayReflection.couldImprove)),
      ].join(' ').trim().split(/\s+/).filter(Boolean).length
    : 0;

  const dailyCompliance: TrackingMetric[] = [
    {
      label: 'Daily rehearsal',
      value: statusFromBoolean(rehearsalToday, 'Done today', 'Missing today'),
      detail: `7-day rate ${rehearsalRate}%`,
      tone: toneFromBoolean(rehearsalToday),
    },
    {
      label: 'Daily reflection',
      value: statusFromBoolean(reflectionToday, 'Done today', 'Missing today'),
      detail: `7-day rate ${reflectionRate}%`,
      tone: toneFromBoolean(reflectionToday),
    },
    {
      label: 'Rehearsal streak',
      value: `${streakDays(completedScheduleDates, todayKey)} days`,
      detail: 'Consecutive completed daily records',
      tone: streakDays(completedScheduleDates, todayKey) > 0 ? 'good' : 'warning',
    },
    {
      label: 'Reflection content',
      value: todayReflection ? `${reflectionWords} words` : 'Missing',
      detail: todayReflection ? 'Saved in Firestore' : 'No Firestore record',
      tone: todayReflection ? 'good' : 'warning',
    },
  ];

  const alerts = buildAlerts({
    onboardingComplete,
    fitbitConnected,
    latestHealthDate,
    rehearsalToday,
    reflectionToday,
  });

  return {
    participantId: asString(demo.participant_id, asString(demo.participantId, normalizedParticipantId)),
    userId,
    displayName: asString(userData.displayName, 'Unknown'),
    email: asString(userData.email, 'No email'),
    cohort: asString(userData.cohort, asString(asRecord(userData.study).cohort, 'Not set')),
    startDate: toDate(userData.createdAt),
    setup,
    dataFlow,
    dailyCompliance,
    alerts,
    recentActivity: [
      {
        label: 'Onboarding',
        detail: onboardingComplete ? 'Completed' : 'Incomplete',
        timestamp: toDate(onboarding.onboarding_completed_at),
        tone: onboardingComplete ? 'good' : 'warning',
      },
      {
        label: 'Fitbit sync',
        detail: latestHealth ? asString(latestHealth.source, 'health_days') : 'No health day',
        timestamp: latestHealthSyncedAt,
        tone: latestHealth ? 'good' : 'warning',
      },
      {
        label: 'Daily rehearsal',
        detail: rehearsalToday ? 'Completed today' : 'Missing today',
        timestamp: toDate(todaySchedule?.completed_at),
        tone: rehearsalToday ? 'good' : 'warning',
      },
      {
        label: 'Daily reflection',
        detail: reflectionToday ? 'Saved today' : 'Missing today',
        timestamp: toDate(todayReflection?.updated_at ?? todayReflection?.created_at),
        tone: reflectionToday ? 'good' : 'warning',
      },
    ],
  };
}
