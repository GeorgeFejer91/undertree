import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { parse } from 'parse5';
import { setupMenuNavigation } from '../modules/frontend/menu-navigation.js';
import { ReviewSession } from '../modules/frontend/review-session.js';

const source = await readFile(new URL('../src/manuscript.js', import.meta.url), 'utf8');
const html = parse(await readFile(new URL('../manuscript.html', import.meta.url), 'utf8'));
const commandStart = source.indexOf("for (const button of document.querySelectorAll('[data-command]')) button.onclick = task(async () => {");
const setupStart = source.indexOf('\n});', commandStart) + '\n});'.length;
const setupEnd = source.indexOf('\nfunction resizeFiles(', setupStart);
const closeStart = source.indexOf('function closeWorkspaceMenus(');
const closeEnd = source.indexOf('function formatSource(', closeStart);
const keysStart = source.indexOf("document.addEventListener('keydown', task(async event => {");
const keysEnd = source.indexOf('\n}));', keysStart) + '\n}));'.length;
assert.ok(commandStart >= 0 && setupEnd > setupStart && closeEnd > closeStart && keysEnd > keysStart);

// Only the DOM operations used by the real menu hooks; layout is explicitly a unit fixture.
class MenuElement {
  constructor(tag, document, attrs = []) {
    this.tagName = tag.toUpperCase(); this.ownerDocument = document; this.attributes = new Map(attrs.map(({ name, value }) => [name, value]));
    this.children = []; this.listeners = new Map(); this.rendered = true;
    this.classList = { contains: name => (this.attributes.get('class') || '').split(' ').includes(name) };
  }
  get id() { return this.getAttribute('id') || ''; }
  set id(value) { this.setAttribute('id', value); }
  get hidden() { return this.attributes.has('hidden'); }
  set hidden(value) { value ? this.setAttribute('hidden', '') : this.removeAttribute('hidden'); }
  get disabled() { return this.attributes.has('disabled'); }
  set disabled(value) { value ? this.setAttribute('disabled', '') : this.removeAttribute('disabled'); }
  get open() { return this.attributes.has('open'); }
  set open(value) {
    const changed = this.open !== value;
    value ? this.setAttribute('open', '') : this.removeAttribute('open');
    if (changed) this.emit('toggle');
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  append(child) { this.children.push(child); child.parentElement = this; }
  contains(child) { return this === child || this.children.some(node => node.contains(child)); }
  matches(selectors) {
    return selectors.split(',').some(selector => {
      if (selector === ':disabled') return this.disabled;
      if (selector === '[contenteditable]:not([contenteditable="false"])') return this.attributes.has('contenteditable') && this.getAttribute('contenteditable') !== 'false';
      if (selector.startsWith('button:not')) return this.tagName === 'BUTTON' && !this.disabled && !this.hidden;
      if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
      const attr = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
      if (attr) return this.attributes.has(attr[1]) && (attr[2] === undefined || this.getAttribute(attr[1]) === attr[2]);
      return this.tagName === selector.toUpperCase();
    });
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  querySelectorAll(selector) {
    const descendants = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
    return selector === '*' ? descendants : descendants.filter(child => child.matches(selector));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getClientRects() {
    for (let node = this; node; node = node.parentElement) {
      if (node.hidden || node.rendered === false) return [];
      if (node.parentElement?.tagName === 'DETAILS' && !node.parentElement.open && node.tagName !== 'SUMMARY') return [];
    }
    return [{}];
  }
  focus() { if (!this.disabled && this.getClientRects().length) this.ownerDocument.activeElement = this; }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(listener); }
  emit(type, values = {}) {
    const event = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...values };
    for (let node = this; node; node = ['toggle', 'pointerenter'].includes(type) ? null : node.parentElement)
      for (const listener of node.listeners.get(type) || []) listener(event);
    return event;
  }
}
const findParsed = (node, id) => node.attrs?.some(attr => attr.name === 'id' && attr.value === id) ? node
  : node.childNodes?.map(child => findParsed(child, id)).find(Boolean);

function fixture({ mobile = false } = {}) {
  const document = new MenuElement('document'); document.ownerDocument = document;
  document.defaultView = { getComputedStyle: element => ({ visibility: element.visibility || 'visible' }) };
  const convert = parsed => {
    const element = new MenuElement(parsed.tagName, document, parsed.attrs);
    for (const child of parsed.childNodes || []) if (child.tagName) element.append(convert(child));
    return element;
  };
  const menus = ['menu-file', 'menu-edit', 'menu-insert', 'menu-view', 'menu-format', 'menu-help', 'workspace-menu'].map(id => {
    const element = convert(findParsed(html, id)); element.rendered = id === 'workspace-menu' ? mobile : !mobile; document.append(element); return element;
  });
  const editor = new MenuElement('div', document, [{ name: 'contenteditable', value: 'true' }]); document.append(editor); editor.focus();
  const session = new ReviewSession({ path: 'main.typ', content: 'Original', review: { revision: 'saved' } }, 'project', () => assert.fail('Menu navigation cannot request a save or mutation'));
  session.edit('Unsaved draft');
  const state = Object.freeze({ document: 'Unsaved draft', selection: { from: 1, to: 7 }, history: {} });
  const view = { state, compositionStarted: false, dispatch: () => assert.fail('Menu navigation cannot dispatch an editor transaction') };
  const environment = { document, workspaceMenus: menus, setupMenuNavigation, active: session, view, windowClosing: false,
    task: callback => callback, saveSession: () => assert.fail('Unexpected Save'), compileSession: () => assert.fail('Unexpected build') };
  const close = runInNewContext(source.slice(closeStart, closeEnd) + source.slice(setupStart, setupEnd) + source.slice(keysStart, keysEnd) + '\ncloseWorkspaceMenus;', environment);
  const before = { content: session.content, snapshot: session.snapshot, queue: session.queue, version: session.version, generation: session.generation, pending: session.pending };
  const unchanged = () => {
    assert.deepEqual({ content: session.content, snapshot: session.snapshot, queue: session.queue, version: session.version, generation: session.generation, pending: session.pending }, before);
    assert.equal(view.state, state); assert.equal(session.dirty, true);
  };
  const key = (element, value, extra = {}) => { element.focus(); return element.emit('keydown', { key: value, ...extra }); };
  return { document, menus, menu: id => menus.find(menu => menu.id === id), editor, view, environment, close, key, unchanged };
}
const trigger = menu => menu.querySelector('summary');
const buttons = menu => menu.querySelector('.workspace-menu-panel').querySelectorAll('button');
const enabled = menu => buttons(menu).filter(item => !item.disabled && !item.hidden && item.getAttribute('aria-disabled') !== 'true' && item.rendered && item.visibility !== 'hidden');

test('actual shared hooks traverse all six desktop menus and mobile with Down, Up, Home, End and Escape', () => {
  for (const id of ['menu-file', 'menu-edit', 'menu-insert', 'menu-view', 'menu-format', 'menu-help', 'workspace-menu']) {
    const f = fixture({ mobile: id === 'workspace-menu' }), menu = f.menu(id), items = enabled(menu);
    f.key(trigger(menu), 'ArrowDown'); assert.equal(menu.open, true); assert.ok(f.document.activeElement === items[0]);
    f.key(items[0], 'ArrowDown'); assert.ok(f.document.activeElement === (items[1] || items[0]), `${id}: second Down`);
    f.key(f.document.activeElement, 'ArrowUp'); assert.ok(f.document.activeElement === items[0]);
    f.key(items[0], 'End'); assert.ok(f.document.activeElement === items.at(-1));
    f.key(items.at(-1), 'ArrowDown'); assert.ok(f.document.activeElement === items.at(-1));
    f.key(items.at(-1), 'Home'); assert.ok(f.document.activeElement === items[0]);
    f.key(items[0], 'ArrowUp'); assert.ok(f.document.activeElement === items[0]);
    f.key(items[0], 'Escape'); assert.equal(menu.open, false); assert.ok(f.document.activeElement === trigger(menu)); f.unchanged();
  }
});

test('navigation rechecks disabled, aria-disabled, hidden and rendered item state, including an empty menu', () => {
  const f = fixture(), menu = f.menu('menu-file'), items = buttons(menu);
  items[0].disabled = true; items[1].hidden = true; items[2].rendered = false; items[3].visibility = 'hidden'; items[4].setAttribute('aria-disabled', 'true');
  f.key(trigger(menu), 'ArrowDown'); assert.ok(f.document.activeElement === items[5]);
  items[6].disabled = true; f.key(items[5], 'ArrowDown'); assert.ok(f.document.activeElement === items[7]);
  f.key(trigger(menu), 'ArrowUp'); assert.ok(f.document.activeElement === enabled(menu).at(-1));
  for (const item of items) item.disabled = true;
  f.key(trigger(menu), 'ArrowDown'); assert.ok(f.document.activeElement === trigger(menu)); f.unchanged();
});

test('closed Home and End, page/editor keys, modifiers, composition and closing never start menu navigation', () => {
  const f = fixture(), menu = f.menu('menu-file');
  for (const value of ['Home', 'End', 'PageUp', 'PageDown', 'Tab']) {
    const event = f.key(trigger(menu), value); assert.equal(event.defaultPrevented, false); assert.equal(menu.open, false);
  }
  for (const extra of [{ isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }]) {
    const event = f.key(trigger(menu), 'ArrowDown', extra); assert.equal(event.defaultPrevented, false); assert.equal(menu.open, false);
  }
  for (const flag of ['composition', 'closing']) {
    f.view.compositionStarted = flag === 'composition'; f.environment.windowClosing = flag === 'closing';
    assert.equal(f.key(trigger(menu), 'ArrowDown').defaultPrevented, false); assert.equal(menu.open, false);
  }
  f.view.compositionStarted = false; f.environment.windowClosing = false;
  menu.open = true;
  for (const value of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Escape', 'Tab']) {
    const event = f.key(f.editor, value); assert.equal(event.defaultPrevented, false); assert.ok(f.document.activeElement === f.editor);
  }
  f.unchanged();
});

test('semantics label real command popups, while the Highlight select keeps native role, Tab and input keys', () => {
  const f = fixture();
  for (const menu of f.menus) {
    const popup = menu.querySelector('.workspace-menu-panel'), heading = trigger(menu);
    assert.equal(heading.getAttribute('aria-controls'), popup.id); assert.equal(popup.getAttribute('aria-labelledby'), heading.id);
    assert.equal(heading.getAttribute('aria-expanded'), 'false');
    if (menu.id === 'menu-format') { assert.equal(popup.getAttribute('role'), 'group'); assert.equal(heading.getAttribute('aria-haspopup'), null); }
    else { assert.equal(popup.getAttribute('role'), 'menu'); assert.equal(heading.getAttribute('aria-haspopup'), 'menu'); for (const item of buttons(menu)) assert.equal(item.getAttribute('role'), 'menuitem'); }
  }
  const menu = f.menu('menu-format'), select = menu.querySelector('select'); menu.open = true;
  assert.equal(select.getAttribute('role'), null); assert.equal(select.getAttribute('tabindex'), null);
  for (const value of ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'Home', 'End', 'Escape', 'Tab']) {
    const event = f.key(select, value); assert.equal(event.defaultPrevented, false); assert.equal(menu.open, true); assert.ok(f.document.activeElement === select);
  }
  assert.equal(f.key(buttons(menu)[0], 'Tab').defaultPrevented, false); f.unchanged();
});

