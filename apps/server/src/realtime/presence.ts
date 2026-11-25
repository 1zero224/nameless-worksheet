import type { PresenceFocus, PresencePeer } from '@nw/shared';

/**
 * 工作表内存在线状态与单元格焦点存储（不落库、不参与游标补发）。
 * key 为 scopeKey({ type: 'worksheet', id })。
 */
export class PresenceStore {
  private readonly byScope = new Map<string, Map<string, PresencePeer>>();

  /** 加入范围，返回该范围内除自身以外的当前在线列表 */
  join(scopeKeyStr: string, peer: PresencePeer): PresencePeer[] {
    let room = this.byScope.get(scopeKeyStr);
    if (!room) {
      room = new Map();
      this.byScope.set(scopeKeyStr, room);
    }
    room.set(peer.connId, { ...peer });

    const others: PresencePeer[] = [];
    for (const [cid, p] of room) {
      if (cid !== peer.connId) {
        others.push({ ...p });
      }
    }
    return others;
  }

  /** 更新某个连接在指定范围内的焦点 */
  updateFocus(
    scopeKeyStr: string,
    connId: string,
    focus: PresenceFocus | null,
  ): PresencePeer | null {
    const room = this.byScope.get(scopeKeyStr);
    if (!room) return null;
    const existing = room.get(connId);
    if (!existing) return null;
    const updated: PresencePeer = { ...existing, focus };
    room.set(connId, updated);
    return updated;
  }

  /** 离开指定范围；返回是否原本在线 */
  leave(scopeKeyStr: string, connId: string): boolean {
    const room = this.byScope.get(scopeKeyStr);
    if (!room) return false;
    const removed = room.delete(connId);
    if (room.size === 0) {
      this.byScope.delete(scopeKeyStr);
    }
    return removed;
  }

  /** 用户改显示名时更新内存副本，返回受影响的 (scopeKey, peer) */
  updateDisplayName(
    userId: string,
    displayName: string,
  ): Array<{ scopeKey: string; peer: PresencePeer }> {
    const affected: Array<{ scopeKey: string; peer: PresencePeer }> = [];
    for (const [key, room] of this.byScope) {
      for (const [cid, peer] of room) {
        if (peer.userId === userId) {
          const updated: PresencePeer = { ...peer, displayName };
          room.set(cid, updated);
          affected.push({ scopeKey: key, peer: updated });
        }
      }
    }
    return affected;
  }
}
