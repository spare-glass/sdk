// app.json 校验：控件、界面元素、权限与请求。规范：https://github.com/spare-glass/spec/blob/main/manifest.md
import { SpacError, Strings, LIMITS, utf8, type Control } from './compiler.ts';

const CONTROL_TYPES = ['switch', 'slider', 'stepper', 'picker', 'text', 'button', 'label'];
const CONTROL_LIMITS = { count: 12, label: 63, option: 31, options: 8, intAbs: 100000, steps: 1000, dataKeys: 24 };
// 各请求种类回给眼镜的数据键数（算眼镜数据表 24 个键的容量用）
const REQUEST_KEYS: Record<string, number> = { location: 3, weather: 3, time_sync: 1, notify_count: 1, control_set: 1 };

const isInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v);
const bytes = (s: string) => utf8(s).length;

export function checkControls(man: any): Map<string, Control> {
  const ctls = man.controls ?? [];
  if (!Array.isArray(ctls)) throw new SpacError('controls 必须是数组');
  if (ctls.length > CONTROL_LIMITS.count) throw new SpacError(`controls 最多 ${CONTROL_LIMITS.count} 个`);
  const out = new Map<string, Control>();
  const fieldKeys = new Set<string>();
  let nKeys = 1;                                                     // _err
  for (const r of man.requests ?? []) {
    if (r.kind === 'http_json') for (const k of Object.keys(r.fields || {})) fieldKeys.add(k);
    else nKeys += REQUEST_KEYS[r.kind] ?? 0;
  }
  ctls.forEach((c: any, k: number) => {
    let where = `controls 第 ${k + 1} 个`;
    if (typeof c !== 'object' || c === null || Array.isArray(c)) throw new SpacError(`${where}必须是对象`);
    const cid = c.id, t = c.type;
    where = `控件 ${cid || k + 1}`;
    if (typeof cid !== 'string' || !/^[a-z][a-z0-9_]{0,11}$/.test(cid)) throw new SpacError(`${where}: id 必须是小写字母开头的 1..12 个 [a-z0-9_]`);
    if (out.has(cid)) throw new SpacError(`${where}: id 重复`);
    if (fieldKeys.has(cid)) throw new SpacError(`${where}: id 和请求 fields 的键重名（眼镜上 data() 会分不清）`);
    if (!CONTROL_TYPES.includes(t)) throw new SpacError(`${where}: type 只能是 ${CONTROL_TYPES.join(' / ')}`);
    const label = c.label;
    if (typeof label !== 'string' || !(bytes(label) > 0 && bytes(label) <= CONTROL_LIMITS.label)) throw new SpacError(`${where}: label 必须 1..63 字节`);
    for (const key of ['hint', 'unit', 'confirm']) {
      if (key in c && (typeof c[key] !== 'string' || bytes(c[key]) > CONTROL_LIMITS.label)) throw new SpacError(`${where}: ${key} 必须是 ≤ 63 字节的文字`);
    }
    const d = c.default;
    const intField = (key: string, dflt?: number) => {
      const v = key in c ? c[key] : dflt;
      if (typeof v === 'boolean' || !isInt(v) || Math.abs(v) > CONTROL_LIMITS.intAbs) throw new SpacError(`${where}: ${key} 必须是 ±${CONTROL_LIMITS.intAbs} 以内的整数`);
      return v as number;
    };
    if (t === 'switch') {
      if (!(d === undefined || d === null || d === 0 || d === 1 || d === true || d === false)) throw new SpacError(`${where}: 开关的 default 只能是 0 / 1`);
    } else if (t === 'slider' || t === 'stepper') {
      const lo = intField('min'), hi = intField('max'), step = intField('step', 1);
      if (lo >= hi) throw new SpacError(`${where}: 需要 min < max`);
      if (step <= 0 || (hi - lo) % step) throw new SpacError(`${where}: step 必须 > 0，且 max - min 是 step 的整数倍`);
      if ((hi - lo) / step > CONTROL_LIMITS.steps) throw new SpacError(`${where}: 档位太多（(max-min)/step ≤ ${CONTROL_LIMITS.steps}）`);
      const v = intField('default', lo);
      if (!(lo <= v && v <= hi) || (v - lo) % step) throw new SpacError(`${where}: default 必须在 min..max 之间并落在 step 上`);
    } else if (t === 'picker') {
      const opts = c.options;
      if (!Array.isArray(opts) || !(opts.length >= 2 && opts.length <= CONTROL_LIMITS.options)
          || !opts.every((o: unknown) => typeof o === 'string' && bytes(o) > 0 && bytes(o) <= CONTROL_LIMITS.option)) {
        throw new SpacError(`${where}: options 必须是 2..8 个 1..31 字节的文字`);
      }
      const v = intField('default', 0);
      if (!(v >= 0 && v < opts.length)) throw new SpacError(`${where}: default 是选项下标，0..${opts.length - 1}`);
      if (!['segmented', 'menu'].includes(c.style ?? 'segmented')) throw new SpacError(`${where}: style 只能是 segmented / menu`);
    } else if (t === 'text' || t === 'label') {
      const mx = t === 'text' ? intField('max', 31) : 63;
      if (!(mx >= 1 && mx <= 63)) throw new SpacError(`${where}: max 是 1..63 字节`);
      if (d !== undefined && d !== null && (typeof d !== 'string' || bytes(d) > mx)) throw new SpacError(`${where}: default 必须是 ≤ ${mx} 字节的文字`);
    } else if (t === 'button' && d !== undefined && d !== null) {
      throw new SpacError(`${where}: 按钮没有 default`);
    }
    out.set(cid, { ...c, index: k });
  });
  if (out.size) nKeys += 1;                                          // _c
  nKeys += fieldKeys.size + [...out.values()].filter(c => c.type !== 'button').length;
  if (nKeys > CONTROL_LIMITS.dataKeys) throw new SpacError(`控件和请求返回的数据键一共 ${nKeys} 个，眼镜数据表只有 ${CONTROL_LIMITS.dataKeys} 个，请减少`);
  return out;
}

