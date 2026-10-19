// report.js: laporan keuangan formal. Murni logika (tanpa DOM dan Firebase),
// jadi bisa dipakai untuk tampilan di aplikasi, unduhan PDF, dan unduhan CSV.

const nf = new Intl.NumberFormat("id-ID");
const num = n => nf.format(Math.round(n));
const pctOf = (a, b) => b > 0 ? Math.round(a / b * 100) : 0;
const MON = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
export const fmtD = s => { const [y, m, d] = String(s).split("-").map(Number); return y ? `${d} ${MON[m - 1]} ${y}` : ""; };
const fmtStamp = d => `${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()}, ${String(d.getHours()).padStart(2, "0")}.${String(d.getMinutes()).padStart(2, "0")}`;
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------- 1) Susun data laporan ---------- */
export function buildReport(o) {
  const rows = o.rows || [];
  const inRows = rows.filter(t => t.type === "in"), outRows = rows.filter(t => t.type === "out");
  const sum = rs => rs.reduce((a, t) => a + t.amount, 0);
  const by = rs => { const m = {}; rs.forEach(t => { m[t.category] = (m[t.category] || 0) + t.amount; }); return Object.entries(m).sort((a, b) => b[1] - a[1]); };
  const masuk = sum(inRows), keluar = sum(outRows), selisih = masuk - keluar;
  const kindOf = c => (o.needCats || []).includes(c) ? "Wajib" : (o.wantCats || []).includes(c) ? "Keinginan" : "Lainnya";

  const inflow = by(inRows).map(([name, amount]) => ({ name, amount, pct: pctOf(amount, masuk) }));
  const outflow = by(outRows).map(([name, amount]) => ({ name, kind: kindOf(name), amount, pct: pctOf(amount, keluar) }));
  const kinds = { wajib: sum(outRows.filter(t => kindOf(t.category) === "Wajib")), ingin: sum(outRows.filter(t => kindOf(t.category) === "Keinginan")) };
  kinds.lain = keluar - kinds.wajib - kinds.ingin;
  const base = masuk > 0 ? masuk : keluar;

  const item = t => ({ name: t.memo || t.category, group: t.category, amount: t.amount });
  const assets = (o.assets || []).filter(t => t.amount > 0), debts = (o.debts || []).filter(t => t.amount > 0);
  const lancar = assets.filter(t => (o.lancarCats || []).includes(t.category)).map(item);
  const tetap = assets.filter(t => !(o.lancarCats || []).includes(t.category)).map(item);
  const pendek = debts.filter(t => t.category === (o.debtShort || "Utang jangka pendek")).map(item);
  const panjang = debts.filter(t => t.category !== (o.debtShort || "Utang jangka pendek")).map(item);
  const s = xs => xs.reduce((a, x) => a + x.amount, 0);
  const totalAset = s(lancar) + s(tetap), totalUtang = s(pendek) + s(panjang);

  const detail = rows.slice().sort((a, b) => a.date.localeCompare(b.date) || String(a.id).localeCompare(String(b.id)))
    .map(t => ({ date: t.date, category: t.category, memo: t.memo || "", masuk: t.type === "in" ? t.amount : 0, keluar: t.type === "out" ? t.amount : 0 }));

  const budget = (o.budget || []).map(x => ({ cat: x.cat, jatah: x.jatah, real: x.real, diff: x.real - x.jatah, status: x.status }));

  return {
    name: o.name || "-", from: o.from, to: o.to, label: o.label || "", cap: o.cap || o.to,
    generated: fmtStamp(o.generated || new Date()),
    masuk, keluar, selisih, status: selisih >= 0 ? "SURPLUS" : "DEFISIT",
    rasioTabung: masuk > 0 ? Math.round(selisih / masuk * 100) : 0,
    inflow, outflow, kinds,
    alok: { wajib: pctOf(kinds.wajib, base), ingin: pctOf(kinds.ingin, base), tabung: masuk > 0 ? Math.round(selisih / masuk * 100) : 0, baseName: masuk > 0 ? "pemasukan" : "pengeluaran" },
    pos: { lancar, tetap, pendek, panjang, subLancar: s(lancar), subTetap: s(tetap), totalAset, subPendek: s(pendek), subPanjang: s(panjang), totalUtang, netWorth: totalAset - totalUtang },
    budget, budgetLabel: o.budgetMonthLabel || "", detail, count: rows.length
  };
}

