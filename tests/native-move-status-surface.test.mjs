import assert from 'node:assert/strict';
import test from 'node:test';
import { readMoveSelect, assertMoveStatusFocus } from './native-move-select-contract.mjs';

function readFixture(mode, { wrongFocus = false, children = 2 } = {}) {
  const box = { left: 10, right: 190, top: 20, bottom: 60, width: 180, height: 40 };
  const nodes = new Map();
  const node = (id, tag = 'P') => {
    const value = { id, tagName: tag, dataset: {}, textContent: id, hidden: false, disabled: false, isConnected: true, clientWidth: 180, clientHeight: 40, scrollWidth: 180, scrollHeight: 40, box: { ...box }, attrs: new Map(), style: { display: 'block', visibility: 'visible', fontSize: '28px', contain: 'paint', overflowX: 'hidden', overflowY: 'hidden', appearance: 'auto', outlineStyle: 'none', outlineWidth: '0px', outlineOffset: '0px', outlineColor: 'black' },
      getAttribute(name) { return this.attrs.get(name) ?? null; }, getBoundingClientRect() { return this.box; }, matches(selector) { return selector === '.text-details-button' ? this.className === 'text-details-button' : selector === ':modal'; } };
    nodes.set(id, value); return value;
  };
  const dialog = node('file-move-dialog', 'DIALOG'), body = node('body', 'DIV'), title = node('title', 'H2'), footer = node('footer', 'DIV');
  body.box = { left: 0, right: 200, top: 0, bottom: 200, width: 200, height: 200 };
  dialog.querySelector = selector => selector === '.file-move-body' ? body : selector === 'h2' ? title : footer; dialog.open = true;
  const status = node('file-move-status'), slot = node('slot', 'SPAN'), button = node('details-button', 'BUTTON');
  status.dataset = { textDetails: 'Move result details', textFit: mode === 'details' ? 'details' : 'fit' }; status.textContent = 'The full prepared status.'; status.attrs.set('role', 'status'); status.parentElement = slot;
  slot.classList = { contains: name => name === 'text-details-slot' || (name === 'text-details-active' && mode === 'details') }; slot.children = Array.from({ length: children }, () => ({})); slot.firstElementChild = status; slot.lastElementChild = button;
  button.className = 'text-details-button'; button.id = ''; button.textContent = status.dataset.textDetails; button.attrs.set('aria-haspopup', 'dialog'); button.attrs.set('aria-label', `${button.textContent}: ${status.textContent}`);
  if (mode === 'details') { status.style.display = 'none'; status.clientWidth = 0; status.box = { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }; }
  for (const id of ['file-move-from', 'file-move-to', 'file-move-identity', 'file-move-commit', 'file-move-request-detail', 'file-move-draft']) node(id);
  const select = node('file-move-requests', 'SELECT'), wrapper = node('wrapper', 'SPAN'); select.parentElement = wrapper; select.options = []; select.labels = [{ control: select }]; wrapper.children = [select]; wrapper.firstElementChild = select; wrapper.className = 'file-move-request-select';
  const previous = Object.fromEntries(['document', 'getComputedStyle', 'innerWidth', 'innerHeight'].map(key => [key, globalThis[key]]));
  globalThis.document = { documentElement: node('html', 'HTML'), activeElement: wrongFocus ? body : mode === 'details' ? button : status, hasFocus: () => true, getElementById: id => nodes.get(id), createRange: () => ({ selectNodeContents(value) { this.value = value; }, getBoundingClientRect() { return this.value.box; } }) };
  globalThis.getComputedStyle = value => value.style; globalThis.innerWidth = 320; globalThis.innerHeight = 480;
  try { return readMoveSelect(); } finally { for (const [key, value] of Object.entries(previous)) value === undefined ? delete globalThis[key] : globalThis[key] = value; }
}

test('actual fixed-node reader and assertion retain original focused source contract when it fits', () => {
  const value = readFixture('source'); assert.equal(value.activeId, 'file-move-status'); assert.equal(value.statusSurface.mode, 'source'); assertMoveStatusFocus(value);
});

test('actual reader admits only the exact current generated button for its hidden status source', () => {
  const value = readFixture('details'); assert.equal(value.activeId, ''); assert.equal(value.statusSurface.tag, 'BUTTON'); assert.equal(value.statusSurface.mode, 'details'); assertMoveStatusFocus(value);
});

test('empty active ID by itself never passes the new focus assertion', () => {
  const value = readFixture('details', { wrongFocus: true }); assert.throws(() => assertMoveStatusFocus(value), /Production focus/);
});

test('ambiguous generated slot child inventory refuses instead of guessing a control', () => {
  const value = readFixture('details', { children: 3 }); assert.equal(value.statusSurface.connected, false); assert.throws(() => assertMoveStatusFocus(value));
});

test('the original source ID remains mandatory in either representation', () => {
  const value = readFixture('details'); value.statusSurface.sourceId = 'unrelated-status'; assert.throws(() => assertMoveStatusFocus(value));
});

test('hidden, detached, disabled, invisible or zero-size surface cannot count as accessible focus', () => {
  for (const [key, invalid] of [['hidden', true], ['connected', false], ['disabled', true], ['display', 'none'], ['visibility', 'hidden']]) {
    const value = readFixture('details'); value.statusSurface[key] = invalid; assert.throws(() => assertMoveStatusFocus(value));
  }
  const value = readFixture('details'); value.statusSurface.box.width = 0; assert.throws(() => assertMoveStatusFocus(value));
});

test('a focused off-body or nonfinite status affordance remains a real failure', () => {
  const off = readFixture('details'); off.statusSurface.box.bottom = 201.1; assert.throws(() => assertMoveStatusFocus(off), /exposed inside/);
  const invalid = readFixture('details'); invalid.statusSurface.box.left = Infinity; assert.throws(() => assertMoveStatusFocus(invalid), /finite box/);
});

test('details must expose the complete corresponding text and original dialog affordance', () => {
  for (const [key, invalid] of [['accessibleName', 'Move result details: shortened'], ['hasPopup', null], ['label', 'Different control'], ['tag', 'P'], ['sourceDisplay', 'block']]) {
    const value = readFixture('details'); value.statusSurface[key] = invalid; assert.throws(() => assertMoveStatusFocus(value));
  }
});

test('a blurred document and a stale details mode both refuse', () => {
  const blurred = readFixture('details'); blurred.documentFocused = false; assert.throws(() => assertMoveStatusFocus(blurred));
  const stale = readFixture('details'); stale.status.fit = 'fit'; assert.throws(() => assertMoveStatusFocus(stale));
});
