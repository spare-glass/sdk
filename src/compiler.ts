// SpareScript 编译器：词法 → 语法 → 字节码。行为与平台的 spac 编译器逐字节一致（见 test/parity.mjs）。
// 规范：https://github.com/spare-glass/spec/blob/main/language.md

export class SpacError extends Error {}

export const LIMITS = { globals: 64, elems: 48, funcs: 64, fnBytes: 4096, locals: 32, strBytes: 63, pkg: 32768, requests: 32 };
export const EVENTS = ['open', 'close', 'crown', 'click', 'timer', 'data'];          // + init（编译器生成）= 第 6 号
const EVENT_PARAMS: Record<string, number> = { open: 0, close: 0, crown: 1, click: 0, timer: 1, data: 1, control: 1 };
const SUGAR_EVENTS = ['control'];                                                    // 语法糖：编进 data 处理函数
export const BUILTINS = ['text', 'show', 'gray', 'move', 'size', 'value', 'image', 'anim_x', 'anim_opa', 'anim_scale',
  'timer', 'now', 'clock', 'seconds', 'str', 'num', 'len', 'sub', 'pad', 'min',
  'max', 'clamp', 'abs', 'rand', 'data', 'request', 'connected', 'battery', 'save', 'exit'];
export const ARITY = [2, 2, 2, 3, 3, 2, 2, 4, 4, 4, 3, 0, 0, 0, 1, 1, 1, 3, 2, 2, 2, 3, 1, 1, 1, 2, 0, 0, 0, 0];
export const OP: Record<string, number> = {
  PUSH_I8: 0x01, PUSH_I32: 0x02, PUSH_S: 0x03, LOAD_G: 0x04, STORE_G: 0x05, LOAD_L: 0x06, STORE_L: 0x07, POP: 0x08,
  DUP: 0x09, ADD: 0x10, SUB: 0x11, MUL: 0x12, DIV: 0x13, MOD: 0x14, NEG: 0x15, EQ: 0x16, NE: 0x17, LT: 0x18, LE: 0x19,
  GT: 0x1a, GE: 0x1b, NOT: 0x1c, JMP: 0x30, JZ: 0x31, JNZ: 0x32, CALL: 0x40, RET: 0x41, SYS: 0x42,
};
const BINOP: Record<string, string> = { '+': 'ADD', '-': 'SUB', '*': 'MUL', '/': 'DIV', '%': 'MOD', '==': 'EQ', '!=': 'NE',
  '<': 'LT', '<=': 'LE', '>': 'GT', '>=': 'GE' };
const PREC = [['||'], ['&&'], ['==', '!='], ['<', '<=', '>', '>='], ['+', '-'], ['*', '/', '%']];
const KEYWORDS = new Set(['var', 'persist', 'fn', 'on', 'if', 'else', 'while', 'break', 'continue', 'return', 'true', 'false']);

export const utf8 = (s: string) => new TextEncoder().encode(s);
const repr = (v: unknown) => (typeof v === 'string' ? `'${v}'` : String(v ?? 'None'));

// ---- 词法 ---------------------------------------------------------------------------------------------------------
type Tok = [kind: string, val: any, line: number];
const TOKEN = /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|(?<num>0x[0-9a-fA-F]+|\d+)|(?<str>"(?:\\[\s\S]|[^"\\\n])*")|(?<id>[A-Za-z_][A-Za-z0-9_]*)|(?<op>\+=|-=|\*=|\/=|==|!=|<=|>=|&&|\|\||[-+*/%<>=!(){};,])/y;

export function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let pos = 0, line = 1;
  while (pos < src.length) {
    TOKEN.lastIndex = pos;
    const m = TOKEN.exec(src);
    if (!m) throw new SpacError(`main.ss:${line}: 看不懂的字符 ${repr(src[pos])}`);
    const g = m.groups!;
    if (g.num !== undefined) {
      if (/^0\d*[1-9]/.test(g.num) && !g.num.startsWith('0x')) throw new SpacError(`main.ss:${line}: 数字 ${g.num} 不能以 0 开头`);
      out.push(['num', g.num.startsWith('0x') ? parseInt(g.num, 16) : Number(g.num), line]);
    } else if (g.str !== undefined) {
      const s = g.str.slice(1, -1).replace(/\\([\s\S])/g, (_, c) => ({ n: '\n', t: '\t' } as Record<string, string>)[c] ?? c);
      out.push(['str', s, line]);
    } else if (g.id !== undefined) {
      out.push([KEYWORDS.has(g.id) ? 'kw' : 'id', g.id, line]);
    } else if (g.op !== undefined) {
      out.push(['op', g.op, line]);
    }
    line += (m[0].match(/\n/g) || []).length;
    pos = TOKEN.lastIndex;
  }
  out.push(['eof', null, line]);
  return out;
}

