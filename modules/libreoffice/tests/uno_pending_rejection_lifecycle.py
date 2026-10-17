"""Rejecting P survives native Undo/Redo of an unrelated protected rewrite Q.

Run with LibreOffice Python, UNDERTREE_WRITER_EXTENSION_SOURCE pointing to an
installed package, and a disposable --accept socket/profile. No package rebuild.
"""
import copy
import hashlib
import json
import os
from pathlib import Path
import sys
import time

import uno
from com.sun.star.connection import NoConnectException

sys.path.insert(0, os.environ['UNDERTREE_WRITER_EXTENSION_SOURCE'])
import undertree_writer
from undertree_policy import defaults, utf16_length
from undertree_writer import PROPERTY, Session, property_value


def select(document, quote):
    search = document.createSearchDescriptor()
    search.SearchString, search.SearchCaseSensitive = quote, True
    found = document.findFirst(search)
    assert found is not None and found.String == quote
    document.CurrentController.select(found)


def read(session):
    return session.call('read_manuscript', {'documentId': session.document_id})


def proposal(session, snapshot, quote, request_id, replacement='', parts=None):
    start = snapshot['content'].index(quote)
    arguments = {'documentId': session.document_id, 'proposal': {
        'requestId': request_id, 'contextId': snapshot['contextId'],
        'revision': snapshot['revision'], 'from': utf16_length(snapshot['content'][:start]),
        'to': utf16_length(snapshot['content'][:start] + quote),
        'quote': quote, 'replacement': replacement, 'rationale': 'Native rejection lifecycle regression',
    }}
    if parts is not None:
        arguments['proposal']['replacementParts'] = parts
    return arguments


def denied(operation):
    try:
        operation()
    except ValueError:
        return
    raise AssertionError('Old complete-context authority unexpectedly survived a new grant.')


def check_pending(session, expected):
    raw = session.document.DocumentProperties.UserDefinedProperties.getPropertyValue(PROPERTY)
    disk = json.loads(raw)
    state = {
        'memory': sorted(session.pending),
        'sessionMetadata': sorted(record['proposal']['requestId'] for record in session.data['pending']),
        'nativeMetadata': sorted(record['proposal']['requestId'] for record in disk['pending']),
    }
    assert all(value == sorted(expected) for value in state.values()), state
    return state


