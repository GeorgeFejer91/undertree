// Electron starts this entry point in a utility process. Keeping the service
// import here prevents filesystem, parsing, search, ZIP, and TeX orchestration
// from sharing the native window process event loop.
await import("../../server.mjs");
