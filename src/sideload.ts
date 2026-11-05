// 扫码侧载：在局域网里临时提供一个 .spa，生成给 Spare App 扫的链接。协议见 spec/distribution.md「扫码侧载」。
import { createServer, type Server } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';

export interface SideloadOptions {
  pkg: Uint8Array;
  id: string;
  name: string;
  host?: string;         // 默认自动选局域网 IPv4
  port?: number;         // 默认随机空闲端口
  keep?: boolean;        // true：下载后不退出，可以反复扫（默认下载成功一次就结束）
  timeoutMs?: number;    // 默认 10 分钟没人下载就结束
  onDownload?: (from: string) => void;
}

export interface Sideload { url: string; link: string; sha256: string; server: Server; done: Promise<'downloaded' | 'timeout' | 'closed'>; close(): void }

/** 局域网 IPv4：优先 Wi-Fi/以太网（en*、eth*、wlan*），排除回环和 169.254 链路本地地址 */
export function lanAddress(): string | undefined {
  const all = Object.entries(networkInterfaces()).flatMap(([name, list]) =>
    (list || []).filter(a => a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')).map(a => ({ name, ip: a.address })));
  const pref = all.find(a => /^(en|eth|wlan|wl)/.test(a.name)) || all[0];
  return pref?.ip;
}

/** 侧载链接：spare://workshop/sideload?url=…&sha256=…&id=…&name=… */
export function sideloadLink(url: string, sha256: string, id: string, name: string) {
  const q = new URLSearchParams({ url, sha256, id, name });
  return `spare://workshop/sideload?${q}`;
}

export function serveSideload(o: SideloadOptions): Promise<Sideload> {
  const host = o.host || lanAddress();
  if (!host) return Promise.reject(new Error('找不到局域网地址：电脑要和手机连同一个 Wi-Fi，或者用 --host 指定'));
  const sha256 = createHash('sha256').update(o.pkg).digest('hex');
  const token = randomBytes(12).toString('base64url');
  const path = `/s/${token}/${encodeURIComponent(o.id)}.spa`;
  let finish!: (r: 'downloaded' | 'timeout' | 'closed') => void;
  const done = new Promise<'downloaded' | 'timeout' | 'closed'>(r => { finish = r; });

  const server = createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    if (req.url !== path) { res.writeHead(404).end(); return; }          // 路径里带随机令牌，别人猜不到
    res.writeHead(200, {
      'Content-Type': 'application/vnd.spare.app',
      'Content-Length': o.pkg.length,
      'Cache-Control': 'no-store',
      'X-Spare-Sha256': sha256,
    });
    if (req.method === 'HEAD') { res.end(); return; }
    res.end(o.pkg, () => {
      o.onDownload?.(req.socket.remoteAddress || '?');
      if (!o.keep) { clearTimeout(timer); server.close(); finish('downloaded'); }
    });
  });
  const timer = setTimeout(() => { server.close(); finish('timeout'); }, o.timeoutMs ?? 600_000);
  timer.unref?.();

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port ?? 0, '0.0.0.0', () => {
      const port = (server.address() as { port: number }).port;
      const url = `http://${host}:${port}${path}`;
      resolve({
        url, sha256, server, done, link: sideloadLink(url, sha256, o.id, o.name),
        close() { clearTimeout(timer); server.close(); finish('closed'); },
      });
    });
  });
}
