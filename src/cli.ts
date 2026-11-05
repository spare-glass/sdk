#!/usr/bin/env node
// spare：Spare 眼镜应用命令行。  spare new <目录> | spare check <目录> | spare build <目录> [-o 输出.spa] [--key 密钥文件] | spare keygen [密钥文件]
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, chmodSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { SpacError } from './compiler.ts';
import { build, ed25519, type AppFiles } from './pack.ts';

const USAGE = `用法：
  spare new <目录>                         新建一个最小应用（计数器）
  spare check <目录>                       只检查：编译 + 清单校验，不写文件
  spare build <目录> [-o 输出.spa] [--key 密钥文件]   编译并签名成 .spa
  spare keygen [密钥文件]                   生成开发者密钥（默认 ~/.spare/dev_ed25519.key）

规范：https://github.com/spare-glass/spec`;

const defaultKey = () => process.env.SPARE_DEV_KEY || join(homedir(), '.spare', 'dev_ed25519.key');

function keygen(path: string) {
  if (existsSync(path)) throw new SpacError(`${path} 已存在，不覆盖`);
  mkdirSync(join(path, '..'), { recursive: true });
  const seed = randomBytes(32);
  writeFileSync(path, seed.toString('hex') + '\n');
  chmodSync(path, 0o600);
  return ed25519(seed, new Uint8Array())[0];
}

function readApp(dir: string): AppFiles {
  const files: AppFiles = {
    manifest: readFileSync(join(dir, 'app.json'), 'utf8'),
    script: existsSync(join(dir, 'main.ss')) ? readFileSync(join(dir, 'main.ss'), 'utf8') : '',
  };
  if (existsSync(join(dir, 'icon.png'))) files.icon = readFileSync(join(dir, 'icon.png'));
  if (existsSync(join(dir, 'assets'))) {
    files.assets = {};
    for (const n of readdirSync(join(dir, 'assets'))) if (n.endsWith('.png')) files.assets[n] = readFileSync(join(dir, 'assets', n));
  }
  return files;
}

function seedFrom(path: string) {
  if (!existsSync(path)) keygen(path);
  return Uint8Array.from(Buffer.from(readFileSync(path, 'utf8').trim(), 'hex'));
}

const MINIMAL_APP = (id: string) => JSON.stringify({
  id, name: '计数器', version_name: '0.1.0', version: 1, data_version: 1,
  description: '转表冠加减，单击清零；数字关掉应用也记得。', permissions: [], requests: [],
  ui: [
    { id: 'big', type: 'text', x: 0, y: 50, w: 540, h: 100, size: 88, bold: true, align: 'center', text: '0' },
    { id: 'hint', type: 'text', x: 0, y: 160, w: 540, h: 30, size: 22, align: 'center', gray: 120, text: '转表冠 +1 / -1，单击清零' },
  ],
}, null, 1) + '\n';
const MINIMAL_SS = `persist var n = 0;

on open()   { text(big, n); }
on crown(d) { n = clamp(n + d, -999, 999); text(big, n); save(); }
on click()  { n = 0; text(big, n); anim_opa(big, 80, 255, 300); save(); }
`;

function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  const opt = (flag: string) => { const i = rest.indexOf(flag); return i >= 0 ? rest[i + 1] : undefined; };
  if (cmd === 'keygen') {
    const path = rest[0] || defaultKey();
    console.log('public key', Buffer.from(keygen(path)).toString('hex'), '→', path);
  } else if (cmd === 'new' && rest[0]) {
    const dir = rest[0];
    if (existsSync(join(dir, 'app.json'))) throw new SpacError(`${dir} 里已经有 app.json`);
    mkdirSync(join(dir, 'scenarios'), { recursive: true });
    const slug = basename(dir).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 20) || 'app';
    writeFileSync(join(dir, 'app.json'), MINIMAL_APP(`dev.yourname.${slug}`));
    writeFileSync(join(dir, 'main.ss'), MINIMAL_SS);
    writeFileSync(join(dir, 'scenarios', 'smoke.txt'), 'open\nshot open\ncrown +1\nshot crown\nclick\ntick 400\nshot click\n');
    console.log(`已创建 ${dir}。把 app.json 里的 id 换成平台分配给你的 dev.<handle>.<名字>，然后 spare check ${dir}`);
  } else if ((cmd === 'check' || cmd === 'build') && rest[0]) {
    const dir = rest[0];
    const { pkg, info } = build(readApp(dir), cmd === 'check' ? new Uint8Array(32) : seedFrom(opt('--key') || defaultKey()));
    if (cmd === 'check') {
      console.log(`✓ ${info.name}（${info.id}）：${info.bytes} 字节，${info.functions} 个函数，${info.elements} 个界面元素`);
    } else {
      const out = opt('-o') || dir.replace(/\/$/, '') + '.spa';
      writeFileSync(out, pkg);
      console.log(JSON.stringify({ ...info, out }));
    }
  } else {
    console.log(USAGE);
    process.exitCode = cmd ? 2 : 0;
  }
}

try {
  main(process.argv.slice(2));
} catch (e) {
  if (e instanceof SpacError) { console.error(`spare: ${e.message}`); process.exitCode = 1; } else throw e;
}
