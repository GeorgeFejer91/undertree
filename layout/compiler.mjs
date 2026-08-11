#!/usr/bin/env node
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { XMLParser, XMLValidator } from "fast-xml-parser";

const PT_PER_MM = 72.27 / 25.4;
const PAGE_SIZES = {
  A4: { width: 210, height: 297 },
  letter: { width: 215.9, height: 279.4 },
};
const BLOCK_TAGS = new Set(["heading", "p", "list", "image", "label", "rule", "spacer"]);
const INLINE_TAGS = new Set(["strong", "em", "code", "link", "br"]);

export class LayoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "LayoutError";
  }
}

function fail(message) {
  throw new LayoutError(message);
}

function attributes(node) {
  return node?.[":@"] || {};
}

function elementEntries(children = []) {
  return children.flatMap((node) => Object.keys(node).filter((key) => key !== ":@" && key !== "#text" && !key.startsWith("?")).map((tag) => ({ tag, children: node[tag] || [], attrs: attributes(node) })));
}

function childElements(node, tag) {
  return elementEntries(node?.children || node).filter((entry) => !tag || entry.tag === tag);
}

function firstElement(children, tag, context) {
  const matches = elementEntries(children).filter((entry) => entry.tag === tag);
  if (matches.length !== 1) fail(`${context} must contain exactly one <${tag}> element.`);
  return matches[0];
}

function collapseText(value) {
  return String(value || "").replace(/\s+/g, " ");
}

function parseLength(value, context, fallback = null) {
  if ((value === undefined || value === "") && fallback !== null) return fallback;
  const match = String(value ?? "").trim().match(/^(-?(?:\d+\.?\d*|\.\d+))(mm|cm|in|pt)?$/i);
  if (!match) fail(`${context} must be a physical length such as 12mm or 9pt.`);
  const amount = Number(match[1]);
  const unit = (match[2] || "mm").toLowerCase();
  const mm = unit === "mm" ? amount : unit === "cm" ? amount * 10 : unit === "in" ? amount * 25.4 : amount / PT_PER_MM;
  if (!Number.isFinite(mm) || mm < 0) fail(`${context} must be a non-negative physical length.`);
  return mm;
}

function parseFontSize(value, context, fallback) {
  if (value === undefined || value === "") return fallback;
  const match = String(value).trim().match(/^(\d+(?:\.\d+)?)(pt)?$/i);
  if (!match || Number(match[1]) <= 0) fail(`${context} must be a positive point size, for example 8.5pt.`);
  return Number(match[1]);
}

function parsePositiveInteger(value, context, fallback = 1) {
  if (value === undefined || value === "") return fallback;
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1) fail(`${context} must be a positive integer.`);
  return result;
}

