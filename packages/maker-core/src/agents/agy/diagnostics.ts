import { AcpRpcError } from '../acp/protocol.js';

export interface AgyRpcDiagnostic {
  method: string;
  code: number;
  message: string;
  data?: unknown;
}

// Diagnostics are an explicit, local host opt-in. Never persist the raw payload.
// Keep error structure only for known diagnostic fields; unknown fields are omitted.
const FIELDS = new Set(['code', 'message', 'reason', 'error', 'details', 'status', 'type']);
// Free text can contain short, unlabelled account/project names. Pattern masking
// cannot establish safety. Preserve only exact protocol messages/reason codes;
// mark all other text as omitted, never pretend it is a complete raw transcript.
const SAFE_TEXT = new Set([
  'Authentication required', 'auth_required', 'Internal error', 'internal_error',
  'Invalid request', 'Invalid params', 'Method not found', 'Resource not found',
  'Request cancelled', 'Parse error', 'UNAUTHENTICATED', 'PERMISSION_DENIED',
  'INVALID_ARGUMENT', 'UNAVAILABLE', 'RESOURCE_EXHAUSTED',
]);
function text(value: string): string {
  return SAFE_TEXT.has(value) ? value : '[REDACTED_UNCLASSIFIED_TEXT]';
}

export function agyRpcDiagnostic(method: string, error: AcpRpcError): AgyRpcDiagnostic {
  let remaining = 64;
  const redact = (value: unknown, depth = 0): unknown => {
    if (--remaining < 0 || depth > 4) return '[REDACTED_LIMIT]';
    if (typeof value === 'string') return text(value);
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : '[REDACTED]';
    if (Array.isArray(value)) return value.slice(0, 8).map(item => redact(item, depth + 1));
    if (value && typeof value === 'object') {
      const output: Record<string, unknown> = {};
      let omitted = false;
      for (const [key, item] of Object.entries(value)) {
        if (!FIELDS.has(key)) { omitted = true; continue; }
        output[key] = redact(item, depth + 1);
      }
      if (omitted) output.redactedFields = true;
      return output;
    }
    return '[REDACTED]';
  };
  return { method, code: error.code, message: text(error.message),
    ...(error.data !== undefined ? { data: redact(error.data) } : {}) };
}
