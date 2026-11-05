// .spa 打包：PNG → 16 级灰度、分节、CRC32、Ed25519 签名。规范：https://github.com/spare-glass/spec/blob/main/distribution.md
import { inflateSync } from 'node:zlib';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { SpacError, Strings, Compiler, parse, utf8, LIMITS } from './compiler.ts';
import { checkControls, checkManifest, flattenUi } from './manifest.ts';

const RUNTIME = 1;

// ---- PNG（只解码 8 位、非隔行；够用于图标和资源图）---------------------------------------------------------------
export function pngGray(data: Uint8Array, where: string): [[number, number], number[]] {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (dv.getUint32(0) !== 0x89504e47) throw new SpacError(`${where}: 不是 PNG`);
  let pos = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0;
  let palette: Uint8Array | null = null, trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (pos < data.length) {
    const len = dv.getUint32(pos), type = String.fromCharCode(...data.subarray(pos + 4, pos + 8));
    const body = data.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = dv.getUint32(pos + 8); h = dv.getUint32(pos + 12); depth = body[8]; ctype = body[9]; interlace = body[12]; }
    else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') trns = body;
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (interlace) throw new SpacError(`${where}: 不支持隔行 PNG`);
  if (depth !== 8 && !(ctype === 3 && [1, 2, 4].includes(depth)) && !(ctype === 0 && [1, 2, 4].includes(depth))) throw new SpacError(`${where}: 只支持 8 位 PNG`);
  const chans = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[ctype];
  if (!chans) throw new SpacError(`${where}: 不支持的 PNG 颜色类型 ${ctype}`);
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = Math.max(1, (chans * depth) >> 3), stride = Math.ceil((w * chans * depth) / 8);
  const rows: Uint8Array[] = [];
  let prev = new Uint8Array(stride);
  for (let y = 0, p = 0; y < h; y++) {
    const f = raw[p++], line = new Uint8Array(raw.subarray(p, p + stride)); p += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let add = 0;
      if (f === 1) add = a; else if (f === 2) add = b; else if (f === 3) add = (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[i] = (line[i] + add) & 0xff;
    }
    rows.push(line); prev = line;
  }
  const L = (r: number, g: number, b: number) => (r * 19595 + g * 38470 + b * 7471 + 0x8000) >> 16;   // 与 Pillow 的 RGB→L 一致
  const px: number[] = [];
  for (const row of rows) {
    for (let x = 0; x < w; x++) {
      let lum: number, alpha = 255;
      if (depth < 8) {
        const v = (row[(x * depth) >> 3] >> (8 - depth - ((x * depth) & 7))) & ((1 << depth) - 1);
        if (ctype === 3) { lum = L(palette![v * 3], palette![v * 3 + 1], palette![v * 3 + 2]); alpha = trns && v < trns.length ? trns[v] : 255; }
        else lum = Math.round((v * 255) / ((1 << depth) - 1));
      } else if (ctype === 0) lum = row[x];
      else if (ctype === 4) { lum = row[x * 2]; alpha = row[x * 2 + 1]; }
      else if (ctype === 2) lum = L(row[x * 3], row[x * 3 + 1], row[x * 3 + 2]);
      else if (ctype === 6) { lum = L(row[x * 4], row[x * 4 + 1], row[x * 4 + 2]); alpha = row[x * 4 + 3]; }
      else { const v = row[x]; lum = L(palette![v * 3], palette![v * 3 + 1], palette![v * 3 + 2]); alpha = trns && v < trns.length ? trns[v] : 255; }
      px.push(Math.floor((lum * alpha) / 255) >> 4);
    }
  }
  return [[w, h], px];
}

function iconRle(px: number[]) {
  const out: number[] = [];
  for (let i = 0; i < px.length;) {
    const lvl = px[i];
    let run = 1;
    while (run < 16 && i + run < px.length && px[i + run] === lvl) run++;
    out.push((lvl << 4) | (run - 1));
    i += run;
  }
  return out;
}

// 没有 icon.png 时的默认图标：空心方块（平台构建会改用名字首字）
const defaultIcon = () => Array.from({ length: 44 * 44 }, (_, i) => {
  const x = i % 44, y = Math.floor(i / 44);
  return x === 2 || x === 41 || y === 2 || y === 41 ? 12 : 0;
});

// ---- 字节工具 -----------------------------------------------------------------------------------------------------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
export function crc32(b: Uint8Array) { let c = 0xffffffff; for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

class Bytes {
  a: number[] = [];
  u8(v: number) { this.a.push(v & 0xff); return this; }
  u16(v: number) { this.a.push(v & 0xff, (v >> 8) & 0xff); return this; }
  u32(v: number) { this.a.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff); return this; }
  raw(b: ArrayLike<number>) { for (let i = 0; i < b.length; i++) this.a.push(b[i]); return this; }
  pad(b: Uint8Array, n: number) { this.raw(b); for (let i = b.length; i < n; i++) this.a.push(0); return this; }
  get bytes() { return Uint8Array.from(this.a); }
}

