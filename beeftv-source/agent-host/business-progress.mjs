// A closed projection of our own tool details. Raw tool output and provider
// stage/error text must never become panel copy or reconnect progress.
const TOOLS = new Set(['canvas_generation_submit', 'canvas_timeline_render', 'canvas_timeline_deliver']);
const STAGES = new Set(['processing', 'downloading', 'saving', 'saved', 'binding', 'rendering', 'exporting', 'checking', 'observation_unavailable']);

export function businessLifecycle(toolName, details) {
  const progress = details?.beeftvProgress;
  if (!TOOLS.has(toolName) || !STAGES.has(progress?.stage)) return null;
  const result = { type: 'lifecycle', phase: 'business', toolName, stage: progress.stage };
  if (Number.isSafeInteger(progress.total) && progress.total > 0 && progress.total <= 1000 &&
      Number.isSafeInteger(progress.saved) && progress.saved >= 0 && progress.saved <= progress.total) {
    result.total = progress.total;
    result.saved = progress.saved;
  }
  return result;
}
