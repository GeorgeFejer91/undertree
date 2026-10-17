import test from 'node:test';
import assert from 'node:assert/strict';
import { setupPdfTextSelection } from '../modules/frontend/pdf-text-selection.js';

function fixture() {
  const handlers = new Map(), writes = [], held = new Set();
  let current = 'pdf-1', completed = 0;
  const node = { nodeType: 3, parentElement: { closest: () => ({}) } };
  const pages = { contains: value => value === node, ownerDocument: {
    caretPositionFromPoint: x => ({ offsetNode: node, offset: x }),
    getSelection: () => ({ setBaseAndExtent: (...args) => writes.push(args) }),
  } };
  const scroller = {
    focus() {}, setPointerCapture: id => held.add(id), hasPointerCapture: id => held.has(id), releasePointerCapture: id => held.delete(id),
    addEventListener: (type, handler) => handlers.set(type, handler), removeEventListener: type => handlers.delete(type),
  };
  const dispose = setupPdfTextSelection({ scroller, pages, identity: () => current, onComplete: () => { completed++; } });
  const fire = (type, x = 0, extra = {}) => {
    let prevented = false;
    handlers.get(type)?.({ button: 0, buttons: 1, isPrimary: true, pointerType: 'mouse', pointerId: 1, clientX: x, clientY: 0,
      target: { closest: () => ({}) }, preventDefault: () => { prevented = true; }, ...extra });
    return prevented;
  };
  return { fire, writes, dispose, held, handlers, change: () => { current = 'pdf-2'; }, completed: () => completed };
}

test('real pointer handlers retain the starting text caret while extending and finish once', () => {
  const f = fixture();
  assert.equal(f.fire('pointerdown', 3), true);
  f.fire('pointermove', 8); f.fire('pointermove', 17); f.fire('pointerup', 20);
  assert.deepEqual(f.writes.map(args => [args[1], args[3]]), [[3, 3], [3, 8], [3, 17], [3, 20]]);
  assert.equal(f.completed(), 1); assert.equal(f.held.size, 0);
});

test('changed artifacts and cancelled pointers never submit a completed selection', () => {
  for (const cancel of [false, true]) {
    const f = fixture(); f.fire('pointerdown', 2);
    if (cancel) f.fire('pointercancel'); else f.change();
    f.fire('pointermove', 10); f.fire('pointerup', 12);
    assert.equal(f.completed(), 0); assert.equal(f.writes.length, 1);
  }
});

test('PDF controls, right clicks and native touch panning do not start manuscript selections', () => {
  for (const extra of [{button: 2}, {isPrimary: false}, {pointerType: 'touch'}, {target: {closest: () => null}}]) {
    const f = fixture(); assert.equal(f.fire('pointerdown', 1, extra), false); f.fire('pointerup', 3);
    assert.equal(f.writes.length, 0); assert.equal(f.completed(), 0);
    f.dispose(); assert.equal(f.handlers.size, 0);
  }
});