test('hover switches only an already open visible desktop menu and retains the current focus route', () => {
  const f = fixture(), file = f.menu('menu-file'), edit = f.menu('menu-edit'), mobile = f.menu('workspace-menu');
  trigger(edit).emit('pointerenter', { pointerType: 'mouse' }); assert.equal(edit.open, false);
  f.key(trigger(file), 'ArrowDown'); trigger(edit).emit('pointerenter', { pointerType: 'touch' }); assert.equal(file.open, true);
  trigger(mobile).emit('pointerenter', { pointerType: 'mouse' }); assert.equal(mobile.open, false);
  trigger(edit).emit('pointerenter', { pointerType: 'mouse' });
  assert.equal(file.open, false); assert.equal(edit.open, true); assert.ok(f.document.activeElement === trigger(edit));
  assert.equal(trigger(file).getAttribute('aria-expanded'), 'false'); assert.equal(trigger(edit).getAttribute('aria-expanded'), 'true');
  f.key(trigger(edit), 'Escape'); assert.ok(f.document.activeElement === trigger(edit));
  file.open = true; f.editor.focus(); trigger(edit).emit('pointerenter', { pointerType: 'mouse' }); assert.ok(f.document.activeElement === f.editor); f.unchanged();
});

test('heading traversal skips hidden menus, maintains an open popup and closes without stealing focus', () => {
  const f = fixture(), file = f.menu('menu-file'), edit = f.menu('menu-edit'), insert = f.menu('menu-insert');
  edit.rendered = false;
  f.key(trigger(file), 'ArrowRight'); assert.ok(f.document.activeElement === trigger(insert)); assert.equal(insert.open, false);
  f.key(trigger(file), 'ArrowDown'); f.key(buttons(file)[0], 'ArrowRight');
  assert.equal(file.open, false); assert.equal(insert.open, true); assert.ok(f.document.activeElement === buttons(insert)[0]);
  f.close(); assert.equal(insert.open, false); assert.ok(f.document.activeElement === buttons(insert)[0]);
  f.key(trigger(file), 'ArrowDown'); f.editor.emit('pointerdown'); assert.equal(file.open, false); f.unchanged();
});

