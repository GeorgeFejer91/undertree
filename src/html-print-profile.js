import { parse } from "parse5";

export const HTML_PRINT_PROFILE_VERSION = "1";
export const HTML_PRINT_PAGE_HEIGHT_MM = 296.7;

const SUPPORTED_ELEMENTS = new Set([
  "html", "head", "meta", "title", "style", "body", "main", "section", "article", "header", "footer", "aside", "nav", "figure",
  "div", "span", "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "a", "strong", "b", "em", "i", "u",
  "br", "img", "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "defs", "clipPath",
]);

const FIT_PROPERTIES = new Set([
  "--ut-fit-font-size", "--ut-fit-line-height", "--ut-fit-gap", "font-size", "line-height", "gap", "row-gap", "column-gap",
  "padding", "padding-top", "padding-right", "padding-bottom", "padding-left", "width", "height", "min-width", "min-height",
  "max-width", "max-height", "border", "border-width", "border-style", "border-color", "border-radius", "color", "background",
  "background-color", "text-align", "align-items", "justify-content", "grid-row", "grid-column", "grid-row-start", "grid-column-start",
  "grid-row-end", "grid-column-end", "grid-template-columns", "grid-template-rows", "display", "flex-direction", "flex-wrap",
  "object-fit", "object-position", "font-family", "font-weight", "font-style", "letter-spacing",
]);

