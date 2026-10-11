#!/usr/bin/env node
// Every extension's marketplace icon, `media/icon.png`: the BatleHub mark
// (scripts/batlehub-mark.svg, the cream rustacean of the BatleHub repository)
// on an ink tile. batlehub-vsx shows it as is; every other extension dims it
// to a watermark and draws its topic in cream inside the shelf, outlined in
// ink so the shelf lines do not run into it. Pixel art on a fixed grid, so
// the PNG is written by hand and the glyphs are text: no image dependency.
// `node scripts/icons.mjs [outDir]` writes to <outDir>/<extension>.png instead.
import { readFileSync, writeFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";

const GLYPHS = {
  clipboard: `
....####....
.####..####.
.##########.
.##......##.
.##.####.##.
.##......##.
.##.####.##.
.##......##.
.##.###..##.
.##......##.
.##########.
.##########.`,
  bell: `
.....##.....
....####....
...######...
..########..
..########..
..########..
..########..
.##########.
############
############
............
....####....`,
  terminal: `
............
##..........
.##.........
..##........
...##.......
..##........
.##.........
##..........
............
.....#######
.....#######
............`,
  moon: `
...######...
..#####.....
.#####......
#####.......
####........
####........
####........
####........
#####.......
.#####....#.
..#########.
...######...`,
  pumpkin: `
.....##.....
.....##.....
............
.##.####.##.
###.####.###
###.####.###
###.####.###
###.####.###
###.####.###
.##.####.##.
............
............`,
  hexagon: `
.....##.....
...######...
.####..####.
###......###
##..####..##
##.######.##
##.######.##
##..####..##
###......###
.####..####.
...######...
.....##.....`,
  cup: `
...#..#.....
...#..#.....
...#..#.....
............
#########...
#########.##
#########..#
#########.##
.#######....
..#####.....
............
###########.`,
  cupPlus: `
...#..#...#.
...#..#..###
...#..#...#.
............
#########...
#########.##
#########..#
#########.##
.#######....
..#####.....
............
###########.`,
  braces: `
..###..###..
.##......##.
.##......##.
.##......##.
.##......##.
##........##
##........##
.##......##.
.##......##.
.##......##.
.##......##.
..###..###..`,
  leaf: `
..........##
.......#####
.....#######
...#########
..######.###
.######.####
.#####.#####
.####.######
.###.######.
..#.######..
.#.######...
#...###.....`,
  Q: `
...######...
.##########.
###......###
##........##
##........##
##........##
##........##
##.....##.##
###.....####
.##########.
...######.##
..........##`,
  K: `
###.....###.
###....###..
###...###...
###..###....
###.###.....
######......
######......
###.###.....
###..###....
###...###...
###....###..
###.....###.`,
  G: `
...######...
.##########.
###......###
##..........
##..........
##...######.
##...######.
##.......###
###......###
.##########.
...########.
............`,
};

const ICONS = {
  "batlehub-vsx": null,
  "batlehub-theme": "moon",
  "batlehub-seasons": "pumpkin",
  "che-clipboard": "clipboard",
  "che-notify": "bell",
  "che-remote-ssh": "terminal",
  "che-pack": "hexagon",
  "java-core": "cup",
  "java-pack": "cupPlus",
  "java-pack-frameworks": "braces",
  "java-spring": "leaf",
  "java-quarkus": "Q",
  "java-kotlin": "K",
  "java-groovy": "G",
};

const N = 256;
const INK = [0x0e, 0x0c, 0x0a];
const CREAM = [0xf2, 0xe8, 0xdf];
const DIM = 0.3; // watermark opacity of the mark behind a glyph
const DIMMED = INK.map((a, i) => Math.round(a + (CREAM[i] - a) * DIM));

// The mark: 26×41 cells of 5 px, centred.
const MK = 5;
const mark = new Set();
for (const m of readFileSync(
  new URL("batlehub-mark.svg", import.meta.url),
  "utf8",
).matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"/g)) {
  const [x, y, w, h] = m.slice(1).map(Number);
  for (let i = 0; i < w; i++)
    for (let j = 0; j < h; j++) mark.add(`${x + i},${y + j}`);
}
const MOX = (N - 26 * MK) >> 1;
const MOY = (N - 41 * MK) >> 1;

// A glyph: 12×12 cells of 8 px, inside the shelf under the crab, with a one-cell ink outline.
const GK = 8;
const HALO = 1;

function pixels(glyph) {
  const g = glyph && GLYPHS[glyph].trim().split("\n");
  const on = (cx, cy) => g[cy]?.[cx] === "#";
  // Between a row's first and last lit cell is ink too, so the dimmed shelf never shows through a hollow glyph.
  const span = (cx, cy) =>
    g[cy] !== undefined &&
    cx > g[cy].indexOf("#") &&
    cx < g[cy].lastIndexOf("#");
  const gox = (N - 12 * GK) >> 1;
  const goy = ((N - 12 * GK) >> 1) + 22;
  const out = Buffer.alloc(N * (1 + 3 * N));
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let c = INK;
      const inMark =
        x >= MOX &&
        y >= MOY &&
        mark.has(`${Math.floor((x - MOX) / MK)},${Math.floor((y - MOY) / MK)}`);
      if (!g) c = inMark ? CREAM : INK;
      else {
        const cx = Math.floor((x - gox) / GK);
        const cy = Math.floor((y - goy) / GK);
        let halo = false;
        for (let dx = -HALO; dx <= HALO && !halo; dx++)
          for (let dy = -HALO; dy <= HALO && !halo; dy++)
            halo = on(cx + dx, cy + dy);
        c = on(cx, cy)
          ? CREAM
          : halo || span(cx, cy)
            ? INK
            : inMark
              ? DIMMED
              : INK;
      }
      out.set(c, y * (1 + 3 * N) + 1 + 3 * x);
    }
  }
  return out;
}

function png(raw) {
  const chunk = (type, data) => {
    const td = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(N, 0);
  ihdr.writeUInt32BE(N, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB, no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const outDir = process.argv[2];
for (const [ext, glyph] of Object.entries(ICONS)) {
  const path = outDir
    ? `${outDir}/${ext}.png`
    : `extensions/${ext}/media/icon.png`;
  writeFileSync(path, png(pixels(glyph)));
  console.log(`${ext}: ${glyph ?? "mark"} -> ${path}`);
}
