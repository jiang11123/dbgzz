import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderMarkdown } from './markdown';

/** Renders a markdown string to HTML so tests can assert on the produced markup. */
const html = (text: string) => renderToStaticMarkup(h('div', null, renderMarkdown(text)));

test('renders headings, bold, italic and inline code', () => {
  const out = html('## 标题\n\n**粗体** 与 *斜体* 与 ' + String.fromCharCode(96) + 'code' + String.fromCharCode(96));
  assert.match(out, /<h5[^>]*>标题<\/h5>/);
  assert.match(out, /<strong>粗体<\/strong>/);
  assert.match(out, /<em>斜体<\/em>/);
  assert.match(out, /<code class="chat-code-inline">code<\/code>/);
});

test('renders bullet and ordered lists', () => {
  const out = html('- 一\n- 二\n\n1. 甲\n2. 乙');
  assert.match(out, /<ul class="chat-md-list"><li>一<\/li><li>二<\/li><\/ul>/);
  assert.match(out, /<ol class="chat-md-list"><li>甲<\/li><li>乙<\/li><\/ol>/);
});

test('renders fenced code blocks with a language label', () => {
  const fence = String.fromCharCode(96, 96, 96);
  const out = html(fence + 'ts\nconst a = 1;\n' + fence);
  assert.match(out, /<span class="chat-code-lang">ts<\/span>/);
  assert.match(out, /<code>const a = 1;\n?<\/code>/);
});

test('an unclosed code fence still renders its body while streaming', () => {
  // A half-arrived reply must not swallow the rest of the text as code.
  const fence = String.fromCharCode(96, 96, 96);
  const out = html('开头\n' + fence + 'js\nlet partial =');
  assert.match(out, /<span class="chat-code-lang">js …<\/span>/);
  assert.match(out, /let partial =/);
});

test('an unclosed bold marker renders as literal text, not a swallowed reply', () => {
  const out = html('这是 **加粗还没写完的内容');
  assert.match(out, /加粗还没写完的内容/);
  assert.doesNotMatch(out, /<strong>/);
});

test('renders blockquotes, horizontal rules and tables', () => {
  assert.match(html('> 引用一行'), /<blockquote class="chat-md-quote"><p>引用一行<\/p><\/blockquote>/);
  assert.match(html('---'), /<hr class="chat-md-rule"\/>/);
  const table = html('| 名称 | 值 |\n| --- | --- |\n| a | 1 |');
  assert.match(table, /<th>名称<\/th><th>值<\/th>/);
  assert.match(table, /<td>a<\/td><td>1<\/td>/);
});

test('renders markdown links and bare URLs', () => {
  const out = html('[豆包](https://www.doubao.com) 与 https://example.com/x');
  assert.match(out, /<a href="https:\/\/www\.doubao\.com" target="_blank" rel="noreferrer">豆包<\/a>/);
  assert.match(out, /<a href="https:\/\/example\.com\/x"/);
});

test('escapes HTML so model output cannot inject markup', () => {
  const out = html('<img src=x onerror=alert(1)>');
  assert.doesNotMatch(out, /<img/);
  assert.match(out, /&lt;img/);
});

test('joins wrapped paragraph lines with a break', () => {
  // The renderer wraps each line in a span and inserts the break between them.
  const out = html('第一行\n第二行');
  assert.match(out, /第一行<\/span><span><br\/>第二行<\/span>/);
});

test('handles empty input by rendering an empty wrapper', () => {
  assert.equal(html(''), '<div></div>');
});