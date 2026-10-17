import selectiveEditor from '../modules/review/selective-editor-contract.json' with { type: 'json' };
import { assertSourceBinding } from '../modules/frontend/review-session.js';
import { prepareWithSegments, measureLineStats, measureNaturalWidth } from '@chenglou/pretext';

// Offsets stay on grapheme boundaries; joining successive pages recovers every byte.
export function contextTextPage(text, start, fits) {
  const ends = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text.slice(start))].map(part => start + part.index + part.segment.length);
  let low = 0, high = ends.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(text.slice(start, ends[middle - 1]))) low = middle;
    else high = middle - 1;
  }
  const end = low ? ends[low - 1] : start;
  return { text: text.slice(start, end), end };
}

export function assertContextShareReady(session, binding, { composing = false, closing = false, version = session.version } = {}) {
  assertSourceBinding(session, binding);
  if (closing || composing || session.version !== version || session.dirty || session.conflict || session.pending || session.uncertainMutation || session.unresolvedMove || session.reviewProblem || session.identityProblem) {
    throw { code: 'context_draft', message: 'Save manuscript drafts explicitly and resolve pending changes before sharing complete context. Sharing never saves or discards your text.' };
  }
}

export function validateContextPreview(preview, path) {
  if (!preview || preview.complete !== true || preview.snapshot !== 'saved' || typeof preview.scopeId !== 'string' || !/^[a-f0-9]{64}$/.test(preview.scopeId)
    || typeof preview.main !== 'string' || !Array.isArray(preview.files) || !preview.files.length || preview.files.length > 1000
    || !preview.files.every(file => typeof file.path === 'string' && file.path && file.path.length <= 4096 && typeof file.revision === 'string' && /^[a-f0-9]{64}$/.test(file.revision) && Number.isSafeInteger(file.sourceEpoch) && file.sourceEpoch >= 0)
    || new Set(preview.files.map(file => file.path)).size !== preview.files.length || !preview.files.some(file => file.path === path) || !preview.files.some(file => file.path === preview.main)) {
    throw { code: 'context_incomplete', message: 'Complete saved manuscript context could not be verified. No context sharing was enabled.' };
  }
  return preview;
}

export async function requestContextPreview(request, binding, assertCurrent) {
  for (let attempt = 0; ; attempt++) {
    assertCurrent();
    try {
      const preview = await request({ action: 'context_preview', ...binding });
      assertCurrent();
      return validateContextPreview(preview, binding.path);
    } catch (error) {
      if (attempt >= 3 || error.code !== 'busy' || error.message !== 'A local document operation is running. Retry this action.') throw error;
      await new Promise(resolve => setTimeout(resolve, 40 * (attempt + 1)));
    }
  }
}

