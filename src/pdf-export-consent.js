// Only a local permission draft. Rust owns grants, roots, generations and downloads.
const sameProjects = (left, right) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
const stale = () => ({ code: 'stale', message: 'The PDF export permission changed while waiting. Refresh status before applying it again.' });

export class PdfExportConsentState {
  constructor(request, onChange = () => {}) {
    this.request = request; this.onChange = onChange; this.app = null; this.selected = new Set(); this.epoch = 0; this.pending = false; this.uncertain = false;
  }
  get available() { return !!this.request && !!this.app?.enabled && !!this.app.pdfExport; }
  get eligible() { return this.app?.pdfExport?.eligibleProjects || []; }
  get changed() { return !sameProjects(this.selected, this.app?.pdfExport?.projects || []); }
  update(app) {
    const previous = this.app, before = previous?.pdfExport, after = app?.pdfExport;
    const key = value => JSON.stringify([value?.enabled, value?.generation, value?.pdfExport?.generation, value?.pdfExport?.projects, value?.pdfExport?.eligibleProjects]);
    if (key(previous) !== key(app)) this.epoch += 1;
    this.app = app; this.uncertain = false;
    if (!this.available) this.selected.clear();
    else if (previous?.generation !== app.generation || previous?.enabled !== app.enabled || before?.generation !== after.generation || !sameProjects(before?.projects || [], after.projects)) {
      this.selected = new Set(after.projects.filter(project => this.eligible.some(item => item.project === project)));
    } else {
      // A newly eligible or replaced project root never inherits a checked draft.
      const oldRoots = new Map((before?.eligibleProjects || []).map(item => [item.project, item.root]));
      this.selected = new Set([...this.selected].filter(project => this.eligible.some(item => item.project === project && item.root === oldRoots.get(project))));
    }
    this.onChange();
  }
  select(project, enabled) {
    if (!this.available || this.pending || this.uncertain || !this.eligible.some(item => item.project === project)) return;
    if (enabled) this.selected.add(project); else this.selected.delete(project);
    this.onChange();
  }
  async apply(enabled) {
    if (!this.available || this.pending || this.uncertain) throw { code: 'busy', message: 'Refresh App control status and wait for the current request before changing PDF export permission.' };
    const projects = enabled ? [...this.selected] : [];
    if (enabled && !projects.length) throw { code: 'scope', message: 'Select at least one project folder before allowing PDF exports.' };
    const epoch = this.epoch, generation = this.app.generation, exportGeneration = this.app.pdfExport.generation;
    this.pending = true; this.onChange();
    try {
      const result = await this.request({ action: 'control_pdf_export', generation, exportGeneration, enabled, projects });
      if (this.epoch !== epoch || result?.generation !== generation || !result.enabled) throw stale();
      if (result.pdfExport?.enabled !== enabled || !sameProjects(result.pdfExport.projects, projects)) throw { code: 'state', message: 'The PDF export permission could not be confirmed. Refresh status before retrying.' };
      this.update(result);
      return result;
    } catch (error) {
      if (this.epoch === epoch) this.uncertain = true;
      throw error;
    } finally { this.pending = false; this.onChange(); }
  }
}

export function setupPdfExportConsent({ container, request, run }) {
  const disclosure = document.createElement('details'); disclosure.id = 'connection-pdf-export';
  disclosure.innerHTML = `
    <summary id="connection-pdf-export-summary" data-measure>PDF export · Off</summary>
    <p id="connection-pdf-export-status" role="status" data-measure>Enable App controls to allow PDF exports.</p>
    <p id="connection-pdf-export-scope" data-measure>Allow PDF downloads from shared manuscripts in the selected project folders. PDFs may include current or future saved text, images, fonts and data inside those folders, even from unshared files. Unsaved editor changes are excluded. Other project folders need separate permission.</p>
    <fieldset class="pdf-export-projects"><legend data-measure>Project folders</legend><div id="connection-pdf-export-projects"></div></fieldset>
    <div class="dialog-actions"><button id="connection-pdf-export-apply" type="button" data-measure>Allow PDF exports</button><button id="connection-pdf-export-disable" type="button" data-measure>Revoke PDF exports</button></div>`;
  container.insertBefore(disclosure, container.lastElementChild);
  const $ = id => disclosure.querySelector(`#connection-pdf-export-${id}`);
  let busy = false, eligibleKey = '', inputs = new Map();
  const text = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  const model = new PdfExportConsentState(request, render);
  function render() {
    const available = model.available, native = model.app?.pdfExport;
    const unsupported = !request || (model.app && !native);
    const projects = model.eligible;
    const key = JSON.stringify(projects);
    if (key !== eligibleKey) {
      eligibleKey = key; inputs = new Map();
      const rows = projects.map(project => {
        const label = document.createElement('label'); label.className = 'checkbox-label pdf-export-project';
        const input = document.createElement('input'); input.type = 'checkbox'; input.value = project.project;
        const description = document.createElement('span'), name = document.createElement('span'), path = document.createElement('span');
        name.textContent = `${project.name} · ${project.sharedCount} shared`; name.dataset.measure = '';
        path.textContent = project.root; path.className = 'pdf-export-root'; path.dataset.measure = '';
        description.append(name, path); label.append(input, description); inputs.set(project.project, input);
        input.onchange = () => model.select(project.project, input.checked);
        return label;
      });
      if (!rows.length) { const empty = document.createElement('p'); empty.textContent = 'Share a manuscript locally to make its project folder available here.'; empty.dataset.measure = ''; rows.push(empty); }
      $('projects').replaceChildren(...rows);
    }
    for (const [project, input] of inputs) { input.checked = model.selected.has(project); input.disabled = busy || model.pending || model.uncertain || !available; }
    text($('summary'), unsupported ? 'PDF export · Unavailable' : model.uncertain ? 'PDF export · Check status' : native?.enabled ? `PDF export · ${native.projects.length} project${native.projects.length === 1 ? '' : 's'}` : 'PDF export · Off');
    text($('status'), unsupported ? 'PDF exports are unavailable in this native service.' : !available ? 'Enable App controls to allow PDF exports.' : model.uncertain ? 'The permission could not be confirmed. Use Refresh to read its native status before retrying.' : model.pending ? 'Waiting for native permission confirmation…' : model.changed ? 'Selection changed. Apply to update the permission.' : native.enabled ? `Allowed for ${native.projects.length} project folder${native.projects.length === 1 ? '' : 's'}.` : 'PDF exports are off.');
    $('apply').disabled = busy || model.pending || model.uncertain || !available || !model.selected.size || (native.enabled && !model.changed);
    $('disable').disabled = busy || model.pending || model.uncertain || !available || !native.enabled;
    disclosure.setAttribute('aria-busy', String(model.pending));
  }
  $('apply').onclick = () => run(() => model.apply(true));
  $('disable').onclick = () => run(() => model.apply(false));
  render();
  return { update: app => model.update(app), setBusy: value => { if (busy !== value) { busy = value; render(); } } };
}
