import test from 'node:test';
import assert from 'node:assert/strict';
import type { ReactNode, ReactElement } from 'react';
import { renderMarkdown } from '../../src/renderer/markdown';

/**
 * Lightweight structural assertions on the React element tree. Avoids a DOM
 * dependency while still catching wrong tags, lost text and unsafe elements.
 */

function flatten(node: ReactNode): unknown[] {
  if (node == null || typeof node === 'boolean') return [];
  if (Array.isArray(node)) return node.flatMap(flatten);
  return [node];
}

function textOf(node: ReactNode): string {
  return flatten(node).map(part => {
    if (typeof part === 'string' || typeof part === 'number') return String(part);
    const element = part as ReactElement;
    if (element?.props) return textOf((element.props as { children?: ReactNode }).children);
    return '';
  }).join('');
}

function tags(node: ReactNode, into: string[] = []): string[] {
  for (const part of flatten(node)) {
    if (part && typeof part === 'object' && !Array.isArray(part)) {
      const element = part as ReactElement;
      into.push(typeof element.type === 'string' ? element.type : 'component');
      tags((element.props as { children?: ReactNode })?.children, into);
    }
  }
  return into;
}

function findTag(node: ReactNode, tag: string): ReactElement | null {
  for (const part of flatten(node)) {
    if (part && typeof part === 'object' && !Array.isArray(part)) {
      const element = part as ReactElement;
      if (element.type === tag) return element;
      const nested = findTag((element.props as { children?: ReactNode })?.children, tag);
      if (nested) return nested;
    }
  }
  return null;
}

test('renders a plain paragraph', () => {
  const tree = renderMarkdown('你好，豆包');
  // Each paragraph line is wrapped in a span so multi-line paras can join with <br/>.
  assert.deepEqual(tags(tree), ['p', 'span']);
  assert.equal(textOf(tree), '你好，豆包');
});

test('renders bold, italic, inline code, links and bare urls inline', () => {
  const tree = renderMarkdown('**粗**、*斜*、`代码`、[豆包](https://www.doubao.com)、https://example.com');
  const bold = findTag(tree, 'strong');
  const italic = findTag(tree, 'em');
  const code = findTag(tree, 'code');
  const link = findTag(tree, 'a');
  assert.equal(textOf(bold), '粗');
  assert.equal(textOf(italic), '斜');
  assert.equal(textOf(code), '代码');
  assert.equal(textOf(link), '豆包');
  assert.equal((link!.props as { href: string }).href, 'https://www.doubao.com');
});

test('an unclosed bold marker keeps the rest of the reply visible while streaming', () => {
  const tree = renderMarkdown('开头 **未闭合的后半句');
  const strong = findTag(tree, 'strong');
  assert.equal(strong, null, 'no strong element from a dangling marker');
  assert.ok(textOf(tree).includes('未闭合的后半句'));
});

test('renders a fenced code block with its language label', () => {
  const tree = renderMarkdown('说明\n```ts\nconst a = 1;\n```');
  const pre = findTag(tree, 'pre');
  assert.ok(pre, 'pre element exists');
  assert.equal(textOf(pre), 'tsconst a = 1;');
  assert.ok(tags(tree).includes('span'), 'language label present');
});

test('an unclosed code fence renders the lines received so far', () => {
  const tree = renderMarkdown('```python\nprint(1)\nprint(2)');
  const pre = findTag(tree, 'pre');
  assert.ok(pre, 'still renders a code block');
  assert.ok(textOf(pre).includes('print(1)'), 'partial body is visible');
});

test('renders headings, quotes and rules', () => {
  const tree = renderMarkdown('## 小节\n> 引用一句\n\n---');
  // h-levels are shifted down (h3 base) so headings stay chat-sized; the quote
  // wraps its lines in paragraphs.
  assert.deepEqual(tags(tree), ['h5', 'blockquote', 'p', 'hr']);
  assert.equal(textOf(findTag(tree, 'h5')), '小节');
  assert.equal(textOf(findTag(tree, 'blockquote')), '引用一句');
});

test('renders ordered and unordered lists', () => {
  assert.deepEqual(tags(renderMarkdown('- 甲\n- 乙')), ['ul', 'li', 'li']);
  assert.deepEqual(tags(renderMarkdown('1. 甲\n2. 乙')), ['ol', 'li', 'li']);
  assert.equal(textOf(renderMarkdown('- 甲')), '甲');
});

test('renders a pipe table with header and body rows', () => {
  const tree = renderMarkdown('| 模型 | 时长 |\n| --- | --- |\n| A | 5s |\n| B | 10s |');
  const table = findTag(tree, 'table');
  assert.ok(table, 'table exists');
  const th = findTag(tree, 'th');
  assert.equal(textOf(th), '模型');
  assert.equal((textOf(tree).match(/A/g) || []).length, 1);
});

test('model output can never inject markup', () => {
  const tree = renderMarkdown('<script>alert(1)</script><img src=x onerror=alert(2)>');
  assert.equal(findTag(tree, 'script'), null);
  assert.equal(findTag(tree, 'img'), null);
  assert.ok(textOf(tree).includes('alert(1)'), 'tag text survives as plain text');
});

test('empty and undefined input render nothing harmful', () => {
  assert.deepEqual(tags(renderMarkdown('')), []);
  assert.deepEqual(tags(renderMarkdown(undefined as unknown as string)), []);
});
