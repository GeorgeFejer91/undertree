import './history-panel.css';
import { EditorState } from '@codemirror/state';
import { EditorView, Decoration, lineNumbers, highlightSpecialChars } from '@codemirror/view';
import { HistoryController } from '../modules/frontend/history-controller.js';
import { sourceRoot } from '../modules/frontend/review-session.js';

function identity(context) {
  if (!context?.session || !context.viewToken) throw new Error('Open an editor with a verified project folder before browsing History.');
  return Object.freeze({ session: context.session, viewToken: context.viewToken, projectId: context.projectId, path: context.path, sourceEpoch: context.sourceEpoch, root: sourceRoot({ expectedRoot: context.root }) });
}
function same(a, context) {
  try {
    const b = identity(context);
    return ['session', 'viewToken', 'projectId', 'path', 'sourceEpoch'].every(key => a[key] === b[key]) && a.root.dev === b.root.dev && a.root.ino === b.root.ino;
  } catch { return false; }
}
const node = (tag, text, className = '') => {
  const result = document.createElement(tag); result.textContent = text; result.className = className; return result;
};
const measured = (tag, text, className = '') => { const result = node(tag, text, className); result.dataset.measure = ''; return result; };
const versionLabel = version => `Version ${version.sequence} · ${version.cause === 'native_save' ? 'Saved locally' : 'Accepted suggestion'}${version.afterRecovery ? ' · after recovery' : ''}${version.clockAdjusted ? ' · clock adjusted' : ''}`;

function savedView(parent, saved, changed, label) {
  const extensions = [EditorState.lineSeparator.of('\n'), EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.lineWrapping, lineNumbers(), highlightSpecialChars(),
    EditorView.contentAttributes.of({ 'aria-label': label, 'aria-readonly': 'true', tabindex: '0' })];
  if (changed && changed.toUtf16 > changed.fromUtf16) extensions.push(EditorView.decorations.of(Decoration.set([Decoration.mark({ class: 'history-change' }).range(changed.fromUtf16, changed.toUtf16)])));
  return new EditorView({ parent, state: EditorState.create({ doc: saved.content, extensions }) });
}

