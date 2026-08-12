const MM_PER_CSS_PX = 25.4 / 96;

function computedStyle(element) {
  return element.ownerDocument.defaultView.getComputedStyle(element);
}

function numberAttribute(element, name, fallback) {
  const value = Number.parseFloat(element.getAttribute(name));
  return Number.isFinite(value) ? value : fallback;
}

function cssFont(element, size) {
  const style = computedStyle(element);
  return `${style.fontStyle} ${style.fontWeight} ${size}px ${style.fontFamily}`;
}

function inlineItems(block, size) {
  const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  const items = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.nodeValue) continue;
    const parent = node.parentElement || block;
    const style = computedStyle(parent);
    items.push({
      text: node.nodeValue,
      font: `${style.fontStyle} ${style.fontWeight} ${size}px ${style.fontFamily}`,
      letterSpacing: Number.parseFloat(style.letterSpacing) || 0,
    });
  }
  return items.length ? items : [{ text: block.textContent || "", font: cssFont(block, size) }];
}

function contentBlocks(element) {
  const selector = ":scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6, :scope > p, :scope > ul, :scope > ol, :scope > li";
  const direct = [...element.querySelectorAll(selector)];
  const editor = element.querySelector(":scope > .ProseMirror");
  const blocks = direct.length ? direct : editor ? [...editor.querySelectorAll(selector)] : [];
  return blocks.length ? blocks : [element];
}

function prediction(element, size, lineHeight, gap, pretextRich) {
  const style = computedStyle(element);
  const availableWidth = Math.max(1, element.clientWidth - (Number.parseFloat(style.paddingLeft) || 0) - (Number.parseFloat(style.paddingRight) || 0));
  let height = 0;
  let lines = 0;
  const blocks = contentBlocks(element);
  for (const block of blocks) {
    const prepared = pretextRich.prepareRichInline(inlineItems(block, size));
    const stats = pretextRich.measureRichInlineStats(prepared, availableWidth);
    const count = Math.max(1, stats.lineCount);
    height += count * lineHeight;
    lines += count;
  }
  height += Math.max(0, blocks.length - 1) * gap;
  return { height, lines };
}

function setFit(element, values) {
  element.style.setProperty("--ut-fit-font-size", `${values.fontSize.toFixed(2)}px`);
  element.style.setProperty("--ut-fit-line-height", `${values.lineHeight.toFixed(2)}px`);
  element.style.setProperty("--ut-fit-gap", `${values.gap.toFixed(2)}px`);
  element.style.fontSize = "var(--ut-fit-font-size)";
  element.style.lineHeight = "var(--ut-fit-line-height)";
  element.style.gap = "var(--ut-fit-gap)";
}

function actualFits(element) {
  return element.scrollWidth <= element.clientWidth + 0.5 && element.scrollHeight <= element.clientHeight + 0.5;
}

function bounds(element) {
  const computed = computedStyle(element);
  const current = Number.parseFloat(computed.fontSize) || 14;
  const minFont = numberAttribute(element, "data-ut-fit-min-font", Math.max(7, current * 0.72));
  const maxFont = numberAttribute(element, "data-ut-fit-max-font", current);
  const minLeading = numberAttribute(element, "data-ut-fit-min-leading", 1.05);
  const maxLeading = numberAttribute(element, "data-ut-fit-max-leading", 1.35);
  const minGap = numberAttribute(element, "data-ut-fit-min-gap", 0);
  const maxGap = numberAttribute(element, "data-ut-fit-max-gap", Number.parseFloat(computed.gap) || 8);
  return { minFont, maxFont, minLeading, maxLeading, minGap, maxGap };
}

function predictedFits(element, values, pretextRich) {
  const style = computedStyle(element);
  const availableHeight = element.clientHeight - (Number.parseFloat(style.paddingTop) || 0) - (Number.parseFloat(style.paddingBottom) || 0);
  const predicted = prediction(element, values.fontSize, values.lineHeight, values.gap, pretextRich).height <= availableHeight + 0.25;
  setFit(element, values);
  return predicted && actualFits(element);
}

function candidate(element, fontSize, pretextRich) {
  const range = bounds(element);
  let low = range.minLeading;
  let high = range.maxLeading;
  let leading = low;
  for (let iteration = 0; iteration < 10; iteration += 1) {
    const test = (low + high) / 2;
    const values = { fontSize, lineHeight: fontSize * test, gap: range.minGap };
    if (predictedFits(element, values, pretextRich)) {
      leading = test;
      low = test;
    } else high = test;
  }
  const lineHeight = fontSize * leading;
  let gapLow = range.minGap;
  let gapHigh = range.maxGap;
  let gap = gapLow;
  for (let iteration = 0; iteration < 10; iteration += 1) {
    const test = (gapLow + gapHigh) / 2;
    const values = { fontSize, lineHeight, gap: test };
    if (predictedFits(element, values, pretextRich)) {
      gap = test;
      gapLow = test;
    } else gapHigh = test;
  }
  return { fontSize, lineHeight, gap };
}

