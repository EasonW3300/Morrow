/**
 * 生成应用图标源图（1024x1024 PNG，RGBA）——纯 Node 实现，无外部依赖。
 * 产物 scripts/icon-source.png 交给 `tauri icon` 派生全平台尺寸。
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SIZE = 1024;

// --- PNG 编码 ---------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- 绘制：深蓝渐变圆角底 + 白色粗描 "M" -------------------------------------
const px = Buffer.alloc(SIZE * SIZE * 4);

function distToSegment(pxp, pyp, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = pxp - ax;
  const apy = pyp - ay;
  const len2 = abx * abx + aby * aby;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (apx * abx + apy * aby) / len2));
  const dx = pxp - (ax + t * abx);
  const dy = pyp - (ay + t * aby);
  return Math.hypot(dx, dy);
}

const STROKES = [
  [382, 342, 382, 682], // 左竖
  [382, 342, 512, 562], // 左斜
  [512, 562, 642, 342], // 右斜
  [642, 342, 642, 682], // 右竖
];
const HALF_STROKE = 36;
const RADIUS = 180;

for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    const i = (y * SIZE + x) * 4;
    // 圆角矩形内外判定（带 1px 抗锯齿过渡）
    const cx = Math.max(RADIUS - x, x - (SIZE - 1 - RADIUS), 0);
    const cy = Math.max(RADIUS - y, y - (SIZE - 1 - RADIUS), 0);
    const cornerDist = Math.hypot(cx, cy);
    let alpha = cornerDist <= RADIUS - 1 ? 255 : cornerDist >= RADIUS + 1 ? 0 : (RADIUS + 1 - cornerDist) * 127;

    const t = y / SIZE;
    const r = Math.round(11 + (18 - 11) * t);
    const g = Math.round(18 + (77 - 18) * t);
    const b = Math.round(32 + (158 - 32) * t);
    let color = [r, g, b];

    for (const [ax, ay, bx, by] of STROKES) {
      if (distToSegment(x, y, ax, ay, bx, by) < HALF_STROKE) {
        color = [245, 248, 255];
        break;
      }
    }
    px[i] = color[0];
    px[i + 1] = color[1];
    px[i + 2] = color[2];
    px[i + 3] = alpha;
  }
}

const out = join(dirname(fileURLToPath(import.meta.url)), "icon-source.png");
writeFileSync(out, encodePng(SIZE, SIZE, px));
console.log(`written: ${out}`);