// ---- 语法 ---------------------------------------------------------------------------------------------------------
// 语法树沿用元组形状：['num', v] ['str', s] ['name', n, line] ['bin', op, a, b] ['and'|'or', a, b] ['not', e] ['neg', e]
// ['call', name, args, line]；语句 ['local', n, e, line] ['assign', n, e, line] ['expr', e, line] ['if', c, then, else, line]
// ['while', c, body, line] ['break', line] ['continue', line] ['return', e|null, line]
export type Node = any[];

class Parser {
  t: Tok[]; i = 0;
  constructor(toks: Tok[]) { this.t = toks; }
  peek(k = 0) { return this.t[this.i + k]; }
  err(msg: string): never { throw new SpacError(`main.ss:${this.peek()[2]}: ${msg}`); }
  take(kind?: string, val?: string) {
    const tok = this.t[this.i];
    if ((kind && tok[0] !== kind) || (val !== undefined && tok[1] !== val)) this.err(`这里应该是 ${val || kind}，看到的是 ${repr(tok[1])}`);
    this.i += 1;
    return tok;
  }
  accept(kind: string, val: string) {
    if (this.peek()[0] === kind && this.peek()[1] === val) { this.i += 1; return true; }
    return false;
  }
  program(): Node[] {
    const items: Node[] = [];
    while (this.peek()[0] !== 'eof') {
      const line = this.peek()[2];
      if (this.accept('kw', 'persist')) {
        this.take('kw', 'var');
        items.push(['global', this.take('id')[1], this.init(), true, line]);
      } else if (this.accept('kw', 'var')) {
        items.push(['global', this.take('id')[1], this.init(), false, line]);
      } else if (this.accept('kw', 'fn')) {
        const name = this.take('id')[1];
        items.push(['fn', name, this.params(), this.block(), line]);
      } else if (this.accept('kw', 'on')) {
        const name = this.take('id')[1];
        if (![...EVENTS, ...SUGAR_EVENTS].includes(name)) this.err(`没有 ${name} 这个事件（可用：${[...EVENTS, ...SUGAR_EVENTS].join(', ')}）`);
        items.push(['on', name, this.params(), this.block(), line]);
      } else {
        this.err('顶层只能写 var / persist var / fn / on');
      }
    }
    return items;
  }
  init(): Node {
    const e = this.accept('op', '=') ? this.expr() : ['num', 0];
    this.take('op', ';');
    return e;
  }
  params(): string[] {
    this.take('op', '(');
    const ps: string[] = [];
    if (!this.accept('op', ')')) {
      for (;;) {
        ps.push(this.take('id')[1]);
        if (this.accept('op', ')')) break;
        this.take('op', ',');
      }
    }
    return ps;
  }
  block(): Node[] {
    this.take('op', '{');
    const out: Node[] = [];
    while (!this.accept('op', '}')) out.push(this.stmt());
    return out;
  }
  stmt(): Node {
    const line = this.peek()[2];
    if (this.accept('kw', 'var')) {
      const name = this.take('id')[1];
      return ['local', name, this.init(), line];
    }
    if (this.accept('kw', 'if')) {
      this.take('op', '('); const c = this.expr(); this.take('op', ')');
      const then = this.block();
      let other: Node[] = [];
      if (this.accept('kw', 'else')) other = this.peek()[1] === 'if' ? [this.stmt()] : this.block();
      return ['if', c, then, other, line];
    }
    if (this.accept('kw', 'while')) {
      this.take('op', '('); const c = this.expr(); this.take('op', ')');
      return ['while', c, this.block(), line];
    }
    if (this.accept('kw', 'break')) { this.take('op', ';'); return ['break', line]; }
    if (this.accept('kw', 'continue')) { this.take('op', ';'); return ['continue', line]; }
    if (this.accept('kw', 'return')) {
      const e = this.peek()[1] === ';' ? null : this.expr();
      this.take('op', ';');
      return ['return', e, line];
    }
    if (this.peek()[0] === 'id' && this.peek(1)[0] === 'op' && ['=', '+=', '-=', '*=', '/='].includes(this.peek(1)[1])) {
      const name = this.take('id')[1];
      const op = this.take('op')[1];
      let e = this.expr();
      this.take('op', ';');
      if (op !== '=') e = ['bin', op[0], ['name', name, line], e];
      return ['assign', name, e, line];
    }
    const e = this.expr();
    this.take('op', ';');
    return ['expr', e, line];
  }
  expr(level = 0): Node {
    if (level === PREC.length) return this.unary();
    let left = this.expr(level + 1);
    while (this.peek()[0] === 'op' && PREC[level].includes(this.peek()[1])) {
      const op = this.take('op')[1];
      const right = this.expr(level + 1);
      left = op === '&&' || op === '||' ? [op === '&&' ? 'and' : 'or', left, right] : ['bin', op, left, right];
    }
    return left;
  }
  unary(): Node {
    if (this.accept('op', '!')) return ['not', this.unary()];
    if (this.accept('op', '-')) {
      const e = this.unary();
      return e[0] === 'num' ? ['num', -e[1]] : ['neg', e];
    }
    return this.primary();
  }
  primary(): Node {
    const tok = this.take();
    const line = tok[2];
    if (tok[0] === 'num') return ['num', tok[1]];
    if (tok[0] === 'str') return ['str', tok[1]];
    if (tok[0] === 'kw' && (tok[1] === 'true' || tok[1] === 'false')) return ['num', tok[1] === 'true' ? 1 : 0];
    if (tok[0] === 'op' && tok[1] === '(') { const e = this.expr(); this.take('op', ')'); return e; }
    if (tok[0] === 'id') {
      if (this.accept('op', '(')) {
        const args: Node[] = [];
        if (!this.accept('op', ')')) {
          for (;;) {
            args.push(this.expr());
            if (this.accept('op', ')')) break;
            this.take('op', ',');
          }
        }
        return ['call', tok[1], args, line];
      }
      return ['name', tok[1], line];
    }
    this.i -= 1;
    this.err(`这里应该是一个值，看到的是 ${repr(tok[1])}`);
  }
}