test('menu buttons retain their native Enter/Space action and the frozen Close and command handlers remain exact', () => {
  const f = fixture(), menu = f.menu('menu-help');
  f.key(trigger(menu), 'Enter'); assert.equal(menu.open, true); assert.ok(f.document.activeElement === buttons(menu)[0]);
  assert.equal(f.key(buttons(menu)[0], 'Enter').defaultPrevented, false);
  assert.equal(f.key(buttons(menu)[0], ' ').defaultPrevented, false); f.unchanged();
  const hash = value => createHash('sha256').update(value).digest('hex');
  assert.equal(hash(source.slice(source.indexOf('function setWindowClosing('), source.indexOf('function task('))), '64e7a22dc7cc49b76def339c241311733a016c828f31db06919e28e102f6e89a');
  const commands = source.slice(commandStart, setupStart), moveCommand = "  else if (command === 'move-source') openFileMove(button);\n";
  assert.equal(commands.split(moveCommand).length, 2, 'Exactly one native Move command extends the frozen dispatcher');
  const findFocus = "if (command !== 'find') view.focus();";
  assert.equal(commands.split(findFocus).length, 2, 'Exactly one Find focus correction extends the frozen dispatcher');
  const chatgptCommand = "  if (command === 'chatgpt') { $('workspace-menu-toggle').focus(); $('chatgpt-open').click(); }\n  else if (triggers[command]) $(triggers[command]).click();\n";
  assert.equal(commands.split(chatgptCommand).length, 2, 'Exactly one ChatGPT branch returns focus before opening Connections');
  assert.equal(hash(commands.replace(moveCommand, '').replace(findFocus, 'view.focus();').replace(chatgptCommand, "  if (triggers[command]) $(triggers[command]).click();\n")), '2ad1b1841ec4a0c780841ed0c15cb4e572f33442846c49153f76323d8b126560');
});

