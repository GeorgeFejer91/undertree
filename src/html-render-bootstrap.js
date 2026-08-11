import * as pretextRich from "/__undertree/pretext/rich-inline.js";
import { captureLayoutManifest, fitPrintDocument } from "/__undertree/runtime/pretext-fit-core.js";

async function run() {
  try {
    const capabilities = {
      canvas2d: Boolean(document.createElement("canvas").getContext("2d")),
      segmenter: typeof Intl?.Segmenter === "function",
      fonts: Boolean(document.fonts?.ready),
    };
    if (!Object.values(capabilities).every(Boolean)) throw new Error(`WebKit is missing required print capabilities: ${JSON.stringify(capabilities)}`);
    const fit = await fitPrintDocument(document, { pretextRich });
    const manifest = captureLayoutManifest(document, fit);
    manifest.capabilities = capabilities;
    window.__UT_PRINT_RESULT__ = { ok: !fit.diagnostics.length, manifest, diagnostics: fit.diagnostics };
  } catch (error) {
    window.__UT_PRINT_RESULT__ = { ok: false, error: error?.message || String(error), diagnostics: error?.diagnostics || [] };
  }
}

void run();
