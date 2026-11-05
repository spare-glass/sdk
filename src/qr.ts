// 二维码编码器（ISO/IEC 18004，字节模式，版本 1–40，纠错 L/M/Q/H），零依赖。
// 用在 `spare install --qr` 和 VS Code 插件里：把侧载链接画成终端字符或 SVG。

export type Ecc = 'L' | 'M' | 'Q' | 'H';

// 每个版本、每个纠错级别：每块纠错码字数、块数（下标 = 版本，0 号不用）
const ECC_PER_BLOCK: Record<Ecc, number[]> = {
  L: [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};
const BLOCKS: Record<Ecc, number[]> = {
  L: [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};
const FORMAT_ECC: Record<Ecc, number> = { L: 1, M: 0, Q: 3, H: 2 };

/** 某版本里能放数据和纠错码的模块数 */
function rawModules(ver: number) {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) { const a = Math.floor(ver / 7) + 2; n -= (25 * a - 10) * a - 55; if (ver >= 7) n -= 36; }
  return n;
}
const dataCodewords = (ver: number, ecc: Ecc) => Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ecc][ver] * BLOCKS[ecc][ver];

// ---- GF(256) 上的 Reed–Solomon，本原多项式 x^8+x^4+x^3+x^2+1 -------------------------------------------------------
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a: number, b: number) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function rsGenerator(n: number) {               // (x - α^0)(x - α^1)…(x - α^(n-1))，最高次系数省略
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) { next[j] ^= g[j]; next[j + 1] ^= mul(g[j], EXP[i]); }
    g = next;
  }
  return g.slice(1);
}
function rsRemainder(data: number[], gen: number[]) {
  const r = new Array(gen.length).fill(0);
  for (const b of data) {
    const f = b ^ r.shift()!; r.push(0);
    for (let i = 0; i < gen.length; i++) r[i] ^= mul(gen[i], f);
  }
  return r;
}

// ---- 码字：模式 + 长度 + 数据 + 填充，分块加纠错，交织 ----------------------------------------------------------------
function codewords(bytes: Uint8Array, ver: number, ecc: Ecc) {
  const cap = dataCodewords(ver, ecc), bits: number[] = [];
  const put = (v: number, n: number) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  put(0b0100, 4); put(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, cap * 8 - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let p = 0xec; data.length < cap; p ^= 0xec ^ 0x11) data.push(p);

  const nb = BLOCKS[ecc][ver], ne = ECC_PER_BLOCK[ecc][ver], total = Math.floor(rawModules(ver) / 8);
  const shortLen = Math.floor(total / nb), nShort = nb - (total % nb), gen = rsGenerator(ne);
  const blocks: number[][] = [], eccs: number[][] = [];
  for (let b = 0, k = 0; b < nb; b++) {
    const len = shortLen - ne + (b < nShort ? 0 : 1);
    const d = data.slice(k, k + len); k += len;
    blocks.push(d); eccs.push(rsRemainder(d, gen));
  }
  const out: number[] = [];
  for (let i = 0; i <= shortLen - ne; i++) for (const d of blocks) if (i < d.length) out.push(d[i]);
  for (let i = 0; i < ne; i++) for (const e of eccs) out.push(e[i]);
  return out;
}

