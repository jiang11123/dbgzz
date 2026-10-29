// pi-ai 1.2.0 recognizes network errors but misses this gateway's premature EOF.
// Classify only that complete diagnostic; unrelated auth, quota, parsing and
// context errors must retain the official policy. Keep the original diagnostic.
const FIRST_RESPONSE_EOF = /^upstream stream ended before first response:\s*(?:unexpected\s+)?eof\s*$/i;

export function normalizeModelTransportError(message) {
  if (message.stopReason !== 'error' || typeof message.errorMessage !== 'string') return;
  if (!FIRST_RESPONSE_EOF.test(message.errorMessage)) return;
  message.errorMessage = `Network error: ${message.errorMessage}`;
}
