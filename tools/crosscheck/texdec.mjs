import { readFileSync, writeFileSync } from 'node:fs';
import { decodeTexture } from '../../src/texture.js';
const [, , inp, outp, w, h, fmt] = process.argv;
writeFileSync(outp, decodeTexture(Number(w), Number(h), Number(fmt), readFileSync(inp)));