function safeColor(value, context, fallback) {
  const color = value || fallback;
  if (!/^(?:#[0-9a-f]{3,8}|[a-z]+)$/i.test(color)) fail(`${context} is not a supported color.`);
  return color;
}

function parseTracks(specification, available, gap, context) {
  const tokens = String(specification || "1fr").trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) fail(`${context} must define at least one track.`);
  const parsed = tokens.map((token) => {
    const fraction = token.match(/^(\d+(?:\.\d+)?)fr$/i);
    if (fraction) return { fraction: Number(fraction[1]), fixed: 0 };
    return { fraction: 0, fixed: parseLength(token, context) };
  });
  const distributable = available - gap * (parsed.length - 1) - parsed.reduce((sum, track) => sum + track.fixed, 0);
  const fractionTotal = parsed.reduce((sum, track) => sum + track.fraction, 0);
  if (distributable < -0.001) {
    fail(`${context} does not fit inside the page's available space.`);
  }
  return parsed.map((track) => track.fixed || (fractionTotal ? (distributable * track.fraction) / fractionTotal : 0));
}

function positions(tracks, start, gap) {
  const result = [];
  let cursor = start;
  tracks.forEach((size) => {
    result.push(cursor);
    cursor += size + gap;
  });
  return result;
}

function parseInline(children, context) {
  return (children || []).map((node) => {
    if (Object.hasOwn(node, "#text")) return { type: "text", value: node["#text"] };
    const entries = elementEntries([node]);
    if (entries.length !== 1 || !INLINE_TAGS.has(entries[0].tag)) {
      fail(`${context} contains an unsupported inline element.`);
    }
    const entry = entries[0];
    if (entry.tag === "link" && !entry.attrs.href) fail(`${context} has a <link> without href.`);
    return { type: entry.tag, attrs: entry.attrs, children: parseInline(entry.children, context) };
  });
}

function parseBlocks(children, context) {
  const entries = elementEntries(children);
  return entries.map((entry) => {
    if (!BLOCK_TAGS.has(entry.tag)) fail(`${context} contains unsupported block <${entry.tag}>.`);
    if (["heading", "p", "label"].includes(entry.tag)) {
      if (entry.attrs.scale !== undefined && (!Number.isFinite(Number(entry.attrs.scale)) || Number(entry.attrs.scale) <= 0 || Number(entry.attrs.scale) > 4)) fail(`${context} <${entry.tag}> scale must be between 0 and 4.`);
      if (entry.attrs.leading !== undefined && (!Number.isFinite(Number(entry.attrs.leading)) || Number(entry.attrs.leading) <= 0 || Number(entry.attrs.leading) > 5)) fail(`${context} <${entry.tag}> leading must be between 0 and 5.`);
      if (entry.attrs.color) entry.attrs.color = safeColor(entry.attrs.color, `${context} <${entry.tag}> color`, "#172b36");
      return { type: entry.tag, attrs: entry.attrs, children: parseInline(entry.children, `${context} <${entry.tag}>`) };
    }
    if (entry.tag === "list") {
      const items = elementEntries(entry.children);
      if (!items.length || items.some((item) => item.tag !== "item")) fail(`${context} <list> must contain one or more <item> elements.`);
      return { type: "list", attrs: entry.attrs, items: items.map((item) => parseInline(item.children, `${context} list item`)) };
    }
    if (entry.tag === "image") {
      if (!entry.attrs.src) fail(`${context} <image> requires src.`);
      return { type: "image", attrs: entry.attrs };
    }
    return { type: entry.tag, attrs: entry.attrs };
  });
}

function parsePage(pageEntry, pageIndex) {
  const attrs = pageEntry.attrs;
  const namedSize = PAGE_SIZES[attrs.size || "A4"];
  const width = attrs.width ? parseLength(attrs.width, `page ${pageIndex} width`) : namedSize?.width;
  const height = attrs.height ? parseLength(attrs.height, `page ${pageIndex} height`) : namedSize?.height;
  if (!width || !height) fail(`Page ${pageIndex} needs a known size or explicit width and height.`);
  const margin = parseLength(attrs.margin, `page ${pageIndex} margin`, 10);
  const grid = firstElement(pageEntry.children, "grid", `Page ${pageIndex}`);
  const gap = parseLength(grid.attrs.gap, `page ${pageIndex} grid gap`, 3);
  const usableWidth = width - margin * 2;
  const usableHeight = height - margin * 2;
  if (usableWidth <= 0 || usableHeight <= 0) fail(`Page ${pageIndex} margins leave no usable area.`);

  const boxEntries = elementEntries(grid.children);
  if (!boxEntries.length || boxEntries.some((entry) => entry.tag !== "box")) fail(`Page ${pageIndex} <grid> must contain one or more <box> elements.`);
  const requestedRows = Math.max(...boxEntries.map((entry, index) => parsePositiveInteger(entry.attrs.row, `box ${entry.attrs.id || index + 1} row`, Math.floor(index / String(grid.attrs.columns || "1fr").trim().split(/\s+/).length) + 1) + parsePositiveInteger(entry.attrs["row-span"], `box ${entry.attrs.id || index + 1} row-span`) - 1));
  const columnSpec = grid.attrs.columns || "1fr";
  const columnCount = columnSpec.trim().split(/\s+/).length;
  const rowSpec = grid.attrs.rows || Array.from({ length: requestedRows }, () => "1fr").join(" ");
  const columns = parseTracks(columnSpec, usableWidth, gap, `page ${pageIndex} columns`);
  const rows = parseTracks(rowSpec, usableHeight, gap, `page ${pageIndex} rows`);
  const columnPositions = positions(columns, margin, gap);
  const rowPositions = positions(rows, margin, gap);
  const occupied = new Set();
  const ids = new Set();

  const boxes = boxEntries.map((entry, index) => {
    const id = entry.attrs.id || `box-${pageIndex}-${index + 1}`;
    if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(id)) fail(`Box id “${id}” is invalid.`);
    if (ids.has(id)) fail(`Page ${pageIndex} repeats box id “${id}”.`);
    ids.add(id);
    const column = parsePositiveInteger(entry.attrs.column, `${id} column`, (index % columnCount) + 1);
    const row = parsePositiveInteger(entry.attrs.row, `${id} row`, Math.floor(index / columnCount) + 1);
    const columnSpan = parsePositiveInteger(entry.attrs["column-span"], `${id} column-span`);
    const rowSpan = parsePositiveInteger(entry.attrs["row-span"], `${id} row-span`);
    if (column + columnSpan - 1 > columns.length || row + rowSpan - 1 > rows.length) fail(`Box “${id}” extends beyond its grid.`);
    for (let r = row; r < row + rowSpan; r += 1) {
      for (let c = column; c < column + columnSpan; c += 1) {
        const cell = `${r}:${c}`;
        if (occupied.has(cell)) fail(`Box “${id}” overlaps another box at grid cell ${cell}.`);
        occupied.add(cell);
      }
    }
    const padding = parseLength(entry.attrs.padding, `${id} padding`, 3);
    const maxFontSize = parseFontSize(entry.attrs["max-font-size"], `${id} max-font-size`, 11);
    const minFontSize = parseFontSize(entry.attrs["min-font-size"], `${id} min-font-size`, 8.5);
    if (minFontSize > maxFontSize) fail(`Box “${id}” minimum font size exceeds its maximum.`);
    const widthMm = columns.slice(column - 1, column - 1 + columnSpan).reduce((sum, value) => sum + value, 0) + gap * (columnSpan - 1);
    const heightMm = rows.slice(row - 1, row - 1 + rowSpan).reduce((sum, value) => sum + value, 0) + gap * (rowSpan - 1);
    if (padding * 2 >= widthMm || padding * 2 >= heightMm) fail(`Box “${id}” padding leaves no content area.`);
    return {
      id,
      x: columnPositions[column - 1],
      y: rowPositions[row - 1],
      width: widthMm,
      height: heightMm,
      padding,
      background: safeColor(entry.attrs.background, `${id} background`, "#ffffff"),
      color: safeColor(entry.attrs.color, `${id} color`, "#172b36"),
      headingColor: safeColor(entry.attrs["heading-color"], `${id} heading-color`, entry.attrs.color || "#172b36"),
      borderColor: safeColor(entry.attrs["border-color"], `${id} border-color`, "#c7d5dc"),
      borderWidth: parseLength(entry.attrs["border-width"], `${id} border-width`, 0.35),
      radius: parseLength(entry.attrs.radius, `${id} radius`, 2),
      minFontSize,
      maxFontSize,
      minLineHeight: Number(entry.attrs["min-line-height"] || 1.05),
      maxLineHeight: Number(entry.attrs["max-line-height"] || 1.24),
      minGap: parseLength(entry.attrs["min-gap"], `${id} min-gap`, 0.8),
      maxGap: parseLength(entry.attrs["max-gap"], `${id} max-gap`, 2.2),
      valign: ["top", "center", "distribute"].includes(entry.attrs.valign) ? entry.attrs.valign : "distribute",
      blocks: parseBlocks(entry.children, `Box “${id}”`),
    };
  });
  boxes.forEach((box) => {
    if (!Number.isFinite(box.minLineHeight) || !Number.isFinite(box.maxLineHeight) || box.minLineHeight <= 0 || box.maxLineHeight < box.minLineHeight) fail(`Box “${box.id}” has invalid line-height bounds.`);
    if (box.maxGap < box.minGap) fail(`Box “${box.id}” maximum gap is smaller than its minimum gap.`);
  });
  return { width, height, background: safeColor(attrs.background, `page ${pageIndex} background`, "#ffffff"), boxes };
}

