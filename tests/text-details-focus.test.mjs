import assert from 'node:assert/strict';
import test from 'node:test';
import { createTextDetails } from '../modules/frontend/text-details.js';

function fixture() {
  const focusCalls = [];
  let focused = true;
  class Node {
    constructor(tag = 'span') {
      this.tagName = tag.toUpperCase(); this.children = []; this.attributes = new Map(); this.dataset = {}; this.hidden = false; this.isConnected = false; this.parentElement = null; this.textContent = ''; this.listeners = new Map();
      this.classList = { contains: name => this.className.split(' ').includes(name), toggle: (name, on) => { const names = new Set(this.className.split(' ').filter(Boolean)); on ? names.add(name) : names.delete(name); this.className = [...names].join(' '); } }; this.className = '';
    }
    append(...nodes) { for (const node of nodes) { node.parentElement?.children.splice(node.parentElement.children.indexOf(node), 1); node.parentElement = this; node.isConnected = this.isConnected; this.children.push(node); } }
    before(node) { const parent = this.parentElement; node.parentElement = parent; node.isConnected = parent.isConnected; parent.children.splice(parent.children.indexOf(this), 0, node); }
    setAttribute(name, value) { this.attributes.set(name, value); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    focus(options) { focusCalls.push({ node: this, options }); document.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; this.listeners.get('close')?.(); }
    remove() { if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null; this.isConnected = false; }
    replaceWith(...nodes) { const parent = this.parentElement, index = parent.children.indexOf(this); parent.children.splice(index, 1, ...nodes); for (const node of nodes) node.parentElement = parent; this.parentElement = null; }
  }
  const body = new Node('body'), source = new Node('p'), outside = new Node('button');
  body.isConnected = true; source.id = 'file-move-status'; source.dataset.textDetails = 'Move result details'; source.textContent = 'The exact prepared status and all of its long content remain available.'; source.setAttribute('role', 'status'); source.tabIndex = -1; body.append(source, outside);
  const previous = globalThis.document;
  globalThis.document = { body, activeElement: source, hasFocus: () => focused, createElement: tag => new Node(tag) };
  const details = createTextDetails(source), button = details.slot.children[1];
  return { source, outside, details, button, focusCalls, Node, blur: () => { focused = false; }, restore: () => { globalThis.document = previous; } };
}

function check(callback) { const value = fixture(); try { callback(value); } finally { value.restore(); } }

test('actual present moves focused source to its real full-value button when no-fit hides it', () => check(({ source, details, button, focusCalls }) => {
  assert.equal(details.present('no-fit'), 'details');
  assert.equal(document.activeElement, button); assert.equal(button.hidden, false); assert.equal(details.slot.classList.contains('text-details-active'), true);
  assert.deepEqual(focusCalls.map(row => row.node), [button]);
  assert.equal(button.getAttribute('aria-label'), `Move result details: ${source.textContent}`); assert.equal(button.getAttribute('aria-haspopup'), 'dialog'); assert.equal(details.slot.getAttribute('role'), 'status');
}));

test('a focused descendant of the source also keeps its current status surface', () => check(({ source, details, button, Node }) => {
  const child = new Node('a'); source.append(child); document.activeElement = child;
  details.present('no-fit'); assert.equal(document.activeElement, button);
}));

test('actual present restores focused details button to source when full text fits again', () => check(({ source, details, button, focusCalls }) => {
  details.present('no-fit'); document.activeElement = button; focusCalls.length = 0;
  assert.equal(details.present('fit'), 'fit'); assert.equal(document.activeElement, source); assert.equal(source.tabIndex, -1); assert.equal(button.hidden, true); assert.deepEqual(focusCalls.map(row => row.node), [source]);
}));

test('source to details does not steal newer unrelated focus', () => check(({ outside, details, focusCalls }) => {
  document.activeElement = outside; details.present('no-fit'); assert.equal(document.activeElement, outside); assert.deepEqual(focusCalls, []);
}));

test('details to source does not steal newer unrelated focus', () => check(({ outside, details, focusCalls }) => {
  details.present('no-fit'); document.activeElement = outside; focusCalls.length = 0;
  details.present('fit'); assert.equal(document.activeElement, outside); assert.deepEqual(focusCalls, []);
}));

test('a blurred document does not pull focus from browser or another application on no-fit', () => check(({ source, details, blur, focusCalls }) => {
  blur(); details.present('no-fit'); assert.equal(document.activeElement, source); assert.deepEqual(focusCalls, []);
}));

test('a blurred document does not restore source focus on regrowth', () => check(({ details, button, blur, focusCalls }) => {
  details.present('no-fit'); document.activeElement = button; blur(); focusCalls.length = 0;
  details.present('fit'); assert.equal(document.activeElement, button); assert.deepEqual(focusCalls, []);
}));

test('repeated no-fit and content refresh never repeat focus', () => check(({ source, details, button, focusCalls }) => {
  details.present('no-fit'); focusCalls.length = 0; source.textContent += ' New status.';
  details.present('no-fit'); details.present('unavailable'); assert.equal(document.activeElement, button); assert.deepEqual(focusCalls, []); assert.ok(button.getAttribute('aria-label').endsWith(source.textContent));
}));

test('an already-fitting source remains untouched', () => check(({ source, details, focusCalls }) => {
  details.present('fit'); assert.equal(document.activeElement, source); assert.deepEqual(focusCalls, []);
}));

test('hidden source cannot activate a replacement details surface', () => check(({ source, details, button, focusCalls }) => {
  source.hidden = true; assert.equal(details.present('no-fit'), 'no-fit'); assert.equal(details.slot.hidden, true); assert.equal(button.hidden, true); assert.deepEqual(focusCalls, []);
}));

test('full details retains original show/close focus route and exact text', () => check(({ source, details, button }) => {
  details.present('no-fit'); button.onclick(); const dialog = document.body.children.find(node => node.className === 'text-details-dialog');
  assert.equal(dialog.open, true); assert.equal(dialog.children[1].textContent, source.textContent); assert.equal(document.activeElement, dialog.children[1]);
  dialog.children[2].onclick(); assert.equal(dialog.open, false); assert.equal(document.activeElement, button);
}));

test('error details preserve the complete accessible value and alert role', () => check(({ source, details, button }) => {
  source.setAttribute('role', 'alert'); details.present('no-fit'); assert.equal(button.textContent, 'Error details'); assert.equal(button.getAttribute('aria-label'), `Error details: ${source.textContent}`); assert.equal(details.slot.getAttribute('role'), 'alert');
}));

test('destroy removes generated nodes and restores the exact original source', () => check(({ source, details }) => {
  details.present('no-fit'); details.destroy(); assert.equal(document.body.children[0], source); assert.equal(source.parentElement, document.body); assert.equal(document.body.children.some(node => node.className === 'text-details-dialog'), false);
}));
