import type { User } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore';
import { db } from './firebase';
import { normalizeAdminEmail } from './adminAccess';

export type SavedParticipant = {
  participantId: string;
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

function getRosterCollection(user: User) {
  return collection(db, 'admin_participant_rosters', getAdminEmail(user), 'participants');
}

export async function listSavedParticipants(user: User): Promise<SavedParticipant[]> {
  const snapshot = await getDocs(getRosterCollection(user));
  return snapshot.docs
    .map((item) => {
      const data = item.data();
      const participantId = typeof data.participant_id === 'string' ? data.participant_id : item.id;
      return { participantId: cleanParticipantId(participantId) };
    })
    .filter((item) => item.participantId.length > 0)
    .sort((left, right) => left.participantId.localeCompare(right.participantId, undefined, { sensitivity: 'base' }));
}

export async function addSavedParticipant(user: User, participantId: string): Promise<string> {
  const normalized = getParticipantDocId(participantId);
  const displayParticipantId = cleanParticipantId(participantId);
  await setDoc(
    doc(getRosterCollection(user), normalized),
    {
      participant_id: displayParticipantId,
      owner_email: getAdminEmail(user),
      added_by_uid: user.uid,
      added_at: serverTimestamp(),
      updated_at: serverTimestamp(),
    },
    { merge: true },
  );
  return displayParticipantId;
}

export async function removeSavedParticipant(user: User, participantId: string): Promise<string> {
  const normalized = getParticipantDocId(participantId);
  await deleteDoc(doc(getRosterCollection(user), normalized));
  return cleanParticipantId(participantId);
}
