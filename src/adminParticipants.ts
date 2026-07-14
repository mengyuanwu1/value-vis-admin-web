import type { User } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDocs,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore';
import { db } from './firebase';
import { normalizeAdminEmail } from './adminAccess';

export type SavedParticipant = {
  participantId: string;
  deploymentStartDate?: string;
};

function normalizeParticipantId(participantId: string): string {
  return participantId.trim().toUpperCase();
}

function cleanParticipantId(participantId: string): string {
  return participantId.trim();
}

function getAdminEmail(user: User): string {
  const email = normalizeAdminEmail(user.email ?? '');
  if (!email) {
    throw new Error('Your signed-in account does not have an email address.');
  }
  return email;
}

function getParticipantDocId(participantId: string): string {
  const normalized = normalizeParticipantId(participantId);
  if (!normalized || normalized.includes('/')) {
    throw new Error('Enter a valid participant ID.');
  }
  return normalized;
}

function cleanDeploymentStartDate(dateKey?: string): string {
  const cleanDateKey = dateKey?.trim() ?? '';
  if (!cleanDateKey) return '';

  const match = cleanDateKey.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error('Enter deployment start date as YYYY-MM-DD.');
  }

  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (
    date.getFullYear() !== Number(match[1])
    || date.getMonth() !== Number(match[2]) - 1
    || date.getDate() !== Number(match[3])
  ) {
    throw new Error('Enter a valid deployment start date.');
  }

  return cleanDateKey;
}

function getRosterCollection(user: User) {
  return collection(db, 'admin_participant_rosters', getAdminEmail(user), 'participants');
}

export async function listSavedParticipants(user: User): Promise<SavedParticipant[]> {
  const snapshot = await getDocs(getRosterCollection(user));
  return snapshot.docs
    .map((item) => {
      const data = item.data();
      const participantId = typeof data.participant_id === 'string' ? data.participant_id : item.id;
      const deploymentStartDate =
        typeof data.deployment_start_date === 'string' ? cleanDeploymentStartDate(data.deployment_start_date) : '';
      return {
        participantId: cleanParticipantId(participantId),
        ...(deploymentStartDate ? { deploymentStartDate } : {}),
      };
    })
    .filter((item) => item.participantId.length > 0)
    .sort((left, right) => left.participantId.localeCompare(right.participantId, undefined, { sensitivity: 'base' }));
}

export async function addSavedParticipant(
  user: User,
  participantId: string,
  deploymentStartDate?: string,
): Promise<string> {
  const normalized = getParticipantDocId(participantId);
  const displayParticipantId = cleanParticipantId(participantId);
  const cleanDateKey = cleanDeploymentStartDate(deploymentStartDate);
  await setDoc(
    doc(getRosterCollection(user), normalized),
    {
      participant_id: displayParticipantId,
      owner_email: getAdminEmail(user),
      added_by_uid: user.uid,
      added_at: serverTimestamp(),
      updated_at: serverTimestamp(),
      ...(cleanDateKey ? { deployment_start_date: cleanDateKey } : {}),
    },
    { merge: true },
  );
  return displayParticipantId;
}

export async function updateSavedParticipantDeploymentStartDate(
  user: User,
  participantId: string,
  deploymentStartDate: string,
): Promise<string> {
  const normalized = getParticipantDocId(participantId);
  const cleanDateKey = cleanDeploymentStartDate(deploymentStartDate);
  await setDoc(
    doc(getRosterCollection(user), normalized),
    {
      deployment_start_date: cleanDateKey || deleteField(),
      updated_at: serverTimestamp(),
    },
    { merge: true },
  );
  return cleanDateKey;
}

export async function removeSavedParticipant(user: User, participantId: string): Promise<string> {
  const normalized = getParticipantDocId(participantId);
  await deleteDoc(doc(getRosterCollection(user), normalized));
  return cleanParticipantId(participantId);
}