export const parse = (src: string) => new Parser(lex(src)).program();

// ---- 代码生成 -----------------------------------------------------------------------------------------------------
export class Strings {
  items: string[] = []; index = new Map<string, number>();
  add(s: string, where = '') {
    if (utf8(s).length > LIMITS.strBytes) throw new SpacError(`${where}字符串超过 63 字节：${repr(s)}`);
    if (s.includes('\0')) throw new SpacError(`${where}字符串里不能有 NUL`);
    if (!this.index.has(s)) { this.index.set(s, this.items.length); this.items.push(s); }
    return this.index.get(s)!;
  }
}

export class Fn {
  name: string; params: string[]; locals: string[]; code: number[] = []; loops: [number, number[]][] = [];
  constructor(name: string, params: string[]) { this.name = name; this.params = [...params]; this.locals = [...params]; }
  emit(op: string, ...args: [string, number][]) {
    this.code.push(OP[op]);
    for (const [kind, v] of args) {
      if (kind === 'b' || kind === 'B') this.code.push(v & 0xff);
      else if (kind === 'H' || kind === 'h') this.code.push(v & 0xff, (v >> 8) & 0xff);
      else this.code.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
    }
  }
  jump(op: string) { this.emit(op, ['h', 0]); return this.code.length; }   // 回填点 = 指令之后
  patch(site: number, target: number) {
    const off = target - site;
    if (off < -32768 || off > 32767) throw new SpacError(`${this.name}: 函数太长`);
    this.code[site - 2] = off & 0xff;
    this.code[site - 1] = (off >> 8) & 0xff;
  }
}

const CTL_KEY = '_c';
const CTL_SUGAR = ['ctl', 'ctl_set'];

export type Control = Record<string, any> & { index: number };

export class Compiler {
  items: Node[]; elems: Map<string, number>; requests: Map<string, number>; strings: Strings;
  controls: Map<string, Control>; ctlReq: number | null;
  globals: string[] = []; nPersist = 0; fns: Node[] = []; fnIndex = new Map<string, number>(); ons = new Map<string, Node>();
  out: Fn[] = [];

