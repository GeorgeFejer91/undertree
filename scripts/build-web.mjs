import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "web");
const output = path.join(root, "dist");
const pretext = path.join(root, "node_modules", "@chenglou", "pretext");

await rm(output, { recursive: true, force: true });
await cp(source, output, { recursive: true });
await mkdir(path.join(output, "vendor", "pretext"), { recursive: true });
await cp(path.join(pretext, "dist"), path.join(output, "vendor", "pretext"), { recursive: true });
await cp(path.join(pretext, "LICENSE"), path.join(output, "vendor", "pretext", "LICENSE"), { force: true });
