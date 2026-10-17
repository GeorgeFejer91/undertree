import assert from 'node:assert/strict';
import test from 'node:test';
import { pdfProseContent } from '../modules/frontend/manuscript-pdf-viewer.js';

const item = (str, x, y, overrides = {}) => ({ str, dir: 'ltr', width: str.length * 6, height: 12, transform: [12, 0, 0, 12, x, y], ...overrides });
const marked = (tag, ...entries) => [{ type: 'beginMarkedContentProps', tag }, ...entries, { type: 'endMarkedContent' }];
const strings = content => content.items.filter(item => typeof item.str === 'string').map(item => item.str);
const body = () => [
  ...marked('Span', item('The 40 participants completed a task in 2026.', 72, 700)),
  ...marked('Span', item('The mean score was 18.2.', 72, 680)),
  ...marked('Span', item('Accuracy uses 48 test trials.', 72, 660)),
];

test('only tagged and geometrically verified line-number artifacts leave the selectable prose', () => {
  const content = { lang: 'en', styles: { example: { fontFamily: 'serif' } }, items: [...body(), ...marked('Artifact', item('1', 52, 700)), ...marked('Artifact', item('2', 52, 680)), ...marked('Artifact', item('3', 52, 660))] };
  const original = structuredClone(content), result = pdfProseContent(content);
  assert.equal(result.lineNumbers, 3);
  assert.deepEqual(strings(result.content), ['The 40 participants completed a task in 2026.', 'The mean score was 18.2.', 'Accuracy uses 48 test trials.']);
  assert.deepEqual(result.content.styles, content.styles); assert.equal(result.content.lang, 'en');
  assert.deepEqual(content, original, 'The PDF extraction snapshot is never rewritten.');
});

test('ordinary numeric body text and untagged gutter-position digits are never guessed away', () => {
  const content = { items: [...body(), item('1', 52, 700), ...marked('Span', item('2', 52, 680)), ...marked('Artifact', item('2026', 120, 660))] };
  const result = pdfProseContent(content);
  assert.equal(result.lineNumbers, 0); assert.equal(result.content, content);
  assert.deepEqual(strings(result.content).slice(-3), ['1', '2', '2026']);
});

test('footer numbers, close or rotated text and ambiguous artifact groups remain selectable', () => {
  const cases = [
    marked('Artifact', item('1', 52, 40)), // Footer has no body baseline.
    marked('Artifact', item('1', 64, 700)), // No safe gutter gap.
    marked('Artifact', item('1', 52, 700, { transform: [0, 12, -12, 0, 52, 700] })),
    marked('Artifact', item('1', 52, 700, { transform: [12, 0, 0, 12, NaN, 700] })),
    marked('Artifact', item('1', 52, 700), item('2', 52, 680)), // Multiple written entries.
    marked('Artifact', item('Note', 40, 700)),
    marked('Artifact', item('1', 52, 700, { dir: 'rtl' })),
  ];
  for (const entries of cases) {
    const content = { items: [...body(), ...entries] }, result = pdfProseContent(content);
    assert.equal(result.lineNumbers, 0, JSON.stringify(entries)); assert.equal(result.content, content);
  }
});