export function parseLayout(xml, sourcePath = "layout.xml") {
  const validation = XMLValidator.validate(xml);
  if (validation !== true) fail(`${sourcePath}:${validation.err.line}:${validation.err.col}: ${validation.err.msg}`);
  const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", preserveOrder: true, trimValues: false, parseTagValue: false }).parse(xml);
  const roots = elementEntries(parsed);
  if (roots.length !== 1 || roots[0].tag !== "layout-document") fail(`${sourcePath} must have one <layout-document> root.`);
  const root = roots[0];
  if (String(root.attrs.version || "") !== "1") fail(`${sourcePath} must declare <layout-document version="1">.`);
  const pages = elementEntries(root.children);
  if (!pages.length || pages.some((entry) => entry.tag !== "page")) fail(`${sourcePath} must contain one or more <page> elements.`);
  return {
    title: root.attrs.title || basename(sourcePath, extname(sourcePath)),
    lang: root.attrs.lang || "en",
    pages: pages.map((page, index) => parsePage(page, index + 1)),
  };
}

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function renderHtmlInline(nodes) {
  return nodes.map((node) => {
    if (node.type === "text") return htmlEscape(node.value);
    if (node.type === "br") return "<br>";
    const inner = renderHtmlInline(node.children || []);
    if (node.type === "strong") return `<strong>${inner}</strong>`;
    if (node.type === "em") return `<em>${inner}</em>`;
    if (node.type === "code") return `<code>${inner}</code>`;
    if (node.type === "link") return `<a href="${htmlEscape(node.attrs.href)}">${inner}</a>`;
    return inner;
  }).join("");
}