  constructor(items: Node[], elems: Map<string, number>, requests: Map<string, number>, strings: Strings,
              controls?: Map<string, Control>, ctlReq: number | null = null) {
    this.items = items; this.elems = elems; this.requests = requests; this.strings = strings;
    this.controls = controls ?? new Map(); this.ctlReq = ctlReq;
    for (const i of items) {
      if (i[0] !== 'global' && i[0] !== 'fn') continue;
      if (i[1].startsWith('__') || CTL_SUGAR.includes(i[1])) throw new SpacError(`名字 ${i[1]} 是保留的（ctl / ctl_set / 以 __ 开头）`);
    }
    const ons = new Map<string, Node>();
    for (const i of items) if (i[0] === 'on') ons.set(i[1], i);
    if (ons.has('control') && !this.controls.size) throw new SpacError('写了 on control，但 app.json 没有 controls');
    if (ons.has('control') && ons.get('control')![2].length > 1) throw new SpacError('on control 最多 1 个参数（变了的控件 id）');
    if (ons.has('control')) {
      // on control(id) → 普通函数；data 事件换成生成的分发函数
      const ev = ons.get('control')!; ons.delete('control');
      items = items.filter(i => !(i[0] === 'on' && i[1] === 'control'));
      items.push(['fn', '__on_control', [...ev[2], '__a'].slice(0, 1), ev[3], ev[4]]);
      if (ons.has('data')) {
        const d = ons.get('data')!; ons.delete('data');
        items = items.filter(i => !(i[0] === 'on' && i[1] === 'data'));
        items.push(['fn', '__on_data', [...d[2], '__a'].slice(0, 1), d[3], d[4]]);
      }
      const L = ev[4];
      const body: Node[] = [['if', ['bin', '==', ['name', 'seq', L], ['num', 0]], [
        ['local', '__c', ['call', 'data', [['str', CTL_KEY]], L], L],
        ['if', ['bin', '!=', ['name', '__c', L], ['str', '']],
          [['expr', ['call', '__on_control', [['name', '__c', L]], L], L], ['return', null, L]], [], L]],
        [], L]];
      if (this.items.some(i => i[0] === 'on' && i[1] === 'data')) body.push(['expr', ['call', '__on_data', [['name', 'seq', L]], L], L]);
      items.push(['on', 'data', ['seq'], body, L]);
    }
    if (this.controls.size && Compiler.calls(items).includes('ctl')) {
      // ctl("id")：没收到过手机的值（""）时返回 app.json 的 default
      for (const [fname, conv] of [['__ctl_i', ['call', 'num', [['name', '__v', 0]], 0]], ['__ctl_s', ['name', '__v', 0]]] as [string, Node][]) {
        items.push(['fn', fname, ['__k', '__d'], [
          ['local', '__v', ['call', 'data', [['name', '__k', 0]], 0], 0],
          ['if', ['bin', '==', ['name', '__v', 0], ['str', '']], [['return', ['name', '__d', 0], 0]], [], 0],
          ['return', conv, 0]], 0]);
      }
    }
    this.items = items;
    this.index();
  }

  private index() {
    const items = this.items;
    const persist = items.filter(i => i[0] === 'global' && i[3]);
    const plain = items.filter(i => i[0] === 'global' && !i[3]);
    this.globals = [...persist, ...plain].map(i => i[1]);
    this.nPersist = persist.length;
    if (new Set(this.globals).size !== this.globals.length) throw new SpacError('全局变量重名');
    if (this.globals.length > LIMITS.globals) throw new SpacError('全局变量超过 64 个');
    this.fns = items.filter(i => i[0] === 'fn');
    this.fnIndex = new Map();
    this.fns.forEach((f, k) => this.fnIndex.set(f[1], k));
    if (this.fnIndex.size !== this.fns.length) throw new SpacError('函数重名');
    for (const name of [...this.fnIndex.keys(), ...this.globals]) {
      if (BUILTINS.includes(name) || this.elems.has(name) || this.requests.has(name)) throw new SpacError(`名字 ${name} 和内建函数 / 界面元素 / 请求重名`);
    }
    this.ons = new Map();
    for (const i of items) if (i[0] === 'on') this.ons.set(i[1], i);
    this.out = [];
  }

  static calls(node: any): string[] {
    const out: string[] = [];
    if (Array.isArray(node)) {
      if (node.length >= 3 && node[0] === 'call' && typeof node[1] === 'string') out.push(node[1]);
      for (const x of node) out.push(...Compiler.calls(x));
    }
    return out;
  }

