import { sourceRoot, sourceRootsEqual, sourceEpoch, captureSourceBinding, sourceBindingCurrent, assertSourceSnapshot } from './review-session.js';

const encoder = new TextEncoder(), maxSource = 2 * 1024 * 1024;
const require = condition => { if (!condition) throw { code: 'compile_report_format', message: 'The native compiler report could not be verified. The previous PDF is kept.' }; };
const keys = (value, required, optional = []) => {
  require(value && typeof value === 'object' && !Array.isArray(value));
  require(Reflect.ownKeys(value).every(key => required.includes(key) || optional.includes(key)) && required.every(key => Object.hasOwn(value, key)));
  require(Reflect.ownKeys(value).every(key => Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')));
};
const integer = value => require(Number.isSafeInteger(value) && value >= 0);
const hash = value => require(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value));
const uuid = value => require(typeof value === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value));
const text = value => require(typeof value === 'string');
const bytes = value => encoder.encode(value).length;
const path = value => {
  text(value); require(value.length <= 4096 && bytes(value) <= 4096);
  const parts = value.split('/');
  require(parts.length <= 32 && parts.every(part => part && !part.startsWith('.') && bytes(part) <= 255 && !['For-AI', 'node_modules'].includes(part) && !/[\\\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/.test(part)));
};
const freeze = Object.freeze;
function location(value) {
  if (value === null) return null;
  keys(value, ['projectPath', 'sourceDigest', 'line1', 'columnScalar0', 'byteOffset', 'utf16Offset']);
  path(value.projectPath); hash(value.sourceDigest);
  for (const key of ['line1', 'columnScalar0', 'byteOffset', 'utf16Offset']) { integer(value[key]); require(value[key] <= maxSource + (key === 'line1' ? 1 : 0)); }
  require(value.line1 > 0);
  return freeze({ ...value });
}

// Version1 is a closed native projection, never an alternative source authority.
export function unwrapNativeCompile(value, operation) {
  keys(value, ['compileDiagnosticsVersion', 'status', 'report'], ['preview', 'error']);
  require(value.compileDiagnosticsVersion === 1 && ['succeeded', 'failed', 'outcome_unknown'].includes(value.status));
  const report = value.report;
  keys(report, ['captureComplete', 'truncated', 'text', 'rows', 'sourceCandidates', 'provenance']);
  require(typeof report.captureComplete === 'boolean' && typeof report.truncated === 'boolean'); text(report.text);
  require(Array.isArray(report.rows) && report.rows.length <= 128 && Array.isArray(report.sourceCandidates) && report.sourceCandidates.length <= 128);
  require(report.captureComplete || (!report.rows.length && !report.sourceCandidates.length));
  const provenance = report.provenance;
  keys(provenance, ['project', 'expectedRoot', 'path', 'sourceEpoch', 'sourceDigest', 'mainRevision', 'nativeBuildId', 'instanceId']);
  text(provenance.project); path(provenance.path); integer(provenance.sourceEpoch); hash(provenance.sourceDigest); hash(provenance.mainRevision); uuid(provenance.nativeBuildId); uuid(provenance.instanceId);
  const expectedRoot = sourceRoot(provenance);
  require(expectedRoot && sourceRootsEqual(provenance, operation) && provenance.project === operation.project && provenance.path === operation.path && provenance.sourceEpoch === sourceEpoch(operation) && provenance.mainRevision === operation.revision && provenance.sourceDigest === operation.revision);
  const sources = report.sourceCandidates.map(source => {
    keys(source, ['projectPath', 'sourceDigest', 'sourceEpoch']); path(source.projectPath); hash(source.sourceDigest); integer(source.sourceEpoch);
    return freeze({ ...source });
  });
  require(new Set(sources.map(source => source.projectPath)).size === sources.length);
  const rows = report.rows.map(row => {
    keys(row, ['severity', 'message', 'locationCandidate']); require(['error', 'warning'].includes(row.severity)); text(row.message);
    const point = location(row.locationCandidate);
    require(!point || sources.some(source => source.projectPath === point.projectPath && source.sourceDigest === point.sourceDigest));
    return freeze({ severity: row.severity, message: row.message, locationCandidate: point });
  });
  require(sources.every(source => rows.some(row => row.locationCandidate?.projectPath === source.projectPath)));
  const normalized = freeze({ captureComplete: report.captureComplete, truncated: report.truncated, text: report.text, rows: freeze(rows), sourceCandidates: freeze(sources), provenance: freeze({ ...provenance, expectedRoot }) });
  require(bytes(JSON.stringify(normalized)) <= 128 * 1024);
  const compilation = freeze({ status: value.status, report: normalized });
  if (value.status !== 'succeeded') {
    require(!Object.hasOwn(value, 'preview')); keys(value.error, ['code', 'message']); text(value.error.code); text(value.error.message);
    require((value.status === 'outcome_unknown') === (value.error.code === 'outcome_unknown'));
    require(bytes(JSON.stringify(value)) <= 256 * 1024);
    throw { code: value.error.code, message: value.error.message, compileReport: compilation };
  }
  require(!Object.hasOwn(value, 'error'));
  const preview = value.preview;
  keys(preview, ['available', 'base64', 'revision', 'sourceEpoch', 'expectedRoot', 'current', 'diagnostics', 'dependencyCount', 'dependencyCoverage', 'externalDependencyCount']);
  require(preview.available === true && typeof preview.current === 'boolean'); text(preview.base64); text(preview.diagnostics); hash(preview.revision); integer(preview.sourceEpoch); integer(preview.dependencyCount); integer(preview.externalDependencyCount);
  require(sourceRootsEqual(preview, provenance) && preview.sourceEpoch === provenance.sourceEpoch && preview.revision === provenance.mainRevision && preview.dependencyCoverage === 'project');
  require(preview.base64.length <= Math.ceil(16 * 1024 * 1024 / 3) * 4 && preview.base64.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(preview.base64));
  require(preview.base64.length / 4 * 3 - (preview.base64.endsWith('==') ? 2 : preview.base64.endsWith('=') ? 1 : 0) <= 16 * 1024 * 1024);
  require(bytes(JSON.stringify({ ...value, preview: { ...preview, base64: '' } })) <= 256 * 1024);
  return { ...preview, expectedRoot, compileReport: compilation };
}

// Match Typst's scalar columns and all eight newline spellings; never clamp a header.
export function diagnosticOffset(content, point) {
  text(content); require(bytes(content) <= maxSource); require(point !== null); location(point);
  let line = 1, column = 0, byte = 0, utf16 = 0;
  while (utf16 < content.length) {
    if (line === point.line1 && column === point.columnScalar0) break;
    const code = content.codePointAt(utf16);
    require(code < 0xd800 || code > 0xdfff);
    utf16 += code > 0xffff ? 2 : 1; byte += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (code === 13 || code === 10 || code === 11 || code === 12 || code === 0x85 || code === 0x2028 || code === 0x2029) {
      if (code === 13 && content[utf16] === '\n') { utf16 += 1; byte += 1; }
      require(line !== point.line1); line += 1; column = 0;
    } else column += 1;
  }
  require(line === point.line1 && column === point.columnScalar0 && byte === point.byteOffset && utf16 === point.utf16Offset);
  return utf16;
}

// The only effect is the final local selection; reads never adopt a snapshot or queue work.
export async function navigateCompileDiagnostic(compilation, row, { context, read, digest, select }) {
  const stale = () => { throw { code: 'stale', message: 'The editor or compiler context changed. No source selection was applied.' }; };
  const first = context(), session = first.session, view = first.view, report = compilation.report, point = row?.locationCandidate;
  if (first.compilation !== compilation || !first.current || !report.captureComplete || report.truncated || !report.rows.includes(row) || !point || !session || !view) stale();
  const source = report.sourceCandidates.find(source => source.projectPath === point.projectPath && source.sourceDigest === point.sourceDigest);
  if (!source || point.projectPath !== session.path || report.provenance.project !== session.project || source.sourceEpoch !== session.sourceEpoch || !sourceRootsEqual(report.provenance, session)) stale();
  const binding = captureSourceBinding(session), state = view.state, generation = session.generation, version = session.version, revision = session.snapshot.review.revision;
  const intent = first.intent, navigation = first.navigation, logsVisible = first.logsVisible, logScrollTop = first.logScrollTop, logScrollLeft = first.logScrollLeft;
  const content = state.doc.toString(), scrollTop = view.scrollDOM.scrollTop, scrollLeft = view.scrollDOM.scrollLeft;
  const check = () => {
    const current = context();
    if (current.compilation !== compilation || !current.current || current.intent !== intent || current.navigation !== navigation || current.logsVisible !== logsVisible || current.logScrollTop !== logScrollTop || current.logScrollLeft !== logScrollLeft || current.session !== session || current.view !== view || !current.registered || current.pending || current.composing || current.closing || session.dirty || session.conflict || session.reviewProblem || session.identityProblem || session.uncertainMutation || session.unresolvedMove || session.pending || !sourceBindingCurrent(session, binding) || session.generation !== generation || session.version !== version || session.snapshot.review.revision !== revision || session.content !== content || view.state !== state || view.scrollDOM.scrollTop !== scrollTop || view.scrollDOM.scrollLeft !== scrollLeft) stale();
  };
  check();
  const snapshot = await read({ action: 'review', ...binding }); check(); assertSourceSnapshot(snapshot, binding);
  if (snapshot.documentId !== session.snapshot.documentId || snapshot.content !== content || snapshot.review.revision !== revision) stale();
  const [savedDigest, liveDigest] = await Promise.all([digest(snapshot.content), digest(content)]); check();
  if (savedDigest !== source.sourceDigest || liveDigest !== source.sourceDigest || snapshot.review.revision !== source.sourceDigest) stale();
  const offset = diagnosticOffset(content, point); check(); select(view, offset);
  return offset;
}
