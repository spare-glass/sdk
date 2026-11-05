/* 块注释
   跨两行 */
persist var best = 0x7fffffff;
persist var hex = 0xffffffff;
var zero = 0;
var neg = -129;
var big = 100000;
var f = false;
var s = "转义：\n\t\"\\x";
fn fib(n) { if (n < 2) { return n; } return fib(n - 1) + fib(n - 2); }
fn noret() { }
fn many(a, b, c, d, e, g, h, i) { var j = a + b; var k = j * c; return k - d / e % g + h - i; }
on open() {
  var i = 0; var acc = 0;
  while (i < 10) { i += 1; if (i == 3) { continue; } if (i > 8) { break; } acc += i; }
  acc -= 1; acc *= 2; acc /= 3;
  if (acc > 5 && !(acc == 7) || acc < -1000) { text(t, "a"); } else if (acc == 0) { text(t, "b"); } else { text(t, "c"); }
  text(u, str(fib(10)) + "/" + many(1, 2, 3, 4, 5, 6, 7, 8) + -acc + - -3);
  noret();
  request(q, "x"); request(loc, ""); request(wx, ""); request(tz, ""); request(nc, "");
  timer(3, 100, 1);
}
on close() { save(); }
on crown(d) { best = max(best, d); move(t, d * 2, 0); size(u, 100, 20); gray(t, 128); anim_x(t, 0, 10, 200); }
on click() { exit(); }
on timer(id) { if (id == 3) { timer(3, 0, 0); } value(u, rand(100)); text(u, sub(pad(clock(), 4) + seconds(), 1, 3) + len("x") + abs(-1) + min(1, 2) + num("4") + battery() + now() + connected()); }
on data(seq) { if (data("_err") != "") { return; } text(t, data("v")); }