const ALIGN: Record<string, number> = { center: 0, left: 1, right: 2 };
const ETYPE: Record<string, number> = { text: 1, rect: 2, bar: 3, image: 4 };
const GRAY: Record<string, number> = { text: 255, rect: 40, bar: 255, image: 255 };

// Python 的 str()：清单里的文字通常是字符串，偶尔是数字或布尔
const pyStr = (v: unknown) => (v === true ? 'True' : v === false ? 'False' : String(v));
const pyFloorDiv = (a: number, b: number) => Math.floor(a / b);

export function flattenUi(ui: any[], strings: Strings, assets: string[]): [Uint8Array[], Map<string, number>] {
  const records: Uint8Array[] = [];
  const names = new Map<string, number>();
  const walk = (items: any[], parent: number) => {
    for (const el of items) {
      const t = el.type;
      if (!(t in ETYPE)) throw new SpacError(`界面元素类型 ${t === undefined ? 'None' : `'${t}'`} 不支持（text / rect / bar / image）`);
      const idx = records.length;
      if ('id' in el) {
        if (names.has(el.id)) throw new SpacError(`界面元素 id ${el.id} 重复`);
        names.set(el.id, idx);
      }
      const gray = 'gray' in el ? el.gray : GRAY[t];
      const size = t === 'text' ? ('size' in el ? el.size : 24)
        : ('radius' in el ? el.radius : (t === 'bar' ? pyFloorDiv('h' in el ? el.h : 8, 2) : 0));
      const flags = (el.bold ? 1 : 0) | (ALIGN[el.align ?? 'left'] << 1) | (el.hidden ? 8 : 0);
      let s = 0xffff;
      if (t === 'text' && 'text' in el) s = strings.add(pyStr(el.text), '界面文字');
      if (t === 'image' && (el.src === undefined || el.src === null)) {
        // 空图片框：运行时用 image(el, -1) 放手机传来的图
      } else if (t === 'image') {
        if (!assets.includes(el.src)) throw new SpacError(`图片 ${el.src} 不在 assets/ 里`);
        s = assets.indexOf(el.src);
      }
      for (const key of ['w', 'h']) {
        const v = Math.trunc(Number(el[key] ?? 0));
        if (!(v > 0 && v <= 1080)) throw new SpacError(`元素 ${el.id ?? idx} 缺 ${key} 或超出范围`);
      }
      if (t === 'text' && !(size >= 12 && size <= 96)) throw new SpacError('文字 size 范围 12..96');
      const u8 = (v: number, f: string) => { if (!isInt(v) || v < 0 || v > 255) throw new SpacError(`元素 ${el.id ?? idx} 的 ${f} 必须是 0..255`); return v; };
      const i16 = (v: number, f: string) => { if (!isInt(v) || v < -32768 || v > 32767) throw new SpacError(`元素 ${el.id ?? idx} 的 ${f} 超出范围`); return v; };
      const r = new DataView(new ArrayBuffer(20));
      r.setUint8(0, ETYPE[t]); r.setUint8(1, parent); r.setInt16(2, i16(el.x ?? 0, 'x'), true); r.setInt16(4, i16(el.y ?? 0, 'y'), true);
      r.setUint16(6, el.w, true); r.setUint16(8, el.h, true); r.setUint8(10, u8(gray, 'gray')); r.setUint8(11, u8(size, 'size/radius')); r.setUint8(12, flags);
      r.setUint8(13, u8(el.border ?? 0, 'border')); r.setUint16(14, s, true); r.setUint8(16, u8(el.value ?? 0, 'value')); r.setUint8(17, u8(el.track ?? 55, 'track'));
      r.setUint16(18, 0, true);
      records.push(new Uint8Array(r.buffer));
      if (el.children && el.children.length) {
        if (t !== 'rect') throw new SpacError('只有 rect 可以有 children');
        walk(el.children, idx);
      }
    }
  };
  walk(ui, 0xff);
  if (records.length > LIMITS.elems) throw new SpacError('界面元素超过 48 个');
  return [records, names];
}

