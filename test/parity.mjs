// 逐字节对比：TypeScript 编译器 vs 平台 spac.py。  SPAC=/path/to/spac.py [PYTHON=带 Pillow 的 python] node test/parity.mjs [应用目录...]
// 不传目录时测 ../templates/* ../examples/* test/fixtures/*。
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from '../src/pack.ts';

const here = new URL('..', import.meta.url).pathname;
const spac = process.env.SPAC;
if (!spac) { console.error('设置 SPAC 指向 spac.py'); process.exit(2); }
const tmp = mkdtempSync(join(tmpdir(), 'spare-parity-'));
const seed = Buffer.alloc(32, 7);
writeFileSync(join(tmp, 'k.key'), seed.toString('hex') + '\n');

const dirs = process.argv.slice(2);
if (!dirs.length) {
  for (const base of [join(here, '../templates'), join(here, '../examples'), join(here, 'test/fixtures')]) {
    if (!existsSync(base)) continue;
    for (const d of readdirSync(base)) if (existsSync(join(base, d, 'app.json'))) dirs.push(join(base, d));
  }
}

const read = dir => {
  const f = { manifest: readFileSync(join(dir, 'app.json'), 'utf8'), script: existsSync(join(dir, 'main.ss')) ? readFileSync(join(dir, 'main.ss'), 'utf8') : '' };
  if (existsSync(join(dir, 'icon.png'))) f.icon = readFileSync(join(dir, 'icon.png'));
  if (existsSync(join(dir, 'assets'))) { f.assets = {}; for (const n of readdirSync(join(dir, 'assets'))) f.assets[n] = readFileSync(join(dir, 'assets', n)); }
  return f;
};

// 分节：[类型, 内容]
const sections = b => { const out = []; let p = 16; while (p < b.length) { const t = b.readUInt16LE(p), n = b.readUInt32LE(p + 4); out.push([t, b.subarray(p + 8, p + 8 + n)]); p += 8 + n + ((4 - n % 4) % 4); } return out; };

let fail = 0;
for (const dir of dirs) {
  const name = dir.split('/').slice(-2).join('/');
  const out = join(tmp, 'py.spa');
  let py, ts, pyErr = null, tsErr = null;
  try { execFileSync(process.env.PYTHON || 'python3', ['-I', spac, 'build', dir, '-o', out, '--key', join(tmp, 'k.key')], { stdio: 'pipe' }); py = readFileSync(out); } catch (e) { pyErr = String(e.stderr || e).trim().split('\n').pop(); }
  try { ts = Buffer.from(build(read(dir), seed).pkg); } catch (e) { tsErr = e.message; }
  if (pyErr || tsErr) {
    const ok = !!pyErr && !!tsErr;
    console.log(`${ok ? '✓' : '✗'} ${name}：${ok ? '两边都报错' : '只有一边报错'}  py=${pyErr} ts=${tsErr}`);
    if (!ok) fail++;
    continue;
  }
  if (Buffer.compare(py, ts) === 0) { console.log(`✓ ${name}：${py.length} 字节完全一致`); continue; }
  // 没有 icon.png 时，spac.py 用系统字体画首字，TS 画空心方块：只允许图标节（2）和随之变化的签名、CRC 不同
  const a = sections(py), b = sections(ts);
  const diff = a.map(([t, d], i) => (b[i] && b[i][0] === t && Buffer.compare(d, b[i][1]) === 0 ? null : t)).filter(t => t !== null);
  const iconOnly = !existsSync(join(dir, 'icon.png')) && diff.every(t => t === 2 || t === 8) && a.length === b.length;
  console.log(`${iconOnly ? '✓' : '✗'} ${name}：${iconOnly ? '除默认图标外一致' : `不同的节 ${diff.join(',')}`}`);
  if (!iconOnly) fail++;
}
console.log(fail ? `${fail} 个不一致` : '全部一致');
process.exitCode = fail ? 1 : 0;
