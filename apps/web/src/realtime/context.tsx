import type { Scope } from '@nw/shared';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
} from 'react';
import type { RealtimeClient, RealtimeStatus, ScopeHandlers } from './client.js';

const RealtimeContext = createContext<RealtimeClient | null>(null);

export function createRealtimeUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/api/realtime`;
}

export function RealtimeProvider({
  client,
  active,
  onAuthLost,
  children,
}: {
  client: RealtimeClient;
  active: boolean;
  onAuthLost: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    client.setOnAuthLost(onAuthLost);
  }, [client, onAuthLost]);

  useEffect(() => {
    if (!active) {
      client.stop();
      return;
    }
    client.start();

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        client.retryNow();
      }
    };
    const onOnline = () => {
      client.retryNow();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      client.stop();
    };
  }, [client, active]);

  return <RealtimeContext.Provider value={client}>{children}</RealtimeContext.Provider>;
}

export function useRealtimeClient(): RealtimeClient {
  const ctx = useContext(RealtimeContext);
  if (!ctx) throw new Error('useRealtimeClient must be used inside RealtimeProvider');
  return ctx;
}

export function useRealtimeStatus(): { status: RealtimeStatus; connId: string | null } {
  const client = useRealtimeClient();
  const status = useSyncExternalStore(
    (cb) => client.onStateChange(cb),
    () => client.getStatus(),
  );
  const connId = useSyncExternalStore(
    (cb) => client.onStateChange(cb),
    () => client.getConnId(),
  );
  return { status, connId };
}

export function useRealtimeCursor(scope: Scope | null): string | null {
  const client = useRealtimeClient();
  return useSyncExternalStore(
    (cb) => client.onStateChange(cb),
    () => (scope ? client.getCursor(scope) : null),
  );
}

export function useRealtimeScope(scope: Scope | null, handlers: ScopeHandlers): void {
  const client = useRealtimeClient();
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const scopeType = scope?.type;
  const scopeId = scope?.id;

  useEffect(() => {
    if (!scopeType || !scopeId) return;
    return client.subscribe(
      { type: scopeType, id: scopeId },
      {
        onSubscribed: (c) => handlersRef.current.onSubscribed?.(c),
        onEvent: (ev) => handlersRef.current.onEvent?.(ev),
        onResync: (c) => handlersRef.current.onResync?.(c),
        onError: (code, msg) => handlersRef.current.onError?.(code, msg),
      },
    );
  }, [client, scopeType, scopeId]);
}
