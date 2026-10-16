import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(process.env.UNDERTREE_TAB_TEST_SOURCE || new URL('../src/manuscript.js', import.meta.url), 'utf8');
const start = source.indexOf('function renderTabs('), end = source.indexOf('\nfunction selectAnchor(', start);
assert.ok(start >= 0 && end > start);
const production = source.slice(start, end);

function fixture({ width = 1440, widths = [200, 230, 285.75] } = {}) {
  const frames = [], observers = [], writes = [], focus = {}, editor = { history: ['old edit'], selection: { from: 2, to: 7 }, scrollTop: 91, scrollLeft: 17 };
  const sessions = new Map(['a.typ', 'b.typ', 'z-native-find.typ'].map(path => [path, { project: 'p', path, dirty: true }]));
  const nodes = [];
  function element(tag, text = '', className = '') {
    const node = { tag, textContent: text, className, dataset: {}, attributes: {}, children: [], parentElement: null, width: 0,
      setAttribute(name, value) { this.attributes[name] = value; },
      append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } },
      replaceChildren() { for (const child of this.children) child.parentElement = null; this.children = []; },
      focus() { assert.fail('Tab allocation must not change focus'); },
      scrollIntoView() { assert.fail('Tab allocation must not scroll the page or editor'); },
      getBoundingClientRect() {
        const before = this.parentElement?.children.slice(0, this.parentElement.children.indexOf(this)) || [];
        const left = 2 + before.reduce((total, child) => total + child.width, 0) - tabs.scrollLeft;
        return { left, right: left + this.width, width: this.width, top: 60, bottom: 99, height: 39 };
      }
    };
    nodes.push(node); return node;
  }
  const tabs = element('div');
  tabs.width = width;
  tabs.getBoundingClientRect = () => ({ left: 2, right: 2 + tabs.width, width: tabs.width, top: 60, bottom: 99, height: 39 });
  tabs.querySelector = selector => {
    assert.equal(selector, '[aria-selected="true"]');
    return tabs.children.flatMap(node => node.children).find(node => node.attributes['aria-selected'] === 'true') || null;
  };
  let scroll = 0;
  Object.defineProperty(tabs, 'scrollLeft', { get: () => scroll, set: value => {
    writes.push(value); scroll = Math.min(Math.max(value, 0), Math.max(0, tabs.children.reduce((total, child) => total + child.width, 0) - tabs.width));
  } });
  const page = { x: 0, y: 41 }, document = { activeElement: focus };
  const context = {
    sessions, active: [...sessions.values()].at(-1), navigationIntent: 0,
    $: id => { assert.ok(['manuscript-tabs', 'project-select'].includes(id)); return id === 'manuscript-tabs' ? tabs : { value: 'p' }; },
    element, actionButton: text => element('button', text), task: callback => callback,
    requestAnimationFrame: callback => { frames.push(callback); },
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; this.targets = new Set(); this.highWater = 0; observers.push(this); }
      observe(target) { this.targets.add(target); this.highWater = Math.max(this.highWater, this.targets.size); }
      unobserve(target) { this.targets.delete(target); }
    },
    document, window: { scrollTo() { assert.fail('No global scroll'); } }, view: editor,
  };
  runInNewContext(production + '\nthis.render=renderTabs;', context);
  function render() {
    context.render();
    tabs.children.forEach((node, index) => { node.width = widths[index] ?? 120; });
  }
  const flush = () => { while (frames.length) frames.shift()(); };
  const notify = target => { for (const observer of observers) if (observer.targets.has(target)) observer.callback([{ target }]); };
  const selected = () => tabs.querySelector('[aria-selected="true"]')?.parentElement;
  const contained = () => { const item = selected().getBoundingClientRect(), box = tabs.getBoundingClientRect(); return item.left >= box.left && item.right <= box.right; };
  render(); flush(); writes.length = 0;
  return { tabs, frames, observers, writes, context, sessions, focus, editor, page, document, selected, contained, render, flush, notify };
}

test('actual renderTabs allocation hook reveals the active wrapper after viewport shrink', () => {
  const f = fixture(); assert.equal(f.contained(), true);
  f.tabs.width = 315; f.notify(f.tabs); f.flush();
  assert.equal(f.contained(), true, 'The active fitting wrapper must remain within its resized tab viewport.');
  assert.equal(f.writes.length, 1);
});

test('actual selected-wrapper allocation hook handles font width growth with unchanged viewport', () => {
  const f = fixture({ width: 315, widths: [90, 100, 100] });
  assert.equal(f.contained(), true); f.selected().width = 220; f.notify(f.selected());
  assert.equal(f.contained(), true); assert.equal(f.writes.length, 1);
});

