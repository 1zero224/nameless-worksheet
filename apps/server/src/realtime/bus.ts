import type { Scope } from '@nw/shared';

export interface StoredRealtimeEvent {
  id: bigint;
  projectId: string;
  scope: Scope;
  type: string;
  payload: unknown;
  actorUserId: string | null;
  originConnId: string | null;
  createdAt: Date;
}

export type EventBusHandler = (events: StoredRealtimeEvent[]) => void;

/** 事件总线接口：阶段 1 只有进程内实现，将来多实例时替换为分布式实现 */
export interface EventBus {
  publish(events: StoredRealtimeEvent[]): void;
  subscribe(handler: EventBusHandler): () => void;
}

export class InProcessEventBus implements EventBus {
  private readonly handlers = new Set<EventBusHandler>();

  publish(events: StoredRealtimeEvent[]): void {
    if (events.length === 0) return;
    for (const handler of this.handlers) {
      handler(events);
    }
  }

  subscribe(handler: EventBusHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
}