const section = (t: number, data: ArrayLike<number>) => {
  const b = new Bytes().u16(t).u16(0).u32(data.length).raw(data);
  for (let i = 0; i < (4 - (data.length % 4)) % 4; i++) b.u8(0);
  return b.a;
};

export function fnv(s: string) {
  let h = 2166136261;
  for (const b of utf8(s)) h = Math.imul(h ^ b, 16777619) >>> 0;
  return h >>> 0;
}

export function ed25519(seed: Uint8Array, msg: Uint8Array): [Uint8Array, Uint8Array] {
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed)]);
  const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const pub = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32);
  return [new Uint8Array(pub), new Uint8Array(sign(null, msg, key))];
}

// ---- 打包 ---------------------------------------------------------------------------------------------------------
export interface AppFiles {
  manifest: string;                       // app.json 原文
  script: string;                         // main.ss 原文（没有就传 ""）
  icon?: Uint8Array;                      // icon.png
  assets?: Record<string, Uint8Array>;    // assets/*.png，键是文件名
}

export function build(files: AppFiles, seed: Uint8Array) {
  const man = JSON.parse(files.manifest);
  const { appId, name, version, dataVersion, requests } = checkManifest(man);
  const strings = new Strings();
  const assetNames = Object.keys(files.assets ?? {}).filter(n => n.endsWith('.png')).sort();
  const [records, elems] = flattenUi(man.ui ?? [], strings, assetNames);
  for (const n of elems.keys()) if (requests.has(n)) throw new SpacError(`${n} 既是界面元素又是请求名`);
  const controls = checkControls(man);
  const reqs: any[] = man.requests ?? [];
  const ctlIdx = reqs.findIndex(r => r.kind === 'control_set');
  const comp = new Compiler(parse(files.script), elems, requests, strings, controls, ctlIdx < 0 ? null : ctlIdx);
  const [fns, events] = comp.build();

  const meta = new Bytes().u32(fnv(appId)).u16(version).u16(dataVersion).u8(RUNTIME).u8(comp.globals.length)
    .u8(comp.nPersist).u8(requests.size).pad(utf8(appId), 32).pad(utf8(name), 24).a;
  let iconPx = defaultIcon();
  if (files.icon) {
    const [[w, h], px] = pngGray(files.icon, 'icon.png');
    if (w !== 44 || h !== 44) throw new SpacError('icon.png 必须是 44×44');
    iconPx = px;
  }
  const blob = new Bytes(), ftab = new Bytes();
  for (const f of fns) { ftab.u16(blob.a.length).u16(f.code.length).u8(f.params.length).u8(f.locals.length).u16(0); blob.raw(f.code); }
  const code = [fns.length, ...events, ...ftab.a, ...blob.a];
  const strs = strings.items.map(s => [...utf8(s), 0]);
  let at = 2 + 2 * strs.length;
  const sb = new Bytes().u16(strs.length);
  for (const s of strs) { sb.u16(at); at += s.length; }
  if (at > 65535) throw new SpacError('字符串总量太大');
  for (const s of strs) sb.raw(s);
  const ui = [records.length, 0, 0, 0, ...records.flatMap(r => [...r])];
  const sections = [section(1, meta), section(2, iconRle(iconPx)), section(3, sb.a), section(4, ui), section(5, code)];
  if (assetNames.length) {
    const table = new Bytes(), pix = new Bytes();
    const base = 4 + 8 * assetNames.length;
    for (const n of assetNames) {
      const [[w, h], px] = pngGray(files.assets![n], n);
      if (w % 2) throw new SpacError(`${n}: 宽度必须是偶数`);
      table.u16(w).u16(h).u32(base + pix.a.length);
      for (let i = 0; i < px.length; i += 2) pix.u8((px[i] << 4) | px[i + 1]);
    }
    sections.push(section(6, [assetNames.length, 0, 0, 0, ...table.a, ...pix.a]));
  }
  sections.push(section(7, utf8(JSON.stringify(man))));
  const signed = Uint8Array.from(sections.flat());
  const [pub, sig] = ed25519(seed, signed);
  const body = Uint8Array.from([...signed, ...section(8, [1, 0, 0, 0, ...pub, ...sig])]);
  const total = 16 + body.length;
  if (total > LIMITS.pkg) throw new SpacError(`包 ${total} 字节，超过 32768`);
  const pkg = new Bytes().raw(utf8('SPA1')).u8(1).u8(1).u16(sections.length + 1).u32(total).u32(crc32(body)).raw(body).bytes;
  const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
  const info = {
    id: appId, name, hash: fnv(appId).toString(16).padStart(8, '0'), version, bytes: total, code: blob.a.length,
    functions: fns.length, globals: comp.globals.length, persist: comp.nPersist, elements: records.length,
    strings: strings.items.length, requests: [...requests.keys()], controls: [...controls.keys()], signer: hex(pub),
  };
  return { pkg, info };
}
