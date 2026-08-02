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

export type TrackingTrendPoint = {
  dateKey: string;
  value: number | null;
  secondaryValue?: number | null;
};

export type TrackingTrend = {
  valueLabel: string;
  valueUnit: string;
  secondaryValueLabel?: string;
  secondaryValueUnit?: string;
  suggestedMax?: number;
  points: TrackingTrendPoint[];
};

export type TrackingCompletionPoint = {
  dateKey: string;
  completed: boolean;
  isToday: boolean;
};

export type TrackingMetric = {
  label: string;
  value: string;
  detail?: string;
  tone: TrackingTone;
  trend?: TrackingTrend;
  completionHistory?: TrackingCompletionPoint[];
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

function addDays(date: Date, days: number): Date {
  const nextDate = new Date(date);
  nextDate.setDate(date.getDate() + days);
  return nextDate;
}

function normalizeDate(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function diffCalendarDays(startDate: Date, endDate: Date): number {
  const start = normalizeDate(startDate).getTime();
  const end = normalizeDate(endDate).getTime();
  return Math.floor((end - start) / (24 * 60 * 60 * 1000));
}

function getRecentDateKeys(todayKey: string, count: number): string[] {
  const start = dateKeyToDate(todayKey) ?? new Date();
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() - index);
    return formatDateKey(date);
  });
}