// ---- 画模块 ------------------------------------------------------------------------------------------------------
function alignmentPositions(ver: number) {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2, size = ver * 4 + 17;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const pos = [6];
  for (let p = size - 7; pos.length < n; p -= step) pos.splice(1, 0, p);
  return pos;
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0, (_, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

class Grid {
  ver: number; size: number; dark: boolean[][]; fixed: boolean[][];
  constructor(ver: number) {
    this.ver = ver;
    this.size = ver * 4 + 17;
    this.dark = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    this.fixed = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
  }
  set(x: number, y: number, d: boolean) { this.dark[y][x] = d; this.fixed[y][x] = true; }
  functionPatterns() {
    const s = this.size;
    for (let i = 0; i < s; i++) { this.set(6, i, i % 2 === 0); this.set(i, 6, i % 2 === 0); }
    for (const [cx, cy] of [[3, 3], [s - 4, 3], [3, s - 4]]) {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy, r = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < s && y >= 0 && y < s) this.set(x, y, r !== 2 && r !== 4);
      }
    }
    const ap = alignmentPositions(this.ver);
    for (let i = 0; i < ap.length; i++) for (let j = 0; j < ap.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === ap.length - 1) || (i === ap.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.set(ap[i] + dx, ap[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    this.format(FORMAT_ECC.M, 0);                 // 先占位，选好掩码后再写真值
    if (this.ver >= 7) {
      let r = this.ver;
      for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
      const bits = (this.ver << 12) | r;
      for (let i = 0; i < 18; i++) {
        const d = ((bits >>> i) & 1) === 1, a = s - 11 + (i % 3), b = Math.floor(i / 3);
        this.set(a, b, d); this.set(b, a, d);
      }
    }
  }
  format(eccBits: number, mask: number) {
    const s = this.size, data = (eccBits << 3) | mask;
    let r = data;
    for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
    const bits = ((data << 10) | r) ^ 0x5412, bit = (i: number) => ((bits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
    this.set(8, 7, bit(6)); this.set(8, 8, bit(7)); this.set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.set(s - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.set(8, s - 15 + i, bit(i));
    this.set(8, s - 8, true);
  }
  place(cw: number[]) {
    const s = this.size; let i = 0;
    for (let right = s - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      const up = ((right + 1) & 2) === 0;
      for (let v = 0; v < s; v++) for (let j = 0; j < 2; j++) {
        const x = right - j, y = up ? s - 1 - v : v;
        if (this.fixed[y][x]) continue;
        this.dark[y][x] = i < cw.length * 8 && ((cw[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
        i++;
      }
    }
  }
  applyMask(m: number) {
    for (let y = 0; y < this.size; y++) for (let x = 0; x < this.size; x++) if (!this.fixed[y][x] && MASKS[m](x, y)) this.dark[y][x] = !this.dark[y][x];
  }
  penalty() {
    const s = this.size, d = this.dark; let p = 0, darkCount = 0;
    const line = (get: (i: number) => boolean) => {
      let run = 1, row = '';
      for (let i = 0; i < s; i++) {
        row += get(i) ? '1' : '0';
        if (i > 0 && get(i) === get(i - 1)) run++; else { if (run >= 5) p += run - 2; run = 1; }
      }
      if (run >= 5) p += run - 2;
      const padded = '0000' + row + '0000';
      for (const pat of ['10111010000', '00001011101']) for (let k = padded.indexOf(pat); k >= 0; k = padded.indexOf(pat, k + 1)) p += 40;
    };
    for (let y = 0; y < s; y++) line(x => d[y][x]);
    for (let x = 0; x < s; x++) line(y => d[y][x]);
    for (let y = 0; y < s - 1; y++) for (let x = 0; x < s - 1; x++) {
      const c = d[y][x];
      if (c === d[y][x + 1] && c === d[y + 1][x] && c === d[y + 1][x + 1]) p += 3;
    }
    for (const row of d) for (const c of row) if (c) darkCount++;
    const total = s * s;
    p += (Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1) * 10;
    return p;
  }
}

export interface QrCode { size: number; version: number; ecc: Ecc; mask: number; dark: boolean[][] }

/** 把文本（按 UTF-8 字节）编成二维码。自动选最小版本；`minEcc` 之上如果同版本放得下，自动提高纠错级别。 */
export function encodeQr(text: string, minEcc: Ecc = 'M'): QrCode {
  const bytes = new TextEncoder().encode(text);
  const order: Ecc[] = ['L', 'M', 'Q', 'H'];
  let ver = 0;
  for (let v = 1; v <= 40; v++) {
    const need = 4 + (v <= 9 ? 8 : 16) + bytes.length * 8;
    if (need <= dataCodewords(v, minEcc) * 8) { ver = v; break; }
  }
  if (!ver) throw new Error(`二维码放不下 ${bytes.length} 字节`);
  let ecc = minEcc;
  for (const e of order.slice(order.indexOf(minEcc) + 1)) if (4 + (ver <= 9 ? 8 : 16) + bytes.length * 8 <= dataCodewords(ver, e) * 8) ecc = e;

  const cw = codewords(bytes, ver, ecc);
  let best: Grid | null = null, bestMask = 0, bestP = Infinity;
  for (let m = 0; m < 8; m++) {
    const g = new Grid(ver);
    g.functionPatterns(); g.place(cw); g.applyMask(m); g.format(FORMAT_ECC[ecc], m);
    const p = g.penalty();
    if (p < bestP) { best = g; bestMask = m; bestP = p; }
  }
  return { size: best!.size, version: ver, ecc, mask: bestMask, dark: best!.dark };
}

/** 终端显示：每个字符画上下两个模块，前景黑、背景白写死，深色/浅色终端都能扫。 */
export function qrToTerminal(qr: QrCode, quiet = 2): string {
  const n = qr.size + quiet * 2;
  const at = (x: number, y: number) => { x -= quiet; y -= quiet; return x >= 0 && y >= 0 && x < qr.size && y < qr.size && qr.dark[y][x]; };
  const lines: string[] = [];
  for (let y = 0; y < n; y += 2) {
    let s = '\x1b[30;107m';
    for (let x = 0; x < n; x++) {
      const t = at(x, y), b = at(x, y + 1);
      s += t && b ? '█' : t ? '▀' : b ? '▄' : ' ';
    }
    lines.push(s + '\x1b[0m');
  }
  return lines.join('\n');
}

/** SVG：一条 path，按模块坐标画，`scale` 是每个模块的像素数。 */
export function qrToSvg(qr: QrCode, scale = 6, quiet = 4): string {
  const n = qr.size + quiet * 2; let d = '';
  for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.dark[y][x]) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n * scale}" height="${n * scale}" shape-rendering="crispEdges">` +
    `<rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