function renderHtmlBlock(block) {
  const defaultScale = block.type === "heading" ? 1.22 : block.type === "label" ? 0.78 : 1;
  const scale = Number(block.attrs?.scale || defaultScale);
  const leading = Number(block.attrs?.leading || (block.type === "heading" ? scale * 1.1 : block.type === "label" ? scale * 1.14 : 1.2));
  const blockStyle = `font-size:${scale}em;line-height:${leading};${block.attrs?.color ? `color:${block.attrs.color};` : ""}`;
  if (block.type === "heading") return `<h2 style="${blockStyle}">${renderHtmlInline(block.children)}</h2>`;
  if (block.type === "p") return `<p style="${blockStyle}">${renderHtmlInline(block.children)}</p>`;
  if (block.type === "label") return `<div class="label" style="${blockStyle}">${renderHtmlInline(block.children)}</div>`;
  if (block.type === "list") return `<ul>${block.items.map((item) => `<li>${renderHtmlInline(item)}</li>`).join("")}</ul>`;
  if (block.type === "image") return `<figure><img src="${htmlEscape(block.dataUri || block.attrs.src)}" alt="${htmlEscape(block.attrs.alt || "")}" style="${block.attrs.width ? `width:${htmlEscape(block.attrs.width)};` : ""}max-height:${htmlEscape(block.attrs.height || "28mm")}">${block.attrs.caption ? `<figcaption>${htmlEscape(block.attrs.caption)}</figcaption>` : ""}</figure>`;
  if (block.type === "rule") return "<hr>";
  if (block.type === "spacer") return `<div class="spacer" style="height:${htmlEscape(block.attrs.height || "1mm")}"></div>`;
  return "";
}

function num(value) {
  return Number(value.toFixed(4));
}

