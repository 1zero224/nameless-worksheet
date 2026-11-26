import type { ArtifactScope, UploadSessionMode } from '@nw/shared';

const STORAGE_KEY = 'nw_resumable_uploads_v1';

export interface ResumableUploadRecord {
  sessionId: string;
  mode: UploadSessionMode;
  targetLabel: string;
  artifactName?: string;
  versionNote?: string;
  scope?: ArtifactScope;
  artifactId?: string;
  versionId?: string;
  worksheetId?: string | null;
  workId?: string | null;
  taskId?: string | null;
  originalFilename: string;
  sizeBytes: number;
  mimeType: string;
  fingerprintSha256: string | null;
  expiresAt: string;
  createdAt: string;
}

export function loadResumableRecords(): ResumableUploadRecord[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    const valid = parsed.filter(
      (item): item is ResumableUploadRecord =>
        Boolean(item) &&
        typeof item === 'object' &&
        typeof (item as ResumableUploadRecord).sessionId === 'string' &&
        typeof (item as ResumableUploadRecord).expiresAt === 'string' &&
        Date.parse((item as ResumableUploadRecord).expiresAt) > now,
    );
    if (valid.length !== parsed.length) {
      persistResumableRecords(valid);
    }
    return valid;
  } catch {
    return [];
  }
}

function persistResumableRecords(records: ResumableUploadRecord[]): void {
  try {
    if (records.length === 0) {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
    }
  } catch {
    // ignore storage quota errors
  }
}

export function saveResumableRecord(record: ResumableUploadRecord): void {
  const existing = loadResumableRecords().filter((r) => r.sessionId !== record.sessionId);
  existing.unshift(record);
  persistResumableRecords(existing.slice(0, 20));
}

export function removeResumableRecord(sessionId: string): void {
  const existing = loadResumableRecords();
  const next = existing.filter((r) => r.sessionId !== sessionId);
  if (next.length !== existing.length) {
    persistResumableRecords(next);
  }
}
