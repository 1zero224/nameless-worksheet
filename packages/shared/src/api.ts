import type { Role } from './fields.js';
import type { Permission } from './permissions.js';

export interface MeResponse {
  user: { id: string; loginName: string; displayName: string };
  project: { id: string; name: string };
  role: Role;
  permissions: Permission[];
}

export interface UserListItem {
  id: string;
  displayName: string;
  role: Role;
  loginName?: string;
  createdAt?: string;
}

export type InviteStatus = 'active' | 'exhausted' | 'expired' | 'revoked';
export const INVITE_STATUS_LABELS: Record<InviteStatus, string> = {
  active: '有效',
  exhausted: '已用完',
  expired: '已过期',
  revoked: '已作废',
};

export interface InviteItem {
  id: string;
  role: Role;
  expiresAt: string;
  maxUses: number;
  usedCount: number;
  revokedAt: string | null;
  createdBy: { id: string; displayName: string };
  createdAt: string;
  status: InviteStatus;
}

export interface CreatedInvite extends InviteItem {
  url: string;
}

export interface InvitePreview {
  projectName: string;
  role: Role;
}

export interface ResetPreview {
  loginName: string;
  displayName: string;
}

export interface ResetLinkResponse {
  url: string;
  expiresAt: string;
}
