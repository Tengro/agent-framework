import { ref, shallowRef, onUnmounted } from 'vue';
import type { ApiRequest, ApiResponse, ApiEvent, ApiMessage } from '../api/types';

export interface UseWebSocketOptions {
  url: string;
  autoConnect?: boolean;
  reconnectInterval?: number;
}

export function useWebSocket(options: UseWebSocketOptions) {
  const { url, autoConnect = true, reconnectInterval = 2000 } = options;

  const connected = ref(false);
  const connecting = ref(false);
  const error = ref<string | null>(null);
  const socket = shallowRef<WebSocket | null>(null);

  // Request tracking
  let requestId = 0;
  const pendingRequests = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  // Event handlers
  const eventHandlers = new Map<string, Set<(data: unknown) => void>>();

  function connect() {
    if (socket.value || connecting.value) return;

    connecting.value = true;
    error.value = null;

    const ws = new WebSocket(url);

    ws.onopen = () => {
      socket.value = ws;
      connected.value = true;
      connecting.value = false;
      error.value = null;
    };

    ws.onmessage = (event) => {
      try {
        const message: ApiMessage = JSON.parse(event.data);
        handleMessage(message);
      } catch (e) {
        console.error('Failed to parse message:', e);
      }
    };

    ws.onclose = () => {
      socket.value = null;
      connected.value = false;
      connecting.value = false;

      // Reject pending requests
      for (const [id, { reject }] of pendingRequests) {
        reject(new Error('Connection closed'));
        pendingRequests.delete(id);
      }

      // Auto-reconnect
      setTimeout(() => {
        if (!socket.value) {
          connect();
        }
      }, reconnectInterval);
    };

    ws.onerror = () => {
      error.value = 'Connection error';
      connecting.value = false;
    };
  }

  function disconnect() {
    if (socket.value) {
      socket.value.close();
      socket.value = null;
    }
    connected.value = false;
  }

  function handleMessage(message: ApiMessage) {
    if (message.type === 'response') {
      const response = message as ApiResponse;
      if (response.id) {
        const pending = pendingRequests.get(response.id);
        if (pending) {
          pendingRequests.delete(response.id);
          if (response.success) {
            pending.resolve(response.data);
          } else {
            pending.reject(new Error(response.error ?? 'Unknown error'));
          }
        }
      }
    } else if (message.type === 'event') {
      const event = message as ApiEvent;
      const handlers = eventHandlers.get(event.event);
      if (handlers) {
        for (const handler of handlers) {
          try {
            handler(event.data);
          } catch (e) {
            console.error('Event handler error:', e);
          }
        }
      }
      // Also notify wildcard handlers
      const wildcardHandlers = eventHandlers.get('*');
      if (wildcardHandlers) {
        for (const handler of wildcardHandlers) {
          try {
            handler({ event: event.event, data: event.data });
          } catch (e) {
            console.error('Wildcard handler error:', e);
          }
        }
      }
    }
  }

  async function send<T = unknown>(
    command: string,
    params?: Record<string, unknown>
  ): Promise<T> {
    if (!socket.value || socket.value.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected');
    }

    const id = `req-${++requestId}`;
    const request: ApiRequest = {
      type: 'request',
      id,
      command,
      params,
    };

    return new Promise<T>((resolve, reject) => {
      pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      socket.value!.send(JSON.stringify(request));

      // Timeout after 30 seconds
      setTimeout(() => {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id);
          reject(new Error('Request timeout'));
        }
      }, 30000);
    });
  }

  function on(event: string, handler: (data: unknown) => void) {
    if (!eventHandlers.has(event)) {
      eventHandlers.set(event, new Set());
    }
    eventHandlers.get(event)!.add(handler);
  }

  function off(event: string, handler: (data: unknown) => void) {
    const handlers = eventHandlers.get(event);
    if (handlers) {
      handlers.delete(handler);
    }
  }

  // Auto-connect if enabled
  if (autoConnect) {
    connect();
  }

  // Cleanup on unmount
  onUnmounted(() => {
    disconnect();
  });

  return {
    connected,
    connecting,
    error,
    connect,
    disconnect,
    send,
    on,
    off,
  };
}
