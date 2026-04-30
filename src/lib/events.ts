/**
 * In-process event bus for real-time usage activity.
 *
 * Every approved or denied budget reservation emits an ActivityEvent here.
 * The SSE endpoint at GET /events/activity subscribes and pushes to connected clients.
 *
 * This is intentionally in-memory and process-local. For multi-instance deployments
 * swap the EventEmitter for a Redis pub/sub or Postgres LISTEN/NOTIFY channel.
 */
import { EventEmitter } from 'node:events';

export interface ActivityEvent {
  /** UUID of the usage_log row just inserted. */
  usage_log_id: string;
  /** Agent that made (or attempted) the call. */
  agent_id: string;
  /**
   * Human-readable agent name.
   * Currently identical to agent_id — a dedicated name column can be added later.
   */
  agent_name: string;
  /** Estimated cost in USD (0 is valid for status-only events). */
  cost: number;
  /** 'approved' | 'denied' | 'completed' */
  status: string;
  /** OpenAI model used, if known. */
  model: string | null;
  /** ISO 8601 timestamp of when the event was recorded. */
  timestamp: string;
}

const bus = new EventEmitter();
/** Allow up to 200 simultaneous SSE connections per process. */
bus.setMaxListeners(200);

const EVENT_NAME = 'activity' as const;

/** Emit a usage activity event. Fire-and-forget — never throws. */
export function emitActivity(event: ActivityEvent): void {
  try {
    bus.emit(EVENT_NAME, event);
  } catch {
    // Emitter errors must never propagate into the request lifecycle.
  }
}

/**
 * Subscribe to activity events.
 * Returns an unsubscribe function — call it when the consumer disconnects.
 */
export function onActivity(
  handler: (event: ActivityEvent) => void,
): () => void {
  bus.on(EVENT_NAME, handler);
  return () => bus.off(EVENT_NAME, handler);
}