const UNSUPPORTED_CSS = [
  [/\bfilter\s*:/i, "CSS filters are not supported"],
  [/\b(?:mix-)?blend-mode\s*:/i, "blend modes are not supported"],
  [/\btransform(?:-origin)?\s*:/i, "CSS transforms are not supported"],
  [/::(?:before|after)\b[^{}]*\{[^{}]*\bcontent\s*:/is, "generated pseudo-element content is not supported"],
  [/@import\b/i, "CSS @import is not supported"],
];

function attr(node, name) {
  return node.attrs?.find((item) => item.name === name)?.value ?? null;
}

function walk(node, visitor, ancestors = []) {
  visitor(node, ancestors);
  for (const child of node.childNodes || []) walk(child, visitor, [...ancestors, node]);
}

function documentElement(document) {
  return document.childNodes?.find((node) => node.tagName === "html") || null;
}

function textContent(node) {
  if (node.nodeName === "#text") return node.value || "";
  return (node.childNodes || []).map(textContent).join("");
}

function localAsset(value) {
  if (!value || value.startsWith("#") || value.startsWith("data:")) return null;
  if (/^(?:https?:)?\/\//i.test(value)) return { remote: true, value };
  const clean = value.split(/[?#]/, 1)[0].replaceAll("\\", "/");
  return { remote: false, value, clean };
}

function hasUniversityLogoRegion(ancestors) {
  return ancestors.some((node) => ["ethics-footer", "university-logo"].includes(attr(node, "data-ut-role")));
}

function diagnostic(code, message, node = null, severity = "error") {
  const location = node?.sourceCodeLocation;
  return {
    code,
    message,
    severity,
    line: location?.startLine || 1,
    column: location?.startCol || 1,
    dataUtId: node ? attr(node, "data-ut-id") || "" : "",
  };
}

export function parseHtmlPrintProfile(source) {
  const html = String(source || "");
  const document = parse(html, { sourceCodeLocationInfo: true });
  const root = documentElement(document);
  const diagnostics = [];
  const ids = new Map();
  const pages = [];
  const assets = [];
  const styles = [];
  const site = root ? attr(root, "data-ut-site") : null;

  if (!root || attr(root, "data-ut-print-profile") !== HTML_PRINT_PROFILE_VERSION) {
    diagnostics.push(diagnostic("profile-version", `HTML export requires <html data-ut-print-profile=\"${HTML_PRINT_PROFILE_VERSION}\">.`, root));
  }
  if (site && !["zanv", "schmieder"].includes(site)) {
    diagnostics.push(diagnostic("site", "data-ut-site must be zanv or schmieder.", root));
  }

  walk(document, (node, ancestors) => {
    if (!node.tagName) return;
    const id = attr(node, "data-ut-id");
    if (id) {
      if (ids.has(id)) diagnostics.push(diagnostic("duplicate-id", `data-ut-id \"${id}\" is duplicated.`, node));
      else ids.set(id, node);
    }
    if ((attr(node, "data-ut-box") !== null || attr(node, "data-ut-editable") !== null) && !id) {
      diagnostics.push(diagnostic("stable-id", `${node.tagName} marked as a box or editable region requires data-ut-id.`, node));
    }
    if (attr(node, "data-ut-page") !== null) {
      pages.push(node);
      if (attr(node, "data-ut-size") !== "A4" || attr(node, "data-ut-orientation") !== "portrait") {
        diagnostics.push(diagnostic("page-profile", "Version 1 pages must declare data-ut-size=\"A4\" and data-ut-orientation=\"portrait\".", node));
      }
    }
    if (!SUPPORTED_ELEMENTS.has(node.tagName)) diagnostics.push(diagnostic("element", `<${node.tagName}> is outside the TeX-compatible print profile.`, node));
    if (node.tagName === "script") diagnostics.push(diagnostic("script", "Document JavaScript is forbidden; UnderTree injects its own fitting runtime.", node));
    if (node.tagName === "style") styles.push(textContent(node));

    for (const name of ["src", "data-ut-tex-src"]) {
      const value = attr(node, name);
      const asset = localAsset(value);
      if (!asset) continue;
      if (asset.remote) diagnostics.push(diagnostic("remote-resource", `Remote resource ${value} is forbidden.`, node));
      else {
        if (asset.clean.startsWith("/") || asset.clean.split("/").includes("..")) diagnostics.push(diagnostic("asset-path", `Asset path ${value} must remain inside the project.`, node));
        const ownerId = id || [...ancestors].reverse().map((ancestor) => attr(ancestor, "data-ut-id")).find(Boolean) || "";
        assets.push({ attribute: name, value, path: asset.clean, dataUtId: ownerId, line: node.sourceCodeLocation?.startLine || 1 });
      }
    }
    if (node.tagName === "link" && attr(node, "href")) diagnostics.push(diagnostic("external-style", "External stylesheets are forbidden; embed print CSS in the HTML source.", node));
    const style = attr(node, "style") || "";
    for (const [pattern, message] of UNSUPPORTED_CSS) if (pattern.test(style)) diagnostics.push(diagnostic("unsupported-css", message, node));

    if (node.tagName === "img") {
      const path = (attr(node, "src") || "").toLocaleLowerCase();
      if (/universit(?:a|ä)t|university|unikonstanz|uni[-_ ]?konstanz/.test(path) && !hasUniversityLogoRegion(ancestors)) {
        diagnostics.push(diagnostic("university-logo-region", "The University logo is allowed only inside data-ut-role=\"university-logo\" or data-ut-role=\"ethics-footer\".", node));
      }
    }
  });

  if (!pages.length) diagnostics.push(diagnostic("pages", "The print profile requires at least one explicit data-ut-page element.", root));
  const css = styles.join("\n");
  for (const [pattern, message] of UNSUPPORTED_CSS) if (pattern.test(css)) diagnostics.push(diagnostic("unsupported-css", message, root));
  for (const match of css.matchAll(/url\(\s*(['\"]?)(.*?)\1\s*\)/gi)) {
    const asset = localAsset(match[2]);
    if (!asset) continue;
    if (asset.remote) diagnostics.push(diagnostic("remote-resource", `Remote CSS resource ${match[2]} is forbidden.`, root));
    else if (asset.clean.startsWith("/") || asset.clean.split("/").includes("..")) diagnostics.push(diagnostic("asset-path", `CSS asset path ${match[2]} must remain inside the project.`, root));
    else assets.push({ attribute: "css-url", value: match[2], path: asset.clean, dataUtId: "", line: 1 });
  }

  const sourceLower = html.toLocaleLowerCase();
  if (site === "zanv") {
    if (!sourceLower.includes("zanv.svg")) diagnostics.push(diagnostic("brand-required", "ZANV documents require ZANV.svg.", root));
    if (sourceLower.includes("kliniken-schmieder.svg")) diagnostics.push(diagnostic("brand-exclusive", "ZANV documents must not contain the Kliniken Schmieder logo.", root));
  } else if (site === "schmieder") {
    if (!sourceLower.includes("kliniken-schmieder.svg")) diagnostics.push(diagnostic("brand-required", "Schmieder documents require Kliniken-Schmieder.svg.", root));
    if (sourceLower.includes("zanv.svg")) diagnostics.push(diagnostic("brand-exclusive", "Schmieder documents must not contain the ZANV logo.", root));
  }

  return {
    document,
    root,
    profileVersion: root ? attr(root, "data-ut-print-profile") : null,
    site,
    pages,
    ids,
    assets,
    diagnostics,
    errors: diagnostics.filter((item) => item.severity === "error"),
  };
}

export function assertHtmlPrintProfile(source) {
  const result = parseHtmlPrintProfile(source);
  if (result.errors.length) {
    const error = new Error(result.errors.map((item) => `${item.line}:${item.column} ${item.message}`).join("\n"));
    error.name = "HtmlPrintProfileError";
    error.diagnostics = result.diagnostics;
    throw error;
  }
  return result;
}

function nodeForId(parsed, id) {
  const node = parsed.ids.get(String(id));
  if (!node?.sourceCodeLocation?.startTag) throw new Error(`No stable source range exists for data-ut-id \"${id}\".`);
  return node;
}

export function patchEditableHtml(source, id, nextHtml) {
  const parsed = parseHtmlPrintProfile(source);
  const node = nodeForId(parsed, id);
  const { startTag, endTag } = node.sourceCodeLocation;
  if (!endTag) throw new Error(`data-ut-id \"${id}\" cannot contain editable HTML.`);
  const change = { from: startTag.endOffset, to: endTag.startOffset, insert: String(nextHtml) };
  return { ...change, source: source.slice(0, change.from) + change.insert + source.slice(change.to) };
}

function serializeStyle(properties) {
  return [...properties.entries()].map(([name, value]) => `${name}: ${value}`).join("; ") + (properties.size ? ";" : "");
}

export function patchElementStyle(source, id, changes) {
  const parsed = parseHtmlPrintProfile(source);
  const node = nodeForId(parsed, id);
  const location = node.sourceCodeLocation.startTag;
  const tag = source.slice(location.startOffset, location.endOffset);
  const existing = attr(node, "style") || "";
  const properties = new Map();
  for (const declaration of existing.split(";")) {
    const separator = declaration.indexOf(":");
    if (separator < 0) continue;
    properties.set(declaration.slice(0, separator).trim().toLocaleLowerCase(), declaration.slice(separator + 1).trim());
  }
  for (const [name, rawValue] of Object.entries(changes || {})) {
    const property = String(name).trim().toLocaleLowerCase();
    if (!FIT_PROPERTIES.has(property)) throw new Error(`Visual editing cannot change unsupported CSS property ${property}.`);
    const value = String(rawValue ?? "").trim();
    if (/url\s*\(|expression\s*\(|[{}]/i.test(value)) throw new Error(`Unsafe CSS value for ${property}.`);
    if (value) properties.set(property, value);
    else properties.delete(property);
  }
  const serialized = serializeStyle(properties);
  const stylePattern = /\sstyle\s*=\s*(["'])(.*?)\1/is;
  const replacement = serialized ? ` style=\"${serialized.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}\"` : "";
  let nextTag;
  if (stylePattern.test(tag)) nextTag = tag.replace(stylePattern, replacement);
  else nextTag = tag.replace(/\s*\/?\>$/, (ending) => `${replacement}${ending}`);
  const change = { from: location.startOffset, to: location.endOffset, insert: nextTag };
  return { ...change, source: source.slice(0, change.from) + change.insert + source.slice(change.to) };
}

const VISUAL_ATTRIBUTES = new Set([
  "data-ut-fit-min-font", "data-ut-fit-max-font", "data-ut-fit-min-leading", "data-ut-fit-max-leading",
  "data-ut-fit-min-gap", "data-ut-fit-max-gap", "alt", "width", "height",
  "data-ut-layout",
]);

export function patchElementAttributes(source, id, changes) {
  const parsed = parseHtmlPrintProfile(source);
  const node = nodeForId(parsed, id);
  const location = node.sourceCodeLocation.startTag;
  let tag = source.slice(location.startOffset, location.endOffset);
  for (const [rawName, rawValue] of Object.entries(changes || {})) {
    const name = String(rawName).toLocaleLowerCase();
    if (!VISUAL_ATTRIBUTES.has(name)) throw new Error(`Visual editing cannot change unsupported attribute ${name}.`);
    const value = String(rawValue ?? "").trim();
    if (/[<>"']/.test(value)) throw new Error(`Unsafe value for ${name}.`);
    const pattern = new RegExp(`\\s${name}\\s*=\\s*(["'])(.*?)\\1`, "is");
    if (pattern.test(tag)) tag = tag.replace(pattern, value ? ` ${name}=\"${value}\"` : "");
    else if (value) tag = tag.replace(/\s*\/?\>$/, (ending) => ` ${name}=\"${value}\"${ending}`);
  }
  const change = { from: location.startOffset, to: location.endOffset, insert: tag };
  return { ...change, source: source.slice(0, change.from) + change.insert + source.slice(change.to) };
}