const periodText = r => `${r.label}  (${fmtD(r.from)} s/d ${fmtD(r.to)})`;
const signed = n => n < 0 ? `(${num(-n)})` : num(n);

/* ---------- 2) Tampilan di aplikasi ---------- */
export function reportHtml(r) {
  const tbl = (head, body, foot, cls = "") => `<div class="dtw"><table class="dt ${cls}"><thead><tr>${head.map(([h, c]) => `<th class="${c || ""}">${esc(h)}</th>`).join("")}</tr></thead>
    <tbody>${body || `<tr><td colspan="${head.length}" class="mt">Tidak ada data.</td></tr>`}</tbody>${foot ? `<tfoot>${foot}</tfoot>` : ""}</table></div>`;
  const tr = cells => `<tr>${cells.map(([v, c]) => `<td class="${c || ""}">${v}</td>`).join("")}</tr>`;
  const pos = (title, list, sub, label) => `<tr class="grp"><td colspan="2">${esc(title)}</td></tr>`
    + (list.length ? list.map(x => tr([[esc(x.name) + `<small> · ${esc(x.group)}</small>`], [num(x.amount), "n"]])).join("") : tr([["Tidak ada", "mt"], ["0", "n"]]))
    + `<tr class="sub"><td>${esc(label)}</td><td class="n">${num(sub)}</td></tr>`;

  const inflow = tbl([["Sumber", ""], ["Jumlah (Rp)", "n"], ["%", "n"]],
    r.inflow.map(x => tr([[esc(x.name)], [num(x.amount), "n"], [x.pct + "%", "n"]])).join(""),
    `<tr class="tot"><td>Total arus kas masuk</td><td class="n">${num(r.masuk)}</td><td class="n">100%</td></tr>`);
  const outflow = tbl([["Kategori", ""], ["Jenis", ""], ["Jumlah (Rp)", "n"], ["%", "n"]],
    r.outflow.map(x => tr([[esc(x.name)], [x.kind, "mt"], [num(x.amount), "n"], [x.pct + "%", "n"]])).join(""),
    `<tr class="tot"><td colspan="2">Total arus kas keluar</td><td class="n">${num(r.keluar)}</td><td class="n">100%</td></tr>`);
  const net = tbl([["Ringkasan arus kas", ""], ["Jumlah (Rp)", "n"]],
    tr([["Total arus kas masuk"], [num(r.masuk), "n"]]) + tr([["Total arus kas keluar"], [`(${num(r.keluar)})`, "n"]]),
    `<tr class="tot ${r.selisih < 0 ? "neg" : ""}"><td>${r.status === "SURPLUS" ? "Surplus" : "Defisit"}</td><td class="n">${signed(r.selisih)}</td></tr>`);
  const alok = `<p class="note">Alokasi dari ${r.alok.baseName}: kebutuhan wajib <b>${r.alok.wajib}%</b> (patokan maks. 50%), keinginan <b>${r.alok.ingin}%</b> (maks. 30%)${r.masuk > 0 ? `, tabungan <b>${r.alok.tabung}%</b> (min. 20%)` : ""}.</p>`;
  const posisi = tbl([["Pos", ""], ["Jumlah (Rp)", "n"]],
    pos("Aset lancar", r.pos.lancar, r.pos.subLancar, "Subtotal aset lancar") + pos("Aset tetap", r.pos.tetap, r.pos.subTetap, "Subtotal aset tetap")
    + `<tr class="tot"><td>Total aset</td><td class="n">${num(r.pos.totalAset)}</td></tr>`
    + pos("Liabilitas jangka pendek", r.pos.pendek, r.pos.subPendek, "Subtotal jangka pendek") + pos("Liabilitas jangka panjang", r.pos.panjang, r.pos.subPanjang, "Subtotal jangka panjang")
    + `<tr class="tot"><td>Total liabilitas</td><td class="n">${num(r.pos.totalUtang)}</td></tr>`,
    `<tr class="tot ${r.pos.netWorth < 0 ? "neg" : ""}"><td>Net worth (aset - liabilitas)</td><td class="n">${signed(r.pos.netWorth)}</td></tr>`);
  const budget = r.budget.length ? tbl([["Pos", ""], ["Jatah", "n"], ["Realisasi", "n"], ["Selisih", "n"]],
    r.budget.map(x => tr([[esc(x.cat)], [num(x.jatah), "n"], [num(x.real), "n"], [`<span class="${x.diff > 0 ? "dbad" : "dgood"}">${x.diff > 0 ? "+" : ""}${num(x.diff)}</span>`, "n"]])).join("")) : "";
  const detail = tbl([["Tanggal", ""], ["Kategori", ""], ["Keterangan", ""], ["Masuk", "n"], ["Keluar", "n"]],
    r.detail.map(x => tr([[fmtD(x.date)], [esc(x.category)], [esc(x.memo) || "-", "mt"], [x.masuk ? num(x.masuk) : "", "n dgood"], [x.keluar ? num(x.keluar) : "", "n dbad"]])).join(""),
    `<tr class="tot"><td colspan="3">Total (${r.count} transaksi)</td><td class="n">${num(r.masuk)}</td><td class="n">${num(r.keluar)}</td></tr>`, "wide");

  return `<article class="doc">
    <header class="doc-h"><div class="doc-t">LAPORAN KEUANGAN</div><div class="doc-s">${esc(periodText(r))}</div>
      <dl><dt>Disusun oleh</dt><dd>${esc(r.name)}</dd><dt>Tanggal cetak</dt><dd>${esc(r.generated)}</dd></dl></header>
    <section><h3>Ringkasan</h3>
      <div class="sumr"><div><span>Pemasukan</span><b class="dgood">${num(r.masuk)}</b></div><div><span>Pengeluaran</span><b class="dbad">${num(r.keluar)}</b></div>
      <div><span>${r.status === "SURPLUS" ? "Surplus" : "Defisit"}</span><b class="${r.selisih < 0 ? "dbad" : ""}">${signed(r.selisih)}</b></div></div></section>
    <section><h3>A. Arus kas masuk</h3>${inflow}</section>
    <section><h3>B. Arus kas keluar</h3>${outflow}</section>
    <section><h3>C. Surplus / (defisit)</h3>${net}${alok}</section>
    <section><h3>D. Posisi keuangan per ${esc(fmtD(r.cap))}</h3>${posisi}</section>
    ${budget ? `<section><h3>E. Jatah vs realisasi (${esc(r.budgetLabel)})</h3>${budget}</section>` : ""}
    <section><h3>${budget ? "F" : "E"}. Rincian transaksi</h3>${detail}</section>
    <footer class="doc-f">Disusun otomatis dari catatan di aplikasi Laporan Keuangan Tim.</footer></article>`;
}

