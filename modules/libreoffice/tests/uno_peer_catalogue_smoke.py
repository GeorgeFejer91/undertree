"""Installed Writer peer aliases retain native color-only authority and health."""
import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import time
from urllib.request import Request, urlopen

import uno

sys.path.insert(0, os.environ['UNDERTREE_WRITER_EXTENSION_SOURCE'])
from undertree_mcp import Endpoint
from undertree_peers import PeerConnections
from undertree_writer import Session
from undertree_ui import Panel


def denied(operation):
    try:
        operation()
    except ValueError:
        return
    raise AssertionError('A closed alias request unexpectedly succeeded.')


def run(context, output, profile):
    paths = context.ServiceManager.createInstanceWithContext('com.sun.star.util.PathSubstitution', context)
    assert Path(uno.fileUrlToSystemPath(paths.substituteVariables('$(user)', True))).resolve() == profile / 'user'
    desktop = context.ServiceManager.createInstanceWithContext('com.sun.star.frame.Desktop', context)
    document = desktop.loadComponentFromURL('private:factory/swriter', '_blank', 0, ())
    original = 'Fixture (One).'
    document.Text.String = original
    session = Session(context, document)
    native_errors = []
    original_dispatch = session.dispatch
    def observed_dispatch(name, arguments, endpoint):
        try:
            return original_dispatch(name, arguments, endpoint)
        except Exception as error:
            native_errors.append(str(error))
            raise
    session.dispatch = observed_dispatch
    peers = None
    bridge = None
    temporary = None
    checks = []
    refused_reads = []
    try:
        session.panel = Panel(session)
        session.set_shared(True)
        target = session.start()
        session.panel.refresh()
        session.panel.dialog.toFront()
        session.panel.control('connections').setFocus()
        time.sleep(.5)
        temporary = tempfile.TemporaryDirectory(dir=profile, prefix='peer-qualification-')
        peers = PeerConnections(Path(temporary.name))
        receipt = peers.link(target).result(5)
        assert receipt['toolCount'] == 4
        tools = peers.tools()
        alias = lambda native: next(tool['name'] for tool in tools if tool['name'].endswith('_' + native))
        bridge = Endpoint(lambda *_: {}, extra_tools=peers.tools, extra_dispatch=peers.call)
        request = Request(bridge.url, data=json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list', 'params': {}}).encode(),
                          headers={'Content-Type': 'application/json'})
        with urlopen(request, timeout=5) as response:
            catalogue = json.load(response)['result']['tools']
        advertised = next(tool for tool in catalogue if tool['name'] == alias('highlight_text'))
        assert advertised['annotations'] == {'readOnlyHint': False, 'destructiveHint': False, 'idempotentHint': True}
        assert len(catalogue) == 8
        checks.append('serialized_four_native_and_four_paired_tools_color_mutation_hints')

        def read():
            for attempt in range(5):
                result = peers.call(alias('read_manuscript'), {'documentId': session.document_id})
                if not result.get('isError'):
                    assert result['structuredContent']['content'] == original
                    return result['structuredContent']
                assert native_errors and native_errors[-1] in (
                    'Writer access changed or request expired.',
                    'Document or sharing changed during the context read. Retrieve the complete context again.'), (result, native_errors)
                refused_reads.append(native_errors[-1])
                time.sleep(.2)
            raise AssertionError(('Native complete context never stabilized.', refused_reads))

        current = read()
        marking = {'documentId': session.document_id, 'marking': {
            'requestId': 'paired-color', 'contextId': current['contextId'], 'revision': current['revision'],
            'ranges': [{'from': 8, 'to': 13, 'quote': '(One)'}]}}
        invalid = copy.deepcopy(marking)
        invalid['marking']['action'] = 'protect'
        denied(lambda: peers.call(alias('highlight_text'), invalid))
        assert not session.data['marks']
        read()
        invalid = copy.deepcopy(marking)
        invalid['marking']['requestId'] = 'bad-native-quote'
        invalid['marking']['ranges'][0]['quote'] = '(Bad)'
        assert peers.call(alias('highlight_text'), invalid)['isError']
        assert not session.data['marks']
        current = read()
        checks.append('closed_remote_function_and_actual_native_quote_denials_leave_read_healthy')

        marking['marking'].update(contextId=current['contextId'], revision=current['revision'])
        colored = peers.call(alias('highlight_text'), marking)
        assert not colored.get('isError') and len(session.data['marks']) == 1
        assert peers.call(alias('highlight_text'), copy.deepcopy(marking)) == colored
        assert len(session.data['marks']) == 1 and document.Text.String == original
        changed = copy.deepcopy(marking)
        changed['marking']['ranges'][0]['quote'] = '(Two)'
        denied(lambda: peers.call(alias('highlight_text'), changed))
        current = read()
        proposal = {'documentId': session.document_id, 'proposal': {
            'requestId': 'no-neutral-edit', 'contextId': current['contextId'], 'revision': current['revision'],
            'from': 8, 'to': 13, 'quote': '(One)', 'replacement': 'changed', 'rationale': 'must remain color only'}}
        assert peers.call(alias('suggest_text'), proposal)['isError']
        read()
        checks.append('native_neutral_mark_exact_replay_changed_id_denial_and_zero_edit_coverage')

        color = colored['structuredContent']['colorId']
        session.save_rule(color, dict(session.data['rules'][color], action='protect'))
        current = read()
        reuse = copy.deepcopy(marking)
        reuse['marking'].update(requestId='cannot-bind-protect', contextId=current['contextId'], revision=current['revision'], colorId=color)
        assert peers.call(alias('highlight_text'), reuse)['isError']
        read()
        assert document.Text.String == original and len(session.data['marks']) == 1
        checks.append('local_user_assignment_invalidates_neutral_reuse_without_poisoning_read')

        session.set_shared(False)
        assert peers.call(alias('read_manuscript'), {'documentId': session.document_id})['isError']
        peers.unlink(receipt['id'])
        denied(lambda: peers.call(alias('highlight_text'), marking))
        assert not peers.tools() and document.Text.String == original
        assert not document.getURL()
        checks.append('native_share_revocation_and_local_unlink_revoke_aliases_without_save')
        output.write_text(json.dumps({'status': 'passed', 'checks': checks,
            'installedSource': os.environ['UNDERTREE_WRITER_EXTENSION_SOURCE'], 'documentSaved': bool(document.getURL()),
            'sourceTextUnchanged': True, 'preEffectContextRefusals': refused_reads, 'normalProfileTouched': False}, indent=2))
        print('PASS: ' + ', '.join(checks), flush=True)
    finally:
        if bridge:
            bridge.close()
            assert bridge.wait_closed()
        if peers:
            peers.close()
        if temporary:
            temporary.cleanup()
        session.close()
        document.setModified(False)
        document.close(True)


if __name__ == '__main__':
    port, output, profile = int(sys.argv[1]), Path(sys.argv[2]).resolve(), Path(sys.argv[3]).resolve()
    assert port != 2130
    local = uno.getComponentContext()
    resolver = local.ServiceManager.createInstanceWithContext('com.sun.star.bridge.UnoUrlResolver', local)
    context = resolver.resolve('uno:socket,host=127.0.0.1,port=%d;urp;StarOffice.ComponentContext' % port)
    run(context, output, profile)
