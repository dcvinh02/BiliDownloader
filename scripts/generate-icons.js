/**
 * Tạo icon ứng dụng (SVG, PNG 512x512, ICO đa kích thước cho Windows 10/11)
 * Không phụ thuộc thư viện native ngoài Node.js built-in (fs, path, zlib).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const ASSETS_DIR = path.join(__dirname, '..', 'assets');

// Bảng CRC32 cho chuẩn PNG
const CRC_TABLE = (() => {
  const tbl = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    tbl[n] = c >>> 0;
  }
  return tbl;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  const combined = Buffer.concat([typeBuf, data]);
  crcBuf.writeUInt32BE(crc32(combined), 0);
  return Buffer.concat([lenBuf, combined, crcBuf]);
}

function encodePngRgba(width, height, rgba) {
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0; // filter None
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function sdRoundedBox(px, py, cx, cy, hw, hh, r) {
  const dx = Math.abs(px - cx) - hw + r;
  const dy = Math.abs(py - cy) - hh + r;
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - r;
}

function sdSegment(px, py, ax, ay, bx, by, r) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = clamp01((pax * bax + pay * bay) / (bax * bax + bay * bay));
  return Math.hypot(pax - bax * h, pay - bay * h) - r;
}

function sdTriangleDown(px, py, cx, topY, halfW, height) {
  // Tam giác chỉ xuống gọn gàng (làm đầu mũi tên tải)
  const localY = (py - topY) / height;
  if (localY < 0) return topY - py;
  if (localY > 1) return py - (topY + height);
  const maxW = halfW * (1 - localY);
  return Math.abs(px - cx) - maxW;
}

function blendPixel(buf, idx, r, g, b, alpha) {
  const a = clamp01(alpha);
  if (a <= 0) return;
  const inv = 1 - a;
  buf[idx] = Math.round(buf[idx] * inv + r * a);
  buf[idx + 1] = Math.round(buf[idx + 1] * inv + g * a);
  buf[idx + 2] = Math.round(buf[idx + 2] * inv + b * a);
  buf[idx + 3] = Math.round(Math.min(255, buf[idx + 3] + a * 255 * (1 - buf[idx + 3] / 255)));
}

function renderIconBuffer(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const aa = 1.35 / size;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const idx = (y * size + x) * 4;

      // Nền bo tròn trung tính đậm (slate navy -> carbon)
      const bgDist = sdRoundedBox(u, v, 0.5, 0.5, 0.44, 0.44, 0.14);
      const bgAlpha = 1 - smoothstep(-aa, aa, bgDist);
      if (bgAlpha <= 0) continue;

      const grad = clamp01((u * 0.45 + v * 0.75));
      const bgR = Math.round(18 + grad * 14);
      const bgG = Math.round(25 + grad * 18);
      const bgB = Math.round(38 + grad * 28);

      rgba[idx] = bgR;
      rgba[idx + 1] = bgG;
      rgba[idx + 2] = bgB;
      rgba[idx + 3] = Math.round(bgAlpha * 255);

      // Viền nhấn subtle
      const borderDist = Math.abs(bgDist + 0.008) - 0.006;
      const borderAlpha = (1 - smoothstep(-aa, aa, borderDist)) * bgAlpha * 0.45;
      blendPixel(rgba, idx, 88, 180, 235, borderAlpha);

      // Anten TV đặc trưng (trái & phải)
      const antL = sdSegment(u, v, 0.34, 0.21, 0.43, 0.31, 0.022);
      const antR = sdSegment(u, v, 0.66, 0.21, 0.57, 0.31, 0.022);
      const antDist = Math.min(antL, antR);
      const antAlpha = 1 - smoothstep(-aa, aa, antDist);
      blendPixel(rgba, idx, 0, 174, 236, antAlpha * bgAlpha);

      // Khung TV bo tròn (viền xanh Bilibili #00AEEC -> #FB7299 nhẹ)
      const tvOuter = sdRoundedBox(u, v, 0.5, 0.54, 0.28, 0.22, 0.07);
      const tvInner = sdRoundedBox(u, v, 0.5, 0.54, 0.232, 0.172, 0.042);
      const tvFrameDist = Math.max(tvOuter, -tvInner);
      const tvAlpha = 1 - smoothstep(-aa, aa, tvFrameDist);
      const tvMix = clamp01((u - 0.22) / 0.56);
      const fR = Math.round(0 + tvMix * 245);
      const fG = Math.round(174 - tvMix * 60);
      const fB = Math.round(236 - tvMix * 83);
      blendPixel(rgba, idx, fR, fG, fB, tvAlpha * bgAlpha);

      // Mũi tên tải xuống trắng sắc nét ở trung tâm màn hình
      const stem = sdRoundedBox(u, v, 0.5, 0.49, 0.036, 0.072, 0.014);
      const head = sdTriangleDown(u, v, 0.5, 0.545, 0.115, 0.095);
      const tray = sdRoundedBox(u, v, 0.5, 0.665, 0.125, 0.018, 0.009);
      const glyphDist = Math.min(stem, head, tray);
      const glyphAlpha = 1 - smoothstep(-aa, aa, glyphDist);
      blendPixel(rgba, idx, 248, 250, 252, glyphAlpha * bgAlpha);
    }
  }
  return rgba;
}

function buildIcoFromPngs(pngEntries) {
  // ICONDIR header: 6 bytes
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = 1 (ICO)
  header.writeUInt16LE(pngEntries.length, 4);

  const dirEntries = [];
  let offset = 6 + pngEntries.length * 16;

  for (const { size, png } of pngEntries) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0; // palette
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bpp
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    dirEntries.push(entry);
    offset += png.length;
  }

  return Buffer.concat([header, ...dirEntries, ...pngEntries.map((e) => e.png)]);
}

function generateAllIcons() {
  fs.mkdirSync(ASSETS_DIR, { recursive: true });

  const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#121926"/>
      <stop offset="100%" stop-color="#202b42"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#00AEEC"/>
      <stop offset="100%" stop-color="#FB7299"/>
    </linearGradient>
  </defs>
  <rect x="30" y="30" width="452" height="452" rx="72" fill="url(#bg)" stroke="#38bdf8" stroke-opacity="0.35" stroke-width="6"/>
  <path d="M174 108 L220 158 M338 108 L292 158" stroke="#00AEEC" stroke-width="22" stroke-linecap="round"/>
  <rect x="112" y="164" width="288" height="224" rx="36" fill="none" stroke="url(#accent)" stroke-width="24"/>
  <rect x="238" y="214" width="36" height="74" rx="7" fill="#f8fafc"/>
  <polygon points="196,278 316,278 256,330" fill="#f8fafc"/>
  <rect x="192" y="336" width="128" height="18" rx="9" fill="#f8fafc"/>
</svg>
`;
  fs.writeFileSync(path.join(ASSETS_DIR, 'icon.svg'), svgContent, 'utf8');

  const png512 = encodePngRgba(512, 512, renderIconBuffer(512));
  fs.writeFileSync(path.join(ASSETS_DIR, 'icon.png'), png512);

  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const pngEntries = icoSizes.map((sz) => ({
    size: sz,
    png: encodePngRgba(sz, sz, renderIconBuffer(sz))
  }));
  const icoBuf = buildIcoFromPngs(pngEntries);
  fs.writeFileSync(path.join(ASSETS_DIR, 'icon.ico'), icoBuf);

  let icnsPath = null;
  if (process.platform === 'darwin') {
    const iconsetDir = path.join(os.tmpdir(), `bilidl_${Date.now()}.iconset`);
    try {
      fs.mkdirSync(iconsetDir, { recursive: true });
      const specs = [
        ['icon_16x16.png', 16],
        ['icon_16x16@2x.png', 32],
        ['icon_32x32.png', 32],
        ['icon_32x32@2x.png', 64],
        ['icon_128x128.png', 128],
        ['icon_128x128@2x.png', 256],
        ['icon_256x256.png', 256],
        ['icon_256x256@2x.png', 512],
        ['icon_512x512.png', 512]
      ];
      const cache = new Map();
      for (const [fname, sz] of specs) {
        if (!cache.has(sz)) {
          cache.set(sz, sz === 512 ? png512 : encodePngRgba(sz, sz, renderIconBuffer(sz)));
        }
        fs.writeFileSync(path.join(iconsetDir, fname), cache.get(sz));
      }
      const targetIcns = path.join(ASSETS_DIR, 'icon.icns');
      const r = spawnSync('iconutil', ['-c', 'icns', iconsetDir, '-o', targetIcns], { encoding: 'utf8' });
      if (r.status === 0 && fs.existsSync(targetIcns)) {
        icnsPath = targetIcns;
      }
    } finally {
      fs.rmSync(iconsetDir, { recursive: true, force: true });
    }
  }

  return {
    svg: path.join(ASSETS_DIR, 'icon.svg'),
    png: path.join(ASSETS_DIR, 'icon.png'),
    ico: path.join(ASSETS_DIR, 'icon.ico'),
    ...(icnsPath ? { icns: icnsPath } : {})
  };
}

if (require.main === module) {
  const out = generateAllIcons();
  console.log('Generated icons:', out);
}

module.exports = { generateAllIcons };
