# Secret Tunnel card fixture

This test-only fixture is the exact static `CHAT_CONTROL_HTML` string from
`app/vendor/gpt-repo-mcp/src/chat-control-widget.ts` in the user's SecretTunnel-v2
checkout on 2026-10-16. The checkout was at `d1da8d0d0beb164a379f5535455a634dcb8916fe`,
but this generated source was an untracked local addition; do not attribute its
bytes to that commit. Generated source SHA-256:
`cb6a95750c74511e613fd51788c4f5ec0cec7198bf398e3e917598ccb97269e0`.

The 68,512-byte extracted HTML has SHA-256
`7e35bfaad18493b22beaf10653863c1548082d03507dda8f29f3aa19bf06f78d`.
It matches the static widget string in the installed Secret Tunnel 6 MCP
`dist/server.js`, whose SHA-256 is
`16bcfa8e084f3f6a5ae9f860cec234ab4d22387130868d335299e690d77df4e9`.
Only the static string was extracted; the server, profile and credentials were
not executed or read for this comparison.

Secret Tunnel's MIT license and George Fejer copyright are retained in
[SecretTunnel-LICENSE.txt](SecretTunnel-LICENSE.txt). The HTML retains its bundled
Pretext MIT notice. This fixture is used only by tests, is excluded from runtime
and installer resources, and is preserved as exact bytes by `.gitattributes`.
Updating it and the native gateway's accepted digest requires deliberate source,
license and bridge review; a matching app-supplied URI alone is insufficient.
