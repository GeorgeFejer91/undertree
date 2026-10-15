const fail = (code, message) => { throw { code, message }; };

export function captureControlState(context) {
  return { ...context, sessions: [...context.sessions].map(session => ({ session, generation: session.generation, version: session.version, revision: session.snapshot.review.revision, queue: session.queue, conflict: session.conflict, reviewProblem: session.reviewProblem })) };
}

export function assertControlState(captured, context, { clean = false, allowClosing = false } = {}) {
  const sessions = [...context.sessions];
  if ((!allowClosing && context.closing) || context.composing || context.pending || sessions.some(session => session.pending)) fail('busy', 'Finish local operations and text composition before applying app controls.');
  if (clean && sessions.some(session => session.dirty || session.conflict || session.reviewProblem)) fail('busy', 'Save or resolve every local buffer before this app control.');
  if (captured.navigation !== context.navigation || captured.requestsVersion !== context.requestsVersion || captured.active !== context.active || captured.sessions.length !== sessions.length) fail('stale', 'The local workspace changed while preparing this app control.');
  for (let index = 0; index < sessions.length; index += 1) {
    const before = captured.sessions[index], session = sessions[index];
    if (before.session !== session || before.generation !== session.generation || before.version !== session.version || before.revision !== session.snapshot.review.revision || before.queue !== session.queue || before.conflict !== session.conflict || before.reviewProblem !== session.reviewProblem) fail('stale', 'A local manuscript changed while preparing this app control.');
  }
}

export function assertControlPassage(session, command) {
  if (session.snapshot.documentId !== command.documentId || session.snapshot.review.revision !== command.revision || session.dirty || session.conflict || session.content.slice(command.from, command.to) !== command.quote) fail('stale', 'The saved passage no longer matches the active source.');
}

export function controlPreviewIdentity({ active, shared, pdf, pdfPath, publicationPath, generation }) {
  if (!active || !shared || !pdf || !pdfPath || pdfPath !== active.path || publicationPath !== pdfPath) return null;
  return { session: active, documentId: active.snapshot.documentId, pdf, path: pdfPath, generation };
}

export function assertControlPreview(captured, current) {
  if (!captured || !current || captured.session !== current.session || captured.documentId !== current.documentId || captured.pdf !== current.pdf || captured.path !== current.path || captured.generation !== current.generation) fail('stale', 'The explicitly shared manuscript PDF changed while preparing its view.');
}