export function renderHtml(model) {
  const printPage = model.pages[0];
  const pages = model.pages.map((page, pageIndex) => `<section class="page" data-page="${pageIndex + 1}" style="--page-width:${num(page.width)}mm;--page-height:${num(page.height)}mm;background:${page.background}">${page.boxes.map((box) => `<article class="layout-box" id="${htmlEscape(box.id)}" data-fit data-min-font="${box.minFontSize}" data-max-font="${box.maxFontSize}" data-min-leading="${box.minLineHeight}" data-max-leading="${box.maxLineHeight}" data-min-gap="${num(box.minGap)}" data-max-gap="${num(box.maxGap)}" data-valign="${box.valign}" style="--heading-color:${box.headingColor};left:${num(box.x)}mm;top:${num(box.y)}mm;width:${num(box.width)}mm;height:${num(box.height)}mm;padding:${num(box.padding)}mm;background:${box.background};color:${box.color};border:${num(box.borderWidth)}mm solid ${box.borderColor};border-radius:${num(box.radius)}mm"><div class="box-content">${box.blocks.map(renderHtmlBlock).join("")}</div></article>`).join("")}</section>`).join("");
  return `<!doctype html>
<html lang="${htmlEscape(model.lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(model.title)}</title>
<style>
@page{size:${num(printPage.width)}mm ${num(printPage.height)}mm;margin:0}*{box-sizing:border-box}html,body{margin:0;background:#59636e;font-family:"Noto Sans",Arial,sans-serif;color:#172b36}body{padding:14mm 0}.controls{position:fixed;right:18px;top:18px;z-index:10;display:flex;gap:8px}.controls button{border:0;border-radius:999px;padding:9px 15px;background:#098842;color:white;font:700 14px system-ui;box-shadow:0 2px 12px #0004;cursor:pointer}.page{position:relative;width:var(--page-width);height:var(--page-height);margin:0 auto 12mm;overflow:hidden;box-shadow:0 4px 24px #0006;break-after:page}.layout-box{position:absolute;overflow:hidden}.box-content{width:100%;height:100%;overflow:hidden;font-size:var(--fit-font,11pt);line-height:var(--fit-leading,1.2);display:flex;flex-direction:column;justify-content:flex-start;gap:var(--fit-gap,.8mm)}.layout-box[data-valign="center"] .box-content{justify-content:center}.layout-box[data-valign="distribute"] .box-content{justify-content:space-between}.box-content>*{min-width:0;margin:0}.box-content h2{font-size:1.22em;line-height:1.08;color:var(--heading-color,currentColor)}.box-content p,.box-content li{hyphens:auto}.box-content ul{padding-left:1.25em}.box-content li+li{margin-top:.25em}.box-content a{color:#006c76}.box-content code{font-family:ui-monospace,monospace;font-size:.92em}.box-content figure{display:flex;min-height:0;align-items:center;justify-content:center;flex-direction:column}.box-content img{display:block;max-width:100%;object-fit:contain;min-height:0}.box-content figcaption{text-align:center;font-size:.82em;margin-top:.35em}.box-content .label{text-transform:uppercase;letter-spacing:.04em;font-weight:700;font-size:.78em}.box-content hr{width:100%;border:0;border-top:.2mm solid currentColor;opacity:.35}.layout-box.fit-error{border-color:#c3092b!important;box-shadow:inset 0 0 0 .4mm #c3092b}.fit-error-banner{position:absolute;z-index:4;left:0;right:0;top:0;padding:1mm;background:#c3092b;color:#fff;font:700 7.5pt/1.1 sans-serif;text-align:center}.fit-report{position:fixed;left:18px;bottom:18px;z-index:20;max-width:420px;padding:9px 12px;border-radius:6px;background:#c3092b;color:#fff;font:600 13px system-ui;box-shadow:0 2px 12px #0005}.fit-report[hidden]{display:none}
@media print{html,body{background:#fff;padding:0}.controls,.fit-report{display:none!important}.page{margin:0;box-shadow:none}.page:last-of-type{break-after:auto}}
</style></head><body><div class="controls"><button type="button" onclick="fitAll()">Refit boxes</button><button type="button" onclick="window.print()">Print / Save PDF</button></div><div id="fit-report" class="fit-report" hidden></div>${pages}
<script>
const mm=(value)=>value+'mm';
function fits(content){return content.scrollHeight<=content.clientHeight+1.25&&content.scrollWidth<=content.clientWidth+1.25}
function setFit(box,font,comfort){const minLead=+box.dataset.minLeading,maxLead=+box.dataset.maxLeading,minGap=+box.dataset.minGap,maxGap=+box.dataset.maxGap;box.style.setProperty('--fit-font',font.toFixed(3)+'pt');box.style.setProperty('--fit-leading',(minLead+(maxLead-minLead)*comfort).toFixed(4));box.style.setProperty('--fit-gap',mm((minGap+(maxGap-minGap)*comfort).toFixed(3)))}
function fitBox(box){box.classList.remove('fit-error');box.querySelector('.fit-error-banner')?.remove();const content=box.querySelector('.box-content'),min=+box.dataset.minFont,max=+box.dataset.maxFont;setFit(box,min,0);if(!fits(content)){box.classList.add('fit-error');const banner=document.createElement('div');banner.className='fit-error-banner';banner.textContent='CONTENT DOES NOT FIT AT '+min+' PT';box.append(banner);return false}let low=min,high=max;for(let i=0;i<18;i++){const mid=(low+high)/2;setFit(box,mid,0);if(fits(content))low=mid;else high=mid}let bestFont=low;low=0;high=1;for(let i=0;i<16;i++){const mid=(low+high)/2;setFit(box,bestFont,mid);if(fits(content))low=mid;else high=mid}setFit(box,bestFont,low);box.dataset.fittedFont=bestFont.toFixed(2);return true}
function fitAll(){const failed=[...document.querySelectorAll('[data-fit]')].filter((box)=>!fitBox(box));const report=document.getElementById('fit-report');report.hidden=!failed.length;report.textContent=failed.length?failed.length+' box'+(failed.length===1?'':'es')+' cannot fit above the declared minimum: '+failed.map((box)=>box.id).join(', '):'';return failed.length===0}
document.fonts.ready.then(fitAll);addEventListener('beforeprint',fitAll);addEventListener('resize',fitAll);
</script></body></html>`;
}

