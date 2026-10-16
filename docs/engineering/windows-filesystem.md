# Windows rooted files and saved History

The Windows implementation uses the existing capability-based filesystem APIs.
Volume serial and file index identify retained roots, parents and file entries;
regular files must have exactly one hard link. Windows reparse-point attributes
are rejected for source entries and every traversed project directory. Source
names must use the actual directory spelling when captured in saved History.
Source reads retain bounded exact bytes and digests alongside identity,
creation/write timestamps, length and read-only state. Windows does not expose
Unix ctime through this API; content digests remain part of every stale check.

Windows saves write sibling staging files with write-through enabled, flush the
file, validate the original observations, replace the entry, flush the retained
written handle again and verify the installed identity and exact bytes. History
catalogues and blobs are flushed through writable handles; read-only History
queries still open files read-only. Failed flushes or failed verification return
an error or the existing outcome-unknown state and preserve recovery evidence.

Unix continues to fsync parent directories. Windows has no equivalent portable
directory fsync in the safe standard/capability APIs used here. Its completion
contract is flushed file bytes plus checked namespace publication. It does not
promise that a rename, hard-link publication or journal deletion survives sudden
power loss with the same directory-entry guarantee as Unix. Journals, exact
ownership checks and explicit recovery remain necessary. No directory-flush
error is caught and converted to success. Verification targets local NTFS;
network shares and ReFS have not been qualified.