  private controlArg(name: string, args: Node[], line: number): [string, Control] {
    if (!args.length || args[0][0] !== 'str') throw new SpacError(`main.ss:${line}: ${name} 的第一个参数必须是控件 id 字符串，如 ${name}("sound")`);
    const cid = args[0][1];
    if (!this.controls.has(cid)) throw new SpacError(`main.ss:${line}: app.json 的 controls 里没有 ${cid}（有：${[...this.controls.keys()].join(', ') || '无'}）`);
    return [cid, this.controls.get(cid)!];
  }

  build(): [Fn[], number[]] {
    for (const f of this.fns) this.out.push(this.fn(f[1], f[2], f[3]));
    const events = Array(7).fill(0xff);
    for (const [ev, item] of this.ons) {
      if (item[2].length > EVENT_PARAMS[ev]) throw new SpacError(`on ${ev} 最多 ${EVENT_PARAMS[ev]} 个参数`);
      events[EVENTS.indexOf(ev)] = this.out.length;
      this.out.push(this.fn('on ' + ev, item[2], item[3]));
    }
    const inits = this.items.filter(i => i[0] === 'global' && !(i[2][0] === 'num' && i[2].length === 2 && i[2][1] === 0));
    if (inits.length) {
      events[6] = this.out.length;
      this.out.push(this.fn('init', [], inits.map(i => ['assign', i[1], i[2], i[4]])));
    }
    if (this.out.length > LIMITS.funcs) throw new SpacError('函数（含事件）超过 64 个');
    return [this.out, events];
  }

  private fn(name: string, params: string[], body: Node[]) {
    const f = new Fn(name, params);
    for (const s of body) this.stmt(f, s);
    f.emit('PUSH_I8', ['b', 0]);
    f.emit('RET');
    if (f.locals.length > LIMITS.locals) throw new SpacError(`${name}: 局部变量超过 32 个`);
    if (f.code.length > LIMITS.fnBytes) throw new SpacError(`${name}: 函数编译后超过 4096 字节，请拆开`);
    return f;
  }

  private stmt(f: Fn, s: Node) {
    switch (s[0]) {
      case 'local':
        if (f.locals.includes(s[1])) throw new SpacError(`main.ss:${s[3]}: 局部变量 ${s[1]} 重复定义`);
        this.expr(f, s[2]);
        f.locals.push(s[1]);
        f.emit('STORE_L', ['B', f.locals.length - 1]);
        break;
      case 'assign':
        this.expr(f, s[2]);
        if (f.locals.includes(s[1])) f.emit('STORE_L', ['B', f.locals.indexOf(s[1])]);
        else if (this.globals.includes(s[1])) f.emit('STORE_G', ['B', this.globals.indexOf(s[1])]);
        else throw new SpacError(`main.ss:${s[3]}: 没有变量 ${s[1]}（先用 var 声明）`);
        break;
      case 'expr':
        this.expr(f, s[1]);
        f.emit('POP');
        break;
      case 'if': {
        this.expr(f, s[1]);
        const j = f.jump('JZ');
        for (const x of s[2]) this.stmt(f, x);
        if (s[3].length) {
          const e = f.jump('JMP');
          f.patch(j, f.code.length);
          for (const x of s[3]) this.stmt(f, x);
          f.patch(e, f.code.length);
        } else {
          f.patch(j, f.code.length);
        }
        break;
      }
      case 'while': {
        const top = f.code.length;
        this.expr(f, s[1]);
        const j = f.jump('JZ');
        f.loops.push([top, []]);
        for (const x of s[2]) this.stmt(f, x);
        const back = f.jump('JMP');
        f.patch(back, top);
        f.patch(j, f.code.length);
        for (const site of f.loops.pop()![1]) f.patch(site, f.code.length);
        break;
      }
      case 'break':
      case 'continue': {
        if (!f.loops.length) throw new SpacError(`main.ss:${s[1]}: ${s[0]} 不在循环里`);
        const site = f.jump('JMP');
        if (s[0] === 'continue') f.patch(site, f.loops[f.loops.length - 1][0]);
        else f.loops[f.loops.length - 1][1].push(site);
        break;
      }
      case 'return':
        if (s[1] === null) f.emit('PUSH_I8', ['b', 0]);
        else this.expr(f, s[1]);
        f.emit('RET');
        break;
    }
  }