function texEscape(value) {
  return collapseText(value).replace(/([\\{}%$#&_])/g, "\\$1").replace(/\^/g, "\\textasciicircum{}").replace(/~/g, "\\textasciitilde{}");
}

function renderTexInline(nodes) {
  return nodes.map((node) => {
    if (node.type === "text") return texEscape(node.value);
    if (node.type === "br") return "\\newline{}";
    const inner = renderTexInline(node.children || []);
    if (node.type === "strong") return `\\textbf{${inner}}`;
    if (node.type === "em") return `\\emph{${inner}}`;
    if (node.type === "code") return `\\texttt{${inner}}`;
    if (node.type === "link") return `\\href{${texEscape(node.attrs.href)}}{${inner}}`;
    return inner;
  }).join("");
}

function scaleParts(block) {
  const defaultScale = block.type === "heading" ? 1.22 : block.type === "label" ? 0.78 : 1;
  const scale = Number(block.attrs?.scale || defaultScale);
  const leading = Number(block.attrs?.leading || (block.type === "heading" ? scale * 1.1 : block.type === "label" ? scale * 1.14 : 1.2));
  // A centesimal ratio is precise enough for type and keeps TeX's intermediate
  // dimension below its hard 16383.99999pt limit while the fit loop runs.
  return { scale: Math.round(scale * 100), leading: Math.round(leading * 100) };
}

function renderTexBlock(block, box, headingColorName, colorName) {
  const sizing = scaleParts(block);
  const blockColor = block.attrs?.color ? colorName(block.attrs.color) : block.type === "heading" ? headingColorName : "";
  if (block.type === "heading") return `{\\bfseries${blockColor ? `\\color{${blockColor}}` : ""}\\LocalTeXScaledFont{${sizing.scale}}{${sizing.leading}} ${renderTexInline(block.children)}}\\par`;
  if (block.type === "p") return `{${blockColor ? `\\color{${blockColor}}` : ""}\\LocalTeXScaledFont{${sizing.scale}}{${sizing.leading}} ${renderTexInline(block.children)}}\\par`;
  if (block.type === "label") return `{\\bfseries${blockColor ? `\\color{${blockColor}}` : ""}\\LocalTeXScaledFont{${sizing.scale}}{${sizing.leading}} ${renderTexInline(block.children)}}\\par`;
  if (block.type === "list") return `\\begin{itemize}[leftmargin=1.25em,topsep=0pt,itemsep=.25em,parsep=0pt]${block.items.map((item) => `\\item ${renderTexInline(item)}`).join("")}\\end{itemize}`;
  if (block.type === "image") {
    const requestedHeight = parseLength(block.attrs.height, `${box.id} image height`, Math.min(28, box.height / 2));
    const requestedWidth = parseLength(block.attrs.width, `${box.id} image width`, box.width - box.padding * 2);
    const path = texEscape(block.absolutePath || block.attrs.src);
    // Avoid LaTeX's center environment here: its implicit vertical skips make
    // physical image regions disagree with the HTML target and the declared
    // box height. A scoped centering declaration has no hidden block margins.
    return `{\\centering\\includegraphics[width=${num(Math.min(requestedWidth, box.width - box.padding * 2))}mm,height=${num(requestedHeight)}mm,keepaspectratio]{\\detokenize{${path}}}${block.attrs.caption ? `\\par{\\scriptsize ${texEscape(block.attrs.caption)}}` : ""}\\par}`;
  }
  if (block.type === "rule") return "\\hrule height .2mm";
  if (block.type === "spacer") return `\\vskip ${num(parseLength(block.attrs.height, `${box.id} spacer height`, 1))}mm`;
  return "";
}

function texColorDefinition(name, color) {
  if (/^#[0-9a-f]{6}$/i.test(color)) return `\\definecolor{${name}}{HTML}{${color.slice(1).toUpperCase()}}`;
  return `\\colorlet{${name}}{${color}}`;
}

export function renderLatex(model) {
  const page = model.pages[0];
  if (model.pages.some((candidate) => Math.abs(candidate.width - page.width) > 0.001 || Math.abs(candidate.height - page.height) > 0.001)) fail("The LuaLaTeX renderer currently requires every page to use the same dimensions.");
  const usedColors = new Map();
  let colorIndex = 0;
  const colorName = (color) => {
    if (!usedColors.has(color)) usedColors.set(color, `LocalTeXColor${colorIndex++}`);
    return usedColors.get(color);
  };
  model.pages.forEach((candidate) => {
    colorName(candidate.background);
    candidate.boxes.forEach((box) => {
      [box.background, box.color, box.headingColor, box.borderColor].forEach(colorName);
      box.blocks.forEach((block) => { if (block.attrs?.color) colorName(block.attrs.color); });
    });
  });
  const pageBodies = model.pages.map((candidate) => {
    const drawings = [`\\fill[${colorName(candidate.background)}] (current page.north west) rectangle (current page.south east);`];
    candidate.boxes.forEach((box) => {
      const x = num(box.x), y = num(box.y), width = num(box.width), height = num(box.height);
      const innerX = num(box.x + box.padding), innerY = num(box.y + box.padding), innerWidth = num(box.width - box.padding * 2), innerHeight = num(box.height - box.padding * 2);
      drawings.push(`\\path[fill=${colorName(box.background)},draw=${colorName(box.borderColor)},line width=${num(box.borderWidth)}mm,rounded corners=${num(box.radius)}mm] ([xshift=${x}mm,yshift=-${y}mm]current page.north west) rectangle ++(${width}mm,-${height}mm);`);
      const blocks = box.blocks.map((block) => renderTexBlock(block, box, colorName(box.headingColor), colorName)).join(`\\LocalTeXGap{${num(box.minGap)}mm}`);
      drawings.push(`\\begin{scope}\\clip ([xshift=${innerX}mm,yshift=-${innerY}mm]current page.north west) rectangle ++(${innerWidth}mm,-${innerHeight}mm);\\node[anchor=north west,inner sep=0pt,outer sep=0pt,text=${colorName(box.color)}] at ([xshift=${innerX}mm,yshift=-${innerY}mm]current page.north west) {\\LocalTeXAdaptiveBox{${innerWidth}mm}{${innerHeight}mm}{${box.maxFontSize}pt}{${box.minFontSize}pt}{${blocks}}{${box.valign}}};\\end{scope}`);
    });
    return `\\begin{tikzpicture}[remember picture,overlay]${drawings.join("\n")}\\end{tikzpicture}\\null`;
  });
  const definitions = [...usedColors.entries()].map(([color, name]) => texColorDefinition(name, color)).join("\n");
  return `% !TeX program = lualatex
% Generated by UnderTree Layout. Edit the semantic .layout.xml source, not this file.
\\documentclass{article}
\\usepackage[paperwidth=${num(page.width)}mm,paperheight=${num(page.height)}mm,margin=0mm]{geometry}
\\usepackage{fontspec}
\\usepackage{xcolor}
\\usepackage{graphicx}
\\usepackage{tikz}
\\usepackage{enumitem}
\\usepackage{etoolbox}
\\usepackage{ragged2e}
\\usepackage{hyperref}
\\setmainfont{Noto Sans}
\\pagestyle{empty}
\\setlength{\\parindent}{0pt}
\\setlength{\\parskip}{0pt}
\\definecolor{LocalTeXAccent}{HTML}{006C76}
${definitions}
\\makeatletter
\\newsavebox{\\LocalTeXMeasureBox}
\\newdimen\\LocalTeXFontSize
\\newdimen\\LocalTeXMinFontSize
\\newdimen\\LocalTeXTargetWidth
\\newdimen\\LocalTeXTargetHeight
\\newdimen\\LocalTeXLeading
\\newdimen\\LocalTeXHeadingSize
\\newdimen\\LocalTeXHeadingLeading
\\newif\\ifLocalTeXOverflow
\\newif\\ifLocalTeXFinal
\\newif\\ifLocalTeXCenter
\\newif\\ifLocalTeXDistribute
\\newcommand{\\LocalTeXSetFont}{\\LocalTeXLeading=\\dimexpr 6\\LocalTeXFontSize/5\\relax\\fontsize{\\strip@pt\\LocalTeXFontSize}{\\strip@pt\\LocalTeXLeading}\\selectfont}
\\newcommand{\\LocalTeXHeadingFont}{\\LocalTeXHeadingSize=\\dimexpr 61\\LocalTeXFontSize/50\\relax\\LocalTeXHeadingLeading=\\dimexpr 68\\LocalTeXFontSize/50\\relax\\fontsize{\\strip@pt\\LocalTeXHeadingSize}{\\strip@pt\\LocalTeXHeadingLeading}\\selectfont}
\\newcommand{\\LocalTeXScaledFont}[2]{\\LocalTeXHeadingSize=\\dimexpr #1\\LocalTeXFontSize/100\\relax\\LocalTeXHeadingLeading=\\dimexpr #2\\LocalTeXFontSize/100\\relax\\fontsize{\\strip@pt\\LocalTeXHeadingSize}{\\strip@pt\\LocalTeXHeadingLeading}\\selectfont}
\\newcommand{\\LocalTeXGap}[1]{\\ifLocalTeXFinal\\ifLocalTeXDistribute\\vskip #1 plus 1fill\\else\\vskip #1\\fi\\else\\vskip #1\\fi}
\\newcommand{\\LocalTeXFitLoop}{%
  \\setbox\\LocalTeXMeasureBox=\\vbox{\\hsize=\\LocalTeXTargetWidth\\linewidth=\\LocalTeXTargetWidth\\emergencystretch=1.5em\\RaggedRight\\LocalTeXSetFont\\LocalTeXContent}%
  \\ifdim\\dimexpr\\ht\\LocalTeXMeasureBox+\\dp\\LocalTeXMeasureBox\\relax>\\LocalTeXTargetHeight
    \\advance\\LocalTeXFontSize by -.25pt
    \\ifdim\\LocalTeXFontSize<\\LocalTeXMinFontSize\\LocalTeXOverflowtrue\\else\\expandafter\\LocalTeXFitLoop\\fi
  \\fi}
\\newcommand{\\LocalTeXAdaptiveBox}[6]{\\begingroup
  \\LocalTeXTargetWidth=#1\\LocalTeXTargetHeight=#2\\LocalTeXFontSize=#3\\LocalTeXMinFontSize=#4\\def\\LocalTeXContent{#5}\\LocalTeXCenterfalse\\LocalTeXDistributefalse\\ifstrequal{#6}{center}{\\LocalTeXCentertrue}{}\\ifstrequal{#6}{distribute}{\\LocalTeXDistributetrue}{}\\LocalTeXOverflowfalse\\LocalTeXFinalfalse\\LocalTeXFitLoop
  \\ifLocalTeXOverflow\\LocalTeXFontSize=\\LocalTeXMinFontSize\\PackageWarning{localtex-layout}{Content overflow in an adaptive box at minimum size}\\fi
  \\LocalTeXFinaltrue\\vbox to\\LocalTeXTargetHeight{\\hsize=\\LocalTeXTargetWidth\\linewidth=\\LocalTeXTargetWidth\\emergencystretch=1.5em\\RaggedRight\\LocalTeXSetFont\\ifLocalTeXCenter\\vfil\\fi\\ifLocalTeXOverflow\\colorbox{red}{\\parbox{\\dimexpr\\LocalTeXTargetWidth-2mm\\relax}{\\centering\\color{white}\\bfseries\\fontsize{7.5}{8}\\selectfont CONTENT DOES NOT FIT}}\\LocalTeXGap{.8mm}\\fi\\LocalTeXContent\\vfil}\\endgroup}
\\makeatother
\\begin{document}
${pageBodies.join("\n\\newpage\n")}
\\end{document}
`;
}

function imageMime(path) {
  const extension = extname(path).toLowerCase();
  return extension === ".svg" ? "image/svg+xml" : extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : extension === ".gif" ? "image/gif" : "image/png";
}

async function hydrateImages(model, sourceDirectory) {
  for (const page of model.pages) {
    for (const box of page.boxes) {
      for (const block of box.blocks) {
        if (block.type !== "image") continue;
        const absolutePath = isAbsolute(block.attrs.src) ? block.attrs.src : resolve(sourceDirectory, block.attrs.src);
        const bytes = await readFile(absolutePath).catch(() => fail(`Image not found: ${block.attrs.src}`));
        block.absolutePath = absolutePath;
        block.dataUri = `data:${imageMime(absolutePath)};base64,${bytes.toString("base64")}`;
      }
    }
  }
}

export async function compileLayout(sourcePath, outputDirectory) {
  const absoluteSource = resolve(sourcePath);
  const xml = await readFile(absoluteSource, "utf8");
  const model = parseLayout(xml, absoluteSource);
  await hydrateImages(model, dirname(absoluteSource));
  const stem = basename(absoluteSource).replace(/\.layout\.xml$/i, "").replace(/\.xml$/i, "");
  const outDir = resolve(outputDirectory || join(dirname(absoluteSource), ".localtex-layout", stem));
  await mkdir(outDir, { recursive: true });
  const htmlPath = join(outDir, `${stem}.html`);
  const texPath = join(outDir, `${stem}.tex`);
  await writeFile(htmlPath, renderHtml(model), "utf8");
  await writeFile(texPath, renderLatex(model), "utf8");
  return { sourcePath: absoluteSource, outDir, htmlPath, texPath, pdfPath: join(outDir, `${stem}.pdf`), model };
}

async function cli() {
  const [source, outputFlag, outputValue] = process.argv.slice(2);
  if (!source || (outputFlag && outputFlag !== "--out-dir")) {
    console.error("Usage: node layout/compiler.mjs document.layout.xml [--out-dir DIRECTORY]");
    process.exitCode = 2;
    return;
  }
  try {
    const result = await compileLayout(source, outputValue);
    console.log(`Validated: ${result.sourcePath}`);
    console.log(`HTML: ${result.htmlPath}`);
    console.log(`LuaLaTeX: ${result.texPath}`);
  } catch (error) {
    console.error(`${error.name}: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await cli();
