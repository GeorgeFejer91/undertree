# Compiler module

Compiler discovery, local-service hosting, TeX process lifecycle, and future persistent `latexmk` sessions live here. Platform shells start this module but do not absorb its work into their UI process.

MiKTeX and TeX Live are external toolchains discovered through `latexmk`.
TeXstudio is an optional external editor, not a compiler runtime dependency;
UnderTree neither embeds it nor couples its realtime scheduler to TeXstudio.