function largestShared(elements, pretextRich) {
  const ranges = elements.map(bounds);
  let low = Math.max(...ranges.map((range) => range.minFont));
  let high = Math.min(...ranges.map((range) => range.maxFont));
  let selected = low;
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const fontSize = (low + high) / 2;
    const fits = elements.every((element) => predictedFits(element, candidate(element, fontSize, pretextRich), pretextRich));
    if (fits) {
      selected = fontSize;
      low = fontSize;
    } else high = fontSize;
  }
  return selected;
}

async function waitForAssets(document, timeoutMs = 10000) {
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Fonts or images did not load before the print timeout.")), timeoutMs));
  const fonts = document.fonts?.ready || Promise.resolve();
  const images = [...document.images].map((image) => image.complete
    ? (image.naturalWidth ? Promise.resolve() : Promise.reject(new Error(`Image failed to load: ${image.currentSrc || image.src}`)))
    : new Promise((resolve, reject) => {
      image.addEventListener("load", resolve, { once: true });
      image.addEventListener("error", () => reject(new Error(`Image failed to load: ${image.currentSrc || image.src}`)), { once: true });
    }));
  await Promise.race([Promise.all([fonts, ...images]), timeout]);
}

export async function fitPrintDocument(document, { pretextRich, timeoutMs = 10000 } = {}) {
  if (!pretextRich?.prepareRichInline || !pretextRich?.measureRichInlineStats) throw new Error("The bundled Pretext rich-inline runtime is unavailable.");
  await waitForAssets(document, timeoutMs);
  const elements = [...document.querySelectorAll('[data-ut-fit="pretext"]')];
  const grouped = new Map();
  for (const element of elements) {
    const name = element.getAttribute("data-ut-fit-group") || `__${element.getAttribute("data-ut-id")}`;
    if (!grouped.has(name)) grouped.set(name, []);
    grouped.get(name).push(element);
  }
  const resolved = [];
  const diagnostics = [];
  for (const members of grouped.values()) {
    const fontSize = largestShared(members, pretextRich);
    for (const element of members) {
      const values = candidate(element, fontSize, pretextRich);
      setFit(element, values);
      resolved.push({ dataUtId: element.getAttribute("data-ut-id") || "", ...values });
    }
  }
  const view = document.defaultView;
  await new Promise((resolve) => view.requestAnimationFrame(() => view.requestAnimationFrame(resolve)));
  for (const element of elements) {
    if (!actualFits(element)) diagnostics.push({
      code: "overflow",
      message: "Content still overflows at the minimum permitted fit settings.",
      dataUtId: element.getAttribute("data-ut-id") || "",
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    });
  }
  return { resolved, diagnostics };
}

function rounded(value) {
  return Math.round(value * 1000) / 1000;
}

function relativeRect(rect, pageRect) {
  return {
    xMm: rounded((rect.left - pageRect.left) * MM_PER_CSS_PX),
    yMm: rounded((rect.top - pageRect.top) * MM_PER_CSS_PX),
    widthMm: rounded(rect.width * MM_PER_CSS_PX),
    heightMm: rounded(rect.height * MM_PER_CSS_PX),
  };
}

function pageFor(element, pages) {
  return pages.findIndex((page) => page === element || page.contains(element));
}

function lineFragments(document, pages) {
  const fragments = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.nodeValue?.trim() || node.parentElement?.closest("style,script")) continue;
    const owner = node.parentElement;
    const pageIndex = pageFor(owner, pages);
    if (pageIndex < 0) continue;
    const pageRect = pages[pageIndex].getBoundingClientRect();
    const style = computedStyle(owner);
    let current = null;
    for (let index = 0; index < node.nodeValue.length; index += 1) {
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + 1);
      const clientRects = [...range.getClientRects()];
      const rect = clientRects.at(-1) || range.getBoundingClientRect();
      if (!rect.width && !rect.height) continue;
      if (!current || Math.abs(current.top - rect.top) > 0.75) {
        if (current) fragments.push(current);
        current = {
          page: pageIndex + 1,
          dataUtId: owner.closest("[data-ut-id]")?.getAttribute("data-ut-id") || "",
          text: "",
          top: rect.top,
          rect: relativeRect(rect, pageRect),
          fontFamily: style.fontFamily,
          fontSizePx: Number.parseFloat(style.fontSize),
          fontWeight: style.fontWeight,
          fontStyle: style.fontStyle,
          color: style.color,
          link: owner.closest("a")?.href || "",
        };
      }
      current.text += node.nodeValue[index];
      const right = (rect.right - pageRect.left) * MM_PER_CSS_PX;
      current.rect.widthMm = rounded(Math.max(current.rect.widthMm, right - current.rect.xMm));
      current.rect.heightMm = rounded(Math.max(current.rect.heightMm, rect.height * MM_PER_CSS_PX));
    }
    if (current) fragments.push(current);
  }
  return fragments.map(({ top, ...fragment }) => fragment).filter((fragment) => fragment.text.trim());
}

