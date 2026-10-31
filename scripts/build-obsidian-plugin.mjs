#!/usr/bin/env node
/**
 * Builds Vane for Obsidian: bundles integrations/obsidian/src/main.ts into integrations/obsidian/main.js and packs the three files
 * Obsidian needs (manifest.json, main.js, styles.css) into public/downloads/vane-for-obsidian.zip, inside a folder called `vane`
 * (unzip it into <vault>/.obsidian/plugins/). The zip is byte-for-byte reproducible: fixed dates, fixed order.
 *
 *   npm run build:obsidian            write main.js and the zip
 *   node scripts/build-obsidian-plugin.mjs --check   fail when either is out of date (runs in `npm run test:unit`)
 *
 * The type-check of the plugin needs the `obsidian` package: run `npm install` in integrations/obsidian, then `npm run typecheck` there.
 */
import { build } from 'esbuild';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';

const DIR = 'integrations/obsidian';
const ZIP = 'public/downloads/vane-for-obsidian.zip';
const check = process.argv.includes('--check');

const out = await build({
  entryPoints: [`${DIR}/src/main.ts`], bundle: true, write: false, format: 'cjs', platform: 'browser', target: 'es2018',
  external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*'], logLevel: 'silent', legalComments: 'none',
});
const banner = '/* Vane for Obsidian: built from integrations/obsidian/src by `npm run build:obsidian`. Source: https://github.com/ULTRAAAA3000/vaneapp */\n';
const mainJs = Buffer.from(banner + out.outputFiles[0].text, 'utf8');

const files = [
  ['vane/manifest.json', readFileSync(`${DIR}/manifest.json`)],
  ['vane/main.js', mainJs],
  ['vane/styles.css', readFileSync(`${DIR}/styles.css`)],
];

// ── a small, deterministic ZIP writer (deflate)
const TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = TABLE[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const DOS_TIME = 0, DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;      // 2026-01-01 00:00
function zip(entries) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, 'utf8'), packed = deflateRawSync(data, { level: 9 }), crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(8, 8);
    head.writeUInt16LE(DOS_TIME, 10); head.writeUInt16LE(DOS_DATE, 12); head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(nameBuf.length, 26);
    local.push(head, nameBuf, packed);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(DOS_TIME, 12); cen.writeUInt16LE(DOS_DATE, 14); cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(packed.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += head.length + nameBuf.length + packed.length;
  }
  const cenBuf = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cenBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cenBuf, end]);
}
const zipBuf = zip(files);

if (check) {
  const stale = [];
  if (!existsSync(`${DIR}/main.js`) || !readFileSync(`${DIR}/main.js`).equals(mainJs)) stale.push(`${DIR}/main.js`);
  if (!existsSync(ZIP) || !readFileSync(ZIP).equals(zipBuf)) stale.push(ZIP);
  if (stale.length) { console.error(`out of date: ${stale.join(', ')}. Run: npm run build:obsidian`); process.exit(1); }
  console.log('obsidian plugin build is current');
} else {
  writeFileSync(`${DIR}/main.js`, mainJs);
  writeFileSync(ZIP, zipBuf);
  console.log(`wrote ${DIR}/main.js (${mainJs.length} bytes) and ${ZIP} (${zipBuf.length} bytes)`);
}