test('already contained wrapper and width regrowth make no unnecessary horizontal writes', () => {
  const f = fixture({ width: 315, widths: [90, 100, 100] });
  f.notify(f.tabs); f.notify(f.selected()); f.tabs.width = 1440; f.notify(f.tabs); f.flush();
  assert.equal(f.writes.length, 0); assert.equal(f.contained(), true);
});

test('exactly fitting wrapper stays stable through render RAF and repeated observer callbacks', () => {
  const f = fixture({ width: 315, widths: [0, 0, 315] });
  for (let i = 0; i < 8; i++) { f.notify(f.tabs); f.notify(f.selected()); }
  assert.equal(f.writes.length, 0); assert.equal(f.contained(), true);
});

test('oversized wrapper on right uses one original reveal then covering guard prevents oscillation', () => {
  const f = fixture({ width: 315, widths: [200, 230, 500] });
  f.tabs.scrollLeft = 0; f.writes.length = 0;
  assert.ok(f.selected().getBoundingClientRect().left > f.tabs.getBoundingClientRect().right);
  f.notify(f.tabs);
  for (let i = 0; i < 8; i++) { f.notify(f.tabs); f.notify(f.selected()); f.flush(); }
  assert.equal(f.writes.length, 1);
  const r = f.selected().getBoundingClientRect(), b = f.tabs.getBoundingClientRect();
  assert.ok(r.left <= b.left && r.right >= b.right);
});

test('oversized wrapper on left aligns once then remains stable without changing native fit contract', () => {
  const f = fixture({ width: 315, widths: [500, 230, 285.75] });
  f.context.active = [...f.sessions.values()][0]; f.render(); f.flush();
  f.tabs.scrollLeft = 600; f.writes.length = 0;
  assert.ok(f.selected().getBoundingClientRect().right < f.tabs.getBoundingClientRect().left);
  f.notify(f.tabs); const after = f.tabs.scrollLeft;
  for (let i = 0; i < 8; i++) { f.notify(f.tabs); f.notify(f.selected()); }
  assert.equal(f.tabs.scrollLeft, after); assert.equal(f.writes.length, 1); assert.equal(after, 0);
  const r = f.selected().getBoundingClientRect(), b = f.tabs.getBoundingClientRect();
  assert.ok(r.left <= b.left && r.right >= b.right); assert.equal(f.contained(), false);
});

test('left overflow uses only the original conditional horizontal correction', () => {
  const f = fixture({ width: 315 }); f.tabs.scrollLeft = 450; f.writes.length = 0;
  f.context.active = [...f.sessions.values()][0]; f.render(); f.flush();
  assert.equal(f.contained(), true); assert.equal(f.tabs.scrollLeft, 0); assert.equal(f.writes.length, 1);
});

test('one observer has at most viewport plus current wrapper across repeated render/retarget/empty states', () => {
  const f = fixture(); assert.equal(f.observers.length, 1);
  const observer = f.observers[0];
  for (let i = 0; i < 40; i++) {
    const before = f.selected(); f.context.active = [...f.sessions.values()][i % 3]; f.render();
    assert.equal(observer.targets.has(before), false); assert.equal(observer.targets.has(f.selected()), true); assert.equal(observer.targets.size, 2); f.flush();
  }
  f.context.active = null; f.sessions.clear(); f.render(); f.flush();
  assert.equal(observer.targets.size, 1); assert.equal(observer.targets.has(f.tabs), true); assert.equal(observer.highWater, 2);
});

test('stale pending observer callback and queued render RAF always read current DOM selection', () => {
  const f = fixture(); const callback = f.observers[0].callback, old = f.selected();
  f.context.active = [...f.sessions.values()][0]; f.render(); f.tabs.width = 315;
  callback([{ target: old }]); f.flush();
  assert.equal(f.selected(), f.tabs.children[0]); assert.equal(f.contained(), true); assert.equal(f.observers[0].targets.has(old), false);
});

test('tab allocation cannot touch editor history/selection/scroll, focus, global page scroll or source state', () => {
  const f = fixture(), before = JSON.stringify({ editor: f.editor, page: f.page, sessions: [...f.sessions.values()] });
  f.tabs.width = 315; f.notify(f.tabs); f.notify(f.selected()); f.flush();
  assert.equal(JSON.stringify({ editor: f.editor, page: f.page, sessions: [...f.sessions.values()] }), before);
  assert.equal(f.document.activeElement, f.focus);
});