/* ---------- 3) CSV (dibuka di Excel / Google Sheets) ---------- */
export function reportCsv(r) {
  const q = v => { const s = String(v ?? ""); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const L = [];
  const row = (...c) => L.push(c.map(q).join(";"));
  row("LAPORAN KEUANGAN"); row("Periode", periodText(r)); row("Disusun oleh", r.name); row("Tanggal cetak", r.generated); row();
  row("RINGKASAN"); row("Total pemasukan", r.masuk); row("Total pengeluaran", r.keluar); row(r.status === "SURPLUS" ? "Surplus" : "Defisit", r.selisih); row();
  row("A. ARUS KAS MASUK"); row("Sumber", "Jumlah (Rp)", "Persen"); r.inflow.forEach(x => row(x.name, x.amount, x.pct + "%")); row("Total", r.masuk, "100%"); row();
  row("B. ARUS KAS KELUAR"); row("Kategori", "Jenis", "Jumlah (Rp)", "Persen"); r.outflow.forEach(x => row(x.name, x.kind, x.amount, x.pct + "%")); row("Total", "", r.keluar, "100%"); row();
  row("D. POSISI KEUANGAN", fmtD(r.cap)); row("Pos", "Kelompok", "Jumlah (Rp)");
  [["Aset lancar", r.pos.lancar], ["Aset tetap", r.pos.tetap]].forEach(([t, l]) => l.forEach(x => row(x.name, t + " / " + x.group, x.amount)));
  row("Total aset", "", r.pos.totalAset);
  [["Liabilitas jangka pendek", r.pos.pendek], ["Liabilitas jangka panjang", r.pos.panjang]].forEach(([t, l]) => l.forEach(x => row(x.name, t, x.amount)));
  row("Total liabilitas", "", r.pos.totalUtang); row("Net worth", "", r.pos.netWorth); row();
  if (r.budget.length) { row("JATAH VS REALISASI", r.budgetLabel); row("Pos", "Jatah", "Realisasi", "Selisih"); r.budget.forEach(x => row(x.cat, x.jatah, x.real, x.diff)); row(); }
  row("RINCIAN TRANSAKSI"); row("Tanggal", "Kategori", "Keterangan", "Masuk", "Keluar");
  r.detail.forEach(x => row(x.date, x.category, x.memo, x.masuk || "", x.keluar || ""));
  row("Total", "", "", r.masuk, r.keluar);
  return "\uFEFF" + L.join("\r\n") + "\r\n";
}

/* ---------- 4) PDF (ditulis langsung, tanpa pustaka) ---------- */
const WR = "278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 278 278 584 584 584 556 1015 667 667 722 722 667 611 778 722 278 500 667 556 833 722 778 667 778 722 667 611 722 667 944 667 667 611 278 278 278 469 556 333 556 556 500 556 556 278 556 556 222 222 500 222 833 556 556 556 556 333 500 278 556 500 722 500 500 500 334 260 334 584".split(" ").map(Number);
const WB = "278 333 474 556 556 889 722 238 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 333 333 584 584 584 611 975 722 722 722 722 667 611 778 722 278 556 722 611 833 722 778 667 778 722 667 611 722 667 944 667 667 611 333 278 333 584 556 333 556 611 556 611 556 333 611 611 278 278 556 278 889 611 611 611 611 389 556 333 611 556 778 556 556 500 389 280 389 584".split(" ").map(Number);
const asc = s => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[\u2013\u2014\u2212]/g, "-").replace(/[\u2022\u00b7]/g, "-")
  .replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\u2026/g, "...").replace(/[\r\n\t]/g, " ").replace(/[^\x20-\x7e]/g, "?");
