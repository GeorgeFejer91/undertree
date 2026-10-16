import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

// Run the actual production helper in a finite DOM boundary model. No browser metrics are simulated as fit proof.
const sourcePath = resolve(process.argv[2] || new URL('../modules/frontend/review-text-layout.js', import.meta.url).pathname);
const originalSource = readFileSync(sourcePath, 'utf8');
const source = originalSource.replace(/^import .*;\n/gm, '').replace('export function observeReviewText', 'function observeReviewText')
  + '\n globalThis.actual = { observeReviewText, textBox };';

function fixture() {
  const queries = [], stylesRead = [], frames = new Map(), mutations = [], resizes = [], listeners = new Set(), trackedSets = [];
  class TrackedSet extends Set { constructor(...args) { super(...args); this.iterations = 0; trackedSets.push(this); } [Symbol.iterator]() { this.iterations++; return super[Symbol.iterator](); } }
  let frameID = 0;
  class Element {
    constructor(tag = 'div', attrs = {}, text = '') { this.tagName = tag.toUpperCase(); this.attrs = attrs; this.ownText = text; this.children = []; this.parentElement = null; this.dataset = {}; this.nodeType = 1; this.clientWidth = 160; this.clientHeight = 40; this.scrollWidth = 160; this.scrollHeight = 40; this.boxWidth = 160; this.style = {}; }
    get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
    get isConnected() { return this.root || Boolean(this.parentElement?.isConnected); }
    get hidden() { return this.hasAttribute('hidden'); }
    get lang() { return this.attrs.lang; }
    append(...children) { for (const child of children) { child.parentElement?.remove(child); child.parentElement = this; this.children.push(child); } return this; }
    remove(child) { const index = this.children.indexOf(child); if (index >= 0) this.children.splice(index, 1); child.parentElement = null; }
    matches(selector) {
      return selector.split(',').some(part => {
        part = part.trim();
        const space = part.lastIndexOf(' ');
        if (space >= 0) return this.matches(part.slice(space + 1)) && Boolean(this.parentElement?.closest(part.slice(0, space)));
        const tag = part.match(/^[a-z][a-z0-9-]*/i)?.[0];
        if (tag && this.tagName.toLowerCase() !== tag.toLowerCase()) return false;
        for (const match of part.matchAll(/\.([\w-]+)/g)) if (!(this.attrs.class || '').split(' ').includes(match[1])) return false;
        for (const match of part.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) if (!this.hasAttribute(match[1]) || (match[2] !== undefined && this.attrs[match[1]] !== match[2])) return false;
        return true;
      });
    }
    closest(selector) { for (let at = this; at; at = at.parentElement) if (at.matches(selector)) return at; return null; }
    contains(other) { for (let at = other; at; at = at.parentElement) if (at === this) return true; return false; }
    hasAttribute(name) { return Object.hasOwn(this.attrs, name); }
    querySelectorAll(selector) { queries.push({ element: this, selector }); const found = []; const walk = at => { for (const child of at.children) { if (child.matches(selector)) found.push(child); walk(child); } }; walk(this); return found; }
    querySelector(selector) { if (selector === ':scope > [data-text-label]') return this.children.find(child => child.hasAttribute('data-text-label')) || null; return this.querySelectorAll(selector)[0] || null; }
    getBoundingClientRect() { return { width: this.boxWidth, height: this.clientHeight }; }
  }
  class ResizeObserver { constructor(callback) { this.callback = callback; this.observed = new Set(); this.unobserved = []; resizes.push(this); } observe(node) { this.observed.add(node); } unobserve(node) { this.unobserved.push(node); this.observed.delete(node); } disconnect() { this.observed.clear(); this.disconnected = true; } }
  class MutationObserver { constructor(callback) { this.callback = callback; mutations.push(this); } observe() {} disconnect() { this.disconnected = true; } }
  const html = new Element('html', { lang: 'en' }); html.root = true;
  const body = new Element('body'); html.append(body);
  const computed = element => { stylesRead.push(element); return { paddingLeft: '0', paddingRight: '0', paddingTop: '0', paddingBottom: '0', marginLeft: '0', marginRight: '0', columnGap: '0', display: 'block', lineHeight: '20px', fontSize: '14px', fontStyle: 'normal', fontWeight: '400', fontFamily: 'Arial', whiteSpace: 'normal', wordBreak: 'normal', wordSpacing: '0', hyphens: 'manual', getPropertyValue: () => '', ...element.style }; };
  const context = vm.createContext({ Set: TrackedSet, Element, ResizeObserver, MutationObserver, document: { documentElement: html, body, head: null }, window: { addEventListener: (name, fn) => listeners.add(fn), removeEventListener: (name, fn) => listeners.delete(fn) }, getComputedStyle: computed, requestAnimationFrame: fn => { const id = ++frameID; frames.set(id, fn); return id; }, cancelAnimationFrame: id => frames.delete(id), clearCache() {}, setLocale() {}, prepareWithSegments: text => ({ text }), measureLineStats: () => ({ maxLineWidth: 10, lineCount: 1 }), measureNaturalWidth: () => 10, createTextDetails: () => { throw Error('No details fixture expected'); } });
  vm.runInContext(source, context, { filename: sourcePath });
  const node = (tag, attrs, text) => new Element(tag, attrs, text);
  const editor = node('div', { class: 'cm-editor' }), panels = node('div', { class: 'cm-panels cm-panels-bottom' }), content = node('div', { class: 'cm-content', contenteditable: 'true' });
  editor.append(content); body.append(editor);
  const panel = () => { const search = node('div', { class: 'cm-panel cm-search' }), button = node('button', { name: 'next' }, 'next'), label = node('label', {}, 'match case'), checkbox = node('input', { type: 'checkbox' }); checkbox.boxWidth = checkbox.clientWidth = 13; label.append(checkbox); search.append(button, label); return { search, button, label, checkbox }; };
  const begin = () => context.actual.observeReviewText(body);
  const mutate = (target, addedNodes = [], removedNodes = [], type = 'childList') => mutations[0].callback([{ target, type, addedNodes, removedNodes }]);
  const flush = () => { for (const [id, fn] of [...frames]) { frames.delete(id); fn(); } };
  return { node, body, editor, panels, content, panel, begin, mutate, flush, context, queries, stylesRead, frames, resizes, mutations, listeners, computed, trackedSets };
}
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('initial real search controls register, editable inputs do not', () => {
  const f = fixture(), p = f.panel(); f.panels.append(p.search); f.editor.append(f.panels); f.begin();
  assert(f.resizes[0].observed.has(p.button)); assert(f.resizes[0].observed.has(p.label)); assert(!f.resizes[0].observed.has(p.checkbox));
});
test('a later panel group discovers only the bounded search subtree', () => {
  const f = fixture(); f.begin(); const p = f.panel(); f.panels.append(p.search); f.editor.append(f.panels); f.queries.length = 0; f.mutate(f.editor, [f.panels]);
  assert(f.resizes[0].observed.has(p.button)); assert(f.queries.some(q => q.element === f.panels && q.selector === '.cm-panel.cm-search')); assert(!f.queries.some(q => q.element === f.content));
});
test('a later editor mount discovers its already open search panel', () => {
  const f = fixture(); f.body.remove(f.editor); f.begin(); const p = f.panel(); f.panels.append(p.search); f.editor.append(f.panels); f.body.append(f.editor); f.mutate(f.body, [f.editor]);
  assert(f.resizes[0].observed.has(p.label));
});
test('an existing panel group registers a newly opened search panel', () => {
  const f = fixture(); f.editor.append(f.panels); f.begin(); const p = f.panel(); f.panels.append(p.search); f.mutate(f.panels, [p.search]); assert(f.resizes[0].observed.has(p.button));
});
test('search label additions use the real mutation callback', () => {
  const f = fixture(), p = f.panel(); f.panels.append(p.search); f.editor.append(f.panels); f.begin(); const label = f.node('label', {}, 'by word'); p.search.append(label); f.mutate(p.search, [label]); assert(f.resizes[0].observed.has(label));
});
test('closing search under the excluded panel group unobserves all detached controls', () => {
  const f = fixture(), p = f.panel(); f.panels.append(p.search); f.editor.append(f.panels); f.begin(); f.flush(); f.panels.remove(p.search); f.mutate(f.panels, [], [p.search]);
  assert(!f.resizes[0].observed.has(p.button)); assert(!f.resizes[0].observed.has(p.label)); assert(f.resizes[0].unobserved.includes(p.button)); assert.equal(f.frames.size, 0);
});
test('removing an entire panel group also cleans search watchers', () => {
  const f = fixture(), p = f.panel(); f.panels.append(p.search); f.editor.append(f.panels); f.begin(); f.editor.remove(f.panels); f.mutate(f.editor, [], [f.panels]); assert.equal(f.resizes[0].observed.size, 0);
});
test('reopening uses fresh controls without retaining old ones', () => {
  const f = fixture(), old = f.panel(); f.panels.append(old.search); f.editor.append(f.panels); f.begin(); f.panels.remove(old.search); f.mutate(f.panels, [], [old.search]); const next = f.panel(); f.panels.append(next.search); f.mutate(f.panels, [next.search]);
  assert(f.resizes[0].observed.has(next.label)); assert(!f.resizes[0].observed.has(old.label)); assert.equal(f.resizes[0].observed.size, 2);
});
test('one thousand source edit records trigger no query, style read, frame, or watcher work', () => {
  const f = fixture(), p = f.panel(); f.panels.append(p.search); f.editor.append(f.panels); f.begin(); f.flush(); f.queries.length = 0; f.stylesRead.length = 0;
  const sourceButton = f.node('button', {}, 'source stays excluded'); f.content.append(sourceButton);
  for (let i = 0; i < 1000; i++) f.mutate(f.content, [sourceButton], [], i % 2 ? 'childList' : 'characterData');
  assert.equal(f.queries.length, 0); assert.equal(f.stylesRead.length, 0); assert.equal(f.frames.size, 0); assert(!f.resizes[0].observed.has(sourceButton));
});
test('unrelated excluded editor removals do not iterate the global watched set', () => {
  const f = fixture(), p = f.panel(); f.panels.append(p.search); f.editor.append(f.panels); f.begin(); f.flush();
  const watched = f.trackedSets[1]; assert(watched.has(p.button)); watched.iterations = 0;
  const measure = f.node('div', { class: 'cm-measure' }); f.editor.append(measure); f.editor.remove(measure); f.mutate(f.editor, [], [measure]);
  assert.equal(watched.iterations, 0); assert(f.resizes[0].observed.has(p.button)); assert.equal(f.resizes[0].unobserved.length, 0);
});
test('unrelated excluded panel-group removals do not iterate the global watched set', () => {
  const f = fixture(), p = f.panel(); f.panels.append(p.search); f.editor.append(f.panels); f.begin(); f.flush();
  const watched = f.trackedSets[1]; assert(watched.has(p.label)); watched.iterations = 0;
  const other = f.node('div', { class: 'cm-panel' }); f.panels.append(other); f.panels.remove(other); f.mutate(f.panels, [], [other]);
  assert.equal(watched.iterations, 0); assert(f.resizes[0].observed.has(p.label));
});
test('detached genuine search removal still iterates and clears its live watchers', () => {
  const f = fixture(), p = f.panel(); f.panels.append(p.search); f.editor.append(f.panels); f.begin(); f.flush();
  const watched = f.trackedSets[1]; assert(watched.has(p.label)); watched.iterations = 0;
  f.panels.remove(p.search); assert.equal(p.search.parentElement, null); f.mutate(f.panels, [], [p.search]);
  assert.equal(watched.iterations, 1); assert.equal(f.resizes[0].observed.size, 0); assert(f.resizes[0].unobserved.includes(p.label));
});
test('detached genuine panel-group removal still clears all its search watchers', () => {
  const f = fixture(), p = f.panel(); f.panels.append(p.search); f.editor.append(f.panels); f.begin(); f.flush();
  const watched = f.trackedSets[1]; assert(watched.has(p.button)); watched.iterations = 0;
  f.editor.remove(f.panels); assert.equal(f.panels.parentElement, null); f.mutate(f.editor, [], [f.panels]);
  assert.equal(watched.iterations, 1); assert.equal(f.resizes[0].observed.size, 0);
});
test('search-shaped markup inside source remains excluded', () => {
  const f = fixture(), p = f.panel(); const nestedEditor = f.node('div', { class: 'cm-editor' }); f.content.append(nestedEditor); nestedEditor.append(f.panels); f.panels.append(p.search); f.begin(); f.mutate(f.content, [nestedEditor]); assert.equal(f.resizes[0].observed.size, 0);
});
test('custom editor panels remain excluded', () => {
  const f = fixture(); f.editor.append(f.panels); f.begin(); const other = f.node('div', { class: 'cm-panel' }), button = f.node('button', {}, 'Other panel'); other.append(button); f.panels.append(other); f.mutate(f.panels, [other]); assert(!f.resizes[0].observed.has(button));
});
test('search labels nested in another contenteditable subtree remain excluded', () => {
  const f = fixture(), p = f.panel(), editable = f.node('div', { contenteditable: 'true' }); f.body.remove(f.editor); editable.append(f.editor); f.body.append(editable); f.panels.append(p.search); f.editor.append(f.panels); f.begin(); assert.equal(f.resizes[0].observed.size, 0);
});
test('checkbox reserves its actual 13px slot plus margin and gap once', () => {
  const f = fixture(), p = f.panel(); f.panels.append(p.search); f.editor.append(f.panels); p.label.clientWidth = 122; p.label.style = { display: 'inline-flex', paddingLeft: '2px', paddingRight: '2px', columnGap: '4px' }; p.checkbox.style = { marginLeft: '2px', marginRight: '3px' };
  assert.equal(f.context.actual.textBox(p.label, f.computed(p.label)).width, 96);
});
test('checkbox sizing is not inferred from label font size', () => {
  const f = fixture(), p = f.panel(); f.panels.append(p.search); f.editor.append(f.panels); p.label.clientWidth = 100; p.label.style = { display: 'inline-flex', fontSize: '28px', columnGap: '4px' };
  assert.equal(f.context.actual.textBox(p.label, f.computed(p.label)).width, 83);
});
test('ordinary measured checkbox labels retain their existing box policy', () => {
  const f = fixture(), label = f.node('label', { 'data-measure': '' }, 'Unrelated'), check = f.node('input', { type: 'checkbox' }); label.clientWidth = 100; label.style = { display: 'inline-flex', columnGap: '4px' }; check.boxWidth = 13; label.append(check); f.body.append(label);
  assert.equal(f.context.actual.textBox(label, f.computed(label)).width, 100);
});
test('existing icon reservation is preserved', () => {
  const f = fixture(), button = f.node('button', {}, 'Existing icon label'), icon = f.node('svg'); button.clientWidth = 100; button.style = { display: 'flex', columnGap: '4px' }; icon.boxWidth = 16; button.append(icon); f.body.append(button);
  assert.equal(f.context.actual.textBox(button, f.computed(button)).width, 80);
});
test('disposing disconnects observers, cancels frames, and removes resize listener', () => {
  const f = fixture(), p = f.panel(); f.panels.append(p.search); f.editor.append(f.panels); const stop = f.begin(); stop();
  assert.equal(f.resizes[0].observed.size, 0); assert(f.resizes[0].disconnected); assert(f.mutations.every(observer => observer.disconnected)); assert.equal(f.frames.size, 0); assert.equal(f.listeners.size, 0);
});
let failures = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.log(`FAIL ${name}\n${error.stack}`); }
}
console.log(JSON.stringify({ sourcePath, tests: tests.length, passed: tests.length - failures, failed: failures, scope: 'actual helper control discovery, cleanup, exclusion, and box-budget model; no rendered geometry or real Pretext metric claim' }));
process.exitCode = failures ? 1 : 0;
