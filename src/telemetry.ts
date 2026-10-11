// Layer one of DESIGN.md §7: one structured line per request and per tool call, correlated by a
// W3C trace id. Never arguments, images, file contents or findings text. An OpenTelemetry
// exporter can be dropped in behind `emit` without touching callers.
import { createHmac, randomBytes } from 'node:crypto';

export interface TraceContext { traceId: string; spanId: string; traceparent: string }

export function traceFromHeader(traceparent: string | undefined): TraceContext {
  const m = traceparent?.match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i);
  const traceId = m ? m[1]!.toLowerCase() : randomBytes(16).toString('hex');
  const spanId = randomBytes(8).toString('hex');
  return { traceId, spanId, traceparent: `00-${traceId}-${spanId}-01` };
}

/**
 * The principal as telemetry sees it (DESIGN.md §7: a principal hash, never the raw `sub`). Keyed
 * so a short `sub` cannot be recovered by guessing; stable across restarts with the same key, so
 * distinct-principal counts survive.
 */
export function principalHash(sub: string): string {
  const key = process.env.TELEMETRY_SALT ?? process.env.AUTH_HMAC_KEY ?? 'tenet-ui-mcp';
  return `p_${createHmac('sha256', key).update(sub).digest('hex').slice(0, 16)}`;
}

export interface Event {
  event: 'request' | 'tool' | 'resource' | 'auth';
  traceId: string;
  [k: string]: unknown;
}

let sink: (e: Event) => void = (e) => {
  if (process.env.TELEMETRY === 'off') return;
  process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), ...e }) + '\n');
};

export const setTelemetrySink = (fn: (e: Event) => void): void => { sink = fn; };
export const emit = (e: Event): void => sink(e);
