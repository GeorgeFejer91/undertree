import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('./native-ui-smoke.mjs', import.meta.url), 'utf8');
const start = source.indexOf('async function click(selector) {');
const end = source.indexOf('\nasync function append(', start);
assert.ok(start >= 0 && end > start);

function fixture(open = false) {
  const clicks = [];
  const details = {
    id: 'fixture', open,
    querySelector(selector) { assert.equal(selector, ':scope > summary'); return summary; },
  };
  const summary = { contains: node => node === summary || node === icon };
  const icon = {}, child = {};
  for (const node of [summary, icon, child]) {
    node.closest = selector => {
      assert.equal(selector, 'details:not([open])');
      return details.open ? null : details;
    };
  }
  const nodes = { '#fixture > summary': summary, '#icon': icon, '#child': child };
  const click = runInNewContext(source.slice(start, end) + '\nclick;', {
    execute: (script, args) => runInNewContext('(function(){' + script + '}).apply(null,args)', {
      args, document: { querySelector: selector => nodes[selector] }, CSS: { escape: value => value },
    }),
    find: selector => { assert.ok(nodes[selector]); return selector; },
    command: (path, body) => {
      assert.equal(JSON.stringify(body), '{}');
      const selector = path.slice('/element/'.length, -'/click'.length);
      clicks.push(selector);
      if (nodes[selector] === summary || nodes[selector] === icon) details.open = !details.open;
    },
  });
  return { click, clicks, details };
}

test('a requested closed summary receives one real click and opens', async () => {
  const f = fixture();
  await f.click('#fixture > summary');
  assert.deepEqual(f.clicks, ['#fixture > summary']);
  assert.equal(f.details.open, true);
});

test('a summary descendant receives one real click and opens', async () => {
  const f = fixture();
  await f.click('#icon');
  assert.deepEqual(f.clicks, ['#icon']);
  assert.equal(f.details.open, true);
});

test('a closed menu child still opens its parent before its requested click', async () => {
  const f = fixture();
  await f.click('#child');
  assert.deepEqual(f.clicks, ['#fixture > summary', '#child']);
  assert.equal(f.details.open, true);
});

test('an open summary receives one real click and closes', async () => {
  const f = fixture(true);
  await f.click('#fixture > summary');
  assert.deepEqual(f.clicks, ['#fixture > summary']);
  assert.equal(f.details.open, false);
});
