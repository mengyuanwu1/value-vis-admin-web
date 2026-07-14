import type { User } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore';
import { db } from './firebase';

export type AdminClaims = {
  admin?: boolean;
  study_admin?: boolean;
};

export type AdminAccessSource = 'claim' | 'bootstrap_email' | 'allowlist' | 'none';

export type AdminAccess = {
  isAdmin: boolean;
  source: AdminAccessSource;
  email: string;
  label: string;
};

export type AdminUser = {
  email: string;
  source: 'bootstrap' | 'allowlist';
  removable: boolean;
};

export const BOOTSTRAP_ADMIN_EMAILS = [
  'mw3209@columbia.edu',
  'mengyuanwu1@gmail.com',
] as const;

export const EMPTY_ADMIN_ACCESS: AdminAccess = {
  isAdmin: false,
  source: 'none',
  email: '',
  label: 'No admin access',
};

export function normalizeAdminEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isBootstrapAdminEmail(email: string): boolean {
  return BOOTSTRAP_ADMIN_EMAILS.includes(normalizeAdminEmail(email) as typeof BOOTSTRAP_ADMIN_EMAILS[number]);
}

export function getBootstrapAdminUsers(): AdminUser[] {
  return BOOTSTRAP_ADMIN_EMAILS.map((email) => ({
    email,
    source: 'bootstrap',
    removable: false,
  }));
}

export function validateAdminEmail(email: string): string {
  const normalized = normalizeAdminEmail(email);
  if (!normalized || !normalized.includes('@') || normalized.includes('/')) {
    throw new Error('Enter a valid email address.');
  }
  return normalized;
}

export async function resolveAdminAccess(user: User, claims: AdminClaims): Promise<AdminAccess> {
  const email = normalizeAdminEmail(user.email ?? '');

  if (claims.admin === true || claims.study_admin === true) {
    return {
      isAdmin: true,
      source: 'claim',
      email,
      label: 'Admin access: custom claim',
    };
  }

  if (email && isBootstrapAdminEmail(email)) {
    return {
      isAdmin: true,
      source: 'bootstrap_email',
      email,
      label: 'Admin access: bootstrap email',
    };
  }

  if (!email) return EMPTY_ADMIN_ACCESS;

  const adminDoc = await getDoc(doc(db, 'admin_users', email));
  if (adminDoc.exists()) {
    return {
      isAdmin: true,
      source: 'allowlist',
      email,
      label: 'Admin access: allowlist',
    };
  }

  return {
    ...EMPTY_ADMIN_ACCESS,
    email,
  };
}

export async function listAdminUsers(): Promise<AdminUser[]> {
  const snapshot = await getDocs(collection(db, 'admin_users'));
  const users = new Map<string, AdminUser>();

  for (const admin of getBootstrapAdminUsers()) {
    users.set(admin.email, admin);
  }

  snapshot.docs.forEach((item) => {
    const data = item.data();
    const email = normalizeAdminEmail(typeof data.email === 'string' ? data.email : item.id);
    if (!email) return;
    if (users.has(email)) return;

    users.set(email, {
      email,
      source: 'allowlist',
      removable: true,
    });
  });

  return Array.from(users.values()).sort((left, right) => left.email.localeCompare(right.email));
}

export async function grantAdminAccess(email: string, actor: User): Promise<string> {
  const normalized = validateAdminEmail(email);
  const adminRef = doc(db, 'admin_users', normalized);
  const existing = await getDoc(adminRef);
  const actorEmail = normalizeAdminEmail(actor.email ?? '');
  const basePayload = {
    email: normalized,
    role: 'study_admin',
    updated_at: serverTimestamp(),
    updated_by_uid: actor.uid,
    updated_by_email: actorEmail || null,
  };

  await setDoc(
    adminRef,
    existing.exists()
      ? basePayload
      : {
          ...basePayload,
          created_at: serverTimestamp(),
          created_by_uid: actor.uid,
          created_by_email: actorEmail || null,
        },
    { merge: true },
  );

  return normalized;
}

export async function revokeAdminAccess(email: string): Promise<string> {
  const normalized = validateAdminEmail(email);
  if (isBootstrapAdminEmail(normalized)) {
    throw new Error('Bootstrap admin emails cannot be removed from the website.');
  }

  await deleteDoc(doc(db, 'admin_users', normalized));
  return normalized;
}