function listMarkerFragments(document, pages) {
  return [...document.querySelectorAll("li")].flatMap((element) => {
    const style = computedStyle(element);
    if (style.listStyleType === "none") return [];
    const pageIndex = pageFor(element, pages);
    const pageRect = pages[pageIndex].getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    const ordered = element.parentElement?.tagName === "OL";
    const siblings = ordered ? [...element.parentElement.children].filter((child) => child.tagName === "LI") : [];
    const text = ordered ? `${siblings.indexOf(element) + 1}.` : "•";
    return [{
      page: pageIndex + 1,
      dataUtId: element.closest("[data-ut-id]")?.getAttribute("data-ut-id") || "",
      text,
      rect: {
        xMm: rounded((rect.left - pageRect.left) * MM_PER_CSS_PX - 3.2),
        yMm: rounded((rect.top - pageRect.top) * MM_PER_CSS_PX),
        widthMm: 2.8,
        heightMm: rounded(Number.parseFloat(style.lineHeight) * MM_PER_CSS_PX),
      },
      fontSizePx: Number.parseFloat(style.fontSize),
      fontWeight: style.fontWeight,
      fontStyle: style.fontStyle,
      color: style.color,
      link: "",
    }];
  });
}

function renderedImageRect(element) {
  const rect = element.getBoundingClientRect();
  const style = computedStyle(element);
  const naturalWidth = element.naturalWidth || rect.width;
  const naturalHeight = element.naturalHeight || rect.height;
  if (style.objectFit !== "contain" || !naturalWidth || !naturalHeight) return rect;
  const scale = Math.min(rect.width / naturalWidth, rect.height / naturalHeight);
  const width = naturalWidth * scale;
  const height = naturalHeight * scale;
  const left = rect.left + (rect.width - width) / 2;
  const top = rect.top + (rect.height - height) / 2;
  return { left, top, right: left + width, bottom: top + height, width, height };
}

export function captureLayoutManifest(document, fitResult = {}) {
  const pages = [...document.querySelectorAll("[data-ut-page]")];
  const pageRects = pages.map((page) => page.getBoundingClientRect());
  const objects = [...document.querySelectorAll("[data-ut-id]")].map((element) => {
    const pageIndex = pageFor(element, pages);
    const style = computedStyle(element);
    return {
      page: pageIndex + 1,
      dataUtId: element.getAttribute("data-ut-id"),
      tag: element.tagName.toLocaleLowerCase(),
      rect: relativeRect(element.getBoundingClientRect(), pageRects[pageIndex]),
      backgroundColor: style.backgroundColor,
      color: style.color,
      borderColor: style.borderColor,
      borderWidthPx: Number.parseFloat(style.borderTopWidth) || 0,
      borderRadiusPx: Number.parseFloat(style.borderTopLeftRadius) || 0,
      textAlign: style.textAlign,
    };
  });
  const images = [...document.images].map((element) => {
    const pageIndex = pageFor(element, pages);
    return {
      page: pageIndex + 1,
      dataUtId: element.closest("[data-ut-id]")?.getAttribute("data-ut-id") || "",
      rect: relativeRect(renderedImageRect(element), pageRects[pageIndex]),
      src: element.getAttribute("src") || "",
      texSrc: element.getAttribute("data-ut-tex-src") || "",
      alt: element.getAttribute("alt") || "",
    };
  });
  return {
    profileVersion: document.documentElement.getAttribute("data-ut-print-profile"),
    site: document.documentElement.getAttribute("data-ut-site") || "",
    userAgent: navigator.userAgent,
    viewport: { width: innerWidth, height: innerHeight },
    pages: pages.map((element, index) => ({
      number: index + 1,
      dataUtId: element.getAttribute("data-ut-id") || "",
      size: element.getAttribute("data-ut-size"),
      orientation: element.getAttribute("data-ut-orientation"),
      rect: relativeRect(element.getBoundingClientRect(), pageRects[index]),
    })),
    objects,
    images,
    lines: [...lineFragments(document, pages), ...listMarkerFragments(document, pages)],
    resolvedFits: fitResult.resolved || [],
    diagnostics: fitResult.diagnostics || [],
  };
}