// This adapter owns only its saved-text views, never the live editor or preview objects.
export class HistoryPanel {
  constructor({ root, request, owner, context, intent, visibility, back, createView = savedView }) {
    Object.assign(this, { root, owner, context, intent, visibility, onBack: back, createView });
    this.visible = false; this.openToken = null; this.openIdentity = null; this.ownerId = null;
    this.selected = new Set(); this.views = []; this.result = null; this.page = null; this.showResult = false;
    this.$ = id => root.querySelector(`#history-${id}`);
    this.controller = new HistoryController({ request, context: () => ({ ...context(), ownerId: this.ownerId }), render: state => this.render(state) });
    this.$('back').onclick = () => this.back();
    this.$('current').onclick = () => { void this.open(); };
    this.action('folders', () => this.controller.namespaces());
    this.action('sources', () => this.controller.sources());
    this.action('versions', () => { this.showResult = false; this.presentResult(); });
    this.action('refresh', () => this.controller.firstPage());
    this.action('next', () => this.controller.nextPage());
    this.action('compare', () => {
      const versions = this.page.items.filter(item => item.kind === 'version' && this.selected.has(item.version.versionId)).map(item => item.version);
      if (versions.length !== 2) return;
      versions.sort((a, b) => a.sequence.length - b.sequence.length || a.sequence.localeCompare(b.sequence));
      return this.controller.compare(versions[0].versionId, versions[1].versionId);
    });
    root.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !event.isComposing && !root.ownerDocument.querySelector('dialog[open]')) { event.preventDefault(); event.stopPropagation(); this.back(); }
    });
  }
  action(id, callback) { this.$(id).onclick = () => this.navigate(callback); }
  async navigate(callback) {
    this.intent(); this.root.querySelector('.history-navigation').open = false;
    try { await callback(); }
    catch { if (this.visible) this.render({ ...this.controller.current, phase: 'unavailable', result: null, message: 'Saved History is unavailable. Request its list again.' }); }
  }
  async open() {
    const token = {}; this.openToken = token;
    try { this.openIdentity = identity(this.context()); }
    catch { this.openIdentity = null; return false; }
    this.intent(); this.visible = true; this.root.hidden = false; this.visibility(true);
    this.controller.close();
    this.render({ phase: 'loading', scope: null, page: null, result: null, message: '' });
    this.$('back').focus({ preventScroll: true });
    try {
      const ownerId = await this.owner();
      if (this.openToken !== token || !same(this.openIdentity, this.context())) { this.changed(); return false; }
      this.ownerId = ownerId;
      return await this.controller.open();
    } catch {
      if (this.openToken === token && this.visible) this.render({ phase: 'unavailable', scope: null, page: null, result: null, message: 'Saved History could not connect to this desktop window.' });
      return false;
    }
  }
  changed() {
    if (!this.visible) return;
    if (this.openIdentity && !same(this.openIdentity, this.context())) {
      this.openToken = null; this.openIdentity = null; this.controller.close();
      this.render({ phase: 'stale', scope: null, page: null, result: null, message: 'The editor identity changed. Reopen History deliberately.' });
    } else this.controller.changed();
  }
  back() {
    if (!this.visible) return;
    this.intent(); this.openToken = null; this.openIdentity = null;
    const editor = this.controller.back();
    this.visible = false; this.root.hidden = true; this.visibility(false); this.onBack(editor);
  }
  disposeViews() {
    for (const view of this.views) view.destroy();
    this.views = []; this.result = null; this.$('result').replaceChildren();
  }
  render(state) {
    if (state.result !== this.result) this.disposeViews();
    if (state.page !== this.page) { this.selected.clear(); this.page = state.page; }
    const loading = state.phase === 'loading', scope = state.scope; this.loading = loading;
    this.$('status').textContent = state.message || (loading ? 'Loading saved History…' : '');
    this.$('status').hidden = !this.$('status').textContent;
    this.$('location').textContent = scope?.source ? `${scope.source.path} · saved source identity ${scope.source.sourceEpoch}` : scope?.root ? 'Saved files in the selected project folder' : 'Recorded project folders';
    const metadata = [this.$('location').textContent, 'Saved versions only. Your current editor remains editable.'];
    if (state.result?.from) metadata.push(`Earlier: ${versionLabel(state.result.from.version)}`, `Later: ${versionLabel(state.result.to.version)}`, state.result.fromChanged ? 'Coarse changed region highlighted.' : 'No text changes.');
    else if (state.result) metadata.push(versionLabel(state.result.version));
    this.$('details').textContent = metadata.join('\n');
    for (const id of ['folders', 'current', 'refresh']) this.$(id).disabled = loading;
    this.$('sources').hidden = !scope?.namespaceId; this.$('sources').disabled = loading;
    this.$('versions').hidden = !state.result; this.$('versions').disabled = loading;
    this.$('next').hidden = !state.page?.cursor; this.$('next').disabled = loading;
    this.$('refresh').disabled = loading || !this.controller.listQuery;
    this.$('folders').disabled = loading || !this.controller.capture;
    this.renderList(state);
    if (state.result && this.result !== state.result) { this.result = state.result; this.showResult = true; this.renderResult(state.result); }
    if (!state.result) this.showResult = false;
    this.presentResult();
    if (state.phase === 'closed') { this.$('list').replaceChildren(); this.$('location').textContent = ''; }
  }
  renderList(state) {
    const list = this.$('list'); list.replaceChildren();
    for (const item of state.page?.items || []) {
      const row = node('div', '', 'history-row');
      const button = (text, callback) => { const result = measured('button', text); result.disabled = state.phase === 'loading'; result.onclick = () => this.navigate(callback); return result; };
      if (item.kind === 'namespace') row.append(button(`Project folder · device ${item.root.dev} · folder ${item.root.ino}`, () => this.controller.selectNamespace(item.namespaceId)));
      else if (item.kind === 'source') row.append(button(`${item.path} · source identity ${item.sourceEpoch}`, () => this.controller.selectSource(item.sourceId)));
      else {
        row.dataset.versionId = item.version.versionId;
        const label = node('label', '', 'history-choice'), choice = document.createElement('input'); choice.type = 'checkbox'; choice.value = item.version.versionId; choice.checked = this.selected.has(choice.value);
        choice.setAttribute('aria-label', `Compare version ${item.version.sequence}`);
        choice.onchange = () => {
          if (choice.checked && this.selected.size < 2) this.selected.add(choice.value); else { this.selected.delete(choice.value); choice.checked = false; }
          this.updateChoices();
        };
        label.append(choice, measured('span', versionLabel(item.version)));
        row.append(label, button('View', () => this.controller.read(item.version.versionId)));
      }
      list.append(row);
    }
    if (state.phase === 'ready' && !state.page?.items.length) list.append(measured('p', 'No saved versions in this project folder.', 'history-empty'));
    this.updateChoices();
  }
  updateChoices() {
    for (const input of this.$('list').querySelectorAll('input')) input.disabled = this.loading || this.selected.size === 2 && !this.selected.has(input.value);
    this.$('actions').hidden = this.selected.size !== 2 || this.showResult;
  }
  renderResult(result) {
    const parent = this.$('result'), comparison = !!result.from;
    parent.dataset.comparison = String(comparison); parent.dataset.show = 'from';
    if (comparison) {
      const tabs = node('div', '', 'history-comparison-tabs'); tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', 'Displayed saved version');
      for (const [side, text] of [['from', 'Earlier'], ['to', 'Later']]) {
        const button = measured('button', text); button.setAttribute('aria-pressed', String(side === 'from'));
        button.onclick = () => { this.intent(); parent.dataset.show = side; for (const sibling of tabs.children) sibling.setAttribute('aria-pressed', String(sibling === button)); for (const view of this.views) view.requestMeasure(); };
        tabs.append(button);
      }
      parent.append(tabs);
    }
    const payloads = comparison ? [['from', result.from, result.fromChanged], ['to', result.to, result.toChanged]] : [['from', result, null]];
    for (const [side, saved, changed] of payloads) {
      const section = node('section', '', 'history-version'); section.dataset.side = side;
      const title = measured('h3', versionLabel(saved.version)); title.id = `history-version-${saved.version.versionId}`; title.dataset.textDetails = 'Saved version details';
      const editor = node('div', '', 'history-saved-text');
      section.append(title, editor); parent.append(section);
      this.views.push(this.createView(editor, saved, changed, `${comparison ? side === 'from' ? 'Earlier' : 'Later' : 'Saved'} version ${saved.version.sequence}, read only`));
    }
    if (comparison) parent.append(measured('p', result.fromChanged ? 'Coarse changed region highlighted.' : 'No text changes.', 'history-comparison-note'));
  }
  presentResult() {
    this.$('list').hidden = this.showResult;
    this.$('result').hidden = !this.showResult;
    this.$('actions').hidden = this.showResult || this.selected.size !== 2;
    for (const view of this.views) view.requestMeasure();
  }
}