  private expr(f: Fn, e: Node): void {
    const k = e[0];
    if (k === 'num') {
      let v = Number(e[1]);
      if (!(v >= -(2 ** 31) && v < 2 ** 32)) throw new SpacError(`数字 ${v} 超出 32 位`);
      if (v >= 2 ** 31) v -= 2 ** 32;
      if (v >= -128 && v <= 127) f.emit('PUSH_I8', ['b', v]);
      else f.emit('PUSH_I32', ['i', v]);
    } else if (k === 'str') {
      f.emit('PUSH_S', ['H', this.strings.add(e[1])]);
    } else if (k === 'name') {
      const n = e[1];
      if (f.locals.includes(n)) f.emit('LOAD_L', ['B', f.locals.indexOf(n)]);
      else if (this.globals.includes(n)) f.emit('LOAD_G', ['B', this.globals.indexOf(n)]);
      else if (this.elems.has(n)) this.expr(f, ['num', this.elems.get(n)]);
      else if (this.requests.has(n)) this.expr(f, ['num', this.requests.get(n)]);
      else throw new SpacError(`main.ss:${e[2]}: 不认识的名字 ${n}`);
    } else if (k === 'bin') {
      this.expr(f, e[2]);
      this.expr(f, e[3]);
      f.emit(BINOP[e[1]]);
    } else if (k === 'and' || k === 'or') {
      this.expr(f, e[1]);
      f.emit('DUP');
      const j = f.jump(k === 'and' ? 'JZ' : 'JNZ');
      f.emit('POP');
      this.expr(f, e[2]);
      f.patch(j, f.code.length);
    } else if (k === 'not') {
      this.expr(f, e[1]);
      f.emit('NOT');
    } else if (k === 'neg') {
      this.expr(f, e[1]);
      f.emit('NEG');
    } else if (k === 'call' && e[1] === 'ctl' && !this.fnIndex.has('ctl')) {
      const [cid, c] = this.controlArg('ctl', e[2], e[3]);
      if (e[2].length !== 1) throw new SpacError(`main.ss:${e[3]}: ctl 要 1 个参数`);
      if (c.type === 'button') throw new SpacError(`main.ss:${e[3]}: ${cid} 是按钮，没有值；在 on control(id) 里判断 id == "${cid}"`);
      const text = c.type === 'text' || c.type === 'label';
      const d: Node = text ? ['str', 'default' in c ? c.default : ''] : ['num', 'default' in c ? Number(c.default) : 0];
      this.expr(f, ['call', text ? '__ctl_s' : '__ctl_i', [['str', cid], d], e[3]]);
    } else if (k === 'call' && e[1] === 'ctl_set' && !this.fnIndex.has('ctl_set')) {
      const [cid, c] = this.controlArg('ctl_set', e[2], e[3]);
      if (e[2].length !== 2) throw new SpacError(`main.ss:${e[3]}: ctl_set 要 2 个参数：ctl_set("${cid}", 值)`);
      if (this.ctlReq === null) throw new SpacError(`main.ss:${e[3]}: 用 ctl_set 要先在 requests 里声明 {"name": "setctl", "kind": "control_set"}`);
      if (c.type === 'button') throw new SpacError(`main.ss:${e[3]}: ${cid} 是按钮，没有值`);
      // 请求参数 "<控件序号>=<值>"（≤ 10 字节），手机存下并原样回给眼镜
      this.expr(f, ['call', 'request', [['num', this.ctlReq], ['bin', '+', ['str', `${c.index}=`], e[2][1]]], e[3]]);
    } else if (k === 'call') {
      const [, name, args, line] = e;
      for (const a of args) this.expr(f, a);
      if (this.fnIndex.has(name)) {
        const want = this.fns[this.fnIndex.get(name)!][2].length;
        if (args.length !== want) throw new SpacError(`main.ss:${line}: ${name} 要 ${want} 个参数`);
        f.emit('CALL', ['B', this.fnIndex.get(name)!]);
      } else if (BUILTINS.includes(name)) {
        const b = BUILTINS.indexOf(name);
        if (args.length !== ARITY[b]) throw new SpacError(`main.ss:${line}: ${name} 要 ${ARITY[b]} 个参数`);
        f.emit('SYS', ['B', b], ['B', ARITY[b]]);
      } else {
        throw new SpacError(`main.ss:${line}: 没有函数 ${name}`);
      }
    }
  }
}
