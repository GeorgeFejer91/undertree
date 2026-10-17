export function smartSourceEntries(inventory) {
  const sources = inventory.typstSources;
  const paths = new Set(sources?.paths || []);
  return inventory.entries.filter(entry => entry.editable && entry.path.endsWith('.typ') && paths.has(entry.path));
}

export function smartSourceNotice(inventory) {
  const sources = inventory.typstSources;
  if (!sources?.main) return 'Choose the PDF source, then use File → Set as main document to populate Smart view.';
  const context = `Saved Typst sources for ${sources.main}.`;
  return sources.complete ? context : `${context} ${sources.reason || 'Some dependencies could not be resolved. Refresh after saving your sources.'}`;
}