def run_mode(context, output, mode):
    desktop = context.ServiceManager.createInstanceWithContext('com.sun.star.frame.Desktop', context)
    document = desktop.loadComponentFromURL('private:factory/swriter', '_blank', 0, ())
    session = None
    states = []
    p = 'Pending wording stays.'
    q = 'Rewrite [A] then [B].'
    original = p + '\n' + q + '\nUntouched footer.'
    rewritten = p + '\nChanged [B] before [A].\nUntouched footer.'
    request_id = 'pending-P-' + mode
    try:
        document.Text.String = original
        session = Session(context, document)
        select(document, p)
        session.mark_selection('snappier')
        session.save_rule('rewrite-q', dict(defaults()['rules']['snappier'], mode=mode))
        for quote in ('[A]', '[B]'):
            select(document, quote)
            session.mark_selection('protect')
        select(document, q)
        session.mark_selection('rewrite-q')
        session.set_shared(True)

        old_p = proposal(session, read(session), p, request_id, 'P must never appear without a fresh submission.')
        assert session.call('suggest_text', old_p)['status'] == 'pending_local_approval'
        assert document.Text.String == original
        check_pending(session, [request_id])
        current = read(session)
        units = {mark['text']: mark['id'] for mark in current['markers'] if mark['action'] == 'protect'}
        rewrite = proposal(session, current, q, 'rewrite-Q-' + mode, parts=[
            {'text': 'Changed '}, {'protectedId': units['[B]']},
            {'text': ' before '}, {'protectedId': units['[A]']}, {'text': '.'},
        ])
        result = session.call('suggest_text', rewrite)
        if mode == 'suggestion':
            assert result['status'] == 'pending_local_approval'
            assert document.Text.String == original
            session.accept(rewrite['proposal']['requestId'])
        else:
            assert result['status'] == 'applied'
        assert document.Text.String == rewritten
        check_pending(session, [request_id])
        title = document.UndoManager.getCurrentUndoActionTitle()
        assert title.startswith('wrAIter: apply marked edit '), title

        session.reject(request_id)
        assert document.UndoManager.getCurrentUndoActionTitle() == title
        for stage, expected in (('rejected-after-Q', rewritten), ('undo-Q', original), ('redo-Q', rewritten)):
            if stage == 'undo-Q':
                document.UndoManager.undo()
            elif stage == 'redo-Q':
                document.UndoManager.redo()
            assert document.Text.String == expected
            state = check_pending(session, [])
            replay = session.call('suggest_text', copy.deepcopy(old_p))
            assert replay['status'] == 'rejected_locally' and replay['replayed']
            assert not replay['documentChanged'] and document.Text.String == expected
            for quote, marker_id in units.items():
                assert document.Bookmarks.getByName(marker_id).Anchor.String == quote
            states.append({'stage': stage, 'pending': state, 'sameGrantReplay': 'rejected_locally',
                           'nativeProtectedIdsIntact': True})

        destination = output.with_name(output.stem + '-' + mode + '.odt')
        document.storeAsURL(uno.systemPathToFileUrl(str(destination)),
                            (property_value('FilterName', 'writer8'),))
        session.close()
        session = None
        document.close(True)
        document = desktop.loadComponentFromURL(uno.systemPathToFileUrl(str(destination)), '_blank', 0, ())
        session = Session(context, document)
        assert not session.shared and document.Text.String == rewritten
        state = check_pending(session, [])
        assert all(document.Bookmarks.getByName(marker_id).Anchor.String == quote for quote, marker_id in units.items())
        states.append({'stage': 'save-reopen', 'pending': state, 'consentRestored': False,
                       'nativeProtectedIdsIntact': True})

        session.set_shared(True)
        denied(lambda: session.call('suggest_text', copy.deepcopy(old_p)))
        assert not session.pending and document.Text.String == rewritten
        fresh_p = proposal(session, read(session), p, request_id, old_p['proposal']['replacement'])
        assert session.call('suggest_text', fresh_p)['status'] == 'pending_local_approval'
        check_pending(session, [request_id])
        assert document.Text.String == rewritten
        session.reject(request_id)
        check_pending(session, [])
        states.append({'stage': 'fresh-grant', 'oldContextDenied': True,
                       'sameRequestIdWithFreshContext': 'new pending proposal, explicitly rejected locally'})
        document.store()
        return {'mode': mode, 'status': 'passed', 'states': states,
                'document': str(destination), 'documentSha256': hashlib.sha256(destination.read_bytes()).hexdigest()}
    finally:
        if session:
            session.close()
        # Only this function's newly created synthetic fixture may be discarded.
        document.setModified(False)
        try:
            document.close(True)
        except Exception:
            document.dispose()


if __name__ == '__main__':
    port, output, profile = int(sys.argv[1]), Path(sys.argv[2]).resolve(), Path(sys.argv[3]).resolve()
    local = uno.getComponentContext()
    resolver = local.ServiceManager.createInstanceWithContext('com.sun.star.bridge.UnoUrlResolver', local)
    deadline = time.monotonic() + 45
    while True:
        try:
            context = resolver.resolve('uno:socket,host=127.0.0.1,port=%d;urp;StarOffice.ComponentContext' % port)
            break
        except NoConnectException:
            if time.monotonic() >= deadline:
                raise
            time.sleep(.2)
    substitution = context.ServiceManager.createInstanceWithContext('com.sun.star.util.PathSubstitution', context)
    actual = Path(uno.fileUrlToSystemPath(substitution.substituteVariables('$(user)', True))).resolve()
    assert actual == profile / 'user' and port != 2130
    source = Path(undertree_writer.__file__).resolve()
    assert source.is_relative_to(profile)
    modes = [run_mode(context, output, mode) for mode in ('direct', 'suggestion')]
    result = {'status': 'passed', 'port': port, 'profileUser': str(actual), 'installedWriterSource': str(source),
              'writerSourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(), 'modes': modes,
              'normalProfileTouched': False, 'runtimeChanged': False}
    output.write_text(json.dumps(result, indent=2))
    print('PASS: rejected P stays absent after protected Q native Undo, Redo, save/reopen; both direct and locally approved Q; old-context denied and new receipt epoch permitted.', flush=True)
