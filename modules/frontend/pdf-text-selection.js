export function setupPdfTextSelection({ scroller, pages, identity, onComplete }) {
  let drag = null;
  const caret = event => {
    const document = pages.ownerDocument;
    const position = document.caretPositionFromPoint?.(event.clientX, event.clientY);
    const range = !position && document.caretRangeFromPoint?.(event.clientX, event.clientY);
    const node = position?.offsetNode || range?.startContainer;
    const offset = position?.offset ?? range?.startOffset;
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    return node && pages.contains(node) && element?.closest('.pdf-text-layer') ? { node, offset } : null;
  };
  const extend = event => {
    if (!drag || drag.identity !== identity() || !pages.contains(drag.node)) return false;
    const end = caret(event);
    if (!end) return false;
    pages.ownerDocument.getSelection()?.setBaseAndExtent(drag.node, drag.offset, end.node, end.offset);
    return true;
  };
  const down = event => {
    if (event.button !== 0 || event.isPrimary === false || event.pointerType === 'touch'
      || !event.target.closest('.pdf-text-layer')) return;
    const start = caret(event), current = identity();
    if (!start || !current) return;
    event.preventDefault();
    scroller.focus({ preventScroll: true });
    drag = { ...start, identity: current, pointer: event.pointerId };
    scroller.setPointerCapture(event.pointerId);
    extend(event);
  };
  const move = event => {
    if (!drag || event.pointerId !== drag.pointer || !(event.buttons & 1)) return;
    event.preventDefault(); extend(event);
  };
  const finish = event => {
    if (!drag || event.pointerId !== drag.pointer) return;
    const current = drag.identity === identity() && pages.contains(drag.node);
    if (current) extend(event);
    drag = null;
    if (scroller.hasPointerCapture(event.pointerId)) scroller.releasePointerCapture(event.pointerId);
    if (current) onComplete();
  };
  const cancel = () => { drag = null; };
  scroller.addEventListener('pointerdown', down);
  scroller.addEventListener('pointermove', move);
  scroller.addEventListener('pointerup', finish);
  scroller.addEventListener('pointercancel', cancel);
  scroller.addEventListener('lostpointercapture', cancel);
  return () => {
    cancel();
    for (const [type, handler] of [['pointerdown', down], ['pointermove', move], ['pointerup', finish], ['pointercancel', cancel], ['lostpointercapture', cancel]]) scroller.removeEventListener(type, handler);
  };
}