const pe = s => s.replace(/[\\()]/g, m => "\\" + m);
const tw = (s, size, bold) => { let w = 0; for (const ch of s) w += ((bold ? WB : WR)[ch.charCodeAt(0) - 32] || 556); return w * size / 1000; };
const fit = (s, size, bold, maxW) => { s = asc(s); if (tw(s, size, bold) <= maxW) return s; while (s.length > 1 && tw(s + "...", size, bold) > maxW) s = s.slice(0, -1); return s + "..."; };

const PW = 595.28, PH = 841.89, MX = 46, MB = 52;
const NAVY = [0.063, 0.114, 0.251], MUTED = [0.47, 0.52, 0.6], GOOD = [0.04, 0.5, 0.36], BAD = [0.78, 0.17, 0.25], MINT = [0.32, 0.89, 0.69], HEADBG = [0.925, 0.945, 0.975], LINE = [0.85, 0.88, 0.93], ZEBRA = [0.975, 0.982, 0.992];
const f2 = n => (Math.round(n * 100) / 100).toString();

export function reportPdf(r) {
  const pages = []; let cur, y;
  const newPage = () => { cur = []; pages.push(cur); y = 46; };
  const col = (c, st) => `${c.map(f2).join(" ")} ${st ? "RG" : "rg"}`;
  const text = (x, base, s, size = 9, bold = false, color = NAVY, align = "l", maxW = 0) => {
    s = maxW ? fit(s, size, bold, maxW) : asc(s);
    const w = tw(s, size, bold); const px = align === "r" ? x - w : align === "c" ? x - w / 2 : x;
    cur.push(`${col(color)} BT /${bold ? "F2" : "F1"} ${size} Tf ${f2(px)} ${f2(PH - base)} Td (${pe(s)}) Tj ET`);
  };
  const rect = (x, top, w, h, color) => cur.push(`${col(color)} ${f2(x)} ${f2(PH - top - h)} ${f2(w)} ${f2(h)} re f`);
  const hline = (x1, x2, top, color = LINE, wd = 0.6) => cur.push(`${col(color, true)} ${wd} w ${f2(x1)} ${f2(PH - top)} m ${f2(x2)} ${f2(PH - top)} l S`);
  const ensure = h => { if (y + h > PH - MB) { newPage(); return true; } return false; };
  newPage();

  /* kepala */
  rect(MX, y, PW - 2 * MX, 3, MINT); y += 20;
  text(MX, y + 8, "LAPORAN KEUANGAN", 19, true); y += 24;
  text(MX, y, "Periode: " + r.label + "  (" + fmtD(r.from) + " s/d " + fmtD(r.to) + ")", 10.5, false, MUTED); y += 16;
  text(MX, y, "Disusun oleh: " + r.name, 9.5, false, MUTED); text(PW - MX, y, "Tanggal cetak: " + r.generated, 9.5, false, MUTED, "r"); y += 10;
  hline(MX, PW - MX, y, LINE, 0.8); y += 14;

  const heading = t => { ensure(60); y += 8; text(MX, y + 10, t, 11.5, true); y += 15; hline(MX, PW - MX, y, MINT, 1.2); y += 9; };
  const CW = PW - 2 * MX;

  /* tabel generik: cols = [{w, a:'l'|'r'}], head = [..], rows = [[..]], rowKinds optional */
  const table = (cols, head, rows, opts = {}) => {
    const ws = cols.map(c => c.w * CW), xs = []; let ax = MX; ws.forEach(w => { xs.push(ax); ax += w; });
    const hdr = () => { rect(MX, y, CW, 19, HEADBG); head.forEach((h, i) => text(cols[i].a === "r" ? xs[i] + ws[i] - 6 : xs[i] + 6, y + 12.8, h, 8.6, true, NAVY, cols[i].a, ws[i] - 12)); y += 19; };
    ensure(19 + 17 * Math.min(rows.length, 2)); hdr();
    rows.forEach((row, ri) => {
      const kind = row.kind || ""; const rh = kind === "grp" ? 19 : 17;
      if (ensure(rh)) hdr();
      if (kind === "grp") { rect(MX, y, CW, rh, HEADBG); text(xs[0] + 6, y + 12.6, row[0], 9, true); y += rh; return; }
      if (kind === "tot") { hline(MX, MX + CW, y, NAVY, 0.9); } else if (ri % 2 === 1) rect(MX, y, CW, rh, ZEBRA);
      const bold = kind === "tot" || kind === "sub";
      row.forEach((cell, i) => {
        if (cell === "" || cell == null) return;
        const color = (row.colors && row.colors[i]) || (kind === "neg" ? BAD : NAVY);
        let span = ws[i]; // sel kiri boleh melebar ke sel kosong di sebelahnya
        if (cols[i].a !== "r") for (let j = i + 1; j < cols.length && (row[j] === "" || row[j] == null); j++) span += ws[j];
        text(cols[i].a === "r" ? xs[i] + ws[i] - 6 : xs[i] + 6, y + 11.8, String(cell), 9, bold, color, cols[i].a, span - 12);
      });
      y += rh;
    });
    hline(MX, MX + CW, y, LINE, 0.6); y += 4;
  };

  /* ringkasan */
  heading("Ringkasan");
  const bw = (CW - 20) / 3, boxes = [["Pemasukan", num(r.masuk), GOOD], ["Pengeluaran", num(r.keluar), BAD], [r.status === "SURPLUS" ? "Surplus" : "Defisit", signed(r.selisih), r.selisih < 0 ? BAD : NAVY]];
  ensure(52);
  boxes.forEach(([l, v, c], i) => { const bx = MX + i * (bw + 10); rect(bx, y, bw, 44, HEADBG); text(bx + 10, y + 16, l + " (Rp)", 8.6, false, MUTED); text(bx + 10, y + 34, v, 14, true, c, "l", bw - 20); });
  y += 52;

  heading("A. Arus kas masuk");
  table([{ w: .6 }, { w: .26, a: "r" }, { w: .14, a: "r" }], ["Sumber", "Jumlah (Rp)", "%"],
    r.inflow.length ? [...r.inflow.map(x => [x.name, num(x.amount), x.pct + "%"]), Object.assign(["Total arus kas masuk", num(r.masuk), "100%"], { kind: "tot" })] : [["Tidak ada data", "", ""]]);

  heading("B. Arus kas keluar");
  table([{ w: .42 }, { w: .18 }, { w: .26, a: "r" }, { w: .14, a: "r" }], ["Kategori", "Jenis", "Jumlah (Rp)", "%"],
    r.outflow.length ? [...r.outflow.map(x => [x.name, x.kind, num(x.amount), x.pct + "%"]), Object.assign(["Total arus kas keluar", "", num(r.keluar), "100%"], { kind: "tot" })] : [["Tidak ada data", "", "", ""]]);

  heading("C. Surplus / (defisit)");
  table([{ w: .74 }, { w: .26, a: "r" }], ["Ringkasan arus kas", "Jumlah (Rp)"], [
    ["Total arus kas masuk", num(r.masuk)], ["Total arus kas keluar", "(" + num(r.keluar) + ")"],
    Object.assign([r.status === "SURPLUS" ? "Surplus" : "Defisit", signed(r.selisih)], { kind: r.selisih < 0 ? "neg" : "tot" })]);
  ensure(30);
  text(MX, y + 10, `Alokasi dari ${r.alok.baseName}: kebutuhan wajib ${r.alok.wajib}% (patokan maks. 50%), keinginan ${r.alok.ingin}% (maks. 30%)${r.masuk > 0 ? `, tabungan ${r.alok.tabung}% (min. 20%)` : ""}.`, 8.6, false, MUTED, "l", CW); y += 16;

  heading("D. Posisi keuangan per " + fmtD(r.cap));
  const grp = (t, list, sub, label) => [Object.assign([t, ""], { kind: "grp" }),
    ...(list.length ? list.map(x => [x.name + "  (" + x.group + ")", num(x.amount)]) : [["Tidak ada", "0"]]), Object.assign([label, num(sub)], { kind: "sub" })];
  table([{ w: .74 }, { w: .26, a: "r" }], ["Pos", "Jumlah (Rp)"], [
    ...grp("Aset lancar", r.pos.lancar, r.pos.subLancar, "Subtotal aset lancar"), ...grp("Aset tetap", r.pos.tetap, r.pos.subTetap, "Subtotal aset tetap"),
    Object.assign(["Total aset", num(r.pos.totalAset)], { kind: "tot" }),
    ...grp("Liabilitas jangka pendek", r.pos.pendek, r.pos.subPendek, "Subtotal jangka pendek"), ...grp("Liabilitas jangka panjang", r.pos.panjang, r.pos.subPanjang, "Subtotal jangka panjang"),
    Object.assign(["Total liabilitas", num(r.pos.totalUtang)], { kind: "tot" }),
    Object.assign(["Net worth (aset - liabilitas)", signed(r.pos.netWorth)], { kind: r.pos.netWorth < 0 ? "neg" : "tot" })]);

  let letter = "E";
  if (r.budget.length) {
    heading("E. Jatah vs realisasi (" + r.budgetLabel + ")");
    table([{ w: .34 }, { w: .22, a: "r" }, { w: .22, a: "r" }, { w: .22, a: "r" }], ["Pos", "Jatah (Rp)", "Realisasi (Rp)", "Selisih (Rp)"],
      r.budget.map(x => Object.assign([x.cat, num(x.jatah), num(x.real), (x.diff > 0 ? "+" : "") + num(x.diff)], { colors: [null, null, null, x.diff > 0 ? BAD : GOOD] })));
    letter = "F";
  }
  heading(letter + ". Rincian transaksi");
  table([{ w: .15 }, { w: .22 }, { w: .31 }, { w: .16, a: "r" }, { w: .16, a: "r" }], ["Tanggal", "Kategori", "Keterangan", "Masuk (Rp)", "Keluar (Rp)"],
    r.detail.length ? [...r.detail.map(x => Object.assign([fmtD(x.date), x.category, x.memo || "-", x.masuk ? num(x.masuk) : "", x.keluar ? num(x.keluar) : ""], { colors: [null, null, null, GOOD, BAD] })),
      Object.assign(["Total (" + r.count + " transaksi)", "", "", num(r.masuk), num(r.keluar)], { kind: "tot" })] : [["Tidak ada transaksi", "", "", "", ""]]);

  /* tanda tangan */
  if (ensure(70)) { /* halaman baru */ }
  y += 18; text(PW - MX, y, "Disusun oleh,", 9.5, false, MUTED, "r"); y += 44; hline(PW - MX - 150, PW - MX, y, NAVY, 0.7); y += 13; text(PW - MX, y, r.name, 10, true, NAVY, "r", 150);

  /* kaki halaman */
  const n = pages.length;
  pages.forEach((p, i) => { cur = p; hline(MX, PW - MX, PH - 34, LINE, 0.6); text(MX, PH - 21, "Laporan Keuangan Tim - " + r.name, 8, false, MUTED, "l", 300); text(PW - MX, PH - 21, `Halaman ${i + 1} dari ${n}`, 8, false, MUTED, "r"); });

  /* rakit berkas PDF */
  const objs = [];
  const put = s => { objs.push(s); return objs.length; };
  put("<< /Type /Catalog /Pages 2 0 R >>");
  put(`<< /Type /Pages /Kids [${pages.map((_, i) => `${7 + 2 * i} 0 R`).join(" ")}] /Count ${n} >>`);
  put("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  put("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  put(`<< /Title (${pe(asc("Laporan Keuangan - " + r.name + " - " + r.label))}) /Producer (Laporan Keuangan Tim) >>`);
  pages.forEach((p, i) => {
    const stream = p.join("\n");
    put(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    put(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f2(PW)} ${f2(PH)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + 2 * i} 0 R >>`);
  });
  /* objek: 1 katalog, 2 daftar halaman, 3-4 font, 5 info, lalu (isi, halaman) untuk tiap halaman */
  return assemble(objs);
}

function assemble(objs) {
  let out = "%PDF-1.4\n"; const off = [];
  objs.forEach((o, i) => { off.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xr = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + off.map(o => String(o).padStart(10, "0") + " 00000 n \n").join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xr}\n%%EOF\n`;
  return out;
}