test('actual command dispatch retains Find query focus and refocuses ordinary editor commands', async () => {
  for (const command of ['find', 'undo', 'redo', 'select-all']) {
    const button = { dataset: { command } }, calls = [], state = Object.freeze({});
    let focus = 'menu';
    const view = { state, focus: () => { calls.push('editor-focus'); focus = 'editor'; } };
    const action = name => target => { assert.equal(target, view); calls.push(name); };
    runInNewContext(source.slice(commandStart, setupStart), {
      document: { querySelectorAll: () => [button] }, task: callback => callback,
      closeWorkspaceMenus: () => calls.push('close-menu'), showPane: pane => { assert.equal(pane, 'editor'); calls.push('editor-pane'); },
      view, insertionCommands: new Set(), undo: action('undo'), redo: action('redo'), selectAll: action('select-all'),
      openSearchPanel: target => { action('find')(target); focus = 'query'; },
    });
    await button.onclick();
    assert.equal(focus, command === 'find' ? 'query' : 'editor', `${command}: preserve the command's intended focus`);
    assert.deepEqual(calls, ['close-menu', 'editor-pane', command, ...(command === 'find' ? [] : ['editor-focus'])]);
    assert.equal(view.state, state);
  }
});

test('actual ChatGPT dispatch restores the workspace menu focus before opening Connections', async () => {
  const button = { dataset: { command: 'chatgpt' } }, calls = [], state = Object.freeze({ dirty: true });
  const view = { state, focus: () => assert.fail('ChatGPT must preserve the editor focus route') };
  const controls = {
    'workspace-menu-toggle': { focus: () => calls.push('workspace-menu-focus') },
    'chatgpt-open': { click: () => calls.push('chatgpt-open') },
  };
  runInNewContext(source.slice(commandStart, setupStart), {
    document: { querySelectorAll: () => [button] }, task: callback => callback,
    closeWorkspaceMenus: () => calls.push('close-menu'), $: id => {
      assert.ok(controls[id], `Unexpected control ${id}`); return controls[id];
    }, view,
  });
  await button.onclick();
  assert.deepEqual(calls, ['close-menu', 'workspace-menu-focus', 'chatgpt-open']);
  assert.equal(view.state, state);
});
