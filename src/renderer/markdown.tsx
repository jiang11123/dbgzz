import type { ReactNode } from 'react';

/**
 * Minimal streaming-friendly Markdown renderer for chat replies.
 *
 * Builds React nodes directly instead of HTML strings, so model output can never
 * inject markup. Every construct tolerates being cut mid-syntax: while text is
 * streaming an unclosed code fence or bold marker must still render as ordinary
 * text instead of swallowing the rest of the reply.
 */

const INLINE_PATTERN = /(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\*([^*\n]+)\*)|(\[([^\]]+)\]\(([^)\s]+)\))|(https?:\/\/[^\s<>()]+)/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let index = 0;
  INLINE_PATTERN.lastIndex = 0;
  for (let match = INLINE_PATTERN.exec(text); match; match = INLINE_PATTERN.exec(text)) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    const key = `${keyPrefix}-${index++}`;
    if (match[2] !== undefined) nodes.push(<strong key={key}>{match[2]}</strong>);
    else if (match[4] !== undefined) nodes.push(<code key={key} className="chat-code-inline">{match[4]}</code>);
    else if (match[6] !== undefined) nodes.push(<em key={key}>{match[6]}</em>);
    else if (match[8] !== undefined) nodes.push(<a key={key} href={match[9]} target="_blank" rel="noreferrer">{match[8]}</a>);
    else if (match[10] !== undefined) nodes.push(<a key={key} href={match[10]} target="_blank" rel="noreferrer">{match[10]}</a>);
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

type Block =
  | { kind: 'code'; lang: string; lines: string[]; closed: boolean }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'rule' }
  | { kind: 'para'; lines: string[] };

function parseBlocks(text: string): Block[] {
  const lines = text.split('\n');
  const blocks: Block[] = [];
  let index = 0;
  const cells = (line: string) => line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
  const isTableRow = (line: string) => /^\s*\|.+\|\s*$/.test(line);

  while (index < lines.length) {
    const line = lines[index];

    if (/^\s*```/.test(line)) {
      const lang = line.replace(/^\s*```/, '').trim();
      const body: string[] = [];
      index += 1;
      // An unclosed fence (still streaming) renders what has arrived so far.
      while (index < lines.length && !/^\s*```/.test(lines[index])) { body.push(lines[index]); index += 1; }
      const closed = index < lines.length;
      if (closed) index += 1;
      blocks.push({ kind: 'code', lang, lines: body, closed });
      continue;
    }

    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) { blocks.push({ kind: 'rule' }); index += 1; continue; }

    const heading = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (heading) { blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] }); index += 1; continue; }

    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) { quote.push(lines[index].replace(/^\s*>\s?/, '')); index += 1; }
      blocks.push({ kind: 'quote', lines: quote });
      continue;
    }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || ordered) {
      const marker = bullet ? 'bullet' : 'number';
      const items: string[] = [];
      while (index < lines.length) {
        const next = lines[index].match(marker === 'bullet' ? /^\s*[-*+]\s+(.*)$/ : /^\s*\d+[.)]\s+(.*)$/);
        if (!next) break;
        items.push(next[1]);
        index += 1;
      }
      blocks.push({ kind: 'list', ordered: marker === 'number', items });
      continue;
    }

    if (isTableRow(line) && index + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[index + 1])) {
      const header = cells(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && isTableRow(lines[index])) { rows.push(cells(lines[index])); index += 1; }
      blocks.push({ kind: 'table', header, rows });
      continue;
    }

    if (!line.trim()) { index += 1; continue; }

    const para: string[] = [];
    while (index < lines.length && lines[index].trim()
      && !/^\s*```/.test(lines[index]) && !/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(lines[index])
      && !/^\s*(#{1,6})\s+/.test(lines[index]) && !/^\s*>/.test(lines[index])
      && !/^\s*[-*+]\s+/.test(lines[index]) && !/^\s*\d+[.)]\s+/.test(lines[index])) {
      para.push(lines[index]);
      index += 1;
    }
    if (para.length) blocks.push({ kind: 'para', lines: para });
    else index += 1;
  }
  return blocks;
}

/** Renders a (possibly incomplete) Markdown string as safe React nodes. */
export function renderMarkdown(text: string): ReactNode {
  const blocks = parseBlocks(text ?? '');
  return blocks.map((block, index) => {
    const key = `b${index}`;
    switch (block.kind) {
      case 'code':
        return (
          <pre key={key} className="chat-code-block">
            {block.lang && <span className="chat-code-lang">{block.lang}{block.closed ? '' : ' …'}</span>}
            <code>{block.lines.join('\n')}</code>
          </pre>
        );
      case 'heading': {
        const Tag = (`h${Math.min(6, block.level + 3)}`) as 'h4';
        return <Tag key={key} className={`chat-md-h chat-md-h${block.level}`}>{renderInline(block.text, key)}</Tag>;
      }
      case 'quote':
        return <blockquote key={key} className="chat-md-quote">{block.lines.map((line, i) => <p key={`${key}-${i}`}>{renderInline(line, `${key}-${i}`)}</p>)}</blockquote>;
      case 'list':
        return block.ordered
          ? <ol key={key} className="chat-md-list">{block.items.map((item, i) => <li key={`${key}-${i}`}>{renderInline(item, `${key}-${i}`)}</li>)}</ol>
          : <ul key={key} className="chat-md-list">{block.items.map((item, i) => <li key={`${key}-${i}`}>{renderInline(item, `${key}-${i}`)}</li>)}</ul>;
      case 'table':
        return (
          <table key={key} className="chat-md-table">
            <thead><tr>{block.header.map((cell, i) => <th key={`${key}-h${i}`}>{renderInline(cell, `${key}-h${i}`)}</th>)}</tr></thead>
            <tbody>{block.rows.map((row, r) => <tr key={`${key}-r${r}`}>{row.map((cell, c) => <td key={`${key}-r${r}c${c}`}>{renderInline(cell, `${key}-r${r}c${c}`)}</td>)}</tr>)}</tbody>
          </table>
        );
      case 'rule':
        return <hr key={key} className="chat-md-rule" />;
      case 'para':
      default:
        return <p key={key} className="chat-md-p">{block.lines.map((line, i) => <span key={`${key}-l${i}`}>{i > 0 && <br />}{renderInline(line, `${key}-l${i}`)}</span>)}</p>;
    }
  });
}
