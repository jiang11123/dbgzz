/// <reference lib="dom" />

export interface PageReplyMessage { id: string; role: 'user' | 'assistant' | 'unknown'; text: string }
export interface PageReplySnapshot { url: string; messages: PageReplyMessage[]; error?: string }
export interface PageReplyBaseline {
  url: string;
  messages: PageReplyMessage[];
  prompt: string;
  anchorId: string;
  emitted: Record<string, string>;
}

export function normalizePageReplyText(text: string): string {
  return text.replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n').split('\n').map(line => line.trim()).filter(Boolean).join('\n');
}

/** Capture immediately BEFORE submitting. Keep the returned state per task, never per account. */
export function createPageReplyBaseline(snapshot: PageReplySnapshot, options: { prompt?: string } = {}): PageReplyBaseline {
  return { url: snapshot.url, messages: snapshot.messages.map(message => ({ ...message, text: normalizePageReplyText(message.text) })),
    prompt: normalizePageReplyText(options.prompt || ''), anchorId: '', emitted: Object.create(null) as Record<string, string> };
}

/** Pure reducer: persist result.baseline on every poll (including polls without replies).
 * With prompt supplied, no assistant text is trusted until a NEW matching user turn exists.
 * Without prompt, only additions after a known baseline tail are accepted (empty baseline fails closed).
 */
const compact = (text: string): string => normalizePageReplyText(text).replace(/\s+/g, '');

/** The page can re-render a pasted turn with trimmed punctuation or a wrapper prefix. */
export function sameTurn(rendered: string, prompt: string): boolean {
  const left = compact(rendered);
  const right = compact(prompt).replace(/[。！？!?.,，]+$/, '');
  if (!left || !right) return false;
  if (left === right) return true;
  const shorter = Math.min(left.length, right.length);
  const longer = Math.max(left.length, right.length);
  return shorter >= 8 && shorter / longer >= 0.6 && (left.includes(right) || right.includes(left));
}

export function collectPageReplies(baseline: PageReplyBaseline, snapshot: PageReplySnapshot): { baseline: PageReplyBaseline; replies: PageReplyMessage[]; latestText: string } {
  const state = { ...baseline, emitted: { ...baseline.emitted } };
  const messages = snapshot.messages.map(message => ({ ...message, text: normalizePageReplyText(message.text) }));
  const oldIds = new Set(baseline.messages.map(message => message.id));
  const oldText = new Set(baseline.messages.filter(message => message.role === 'assistant' && message.text).map(message => message.text));
  let anchor = state.anchorId ? messages.findIndex(message => message.id === state.anchorId && message.role === 'user') : -1;
  if (anchor < 0) {
    const fresh = messages.map((message, index) => ({ message, index }))
      .filter(entry => entry.message.role === 'user' && !oldIds.has(entry.message.id));
    if (state.prompt) {
      // The page may echo the turn with trimmed punctuation or an extra suffix, so an exact
      // text match is not a reliable ownership proof.
      const matched = fresh.filter(entry => sameTurn(entry.message.text, state.prompt));
      if (matched.length) anchor = matched[matched.length - 1].index;
      // The baseline was captured before this task submitted, so a genuinely new user turn
      // is this task's turn even when its rendered text differs from what we pasted.
      else if (fresh.length) anchor = fresh[fresh.length - 1].index;
    } else if (fresh.length) {
      anchor = fresh[fresh.length - 1].index;
    }
    if (anchor >= 0 && anchor < messages.length) state.anchorId = messages[anchor].id;
  }
  if (!state.prompt && !state.anchorId && baseline.url === snapshot.url && baseline.messages.length) {
    const tail = baseline.messages[baseline.messages.length - 1];
    anchor = messages.findIndex(message => message.id === tail.id);
  }
  const replies: PageReplyMessage[] = [];
  if (anchor >= 0 && !snapshot.error) {
    for (const message of messages.slice(anchor + 1)) {
      if (message.role !== 'assistant' || !message.text || oldIds.has(message.id)) continue;
      // A remounted historical greeting is not a new response. Repeated genuine text is
      // allowed once a task-specific user anchor proves ownership.
      if (!state.prompt && oldText.has(message.text)) continue;
      if (state.emitted[message.id] === message.text) continue;
      const duplicateIdentity = !Object.prototype.hasOwnProperty.call(state.emitted, message.id)
        && Object.values(state.emitted).includes(message.text);
      state.emitted[message.id] = message.text;
      if (!duplicateIdentity) replies.push(message);
    }
  }
  return { baseline: state, replies, latestText: replies.at(-1)?.text || '' };
}

