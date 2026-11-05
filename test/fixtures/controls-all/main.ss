var n = 0;
on open() { text(o, ctl("sw") + ctl("sl") + ctl("st") + ctl("pk") + ctl("tx") + ctl("lb")); request(cfg, ""); }
on control(id) { if (id == "bt") { n += 1; ctl_set("lb", n); } text(o, id); }
on data(seq) { text(o, data("k1")); }
