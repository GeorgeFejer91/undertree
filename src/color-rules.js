import selectiveEditor from '../modules/review/selective-editor-contract.json' with { type: 'json' };

const $ = id => document.getElementById(id);
const PAGE_SIZE = selectiveEditor.slots.visible;
const RULE_LIMIT = selectiveEditor.slots.ruleLimit;

export function rulePromptParts(prompt) {
  const lines = prompt.split('\n');
  const parts = { shorten: false, detail: false };
  for (const preset of selectiveEditor.presets) if (lines[0] === preset.prompt) {
    parts[preset.id] = true;
    lines.shift();
  }
  return { ...parts, custom: lines.join('\n') };
}

export function composeRulePrompt(parts) {
  return [...selectiveEditor.presets.filter(preset => parts[preset.id]).map(preset => preset.prompt), parts.custom].filter(Boolean).join('\n');
}

export function setupColorRules({ context, save, report, onChoose = () => {} }) {
  const labels = selectiveEditor.labels;
  for (const [selector, label] of [
    ['.color-rule-identity label:first-child span', labels.color], ['.color-rule-identity label:last-child span', labels.ruleName],
    ['.color-rule-actions legend', labels.actionGroup], ['#color-rule-instructions legend', labels.instructionsGroup],
    ['#color-rule-instructions > label span', labels.customPrompt], ['#color-rule-permissions legend', labels.accessGroup],
    ['#color-rule-save', labels.saveRule], ['#color-rule-form [data-close]', labels.cancel], ['.color-rule-explanation', labels.ruleHelp],
  ]) document.querySelector(selector).textContent = label;
  for (const choice of selectiveEditor.actions) document.querySelector(`input[name="color-rule-action"][value="${choice.id}"]`).nextElementSibling.textContent = choice.label;
  for (const choice of selectiveEditor.accessModes) document.querySelector(`input[name="color-rule-access"][value="${choice.id}"]`).nextElementSibling.textContent = choice.label;
  const presets = document.querySelector('.color-rule-presets');
  presets.replaceChildren(...selectiveEditor.presets.map(preset => {
    const label = document.createElement('label'), input = document.createElement('input'), text = document.createElement('span');
    input.id = `color-rule-${preset.id}`; input.type = 'checkbox';
    text.textContent = preset.label; text.dataset.measure = ''; label.append(input, text);
    return label;
  }));
  const selected = new WeakMap();
  const pages = new WeakMap();
  let editing = null;
  let returnFocus = null;
  let returnControl = null;
  let rendered = '';
  let saving = false;
  let choosing = null;
  const dialog = $('color-rule-dialog');
  $('color-rule-save').setAttribute('aria-label', labels.saveRule);
  const run = callback => async event => {
    const dialogIntent = editing;
    try { await callback(event); }
    catch (error) { report(error.message || String(error), true); if (editing && editing === dialogIntent) $('color-rule-error').textContent = error.message || String(error); }
  };
  const chosen = () => {
    const session = context().session;
    return session && session.snapshot.review.rules.find(rule => rule.id === selected.get(session));
  };
  const choose = rule => {
    const { session } = context();
    if (!session) return;
    selected.set(session, rule.id);
    pages.set(session, Math.floor(session.snapshot.review.rules.findIndex(value => value.id === rule.id) / PAGE_SIZE));
    $('highlight-rule').value = rule.id;
    render();
    onChoose(rule);
  };
  const open = (rule, target = document.activeElement) => {
    const { session, binding, blocked, composing } = context();
    if (!session || blocked) return;
    if (composing) throw new Error('Finish the current text composition before changing color rules.');
    if (!rule && session.snapshot.review.rules.length >= RULE_LIMIT) return;
    const rules = structuredClone(session.snapshot.review.rules);
    selected.delete(session); render(); onChoose(null);
    editing = { session, binding, rules, original: JSON.stringify(rules), title:rule ? labels.editRule : labels.newRule, rule: rule || { id: crypto.randomUUID(), color: '#74b9a4', label: '', action: 'prompt', prompt: '', accessMode: 'suggestions' } };
    returnFocus = target;
    returnControl = target?.dataset ? { ...target.dataset } : null;
    const parts = rulePromptParts(editing.rule.prompt);
    $('color-rule-label').value = editing.rule.label;
    $('color-rule-color').value = editing.rule.color;
    $('color-rule-form').elements['color-rule-action'].value = editing.rule.action;
    $('color-rule-form').elements['color-rule-access'].value = editing.rule.accessMode === 'direct' ? 'direct' : 'suggestions';
    for (const preset of selectiveEditor.presets) $(`color-rule-${preset.id}`).checked = Boolean(parts[preset.id]);
    $('color-rule-prompt').value = parts.custom;
    $('color-rule-error').textContent = '';
    $('color-rule-title').textContent = rule ? labels.editRule : labels.newRule;
    $('color-rule-title').setAttribute('aria-label', editing.title);
    updateAction();
    $('color-rule-dialog').showModal();
    $('color-rule-label').focus();
  };
  const updateAction = () => {
    const prompt = $('color-rule-form').elements['color-rule-action'].value === 'prompt';
    $('color-rule-instructions').disabled = !prompt || saving;
    $('color-rule-permissions').disabled = !prompt || saving;
  };
  const button = (label, className, callback) => {
    const node = document.createElement('button');
    node.type = 'button'; node.className = className; node.setAttribute('aria-label', label); node.title = label;
    node.onclick = run(callback);
    return node;
  };
  const render = () => {
    const { session, blocked } = context();
    const rules = session?.snapshot.review.rules || [];
    const page = session ? Math.min(pages.get(session) || 0, Math.max(0, Math.ceil(rules.length / PAGE_SIZE) - 1)) : 0;
    for (const swatch of $('color-slots').querySelectorAll('[data-color-rule]')) swatch.setAttribute('aria-pressed', String(swatch.dataset.colorRule === selected.get(session)));
    const key = JSON.stringify([session?.snapshot.documentId, rules, blocked, page]);
    if (key === rendered) return;
    rendered = key;
    const focused = $('color-slots').contains(document.activeElement) ? { ...document.activeElement.dataset } : null;
    const slots = [];
    const visible = rules.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
    for (const rule of visible) {
      const group = document.createElement('span'); group.className = 'color-slot';
      const swatch = button(`Use highlighter: ${rule.label}. Drag over PDF or source text.`, 'color-swatch', () => {
        choose(rule);
        report(`${rule.label} highlighter active. Drag over text in the PDF or source editor. Escape stops marking; ⋮ changes this color's settings.`);
      });
      swatch.dataset.colorRule = rule.id; swatch.style.setProperty('--rule-color', rule.color);
      swatch.title += ' Double-click or press F4 for color settings.';
      swatch.setAttribute('aria-haspopup', 'dialog');
      swatch.addEventListener('dblclick', run(event => { event.preventDefault(); open(rule, swatch); }));
      swatch.addEventListener('keydown', run(event => {
        if (event.key === 'F4' || (event.key === 'Enter' && event.shiftKey)) { event.preventDefault(); open(rule, swatch); }
      }));
      swatch.setAttribute('aria-pressed', String(selected.get(session) === rule.id)); swatch.disabled = !session || blocked;
      const settings = button(labels.configureRule.replace('{name}', rule.label), 'color-configure', () => open(rule, settings));
      settings.dataset.colorConfigure = rule.id; settings.textContent = '⋮'; settings.setAttribute('aria-haspopup', 'dialog'); settings.disabled = swatch.disabled;
      group.append(swatch, settings); slots.push(group);
    }
    if (rules.length > visible.length) {
      const next = button(`${labels.nextColors}. Showing ${page * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE + PAGE_SIZE, rules.length)} of ${rules.length} color rules.`, 'color-empty', () => {
        pages.set(session, (page + 1) % Math.ceil(rules.length / PAGE_SIZE)); render();
      });
      next.textContent = '→'; next.dataset.colorNext = ''; next.disabled = blocked; slots.push(next);
      const more = button(labels.allRules, 'color-empty', () => $('palette-open').click());
      more.textContent = '…'; more.dataset.colorMore = ''; more.setAttribute('aria-haspopup', 'dialog'); more.disabled = blocked; slots.push(more);
    }
    for (let slot = 0; slot < Math.min(rules.length > PAGE_SIZE ? 1 : 3, RULE_LIMIT - rules.length); slot += 1) {
      const add = button(labels.newSlot, 'color-empty', () => open(null, add));
      add.textContent = '+'; add.dataset.colorAdd = String(slot); add.setAttribute('aria-haspopup', 'dialog'); add.disabled = !session || blocked; slots.push(add);
    }
    $('color-slots').replaceChildren(...slots);
    if (focused) [...$('color-slots').querySelectorAll('button')].find(node => ['colorRule', 'colorConfigure', 'colorAdd', 'colorNext', 'colorMore'].some(key => focused[key] !== undefined && node.dataset[key] === focused[key]))?.focus({ preventScroll: true });
  };
  $('color-rule-form').addEventListener('change', updateAction);
  $('color-rule-form').onsubmit = run(async event => {
    event.preventDefault();
    if (saving || !editing) return;
    const captured = editing;
    const rule = { ...captured.rule, label: $('color-rule-label').value.trim(), color: $('color-rule-color').value,
      action: $('color-rule-form').elements['color-rule-action'].value,
      accessMode: $('color-rule-form').elements['color-rule-action'].value === 'prompt' ? $('color-rule-form').elements['color-rule-access'].value : 'suggestions',
      prompt: composeRulePrompt({ ...Object.fromEntries(selectiveEditor.presets.map(preset => [preset.id, $(`color-rule-${preset.id}`).checked])), custom: $('color-rule-prompt').value }) };
    if (rule.action === 'neutral') rule.prompt = '';
    if (!rule.label || new TextEncoder().encode(rule.label).length > selectiveEditor.limits.ruleNameBytes) throw new Error('Name this color using at most 100 bytes.');
    if (new TextEncoder().encode(rule.prompt).length > selectiveEditor.limits.promptBytes) throw new Error('Keep the combined instructions shorter than 4,000 bytes.');
    const rules = captured.rules.some(value => value.id === rule.id) ? captured.rules.map(value => value.id === rule.id ? rule : value) : [...captured.rules, rule];
    saving = true; $('color-rule-save').disabled = true; updateAction();
    try {
      await save(captured, rules);
      if (editing === captured) { choose(rule); $('color-rule-dialog').close(); }
      report(`Color rule saved: ${rule.label}. Existing marks using this color follow this rule.`);
    } finally { saving = false; $('color-rule-save').disabled = false; updateAction(); }
  });
  $('color-rule-dialog').addEventListener('close', () => {
    if ($('color-rule-dialog').open) return;
    editing = null;
    const replacement = returnControl && [...$('color-slots').querySelectorAll('button')].find(node => ['colorRule', 'colorConfigure', 'colorAdd'].some(key => returnControl[key] !== undefined && node.dataset[key] === returnControl[key]));
    const target = returnFocus?.isConnected ? returnFocus : replacement || $('color-slots').querySelector('button');
    target?.focus({ preventScroll: true }); returnFocus = null; returnControl = null;
  });
  const edit = (ids, target = document.activeElement) => {
    const { session, blocked, composing } = context();
    if (!session || blocked) return;
    if (composing) throw new Error('Finish the current text composition before changing color rules.');
    const rules = session.snapshot.review.rules.filter(rule => ids.includes(rule.id));
    if (!rules.length) return;
    if (rules.length === 1) { open(rules[0], target); return; }
    selected.delete(session); render(); onChoose(null);
    choosing = { session, original: JSON.stringify(session.snapshot.review.rules), target };
    $('highlight-color-title').textContent = labels.chooseHighlightColor;
    $('highlight-color-error').textContent = '';
    $('highlight-color-choice').replaceChildren(...rules.map(rule => {
      const option = document.createElement('option'); option.value = rule.id;
      option.textContent = `${rule.label}${rule.action === 'neutral' ? ' · color only' : ''}`;
      return option;
    }));
    $('highlight-color-dialog').showModal(); $('highlight-color-choice').focus();
  };
  $('highlight-color-form').onsubmit = event => {
    event.preventDefault();
    const captured = choosing, { session, blocked, composing } = context();
    if (!captured || captured.session !== session || blocked || composing || captured.original !== JSON.stringify(session.snapshot.review.rules)) {
      $('highlight-color-error').textContent = 'The manuscript or its colors changed. Close this dialog and choose the highlight again.';
      return;
    }
    const rule = session.snapshot.review.rules.find(rule => rule.id === $('highlight-color-choice').value);
    if (!rule) return;
    $('highlight-color-dialog').close(); open(rule, captured.target);
  };
  $('highlight-color-dialog').addEventListener('close', () => {
    if ($('highlight-color-dialog').open) return;
    const target = choosing?.target; choosing = null;
    if (!dialog.open && target?.isConnected) target.focus({ preventScroll: true });
  });
  return { render, chosen, edit, select: id => { const rule = context().session?.snapshot.review.rules.find(rule => rule.id === id); if (rule) choose(rule); }, clear: () => { if (context().session) selected.delete(context().session); render(); onChoose(null); } };
}
