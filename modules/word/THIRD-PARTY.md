# Third-party components

wrAIter for Word uses Windows/.NET Framework and the installed Microsoft Word
COM object model. Neither Microsoft Word nor a separate Office distribution is
included. The add-in sources use only framework libraries; no NuGet package is
required at runtime.

The installer includes zrok2 2.0.4 (upstream build 6ff92039), from
https://github.com/openziti/zrok, under the Apache License, Version 2.0. Its
license is included as `zrok-LICENSE`. Payload hashes are recorded in
`build-manifest.json`. zrok/OpenZiti transitive dependencies retain their
respective upstream licenses; the upstream module metadata is available in the
source release and through `go version -m runtime/zrok.exe`.

The selective-editor contract is shared with UnderTree and wrAIter; it grants
no access to their private connection profiles or runtime processes.