function getTrackingDateKeys(startDate: Date | null, todayKey: string, maxDays = 35): string[] {
  const today = dateKeyToDate(todayKey);
  if (!startDate || !today) return [...getRecentDateKeys(todayKey, 14)].reverse();

  const normalizedStart = normalizeDate(startDate);
  const totalDays = diffCalendarDays(normalizedStart, today) + 1;
  if (totalDays <= 0) return [];

  const cappedDays = Math.min(totalDays, maxDays);
  const rangeStart = addDays(today, -(cappedDays - 1));
  return Array.from({ length: cappedDays }, (_, index) => formatDateKey(addDays(rangeStart, index)));
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

function completionRateForDateKeys(completedDates: Set<string>, dateKeys: string[], days: number): number {
  const keys = dateKeys.slice(-days);
  if (keys.length === 0) return 0;
  return Math.round((keys.filter((key) => completedDates.has(key)).length / keys.length) * 100);
}

function buildCompletionHistory(
  completedDates: Set<string>,
  dateKeys: string[],
  todayKey: string,
): TrackingCompletionPoint[] {
  return dateKeys.map((dateKey) => ({
    dateKey,
    completed: completedDates.has(dateKey),
    isToday: dateKey === todayKey,
  }));
}

function getWeeklyComplianceStatus(completedDates: Set<string>, startDate: Date | null, todayKey: string) {
  const today = dateKeyToDate(todayKey);
  if (!startDate || !today) return null;

  const normalizedStart = normalizeDate(startDate);
  const daysFromStart = diffCalendarDays(normalizedStart, today);
  if (daysFromStart < 0) return null;
  const studyWeek = Math.min(4, Math.floor(daysFromStart / 7) + 1);
  const target = studyWeek < 4 ? 4 : 2;
  const weekStart = addDays(normalizedStart, (studyWeek - 1) * 7);
  const weekDateKeys = Array.from({ length: 7 }, (_, index) => formatDateKey(addDays(weekStart, index)));
  const completed = weekDateKeys.filter((dateKey) => completedDates.has(dateKey)).length;
  const remainingOpportunity = weekDateKeys.filter(
    (dateKey) => dateKey >= todayKey && !completedDates.has(dateKey),
  ).length;

  return {
    completed,
    remainingOpportunity,
    studyWeek,
    target,
    onTrack: completed + remainingOpportunity >= target,
  };
}

function buildAlerts(params: {
  onboardingComplete: boolean;
  fitbitConnected: boolean;
  latestHealthDate: Date | null;
  completedScheduleDates: Set<string>;
  completedReflectionDates: Set<string>;
  startDate: Date | null;
  todayKey: string;
}): TrackingAlert[] {
  const alerts: TrackingAlert[] = [];
  const healthAge = daysSince(params.latestHealthDate);
  const rehearsalStatus = getWeeklyComplianceStatus(
    params.completedScheduleDates,
    params.startDate,
    params.todayKey,
  );
  const reflectionStatus = getWeeklyComplianceStatus(
    params.completedReflectionDates,
    params.startDate,
    params.todayKey,
  );

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
  if (rehearsalStatus && !rehearsalStatus.onTrack) {
    alerts.push({
      title: 'Daily rehearsal off track',
      detail: `Week ${rehearsalStatus.studyWeek}: ${rehearsalStatus.completed}/${rehearsalStatus.target} complete with ${rehearsalStatus.remainingOpportunity} days left.`,
      tone: 'warning',
    });
  }
  if (reflectionStatus && !reflectionStatus.onTrack) {
    alerts.push({
      title: 'Daily reflection off track',
      detail: `Week ${reflectionStatus.studyWeek}: ${reflectionStatus.completed}/${reflectionStatus.target} complete with ${reflectionStatus.remainingOpportunity} days left.`,
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
  deploymentStartDateKey = '',
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
  const deploymentStartDate = deploymentStartDateKey ? dateKeyToDate(deploymentStartDateKey) : null;
  const participantStartDate = deploymentStartDate ?? toDate(userData.createdAt);
  const trackingDateKeys = getTrackingDateKeys(participantStartDate, todayKey);
  const trackingDateSet = new Set(trackingDateKeys);
  const trackingDayCount = Math.max(14, trackingDateKeys.length);

  const [
    todayScheduleDoc,
    todayDailyReflectionDoc,
    todayLegacyReflectionDoc,
    recentSchedules,
    recentDailyReflections,
    recentLegacyReflections,
    recentHealthDocs,
  ] =
    await Promise.all([
      getDoc(doc(db, 'users', userId, 'daily_schedules', todayKey)),
      getDoc(doc(db, 'users', userId, 'daily_reflections', todayKey)),
      getDoc(doc(db, 'users', userId, 'value_reflections', `reflection-daily-${todayKey}`)),
      getLatestCollectionDocs(userId, 'daily_schedules', trackingDayCount),
      getLatestCollectionDocs(userId, 'daily_reflections', trackingDayCount),
      getLatestCollectionDocs(userId, 'value_reflections', trackingDayCount),
      getLatestCollectionDocs(userId, 'health_days', trackingDayCount),
    ]);

  const todaySchedule = todayScheduleDoc.exists() ? todayScheduleDoc.data() : null;
  const todayReflectionDoc = todayDailyReflectionDoc.exists()
    ? todayDailyReflectionDoc
    : todayLegacyReflectionDoc;
  const todayReflection = todayReflectionDoc.exists() ? todayReflectionDoc.data() : null;
  const latestHealthDoc = recentHealthDocs.find((item) => {
    const healthDay = asRecord(item.data);
    const dateKey = asString(healthDay.date, asString(healthDay.snapshot_date, item.id));
    return trackingDateSet.has(dateKey);
  });
  const latestHealth = latestHealthDoc?.data ?? null;
  const latestHealthDate = latestHealth
    ? dateKeyToDate(asString(latestHealth.date, asString(latestHealth.snapshot_date, latestHealthDoc?.id ?? '')))
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
    [...recentDailyReflections, ...recentLegacyReflections.filter((item) => asString(item.data.scope) === 'daily')]
      .map((item) => asString(item.data.date, item.id.replace(/^reflection-daily-/, '')))
      .filter(Boolean),
  );

  const healthByDate = new Map<string, Record<string, unknown>>();
  for (const item of recentHealthDocs) {
    const healthDay = asRecord(item.data);
    const dateKey = asString(healthDay.date, asString(healthDay.snapshot_date, item.id));
    if (dateKey) healthByDate.set(dateKey, healthDay);
  }

  const onboardingComplete = asBoolean(onboarding.onboarding_complete);
  const demographicsComplete = asBoolean(onboarding.demographics_completed);
  const valueQuizComplete = asBoolean(onboarding.value_quiz_completed);
  const fitbitConnected = asBoolean(integrations.fitbit_connected);
  const trackingHasStarted = trackingDateSet.has(todayKey);
  const rehearsalToday = trackingHasStarted && asString(todaySchedule?.status) === 'completed';
  const reflectionToday = trackingHasStarted && todayReflectionDoc.exists();
  const sleep = asRecord(latestHealth?.sleep);
  const activity = asRecord(latestHealth?.activity);
  const vitals = asRecord(latestHealth?.vitals);

  if (rehearsalToday) completedScheduleDates.add(todayKey);
  if (reflectionToday) completedReflectionDates.add(todayKey);

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
  ];

  const sleepHours = asNumber(sleep.hours);
  const sleepEfficiency = asNumber(sleep.efficiency);
  const steps = asNumber(activity.steps);
  const restingHeartRate = asNumber(vitals.resting_heart_rate);
  const chartDateKeys = trackingDateKeys;
  const fitbitTrendPoints: TrackingTrendPoint[] = chartDateKeys.map((dateKey) => ({
    dateKey,
    value: healthByDate.has(dateKey) ? 1 : null,
  }));
  const sleepTrendPoints: TrackingTrendPoint[] = chartDateKeys.map((dateKey) => {
    const healthDay = healthByDate.get(dateKey);
    const daySleep = asRecord(healthDay?.sleep);
    return {
      dateKey,
      value: asNumber(daySleep.hours),
      secondaryValue: asNumber(daySleep.efficiency),
    };
  });
  const activityTrendPoints: TrackingTrendPoint[] = chartDateKeys.map((dateKey) => {
    const healthDay = healthByDate.get(dateKey);
    const dayActivity = asRecord(healthDay?.activity);
    const dayVitals = asRecord(healthDay?.vitals);
    return {
      dateKey,
      value: asNumber(dayActivity.steps),
      secondaryValue: asNumber(dayVitals.resting_heart_rate),
    };
  });

  const dataFlow: TrackingMetric[] = [
    {
      label: 'Fitbit',
      value: fitbitConnected ? 'Connected' : 'Disconnected',
      detail: latestHealthSyncedAt ? `Synced ${formatRelativeDate(latestHealthSyncedAt).toLowerCase()}` : 'No sync record',
      tone: fitbitConnected ? 'good' : 'critical',
      trend: {
        valueLabel: 'Health day',
        valueUnit: 'record',
        suggestedMax: 1,
        points: fitbitTrendPoints,
      },
    },
    {
      label: 'Sleep',
      value: sleepHours !== null ? `${sleepHours.toFixed(1)}h` : 'Missing',
      detail: sleepEfficiency !== null ? `${sleepEfficiency}% efficiency` : undefined,
      tone: sleepHours !== null ? 'good' : 'warning',
      trend: {
        valueLabel: 'Sleep',
        valueUnit: 'h',
        secondaryValueLabel: 'Efficiency',
        secondaryValueUnit: '%',
        suggestedMax: 10,
        points: sleepTrendPoints,
      },
    },
    {
      label: 'Activity',
      value: steps !== null ? `${Math.round(steps).toLocaleString()} steps` : 'Missing',
      detail: restingHeartRate !== null ? `${Math.round(restingHeartRate)} bpm resting HR` : 'Resting HR missing',
      tone: steps !== null || restingHeartRate !== null ? 'good' : 'warning',
      trend: {
        valueLabel: 'Steps',
        valueUnit: 'steps',
        secondaryValueLabel: 'Resting HR',
        secondaryValueUnit: 'bpm',
        points: activityTrendPoints,
      },
    },
  ];

  const rehearsalRate = completionRateForDateKeys(completedScheduleDates, trackingDateKeys, 7);
  const reflectionRate = completionRateForDateKeys(completedReflectionDates, trackingDateKeys, 7);
  const rehearsalHistory = buildCompletionHistory(completedScheduleDates, trackingDateKeys, todayKey);
  const reflectionHistory = buildCompletionHistory(completedReflectionDates, trackingDateKeys, todayKey);

  const dailyCompliance: TrackingMetric[] = [
    {
      label: 'Daily rehearsal',
      value: statusFromBoolean(rehearsalToday, 'Done today', 'Missing today'),
      detail: `7-day rate ${rehearsalRate}%`,
      tone: toneFromBoolean(rehearsalToday),
      completionHistory: rehearsalHistory,
    },
    {
      label: 'Daily reflection',
      value: statusFromBoolean(reflectionToday, 'Done today', 'Missing today'),
      detail: `7-day rate ${reflectionRate}%`,
      tone: toneFromBoolean(reflectionToday),
      completionHistory: reflectionHistory,
    },
  ];

  const alerts = buildAlerts({
    onboardingComplete,
    fitbitConnected,
    latestHealthDate,
    completedScheduleDates,
    completedReflectionDates,
    startDate: participantStartDate,
    todayKey,
  });

  return {
    participantId: asString(demo.participant_id, asString(demo.participantId, normalizedParticipantId)),
    userId,
    displayName: asString(userData.displayName, 'Unknown'),
    email: asString(userData.email, 'No email'),
    cohort: asString(userData.cohort, asString(asRecord(userData.study).cohort, 'Not set')),
    startDate: participantStartDate,
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
