import * as pretextRich from "@chenglou/pretext/rich-inline";
import { fitPrintDocument } from "../../src/pretext-fit-core.js";

export function fitVisualPrintDocument(document, options = {}) {
  return fitPrintDocument(document, { ...options, pretextRich });
}
