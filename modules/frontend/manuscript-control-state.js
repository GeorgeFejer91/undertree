import { captureSourceBinding, sourceBindingCurrent, sourceEpoch, sourceRootsEqual } from './review-session.js';

const fail = (code, message) => { throw { code, message }; };

export function captureControlState(context) {
  return { ...context, sessions: [...context.sessions].map(session => ({ session, binding: captureSourceBinding(session), identityProblem: session.identityProblem, generation: session.generation, version: session.version, revision: session.snapshot.review.revision, queue: session.queue, conflict: session.conflict, reviewProblem: session.reviewProblem })) };
}

export function assertControlState(captured, context, { clean = false, allowClosing = false } = {}) {
  const sessions = [...context.sessions];
  if ((!allowClosing && context.closing) || context.composing || context.pending || sessions.some(session => session.pending || session.uncertainMutation || session.unresolvedMove)) fail('busy', 'Finish local operations and text composition before applying app controls.');
  if (clean && sessions.some(session => session.dirty || session.conflict || session.reviewProblem || session.identityProblem)) fail('busy', 'Save or resolve every local buffer before this app control.');
  if (captured.navigation !== context.navigation || captured.requestsVersion !== context.requestsVersion || captured.active !== context.active || captured.sessions.length !== sessions.length) fail('stale', 'The local workspace changed while preparing this app control.');
  for (let index = 0; index < sessions.length; index += 1) {
    const before = captured.sessions[index], session = sessions[index];
    if (before.session !== session || !sourceBindingCurrent(session, before.binding) || before.identityProblem !== session.identityProblem || before.generation !== session.generation || before.version !== session.version || before.revision !== session.snapshot.review.revision || before.queue !== session.queue || before.conflict !== session.conflict || before.reviewProblem !== session.reviewProblem) fail('stale', 'A local manuscript changed while preparing this app control.');
  }
}

export function assertControlPassage(session, command) {
  if (!sourceBindingCurrent(session, captureSourceBinding(session)) || session.snapshot.documentId !== command.documentId || session.snapshot.review.revision !== command.revision || session.dirty || session.conflict || session.content.slice(command.from, command.to) !== command.quote) fail('stale', 'The saved passage no longer matches the active source.');
}

export function controlPreviewIdentity({ active, shared, pdf, pdfPath, publicationPath, generation, pdfSourceEpoch = 0, pdfProject = active?.project, pdfRoot = {} }) {
  if (!active || pdfProject !== active.project || !sourceBindingCurrent(active, captureSourceBinding(active)) || sourceEpoch({ sourceEpoch: pdfSourceEpoch }) !== sourceEpoch(active) || !sourceRootsEqual(active, pdfRoot) || !shared || !pdf || !pdfPath || pdfPath !== active.path || publicationPath !== pdfPath) return null;
  return { session: active, binding: captureSourceBinding(active), documentId: active.snapshot.documentId, pdf, path: pdfPath, generation };
}

export function assertControlPreview(captured, current) {
  if (!captured || !current || !sourceBindingCurrent(current.session, captured.binding) || captured.session !== current.session || captured.documentId !== current.documentId || captured.pdf !== current.pdf || captured.path !== current.path || captured.generation !== current.generation) fail('stale', 'The explicitly shared manuscript PDF changed while preparing its view.');
}
