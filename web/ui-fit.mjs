import {
  layout,
  measureNaturalWidth,
  prepare,
  prepareWithSegments,
} from "./vendor/pretext/layout.js";

const preparedCache = new Map();
const fitted = new WeakMap();
const observed = new WeakSet();
const MAX_CACHE = 512;
const DEFAULT_MIN = 9;
const candidateSelector = [
  "[data-fit-text]",
  "button:not([data-fit='off'])",
  "select:not([data-fit='off'])",
  ".tab-label",
  ".save-state",
  ".panel-heading > strong",
  ".statusbar > span:not(.status-spacer)",
  ".github-panel-badge",
  ".github-dialog-badge",
].join(",");

let resizeObserver = null;
let pending = new Set();
let frame = 0;

function visibleText(element) {
  if (element.dataset.fitLabel) return element.dataset.fitLabel;
  if (element instanceof HTMLSelectElement) {
    return element.selectedOptions[0]?.textContent?.trim() || "";
  }
  const clone = element.cloneNode(true);
  clone.querySelectorAll("svg,img,.sr-only,[aria-hidden='true']").forEach((node) => node.remove());
  return clone.textContent.replace(/\s+/g, " ").trim();
}

function parsePixels(value, fallback = 0) {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number : fallback;
}

function fontString(style, size) {
  const fontStyle = style.fontStyle && style.fontStyle !== "normal" ? style.fontStyle + " " : "";
  const fontVariant = style.fontVariant && style.fontVariant !== "normal" ? style.fontVariant + " " : "";
  const fontWeight = style.fontWeight ? style.fontWeight + " " : "";
  return fontStyle + fontVariant + fontWeight + size + "px " + style.fontFamily;
}

function whiteSpaceOption(style) {
  return style.whiteSpace === "pre-wrap" ? "pre-wrap" : "normal";
}

function cachePrepared(text, font, whiteSpace, letterSpacing, segmented) {
  const key = (segmented ? "s" : "p") + "\u0000" + text + "\u0000" + font + "\u0000" + whiteSpace + "\u0000" + letterSpacing;
  if (preparedCache.has(key)) {
    const value = preparedCache.get(key);
    preparedCache.delete(key);
    preparedCache.set(key, value);
    return value;
  }
  const options = { whiteSpace, letterSpacing };
  const value = segmented
    ? prepareWithSegments(text, font, options)
    : prepare(text, font, options);
  preparedCache.set(key, value);
  while (preparedCache.size > MAX_CACHE) preparedCache.delete(preparedCache.keys().next().value);
  return value;
}

function reservedInline(element, style) {
  const explicit = Number(element.dataset.fitReserve);
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  const gap = parsePixels(style.columnGap || style.gap);
  const children = [...element.children].filter((child) =>
    child.matches("svg,img,.ui-icon-slot,.ui-chevron,.pdf-action-icon,.preview-find-icon,[aria-hidden='true']") &&
    !child.classList.contains("sr-only"));
  if (!children.length) return 0;
  return children.reduce((sum, child) => sum + child.getBoundingClientRect().width, 0)
    + gap * children.length;
}

function budget(element, style) {
  const width = element.clientWidth
    - parsePixels(style.paddingLeft)
    - parsePixels(style.paddingRight)
    - reservedInline(element, style);
  const height = element.clientHeight
    - parsePixels(style.paddingTop)
    - parsePixels(style.paddingBottom);
  return { width: Math.max(0, width), height: Math.max(0, height) };
}

function fitBounds(element, style) {
  let state = fitted.get(element);
  if (!state) {
    const base = parsePixels(style.fontSize, 12);
    state = { baseFontSize: base, lastText: "", lastWidth: -1, lastHeight: -1, lastSize: -1 };
    fitted.set(element, state);
  }
  const min = Math.max(7, Number(element.dataset.fitMin) || DEFAULT_MIN);
  const max = Math.max(min, Number(element.dataset.fitMax) || state.baseFontSize);
  return { min, max, state };
}

