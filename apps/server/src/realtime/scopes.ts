import { can, type Role } from '@nw/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { type Db, schema } from '../db/index.js';

export interface ScopeAuthInfo {
  userId: string;
  projectId: string;
  role: Role;
}

export type ScopeAuthorizer = (auth: ScopeAuthInfo, scopeId: string) => boolean | Promise<boolean>;

export class ScopeRegistry {
  private readonly registry = new Map<string, ScopeAuthorizer>();

  register(scopeType: string, authorizer: ScopeAuthorizer): void {
    this.registry.set(scopeType, authorizer);
  }

  async authorize(auth: ScopeAuthInfo, scopeType: string, scopeId: string): Promise<boolean> {
    const fn = this.registry.get(scopeType);
    if (!fn) return false;
    return await fn(auth, scopeId);
  }
}

export function createDefaultScopeRegistry(db: Db): ScopeRegistry {
  const registry = new ScopeRegistry();
  registry.register('project', (auth, scopeId) => scopeId === auth.projectId);
  registry.register(
    'diag',
    (auth, scopeId) => scopeId === auth.projectId && can(auth.role, 'diag.realtime'),
  );
  registry.register('worksheet', async (auth, scopeId) => {
    const [ws] = await db
      .select({ id: schema.worksheets.id })
      .from(schema.worksheets)
      .where(
        and(
          eq(schema.worksheets.projectId, auth.projectId),
          eq(schema.worksheets.id, scopeId),
          isNull(schema.worksheets.deletedAt),
        ),
      )
      .limit(1);
    return Boolean(ws);
  });
  return registry;
}
