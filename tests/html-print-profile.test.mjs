import assert from "node:assert/strict";
import test from "node:test";

import {
  assertHtmlPrintProfile,
  insertBoxlet,
  nextBoxletId,
  parseHtmlPrintProfile,
  patchEditableHtml,
  patchElementAttributes,
  patchElementStyle,
  removeVisualElement,
} from "../src/html-print-profile.js";
import { generateLuaLatex, texEscape } from "../src/html-tex-export.js";

function document({ site = "zanv", logo = "ZANV.svg", extra = "", copy = "Langer deutscher Absatz" } = {}) {
  return `<!doctype html>
<html data-ut-print-profile="1" data-ut-site="${site}"><head><style>
[data-ut-page]{display:grid} .box{color:#123456}
</style></head><body>
<main data-ut-page data-ut-id="page" data-ut-size="A4" data-ut-orientation="portrait">
<!-- source formatting must survive -->
<img src="assets/${logo}" data-ut-tex-src="assets/logo.pdf" alt="Site">
<section class="box" data-ut-id="copy" data-ut-box data-ut-editable data-ut-fit="pretext"><p>${copy}</p></section>
${extra}</main></body></html>`;
}

function applyChanges(source, changes) {
  let offset = 0;
  let result = "";
  for (const change of [...changes].sort((left, right) => left.from - right.from)) {
    result += source.slice(offset, change.from) + change.insert;
    offset = change.to;
  }
  return result + source.slice(offset);
}

test("profile parses stable objects and enforces exclusive site branding", () => {
  const valid = assertHtmlPrintProfile(document());
  assert.equal(valid.site, "zanv");
  assert.equal(valid.pages.length, 1);
  assert.ok(valid.ids.has("copy"));

  const wrong = parseHtmlPrintProfile(document({ logo: "Kliniken-Schmieder.svg" }));
  assert.ok(wrong.errors.some((item) => item.code === "brand-required"));
  assert.ok(wrong.errors.some((item) => item.code === "brand-exclusive"));
});

test("profile rejects scripts, remote resources, unsafe paths, and unsupported CSS", () => {
  const parsed = parseHtmlPrintProfile(document({
    extra: '<script>alert(1)</script><img src="https://example.test/pixel.png"><img src="../secret.png"><div style="filter:blur(2px)"></div>',
  }));
  for (const code of ["script", "remote-resource", "asset-path", "unsupported-css"]) {
    assert.ok(parsed.errors.some((item) => item.code === code), `missing ${code}`);
  }
});

test("profile allows the University logo in marked masthead and ethics-footer regions", () => {
  const footer = '<footer data-ut-id="ethics" data-ut-role="ethics-footer"><img src="assets/UniKonstanz_Logo_Optimum_SW.svg"></footer>';
  assert.doesNotThrow(() => assertHtmlPrintProfile(document({ extra: footer })));
  const masthead = '<figure data-ut-id="university" data-ut-role="university-logo"><img src="assets/UniKonstanz_Logo_Optimum_SW.svg"></figure>';
  assert.doesNotThrow(() => assertHtmlPrintProfile(document({ extra: masthead })));

  const unmarked = parseHtmlPrintProfile(document({
    extra: '<figure><img src="assets/UniKonstanz_Logo_Optimum_SW.svg"></figure>',
  }));
  assert.ok(unmarked.errors.some((item) => item.code === "university-logo-region"));
});

test("stable patches preserve unrelated HTML, CSS, comments, and canonical history ranges", () => {
  const source = document();
  const content = patchEditableHtml(source, "copy", "<h2>Neu</h2><p>Inhalt</p>");
  assert.match(content.source, /<!-- source formatting must survive -->/);
  assert.match(content.source, /\.box\{color:#123456\}/);
  assert.match(content.source, /<section class="box"[^>]*><h2>Neu<\/h2><p>Inhalt<\/p><\/section>/);

  const styled = patchElementStyle(content.source, "copy", { padding: "3mm", "--ut-fit-font-size": "12.25px" });
  assert.match(styled.source, /style="[^\"]*padding: 3mm[^\"]*--ut-fit-font-size: 12\.25px/);
  const bounded = patchElementAttributes(styled.source, "copy", { "data-ut-fit-min-font": "9", "data-ut-fit-max-font": "16" });
  assert.match(bounded.source, /data-ut-fit-min-font="9"/);
  assert.throws(() => patchElementStyle(source, "copy", { transform: "scale(2)" }), /unsupported CSS property/);
});

test("visual editor can add and remove a free adaptive boxlet on an A4 page", () => {
  const source = document();
  assert.equal(nextBoxletId(source), "boxlet-1");
  const added = insertBoxlet(source, "page", { title: "Hinweis", copy: "Adaptive Kopie" });
  assert.equal(added.id, "boxlet-1");
  assert.equal(applyChanges(source, added.changes), added.source);
  assert.match(added.source, /data-ut-id="page"[^>]*position: relative/);
  assert.match(added.source, /data-ut-id="boxlet-1"[^>]*data-ut-fit="pretext"/);
  assert.match(added.source, /<h2>Hinweis<\/h2><p>Adaptive Kopie<\/p>/);
  assert.doesNotThrow(() => assertHtmlPrintProfile(added.source));
  assert.equal(nextBoxletId(added.source), "boxlet-2");
  const removed = removeVisualElement(added.source, "boxlet-1");
  assert.doesNotMatch(removed.source, /data-ut-id="boxlet-1"/);
  assert.match(removed.source, /data-ut-id="copy"/);
  assert.throws(() => removeVisualElement(source, "page"), /cannot be deleted/);
});

test("TeX export escapes content and records canonical provenance", () => {
  assert.equal(texEscape("A&B_50%"), "A\\&B\\_50\\%");
  const tex = generateLuaLatex({
    pages: [{ number: 1 }], pdfPageSizePt: { width: 595, height: 842 },
    objects: [], images: [],
    lines: [
      { page: 1, dataUtId: "copy", text: "A&B_50%", rect: { xMm: 10, yMm: 20 }, fontSizePx: 12, fontWeight: "700", fontStyle: "normal", color: "rgb(0, 0, 0)", link: "" },
      { page: 1, dataUtId: "copy", text: " spaced", rect: { xMm: 20, yMm: 20 }, fontSizePx: 12, fontWeight: "400", fontStyle: "normal", color: "rgb(0, 0, 0)", link: "" },
    ],
  }, { sourceHash: "abc123", profileVersion: "1", pretextVersion: "0.0.8", webkitVersion: "2.52.5", sourcePath: "flyer.html" });
  assert.match(tex, /HTML IS THE SOLE SOURCE OF TRUTH/);
  assert.match(tex, /Canonical HTML SHA-256: abc123/);
  assert.match(tex, /A\\&B\\_50\\%/);
  assert.match(tex, /\{\\ spaced\}/);
  assert.match(tex, /paperwidth=209\.90278mm,paperheight=297\.03889mm/);

  const companionTex = generateLuaLatex({ pages: [{ number: 1 }], objects: [], images: [], lines: [] }, {
    sourceHash: "proof-source",
    profileVersion: "1",
    pretextVersion: "0.0.8",
    webkitVersion: "2.52.5",
    sourcePath: "flyer.html",
    browserPdfSha256: "proof-pdf",
  });
  assert.match(companionTex, /Canonical browser PDF SHA-256: proof-pdf/);
  assert.match(companionTex, /reconstructs the manifest as editable TikZ\/text/);
  assert.doesNotMatch(companionTex, /UTUseBrowserProof|directlua|luacode/);
  assert.match(companionTex, /proof-source/);
});