function candidateFits(element, text, style, size, width, height) {
  if (width <= 0 || height <= 0) return false;
  const font = fontString(style, size);
  const letterSpacing = parsePixels(style.letterSpacing);
  const currentFontSize = Math.max(1, parsePixels(style.fontSize, size));
  const lineRatio = Math.max(1, parsePixels(style.lineHeight, size * 1.2) / currentFontSize);
  const lineHeight = size * lineRatio;
  const whiteSpace = whiteSpaceOption(style);
  const noWrap = style.whiteSpace === "nowrap" || element instanceof HTMLSelectElement || element.tagName === "BUTTON";
  if (noWrap) {
    const prepared = cachePrepared(text, font, whiteSpace, letterSpacing, true);
    return measureNaturalWidth(prepared) <= width && lineHeight <= height;
  }
  const prepared = cachePrepared(text, font, whiteSpace, letterSpacing, false);
  const result = layout(prepared, width, lineHeight);
  const maxLines = Number(element.dataset.fitLines) || Math.max(1, Math.floor(height / lineHeight));
  return result.height <= height && result.lineCount <= maxLines;
}

function fitElement(element) {
  if (!(element instanceof HTMLElement) || element.hidden || element.closest(".preview-text-layer")) return;
  const text = visibleText(element);
  if (!text) return;
  const style = getComputedStyle(element);
  const box = budget(element, style);
  if (box.width <= 0 || box.height <= 0) return;
  const bounds = fitBounds(element, style);
  const state = bounds.state;
  if (state.lastText === text && state.lastWidth === box.width && state.lastHeight === box.height) return;

  let low = bounds.min;
  let high = bounds.max;
  let best = bounds.min;
  for (let iteration = 0; iteration < 8 && high - low > 0.2; iteration += 1) {
    const middle = (low + high) / 2;
    if (candidateFits(element, text, style, middle, box.width, box.height)) {
      best = middle;
      low = middle;
    } else {
      high = middle;
    }
  }
  if (!candidateFits(element, text, style, best, box.width, box.height)) best = bounds.min;
  best = Math.round(best * 4) / 4;
  if (state.lastSize !== best) element.style.fontSize = best + "px";
  state.lastText = text;
  state.lastWidth = box.width;
  state.lastHeight = box.height;
  state.lastSize = best;
}

function flush() {
  frame = 0;
  const elements = [...pending];
  pending.clear();
  for (const element of elements) fitElement(element);
}

function schedule(element) {
  if (!(element instanceof HTMLElement)) return;
  pending.add(element);
  if (!frame) frame = requestAnimationFrame(flush);
}

function observe(element) {
  if (!(element instanceof HTMLElement) || observed.has(element)) return;
  const text = visibleText(element);
  if (!text) return;
  observed.add(element);
  resizeObserver.observe(element);
  schedule(element);
}

function scan(root = document) {
  if (root instanceof HTMLElement && root.matches(candidateSelector)) observe(root);
  root.querySelectorAll?.(candidateSelector).forEach(observe);
}

function initialize() {
  resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) schedule(entry.target);
  });
  scan();
  const mutationObserver = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "childList") {
        record.addedNodes.forEach((node) => node.nodeType === 1 && scan(node));
        const owner = record.target instanceof HTMLElement ? record.target.closest(candidateSelector) : null;
        if (owner) schedule(owner);
      } else if (record.type === "characterData") {
        const owner = record.target.parentElement?.closest(candidateSelector);
        if (owner) schedule(owner);
      } else if (record.target instanceof HTMLElement) {
        const owner = record.target.closest(candidateSelector);
        if (owner) {
          const state = fitted.get(owner);
          if (state) {
            state.lastText = "";
            state.lastWidth = -1;
          }
          schedule(owner);
        }
      }
    }
  });
  mutationObserver.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class", "lang", "dir", "data-fit-label"],
  });
  document.fonts?.ready?.then(() => {
    document.querySelectorAll(candidateSelector).forEach((element) => {
      const state = fitted.get(element);
      if (state) {
        state.lastText = "";
        state.lastWidth = -1;
      }
      schedule(element);
    });
  });
  window.UnderTreeFit = { schedule, scan };
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initialize, { once: true });
} else {
  initialize();
}
