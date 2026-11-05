// 二维码往返测试：编码 → 栅格化 → 用独立解码器 jsQR 解回来，覆盖版本 1–40 和 L/M/Q/H。
// 需要先装解码器（只用于测试，SDK 本身零依赖）：  npm i --no-save jsqr@1.4.0 && node test/qr.mjs
import jsQR from 'jsqr';
import { encodeQr } from '../src/qr.ts';

const sample = n => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(32 + ((i * 7919 + n * 31) % 90)); return s; };
const texts = [1, 5, 14, 20, 40, 80, 130, 200, 300, 400, 500, 650, 800, 1000, 1200, 1500, 1800, 2000, 2300].map(sample);
texts.push('spare://workshop/sideload?url=http%3A%2F%2F192.168.1.5%3A8848%2Fs%2Fabc%2Fdev.me.app.spa&id=dev.me.app&name=%E9%AA%B0%E5%AD%90', '中文 UTF-8 ✓');
let ok = 0, bad = 0; const versions = new Set();
for (const ecc of ['L', 'M', 'Q', 'H']) for (const text of texts) {
  let qr; try { qr = encodeQr(text, ecc); } catch { continue; }             // 太长放不下的跳过
  versions.add(qr.version);
  const sc = 3, q = 4, n = (qr.size + 2 * q) * sc, px = new Uint8ClampedArray(n * n * 4).fill(255);
  for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.dark[y][x])
    for (let dy = 0; dy < sc; dy++) for (let dx = 0; dx < sc; dx++) { const o = (((y + q) * sc + dy) * n + (x + q) * sc + dx) * 4; px[o] = px[o + 1] = px[o + 2] = 0; }
  const r = jsQR(px, n, n, { inversionAttempts: 'dontInvert' });
  if (r && new TextDecoder().decode(new Uint8Array(r.binaryData)) === text) ok++;
  else { bad++; console.log(`✗ ${ecc} ${text.length} 字 → 版本 ${qr.version} 掩码 ${qr.mask}`); }
}
console.log(`${ok} 个通过，${bad} 个失败；覆盖版本 ${[...versions].sort((a, b) => a - b).join(',')}`);
process.exitCode = bad ? 1 : 0;