export function setupContextSharing({ request }) {
  const $ = id => document.getElementById(id);
  const labels = selectiveEditor.labels;
  for (const [id, label] of [['context-share-title', labels.contextTitle], ['context-share-help', labels.contextHelp], ['context-share-snapshot', labels.savedSnapshot], ['context-share-files-label', labels.contextFiles], ['context-share-submit', labels.shareContextAction], ['context-share-cancel', labels.cancel]]) $(id).textContent = label;
  let pending = null, frame = 0;
  const dialog = $('context-share-dialog'), location = $('context-share-location'), content = $('context-share-content');
  const output = () => pending.sections[pending.section].kind === 'file' ? $('context-share-files').firstElementChild : $(pending.sections[pending.section].id);
  const schedule = () => {
    cancelAnimationFrame(frame);
    if (pending && dialog.open) { dialog.dataset.contextFit = 'measuring'; $('context-share-submit').disabled = true; frame = requestAnimationFrame(layout); }
  };
  const noFit = () => {
    dialog.dataset.contextFit = 'no-fit';
    location.hidden = true; $('context-share-pager').hidden = true;
    for (const id of ['context-share-help','context-share-snapshot','context-share-files','context-share-error']) $(id).hidden = true;
    $('context-share-title').textContent = 'Context';
    $('context-share-submit').textContent = 'Share';
    $('context-share-resize').hidden = false;
    $('context-share-submit').disabled = true;
    if (location === document.activeElement || $('context-share-pager').contains(document.activeElement)) $('context-share-cancel').focus();
  };
  function layout() {
    frame = 0;
    if (!pending || !dialog.open) return;
    dialog.dataset.contextFit = 'measuring';
    $('context-share-submit').disabled = true;
    location.hidden = false; $('context-share-pager').hidden = false; $('context-share-resize').hidden = true;
    $('context-share-title').textContent = labels.contextTitle;
    $('context-share-submit').textContent = labels.shareContextAction;
    frame = requestAnimationFrame(() => {
      if (!pending || !dialog.open) return;
      const line = parseFloat(getComputedStyle(content).lineHeight);
      try {
        const button=$('context-share-submit'), style=getComputedStyle(button);
        const text=prepareWithSegments(labels.shareContextAction,`${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`,{letterSpacing:parseFloat(style.letterSpacing)||0});
        if(measureNaturalWidth(text)>button.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight)-2) button.textContent='Share';
      } catch { $('context-share-submit').textContent='Share'; }
      if (content.clientHeight < line * 4) $('context-share-title').textContent = labels.shareContextAction;
      frame = requestAnimationFrame(renderPage);
    });
  }
  function renderPage() {
    frame = 0;
    if (!pending || !dialog.open) return;
    const captured = pending, section = pending.sections[pending.section];
    for (const id of ['context-share-help','context-share-snapshot','context-share-files','context-share-error']) $(id).hidden = id !== (section.kind === 'file' ? 'context-share-files' : section.id);
    const node = output(), style = getComputedStyle(node), width = content.clientWidth - 2, height = content.clientHeight - 2;
    const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4;
    if (width <= 0 || height < lineHeight) { noFit(); return; }
    const start = pending.offsets.at(-1), font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    let measured = true, page;
    try {
      const selectStyle = getComputedStyle(location);
      const selectFont = `${selectStyle.fontStyle} ${selectStyle.fontWeight} ${selectStyle.fontSize} ${selectStyle.fontFamily}`;
      const selection = prepareWithSegments(location.selectedOptions[0].textContent, selectFont, {letterSpacing:parseFloat(selectStyle.letterSpacing)||0});
      if (measureNaturalWidth(selection) > location.clientWidth - 40) { noFit(); return; }
      page = contextTextPage(section.text, start, text => {
        const stats = measureLineStats(prepareWithSegments(text, font, { whiteSpace: 'pre-wrap', letterSpacing: parseFloat(style.letterSpacing) || 0 }), width);
        return stats.maxLineWidth <= width && stats.lineCount * lineHeight <= height;
      });
      if (parseFloat(style.wordSpacing)) measured = false;
    } catch {
      measured = false;
      try { page = contextTextPage(section.text, start, text => text.length <= Math.max(1, Math.floor(width / parseFloat(style.fontSize)) * Math.floor(height / lineHeight))); }
      catch { noFit(); return; }
    }
    if (!page.text) { noFit(); return; }
    node.textContent = page.text; node.dataset.start = String(start); node.style.visibility = 'hidden';
    const verify = () => {
      if (pending !== captured || !dialog.open) return;
      if (node.scrollWidth > width + 2 || node.scrollHeight > height + 2) {
        const pieces = [...new Intl.Segmenter(undefined, {granularity:'grapheme'}).segment(page.text)];
        if (pieces.length <= 1) { node.style.visibility = ''; noFit(); return; }
        page.end = start + pieces[Math.floor(pieces.length / 2)].index;
        page.text = section.text.slice(start, page.end); node.textContent = page.text; measured = false;
        frame = requestAnimationFrame(verify); return;
      }
      node.style.visibility = ''; node.dataset.end = String(page.end);
      pending.end = page.end;
      dialog.dataset.contextFit = 'fit'; dialog.dataset.contextMeasurement = measured ? 'pretext' : 'dom-fallback';
      $('context-share-back').disabled = pending.section === 0 && start === 0;
      $('context-share-next').disabled = pending.section === pending.sections.length - 1 && page.end === section.text.length;
      $('context-share-submit').disabled = Boolean(pending.error);
    };
    frame = requestAnimationFrame(verify);
  }
  location.onchange = () => { if (pending) { pending.section = Number(location.value); pending.offsets = pending.pages[pending.section] = [0]; schedule(); } };
  $('context-share-back').onclick = () => {
    if (!pending || dialog.dataset.contextFit !== 'fit') return;
    if (pending.offsets.length > 1) pending.offsets.pop();
    else if (pending.section > 0) { pending.section--; pending.offsets = pending.pages[pending.section]; }
    location.value = String(pending.section); schedule();
  };
  $('context-share-next').onclick = () => {
    if (!pending || dialog.dataset.contextFit !== 'fit') return;
    if (pending.end < pending.sections[pending.section].text.length) pending.offsets.push(pending.end);
    else if (pending.section < pending.sections.length - 1) { pending.section++; pending.offsets = pending.pages[pending.section]; }
    location.value = String(pending.section); schedule();
  };
  new ResizeObserver(schedule).observe(dialog);
  const typography = new MutationObserver(schedule);
  typography.observe(document.documentElement, {attributes:true,attributeFilter:['style','class','lang']});
  typography.observe(document.head, {subtree:true,childList:true,characterData:true,attributes:true});
  document.fonts?.addEventListener('loadingdone', schedule);
  $('context-share-title').setAttribute('aria-label', labels.contextTitle);
  $('context-share-submit').setAttribute('aria-label', labels.shareContextAction);
  $('context-share-form').onsubmit = event => {
    event.preventDefault();
    if (!pending || dialog.dataset.contextFit !== 'fit' || pending.error) return;
    try {
      pending.assertCurrent();
      pending.approved = true;
      $('context-share-dialog').close();
    } catch (error) {
      pending.error = error.message || String(error);
      pending.sections.push({id:'context-share-error',label:'Sharing stopped',text:pending.error});
      const option = document.createElement('option'); option.value = String(pending.sections.length - 1); option.textContent = 'Sharing stopped'; location.append(option);
      pending.section = pending.sections.length - 1; pending.offsets = [0]; pending.pages.push(pending.offsets); location.value = String(pending.section); schedule();
    }
  };
  $('context-share-dialog').addEventListener('close', () => {
    const captured = pending;
    pending = null;
    cancelAnimationFrame(frame);
    captured?.resolve(captured.approved ? captured.preview : null);
  });
  return {
    async confirm({ binding, assertCurrent }) {
      if (pending) throw { code: 'busy', message: 'Finish the current context-sharing confirmation first.' };
      const preview = await requestContextPreview(request, binding, assertCurrent);
      await document.fonts?.ready; assertCurrent();
      const sections = [{id:'context-share-help',label:'Instructions',text:labels.contextHelp}, {id:'context-share-snapshot',label:'Snapshot',text:`${labels.savedSnapshot}\n${preview.main}`},
        ...preview.files.map((file,index)=>({kind:'file',label:`File ${index + 1}/${preview.files.length}`,text:file.path}))];
      location.replaceChildren(...sections.map((section,index)=>{
        const option=document.createElement('option');option.value=String(index);option.textContent=section.label;
        if(section.kind==='file') option.dataset.path=section.text;
        return option;
      }));
      const item=document.createElement('li'); $('context-share-files').replaceChildren(item);
      $('context-share-error').textContent = '';
      return new Promise(resolve => {
        const pages = sections.map(()=>[0]);
        pending = { preview, assertCurrent, resolve, approved: false, sections, section:0, offsets:pages[0], pages, end:0 };
        try { dialog.showModal(); $('context-share-cancel').focus(); schedule(); }
        catch (error) { pending = null; throw error; }
      });
    },
  };
}
