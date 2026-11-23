#!/usr/bin/env node
// The `tabellar` command. A source checkout runs the TypeScript in server/
// directly; the npm package only holds the same files built to dist/.
import { existsSync } from "node:fs";

const source = new URL("../server/tabellar.ts", import.meta.url);
await import(existsSync(source) ? source.href : new URL("../dist/tabellar.js", import.meta.url).href);