/** Serialized into the remote page. Read message-local DOM/React props only, never stores/body text. */
function capturePageReplies(): PageReplySnapshot {
  const result: PageReplySnapshot = { url: location.href, messages: [] };
  try {
    const rootSelector = '[data-message-id],[data-message-role],[data-testid*="message"],[data-testid="message-list"] > *,[data-testid="message_list"] > *,[class*="message-item"],[class*="message-assistant"],[class*="assistant-message"],[class*="user-message"],[class*="bot-message"]';
    const candidates = [...document.querySelectorAll<HTMLElement>(rootSelector)].filter(node => {
      const testid = node.getAttribute('data-testid') || '';
      return node !== document.body && node !== document.documentElement && !/message[-_]?list|message[-_]?input|message[-_]?action|message[-_]?toolbar/i.test(testid)
        && !node.closest('nav,aside,textarea,[contenteditable="true"],[role="textbox"]');
    });
    const identity = (node: HTMLElement) => {
      const host = window as unknown as { __dshPageReplyNodes?: { nodes: WeakMap<object, string>; next: number } };
      const cache = host.__dshPageReplyNodes || (host.__dshPageReplyNodes = { nodes: new WeakMap(), next: 0 });
      let id = cache.nodes.get(node);
      if (!id) { id = 'dom:' + ++cache.next; cache.nodes.set(node, id); }
      return id;
    };
    const metadata = (node: HTMLElement): { id: string; role: PageReplyMessage['role'] } => {
      let id = node.getAttribute('data-message-id') || '';
      let role: PageReplyMessage['role'] = 'unknown';
      const label = [node.getAttribute('data-message-role'), node.getAttribute('data-role'), node.getAttribute('data-testid'), node.className].join(' ');
      if (/(^|[\s_-])(?:user|human)(?:[\s_-]|$)/i.test(label)) role = 'user';
      else if (/(^|[\s_-])(?:assistant|bot)(?:[\s_-]|$)/i.test(label)) role = 'assistant';
      // Only known message wrappers are followed. Do not walk arbitrary props, return
      // trees, account stores, request headers, or authentication state.
      const inspect = (value: any, depth: number): void => {
        if (!value || typeof value !== 'object' || depth > 3) return;
        if (value.message_id || value.local_message_id) {
          id ||= String(value.message_id || value.local_message_id);
          if (role === 'unknown') {
            if (value.user_type === 2 || value.role === 'assistant' || (value.sender && value.bot_id && value.sender === value.bot_id)) role = 'assistant';
            else if (value.user_type === 1 || value.role === 'user') role = 'user';
          }
        }
        for (const key of ['messageData', 'message', 'data', 'item']) inspect(value[key], depth + 1);
      };
      for (const key of Object.keys(node)) {
        if (key.startsWith('__reactProps$')) inspect((node as any)[key], 0);
        if (key.startsWith('__reactFiber$')) {
          let fiber = (node as any)[key];
          for (let level = 0; fiber && level < 6; level++, fiber = fiber.return) {
            inspect(fiber.memoizedProps, 0);
            if (id && role !== 'unknown') break;
          }
        }
      }
      return { id: id || identity(node), role };
    };
    const roleEntries = candidates.map(node => ({ node, ...metadata(node) })).filter(entry => entry.role !== 'unknown');
    // A list/group wrapper must not swallow multiple distinct messages.
    const entries = roleEntries.filter(entry => !roleEntries.some(other => other !== entry && entry.node.contains(other.node)
      && (other.role !== entry.role || (other.id !== entry.id && !other.id.startsWith('dom:') && !entry.id.startsWith('dom:')))));
    const seen = new Set<string>();
    for (const entry of entries) {
      // Prefer a single role-bearing message root, not its nested markdown blocks.
      if (entries.some(other => other !== entry && other.node.contains(entry.node) && other.role === entry.role)) continue;
      if (seen.has(entry.id)) continue;
      const clone = entry.node.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('button,[role="button"],svg,img,video,script,style,textarea,[contenteditable="true"],[aria-hidden="true"],[hidden],[data-testid*="action"],[data-testid*="toolbar"],[class*="toolbar"],[class*="message-action"]').forEach(node => node.remove());
      clone.querySelectorAll('br').forEach(node => node.replaceWith(document.createTextNode('\n')));
      clone.querySelectorAll('p,li,pre,h1,h2,h3,tr').forEach(node => node.appendChild(document.createTextNode('\n')));
      const text = (clone.textContent || '').replace(/\u00a0/g, ' ').split(/\r?\n/).map(line => line.trim()).filter(line => line && !/^(复制|朗读|赞|踩|重新生成|分享|转发)$/.test(line)).join('\n');
      seen.add(entry.id);
      result.messages.push({ id: entry.id, role: entry.role, text });
    }
  } catch { result.error = 'message-snapshot-unavailable'; }
  return result;
}

export const pageReplySnapshotScript = '(' + capturePageReplies.toString() + ')()';
