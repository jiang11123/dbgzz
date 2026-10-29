const textOf = (message) => message?.role === 'assistant'
  ? (message.content || []).filter((block) => block?.type === 'text').map((block) => block.text || '').join('') : '';

// Durable publishes whole messages/blocks as well as append deltas. Keep one
// current-turn projection so replacement and overflow snapshots cannot duplicate text.
export function createDurableTextProjection() {
  let afterEntry = Infinity;
  let completed = new Map();
  let message = null;
  let text = '';
  let initialized = false;
  return {
    get text() { return text; },
    get initialized() { return initialized; },
    accept(event) {
      switch (event?.type) {
        case 'snapshot':
          if (event.afterEntry !== undefined) afterEntry = event.afterEntry;
          completed = new Map((event.entries || []).filter((entry) => entry.id > afterEntry)
            .map((entry) => [entry.id, textOf(entry.model?.[0])]));
          message = event.generation?.message ? structuredClone(event.generation.message) : null;
          break;
        case 'message_start':
          if (event.message?.role !== 'assistant') return null;
          message = structuredClone(event.message);
          break;
        case 'message_update':
          for (const change of event.changes || []) {
            if (change.type === 'message') { message = structuredClone(change.message); continue; }
            if (!message) message = { role: 'assistant', content: [] };
            // Only visible text is projected. Reasoning, tool arguments and provider errors stay private.
            if (change.type === 'text_start' || (change.type === 'block' && change.block?.type === 'text')) {
              message.content[change.contentIndex] = structuredClone(change.block);
            } else if (change.type === 'text_delta') {
              const previous = message.content[change.contentIndex];
              message.content[change.contentIndex] = { type: 'text', text: (previous?.type === 'text' ? previous.text : '') + change.delta };
            } else if (change.type === 'block') {
              message.content[change.contentIndex] = { type: 'text', text: '' };
            }
          }
          break;
        case 'message_end':
          if (event.entry?.model?.[0]?.role !== 'assistant' || event.entry.id <= afterEntry) return null;
          completed.set(event.entry.id, textOf(event.entry.model[0]));
          message = null;
          break;
        default: return null;
      }
      const next = [...completed.values(), textOf(message)].filter(Boolean).join('\n\n');
      if (initialized && next === text) return null;
      initialized = true;
      text = next;
      return { type: 'text_snapshot', text };
    },
  };
}