// 受限能力（只对 Spare 授权的应用开放）不在开源编译器里，由平台构建处理。
const KINDS = ['http_json', 'location', 'weather', 'notify_count', 'time_sync', 'control_set'];

export function checkManifest(man: any) {
  const appId = man.id ?? '', name = man.name ?? '';
  if (typeof appId !== 'string' || !/^[a-z0-9._-]{3,31}$/.test(appId)) throw new SpacError('id 必须是 3..31 个 [a-z0-9._-]');
  if (typeof name !== 'string' || !(bytes(name) > 0 && bytes(name) <= 23)) throw new SpacError('name 必须 1..23 字节 UTF-8');
  const version = Math.trunc(Number(man.version ?? 1)), dataVersion = Math.trunc(Number(man.data_version ?? 1));
  if (!(version > 0 && version < 65536) || !(dataVersion >= 0 && dataVersion < 65536)) throw new SpacError('version 1..65535，data_version 0..65535');
  const reqs: any[] = man.requests ?? [];
  const requests = new Map<string, number>();
  reqs.forEach((r, k) => requests.set(r.name, k));
  if (requests.size > LIMITS.requests) throw new SpacError('请求超过 32 个');
  const perms = new Set<string>(man.permissions ?? []);
  for (const r of reqs) {
    if (r.kind === 'http_json') {
      const host = /^https:\/\/([^/:?#]+)/.exec(r.url ?? '');
      if (!host || !perms.has(`network:${host[1]}`)) throw new SpacError(`请求 ${r.name}: URL 必须是 https，且主机要写进 permissions（network:主机名）`);
    } else if ((r.kind === 'location' || r.kind === 'weather') && !perms.has('location')) {
      throw new SpacError(`请求 ${r.name}: 需要 location 权限`);
    } else if (r.kind === 'notify_count' && !perms.has('notifications')) {
      throw new SpacError(`请求 ${r.name}: 需要 notifications 权限`);
    } else if (r.kind === 'control_set' && !(man.controls && man.controls.length)) {
      throw new SpacError(`请求 ${r.name}: control_set 要配合 controls 用`);
    } else if (!KINDS.includes(r.kind)) {
      throw new SpacError(`请求 ${r.name}: 不支持的 kind ${r.kind}`);
    }
  }
  return { appId, name, version, dataVersion, requests };
}
