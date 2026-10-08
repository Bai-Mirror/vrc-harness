#!/usr/bin/env node
import { existsSync } from 'node:fs';

// A source checkout runs the TypeScript directly; the packed package ships only the compiled dist/.
const source = new URL('../src/cli.ts', import.meta.url);
const { main } = await import(existsSync(source) ? source.href : new URL('../dist/cli.js', import.meta.url).href);

try { await main(); }
catch (error) { console.error(`avh: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
