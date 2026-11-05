#!/usr/bin/env node
// spare：Spare 眼镜应用命令行。  spare new | check | build | install | qr | keygen（见 USAGE）
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, chmodSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { SpacError } from './compiler.ts';
import { build, ed25519, type AppFiles } from './pack.ts';
import { encodeQr, qrToTerminal } from './qr.ts';
import { serveSideload } from './sideload.ts';

const USAGE = `用法：
  spare new <目录>                         新建一个最小应用（计数器）
  spare check <目录>                       只检查：编译 + 清单校验，不写文件
  spare build <目录> [-o 输出.spa] [--key 密钥文件]   编译并签名成 .spa
  spare install <目录> [--qr] [--keep] [--host IP] [--port N] [--key 密钥文件]
                                           构建后在局域网里临时提供，终端显示二维码；
                                           用 Spare App「工坊 › 创作 › 扫码安装」扫一下就装到眼镜
  spare qr <文字>                           把任意文字画成终端二维码
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

async function main(argv: string[]) {
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
  } else if (cmd === 'install' && rest[0]) {
    const { pkg, info } = build(readApp(rest[0]), seedFrom(opt('--key') || defaultKey()));
    const keep = rest.includes('--keep');
    const sl = await serveSideload({
      pkg, id: info.id, name: info.name, keep, host: opt('--host'), port: opt('--port') ? Number(opt('--port')) : undefined,
      onDownload: from => console.log(`✓ ${from} 已下载（${pkg.length} 字节），在手机上确认安装`),
    });
    console.log(qrToTerminal(encodeQr(sl.link)));
    console.log(`\n${info.name}（${info.id}）${pkg.length} 字节  sha256 ${sl.sha256.slice(0, 16)}…`);
    console.log(`用 Spare App「工坊 › 创作 › 扫码安装」扫上面的码（手机和电脑要在同一个 Wi-Fi，App 要打开开发者模式）。`);
    console.log(`链接：${sl.link}`);
    console.log(keep ? '按 Ctrl+C 结束。' : '下载一次后自动结束；10 分钟没人扫也会结束。');
    process.once('SIGINT', () => sl.close());
    const r = await sl.done;
    if (r === 'timeout') { console.error('spare: 10 分钟没人下载，已结束'); process.exitCode = 1; }
  } else if (cmd === 'qr' && rest.length) {
    console.log(qrToTerminal(encodeQr(rest.join(' '))));
  } else {
    console.log(USAGE);
    process.exitCode = cmd ? 2 : 0;
  }
}

main(process.argv.slice(2)).catch(e => {
  if (e instanceof SpacError || e?.code === 'EADDRINUSE' || /局域网/.test(e?.message)) { console.error(`spare: ${e.message}`); process.exitCode = 1; } else throw e;
});
