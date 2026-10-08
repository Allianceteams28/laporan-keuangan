import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, addDoc, deleteDoc, writeBatch,
  collection, query, where, orderBy, limit, getDocs, onSnapshot, serverTimestamp, Timestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

// Harus sama dengan email founder di firestore.rules
const FOUNDER_EMAIL = "aljanedbagdady@gmail.com";

const CATS = {
  out: ["Makanan", "Transportasi", "Belanja", "Tagihan", "Hiburan", "Kesehatan", "Lainnya"],
  in: ["Gaji", "Bonus", "Usaha", "Hadiah", "Lainnya"]
};
const ROLE_LABEL = { pending: "Menunggu", member: "Anggota", admin: "Admin", founder: "Founder", removed: "Dikeluarkan" };
const ROLE_ACT = { approve: "menyetujui", promote: "mengangkat jadi admin", demote: "mencopot dari admin", remove: "mengeluarkan", restore: "memulihkan" };
const STATUS_LABEL = { open: "Perlu revisi", fixed: "Sudah ditanggapi", admin_fixed: "Diubah admin" };

/* ---------- Helpers ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const rp = n => "Rp " + new Intl.NumberFormat("id-ID").format(Math.round(n));
const pad = n => String(n).padStart(2, "0");
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => ymd(new Date());
const longDay = s => new Date(s + "T00:00").toLocaleDateString("id-ID", { weekday: "long", day: "numeric", month: "long" });
const monthLabel = m => { const [y, mo] = m.split("-"); return new Date(y, mo - 1, 1).toLocaleDateString("id-ID", { month: "long", year: "numeric" }); };
const ms = ts => (ts && ts.toMillis) ? ts.toMillis() : null;
const fmtDT = ts => {
  const m = ts instanceof Date ? ts.getTime() : ms(ts);
  return m ? new Date(m).toLocaleString("id-ID", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "baru saja";
};
const snapOf = t => ({ type: t.type, amount: t.amount, category: t.category, date: t.date, memo: t.memo || "" });
const mapDoc = d => ({ id: d.id, pending: d.metadata.hasPendingWrites, ...d.data() });
const isStaff = () => profile && (profile.role === "admin" || profile.role === "founder");
const isActive = () => profile && ["member", "admin", "founder"].includes(profile.role);
const deadlineOf = t => (t.flagDeadline && t.flagDeadline.toDate) ? t.flagDeadline.toDate() : null;
const defDeadline = () => {
  const d = new Date(); d.setDate(d.getDate() + 2); d.setHours(23, 59, 0, 0);
  return `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), 3500);
}
function friendly(e) {
  if (e && e.code === "permission-denied")
    return "Ditolak oleh aturan akses. Bisa jadi data sudah berubah atau batas waktu sudah lewat. Muat ulang lalu coba lagi.";
  if (e && e.code === "unavailable") return "Tidak ada koneksi. Coba lagi sebentar.";
  return "Terjadi kesalahan: " + (e && (e.code || e.message) || "tidak diketahui");
}
const onErr = e => toast(friendly(e));

/* ---------- Firebase ---------- */
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

/* ---------- State ---------- */
let profile = null, unsubProfile = null, unsubs = [];
let tab = "catatan", myTx = [], flagged = [], nMine = [], nAll = [], notifs = [];
let month = todayStr().slice(0, 7);
let weekOffset = 0, weekTx = [], weekLoading = false, drill = null;
let people = [], auditFeed = [], roleLogs = [], purgeLogs = [], feedLoading = false, seenAtOpen = 0;
let txType = "out";
let layers = [];
let lastKey = "";
const homeTab = () => isStaff() ? "masuk" : "catatan";
const mainTabs = () => isStaff() ? ["masuk", "laporan", "anggota", "lainnya"] : ["catatan", "revisi"];

/* ---------- Auth ---------- */
async function login() {
  const p = new GoogleAuthProvider();
  try { await signInWithPopup(auth, p); }
  catch (e) {
    if (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment") {
      try { await signInWithRedirect(auth, p); } catch (e2) { toast(friendly(e2)); }
    } else if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") toast(friendly(e));
  }
}
getRedirectResult(auth).catch(onErr);

function fatal(e) {
  $("#app").innerHTML = `<div class="center"><h1>Gagal memuat</h1><p>${esc(friendly(e))}</p><button class="btn" data-act="logout">Keluar</button></div>`;
}

onAuthStateChanged(auth, async user => {
  unsubProfile && unsubProfile(); unsubs.forEach(f => f()); unsubs = [];
  layers = []; profile = null; myTx = []; flagged = []; weekTx = []; people = []; notifs = []; nMine = []; nAll = [];
  if (!user) { renderLogin(); return; }
  $("#app").innerHTML = `<div class="center"><p>Memuat…</p></div>`;
  try {
    const ref = doc(db, "users", user.uid);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      const isF = user.email === FOUNDER_EMAIL && user.emailVerified;
      await setDoc(ref, {
        name: user.displayName || user.email, email: user.email, photo: user.photoURL || "",
        role: isF ? "founder" : "pending", createdAt: serverTimestamp()
      });
    }
    unsubProfile = onSnapshot(ref, s => {
      if (!s.exists()) return;
      const prev = profile && profile.role;
      profile = { uid: user.uid, ...s.data() };
      if (prev !== profile.role) startData();
      render();
    }, fatal);
  } catch (e) { fatal(e); }
});

function mergeN() {
  notifs = [...nMine, ...nAll].sort((a, b) => (ms(b.createdAt) || Date.now()) - (ms(a.createdAt) || Date.now()));
  render();
}
function startData() {
  unsubs.forEach(f => f()); unsubs = [];
  myTx = []; flagged = []; nMine = []; nAll = []; notifs = [];
  if (!isActive()) return;
  tab = isStaff() ? "masuk" : "catatan";
  const uid = profile.uid;
  unsubs.push(onSnapshot(query(collection(db, "transactions"), where("uid", "==", uid)),
    s => { myTx = s.docs.map(mapDoc); render(); }, onErr));
  unsubs.push(onSnapshot(query(collection(db, "notifications"), where("toUid", "==", uid)),
    s => { nMine = s.docs.map(mapDoc); mergeN(); }, onErr));
  unsubs.push(onSnapshot(query(collection(db, "notifications"), where("toUid", "==", "all")),
    s => { nAll = s.docs.map(mapDoc); mergeN(); }, onErr));
  if (isStaff()) {
    unsubs.push(onSnapshot(query(collection(db, "transactions"), where("flagStatus", "in", ["open", "fixed", "admin_fixed"])),
      s => { flagged = s.docs.map(mapDoc); render(); }, onErr));
    loadWeek();
  }
}

/* ---------- Loaders (admin/founder) ---------- */
const weekStart = d => { const x = new Date(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); x.setHours(0, 0, 0, 0); return x; };
function weekRange() {
  const s = weekStart(new Date()); s.setDate(s.getDate() + weekOffset * 7);
  const e = new Date(s); e.setDate(e.getDate() + 6); return [s, e];
}
async function loadWeek() {
  const [s, e] = weekRange(); drill = null; weekLoading = true; render();
  try {
    const snap = await getDocs(query(collection(db, "transactions"), where("date", ">=", ymd(s)), where("date", "<=", ymd(e))));
    weekTx = snap.docs.map(mapDoc);
  } catch (err) { toast(friendly(err)); weekTx = []; }
  weekLoading = false; render();
}
async function loadPeople() {
  try {
    const snap = await getDocs(collection(db, "users"));
    const order = { pending: 0, founder: 1, admin: 2, member: 3, removed: 4 };
    people = snap.docs.map(d => ({ uid: d.id, ...d.data() }))
      .sort((a, b) => (order[a.role] - order[b.role]) || String(a.name).localeCompare(String(b.name)));
  } catch (err) { toast(friendly(err)); }
  render();
}
async function loadFeed() {
  feedLoading = true; render();
  try {
    const a = await getDocs(query(collection(db, "audit"), orderBy("at", "desc"), limit(100)));
    auditFeed = a.docs.map(d => d.data());
    const r = await getDocs(query(collection(db, "roleLog"), orderBy("at", "desc"), limit(50)));
    roleLogs = r.docs.map(d => d.data());
    const pg = await getDocs(query(collection(db, "purgeLog"), orderBy("at", "desc"), limit(30)));
    purgeLogs = pg.docs.map(d => d.data());
  } catch (err) { toast(friendly(err)); auditFeed = []; roleLogs = []; purgeLogs = []; }
  feedLoading = false; render();
}
async function setRole(uid, to) {
  const p = people.find(x => x.uid === uid); if (!p) return;
  const from = p.role; if (from === to) return;
  const action = to === "removed" ? "remove" : from === "removed" ? "restore" : to === "admin" ? "promote" : (from === "admin" ? "demote" : "approve");
  const rid = doc(collection(db, "roleLog")).id;
  try {
    const b = writeBatch(db);
    b.update(doc(db, "users", uid), { role: to, roleLogId: rid });
    b.set(doc(db, "roleLog", rid), { targetUid: uid, targetName: p.name || "", action, from, to, actorUid: profile.uid, actorName: profile.name, actorRole: profile.role, at: serverTimestamp() });
    await b.commit();
    toast("Peran diperbarui dan tercatat.");
  } catch (e) { toast(friendly(e)); }
  await loadPeople();
}
const findTx = id => [...flagged, ...myTx, ...weekTx].find(t => t.id === id);

/* ---------- Render ---------- */
function renderLogin() {
  $("#app").innerHTML = `<div class="center">
    <h1 style="font-size:24px">Laporan Keuangan Tim</h1>
    <p>Masuk dengan akun Google untuk mencatat dan melaporkan keuangan.</p>
    <button class="btn" data-act="login">Masuk dengan Google</button></div>`;
}
function unreadCount() {
  const ls = ms(profile.lastSeen) || 0;
  return notifs.filter(n => n.by !== profile.uid && ms(n.createdAt) && ms(n.createdAt) > ls).length;
}
const badge = n => n ? `<span class="badge">${n}</span>` : "";

function header() {
  return `<header class="top">
    <div><h1>Laporan Keuangan</h1>
      <div class="who">${esc(profile.name)} <span class="pill ${profile.role}">${ROLE_LABEL[profile.role]}</span></div></div>
    <div style="display:flex;gap:6px">
      ${isActive() ? `<button class="ghost" data-act="tab" data-tab="notif" aria-label="Notifikasi">Notif${badge(unreadCount())}</button>` : ""}
      <button class="ghost" data-act="logout">Keluar</button></div></header>`;
}

function render() {
  if (!profile) return;
  const keep = {};
  ["an-title", "an-body"].forEach(id => { const e = document.getElementById(id); if (e) keep[id] = e.value; });

  if (profile.role === "pending") {
    $("#app").innerHTML = `<div class="wrap">${header()}
      <div class="center" style="min-height:60vh"><h1 style="font-size:20px">Menunggu persetujuan</h1>
      <p>Akunmu sudah terdaftar. Admin akan menyetujui sebelum kamu bisa mencatat. Halaman ini berubah otomatis setelah disetujui.</p></div></div>`;
    return;
  }
  if (profile.role === "removed") {
    $("#app").innerHTML = `<div class="wrap">${header()}
      <div class="center" style="min-height:60vh"><h1 style="font-size:20px">Akun dinonaktifkan</h1>
      <p>Kamu dikeluarkan dari tim oleh founder, jadi tidak bisa mencatat lagi. Data yang sudah kamu catat tetap tersimpan. Hubungi founder kalau ini keliru.</p></div></div>`;
    return;
  }
  const staff = isStaff();
  const views = { catatan: viewCatatan, revisi: viewRevisi, masuk: viewMasuk, laporan: viewLaporan,
    anggota: viewAnggota, lainnya: viewLainnya, riwayat: viewRiwayat, notif: viewNotif, pengumuman: viewPengumuman };
  const openMine = myTx.filter(t => t.flagStatus === "open").length;
  const toReview = flagged.filter(t => t.flagStatus === "open" || t.flagStatus === "fixed").length;
  const items = staff
    ? [["masuk", "Data masuk"], ["laporan", "Laporan" + badge(toReview)], ["anggota", "Anggota"], ["lainnya", "Lainnya"]]
    : [["catatan", "Catatan"], ["revisi", "Revisi" + badge(openMine)]];
  const on = t => staff ? (tab === t || (t === "lainnya" && ["catatan", "riwayat", "pengumuman"].includes(tab))) : tab === t;
  const nav = `<nav class="bar"><div class="in">${items.map(([t, l]) =>
    `<button data-act="tab" data-tab="${t}" class="${on(t) ? "on" : ""}">${l}</button>`).join("")}</div></nav>`;
  const fab = tab === "catatan" ? `<button class="fab" data-act="add" style="bottom:calc(76px + env(safe-area-inset-bottom))">+ Catat transaksi</button>` : "";
  const key = [tab, drill ? drill.type + drill.cat : "", weekOffset, weekLoading ? "L" : "D", feedLoading ? "L" : "D"].join("|");
  const animate = key !== lastKey; lastKey = key;
  $("#app").innerHTML = `<div class="wrap ${animate ? "enter" : ""}">${header()}${backBar()}${(views[tab] || viewCatatan)()}</div>${nav}${fab}`;
  Object.entries(keep).forEach(([id, v]) => { const e = document.getElementById(id); if (e) e.value = v; });
}

const backBar = () => mainTabs().includes(tab) ? "" :
  `<button class="ghost small" data-act="back" style="margin-bottom:12px">← Kembali</button>`;

/* ---------- Navigasi (tombol kembali + tombol back HP) ---------- */
function goTab(t) {
  const secondary = !mainTabs().includes(t);
  if (secondary && t === tab) return;
  if (secondary) { layers.push({ type: "tab", from: tab }); history.pushState({ l: layers.length }, ""); }
  else layers = [];
  tab = t;
  if (t === "notif") {
    seenAtOpen = ms(profile.lastSeen) || 0;
    updateDoc(doc(db, "users", profile.uid), { lastSeen: serverTimestamp() }).catch(() => {});
  }
  render(); window.scrollTo(0, 0);
  if (t === "masuk") loadWeek();
  if (t === "anggota") loadPeople();
  if (t === "riwayat") loadFeed();
}
function goBack() {
  if (layers.length) history.back();
  else { drill = null; tab = homeTab(); render(); }
}
window.addEventListener("popstate", () => {
  const l = layers.pop(); if (!l) return;
  if (l.type === "drill") drill = null; else tab = l.from;
  render(); window.scrollTo(0, 0);
});

/* ---------- Baris transaksi ---------- */
function txRow(t, o = {}) {
  const mine = t.uid === profile.uid;
  const st = t.flagStatus || "none";
  const dl = deadlineOf(t);
  const passed = !!dl && Date.now() > dl.getTime();
  const main = `<div class="tx ${t.type}"><div class="dot">${t.type === "in" ? "+" : "−"}</div>
    <div class="t"><b>${esc(o.showName ? t.name : t.category)}</b>
      <span>${esc(o.showName ? t.category + (t.memo ? " · " + t.memo : "") + " · " + t.date : t.memo)}</span></div>
    <div class="amt">${t.type === "in" ? "+" : "-"}${rp(t.amount)}</div>
</div>`;

  let info = "";
  if (st !== "none") {
    info += `<div><span class="pill ${st}">${STATUS_LABEL[st]}</span></div>`;
    info += `<div><b>Alasan (${esc(t.flagByName)}):</b> ${esc(t.flagReason)}</div>`;
    if (st === "open" && dl) info += `<div class="${passed ? "late" : ""}">Batas waktu: ${fmtDT(dl)}${passed ? " · sudah lewat, admin dapat mengubah data" : ""}</div>`;
    if (t.reply) info += `<div><b>Tanggapan:</b> ${esc(t.reply)}</div>`;
  }
  if (t.lastEditBy) info += `<div>Terakhir diubah oleh <b>${esc(t.lastEditByName)}</b> (${ROLE_LABEL[t.lastEditRole] || ""}) · ${fmtDT(t.lastEditAt)}</div>`;

  const btns = [];
  if (mine && st === "open" && !passed) btns.push(["respond", "Perbaiki / tanggapi"]);
  if (isStaff() && !mine && o.canFlag && st !== "open") btns.push(["flag", st === "none" ? "Tandai" : "Tandai ulang"]);
  if (isStaff() && o.manage && st === "open") {
    btns.push(["extend", "Perpanjang"]);
    if (passed && !mine) btns.push(["adminfix", "Ubah data"]);
  }
  if (st !== "none" || t.lastEditBy) btns.push(["history", "Riwayat"]);
  const btnHtml = btns.length ? `<div class="btns">${btns.map(([a, l]) => `<button class="ghost small" data-act="${a}" data-id="${t.id}">${l}</button>`).join("")}</div>` : "";
  return `<div class="txc">${main}${(info || btnHtml) ? `<div class="extra">${info}${btnHtml}</div>` : ""}</div>`;
}

/* ---------- Tampilan ---------- */
function viewCatatan() {
  const months = new Set(myTx.map(t => t.date.slice(0, 7))); months.add(month); months.add(todayStr().slice(0, 7));
  const opts = [...months].sort().reverse().map(m => `<option value="${m}" ${m === month ? "selected" : ""}>${monthLabel(m)}</option>`).join("");
  const cur = myTx.filter(t => t.date.startsWith(month)).sort((a, b) => b.date.localeCompare(a.date));
  const inT = cur.filter(t => t.type === "in").reduce((s, t) => s + t.amount, 0);
  const outT = cur.filter(t => t.type === "out").reduce((s, t) => s + t.amount, 0);
  const bal = inT - outT;
  let list = "", last = "";
  cur.forEach(t => {
    if (t.date !== last) { last = t.date; list += `<div class="day">${longDay(t.date)}</div>`; }
    list += txRow(t, { del: true });
  });
  return `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
      <h2 style="margin:0">Catatan saya</h2><select class="month" id="month" aria-label="Pilih bulan">${opts}</select></div>
    <section class="balance"><small>Saldo bulan ini</small>
      <div class="big">${bal < 0 ? "-" : ""}${rp(Math.abs(bal))}</div>
      <div class="split"><div class="i"><small>Pemasukan</small><b>${rp(inT)}</b></div>
      <div class="o"><small>Pengeluaran</small><b>${rp(outT)}</b></div></div></section>
    <h2>Transaksi</h2>
    ${cur.length ? list : `<div class="empty">Belum ada transaksi di ${monthLabel(month)}.<br>Ketuk “Catat transaksi” untuk mulai.</div>`}
    ${cur.length ? `<p class="hint">Hanya founder yang dapat menghapus riwayat transaksi.</p>` : ""}
`;
}

function viewRevisi() {
  const order = { open: 0, fixed: 1, admin_fixed: 2 };
  const list = myTx.filter(t => t.flagStatus && t.flagStatus !== "none")
    .sort((a, b) => (order[a.flagStatus] - order[b.flagStatus]) || ((ms(a.flagDeadline) || 0) - (ms(b.flagDeadline) || 0)));
  return `<h2 style="margin-top:4px">Revisi</h2>` + (list.length
    ? list.map(t => txRow(t)).join("")
    : `<div class="empty">Tidak ada data yang ditandai. Semua aman.</div>`);
}

function group(rows, type) {
  const m = {};
  rows.filter(t => t.type === type).forEach(t => { m[t.category] = (m[t.category] || 0) + t.amount; });
  return Object.entries(m).sort((a, b) => a[1] - b[1]);
}
function chart(rows, type, title) {
  const g = group(rows, type); const max = g.length ? g[g.length - 1][1] : 1;
  return `<h2>${title}</h2><div class="card chart ${type}">${g.length ? g.map(([c, v]) =>
    `<button class="row" data-act="drill" data-type="${type}" data-cat="${esc(c)}" aria-label="Lihat transaksi ${esc(c)}">
      <span class="lab">${esc(c)}</span><span class="track"><i style="width:${Math.max(3, v / max * 100)}%"></i></span>
      <span class="val">${rp(v)}</span></button>`).join("") + `<p class="hint">Urut dari terkecil ke terbesar. Ketuk batang untuk melihat transaksinya.</p>`
    : `<p class="hint" style="margin:0">Belum ada data minggu ini.</p>`}</div>`;
}
function viewMasuk() {
  const rows = weekTx.map(t => flagged.find(f => f.id === t.id) || t);
  const [s, e] = weekRange(); const f = d => d.toLocaleDateString("id-ID", { day: "numeric", month: "short" });
  const inT = rows.filter(t => t.type === "in").reduce((a, t) => a + t.amount, 0);
  const outT = rows.filter(t => t.type === "out").reduce((a, t) => a + t.amount, 0);
  const bal = inT - outT;
  let body = "";
  if (weekLoading) body = `<div class="empty">Memuat data…</div>`;
  else if (drill) {
    const list = rows.filter(t => t.type === drill.type && t.category === drill.cat).sort((a, b) => b.date.localeCompare(a.date));
    body = `<h2>${esc(drill.cat)} · ${drill.type === "in" ? "pemasukan" : "pengeluaran"}</h2>
      <button class="ghost small" data-act="closeDrill" style="margin-bottom:10px">← Kembali ke grafik</button>
      ${list.map(t => txRow(t, { showName: true, canFlag: true })).join("")}`;
  } else body = chart(rows, "out", "Pengeluaran per kategori") + chart(rows, "in", "Pemasukan per sumber");
  return `<div class="weeknav"><button class="ghost" data-act="prevWeek" aria-label="Minggu sebelumnya">←</button>
      <b>${f(s)} – ${f(e)} ${e.getFullYear()}${weekOffset === 0 ? " (minggu ini)" : ""}</b>
      <button class="ghost" data-act="nextWeek" aria-label="Minggu berikutnya" ${weekOffset >= 0 ? "disabled" : ""}>→</button></div>
    <section class="balance"><small>Selisih minggu ini</small>
      <div class="big">${bal < 0 ? "-" : ""}${rp(Math.abs(bal))}</div>
      <div class="split"><div class="i"><small>Pemasukan</small><b>${rp(inT)}</b></div>
      <div class="o"><small>Pengeluaran</small><b>${rp(outT)}</b></div></div></section>${body}`;
}

function viewLaporan() {
  const order = { open: 0, fixed: 1, admin_fixed: 2 };
  const list = [...flagged].sort((a, b) => (order[a.flagStatus] - order[b.flagStatus]) || ((ms(a.flagDeadline) || 0) - (ms(b.flagDeadline) || 0)));
  const sec = (st, title, hint) => {
    const rows = list.filter(t => t.flagStatus === st);
    return `<h2>${title} (${rows.length})</h2>` + (rows.length
      ? rows.map(t => txRow(t, { showName: true, canFlag: true, manage: true })).join("")
      : `<div class="empty">${hint}</div>`);
  };
  return `<div style="height:4px"></div>` + sec("open", "Menunggu perbaikan anggota", "Tidak ada.")
    + sec("fixed", "Sudah ditanggapi anggota", "Tidak ada.")
    + sec("admin_fixed", "Diubah oleh admin", "Belum ada.");
}

function viewAnggota() {
  if (!people.length) return `<h2 style="margin-top:4px">Anggota</h2><div class="empty">Memuat daftar anggota…</div>`;
  const pend = people.filter(p => p.role === "pending");
  const rest = people.filter(p => ["member", "admin", "founder"].includes(p.role));
  const gone = people.filter(p => p.role === "removed");
  const isF = profile.role === "founder";
  const av = p => p.photo ? `<img src="${esc(p.photo)}" alt="" referrerpolicy="no-referrer">` : `<div class="av">${esc((p.name || "?")[0].toUpperCase())}</div>`;
  const row = (p, action) => `<div class="person">${av(p)}<div class="t"><b>${esc(p.name)}</b><span>${esc(p.email)}</span></div>${action}</div>`;
  const pill = p => `<span class="pill ${p.role}">${ROLE_LABEL[p.role]}</span>`;
  const roleCtl = p => {
    if (p.role === "founder" || p.uid === profile.uid || !isF) return pill(p);
    return `<div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end">
      <select class="month" data-act="setrole" data-uid="${p.uid}" aria-label="Peran ${esc(p.name)}">
        ${["member", "admin"].map(r => `<option value="${r}" ${p.role === r ? "selected" : ""}>${ROLE_LABEL[r]}</option>`).join("")}</select>
      <button class="ghost small" data-act="remove" data-uid="${p.uid}" style="color:var(--out)">Keluarkan</button></div>`;
  };
  return `<h2 style="margin-top:4px">Menunggu persetujuan (${pend.length})</h2>
    <div class="card">${pend.length ? pend.map(p => row(p, `<button class="btn small" data-act="approve" data-uid="${p.uid}">Setujui</button>`)).join("") : `<p class="hint" style="margin:0">Tidak ada pendaftar baru.</p>`}</div>
    <h2>Anggota aktif (${rest.length})</h2>
    <div class="card">${rest.map(p => row(p, roleCtl(p))).join("")}</div>
    ${gone.length ? `<h2>Dikeluarkan (${gone.length})</h2><div class="card">${gone.map(p => row(p, isF ? `<button class="ghost small" data-act="restore" data-uid="${p.uid}">Pulihkan</button>` : pill(p))).join("")}</div>` : ""}
    ${isF ? `<p class="hint">Hanya founder yang bisa mengangkat, mencopot admin, dan mengeluarkan anggota. Data anggota yang dikeluarkan tetap tersimpan, dan setiap perubahan peran tercatat di Riwayat.</p>` : ""}`;
}

function viewLainnya() {
  return `<h2 style="margin-top:4px">Lainnya</h2><div class="menu">
    <button data-act="tab" data-tab="pengumuman">Pengumuman</button>
    <button data-act="tab" data-tab="catatan">Catatan saya</button>
    <button data-act="tab" data-tab="riwayat">Riwayat perubahan (semua)</button>
    ${profile.role === "founder" ? `<button data-act="clear" style="color:var(--out)">Hapus riwayat</button>` : ""}</div>`;
}

function diffText(a) {
  const f = { type: "Jenis", amount: "Jumlah", category: "Kategori", date: "Tanggal", memo: "Catatan" };
  const show = (k, v) => k === "amount" ? rp(v) : (k === "type" ? (v === "in" ? "Pemasukan" : "Pengeluaran") : (v || "—"));
  const out = [];
  for (const k in f) {
    const b = a.before && a.before[k], c = a.after && a.after[k];
    if (String(b ?? "") !== String(c ?? "")) out.push(`${f[k]}: ${esc(show(k, b))} → ${esc(show(k, c))}`);
  }
  return out.join("<br>");
}
function auditHtml(a, withOwner) {
  const act = { flag: "menandai data ini", extend: "memperpanjang batas waktu",
    edit_member: "mengubah datanya sendiri", edit_admin: "mengubah data milik " + esc(a.ownerName) }[a.action] || esc(a.action);
  const d = diffText(a);
  return `<div class="hist"><div class="hd">${fmtDT(a.at)}${withOwner ? " · data: " + esc(a.ownerName) : ""}</div>
    <div><b>${esc(a.actorName)}</b> (${ROLE_LABEL[a.actorRole] || esc(a.actorRole)}) ${act}</div>
    ${a.reason ? `<div class="rs">“${esc(a.reason)}”</div>` : ""}${d ? `<div class="df">${d}</div>` : ""}</div>`;
}
function viewRiwayat() {
  const rl = roleLogs.map(l => `<div class="hist"><div class="hd">${fmtDT(l.at)}</div>
    <div><b>${esc(l.actorName)}</b> (${ROLE_LABEL[l.actorRole] || esc(l.actorRole)}) ${ROLE_ACT[l.action] || esc(l.action)} <b>${esc(l.targetName)}</b></div></div>`).join("");
  return `<h2 style="margin-top:4px">Riwayat perubahan</h2>
    <p class="hint" style="margin:0 0 10px">Catatan ini hanya bisa ditambah, tidak bisa diubah atau dihapus oleh siapa pun lewat aplikasi.</p>`
    + (feedLoading ? `<div class="empty">Memuat…</div>`
      : auditFeed.length ? auditFeed.map(a => auditHtml(a, true)).join("") : `<div class="empty">Belum ada riwayat data.</div>`)
    + `<h2>Perubahan peran dan keanggotaan</h2>`
    + (feedLoading ? "" : rl || `<div class="empty">Belum ada perubahan peran.</div>`)
    + `<h2>Penghapusan riwayat</h2>`
    + (feedLoading ? "" : purgeLogs.length ? purgeLogs.map(l => `<div class="hist"><div class="hd">${fmtDT(l.at)}</div>
      <div><b>${esc(l.actorName)}</b> (Founder) menghapus <b>${esc(l.count)} transaksi</b> milik ${esc(l.target)} · ${l.scope === "all" ? "semua riwayat" : esc(l.from) + " s/d " + esc(l.to)}</div></div>`).join("")
      : `<div class="empty">Belum ada penghapusan.</div>`);
}

function viewNotif() {
  const list = notifs.map(n => {
    const isNew = n.by !== profile.uid && ms(n.createdAt) && ms(n.createdAt) > seenAtOpen;
    const link = !isStaff() && ["report", "adminfix"].includes(n.type) ? `<button class="ghost small" data-act="tab" data-tab="revisi" style="margin-top:6px">Lihat revisi</button>` : "";
    const kind = n.type === "announce" ? "Pengumuman" : "";
    return `<div class="notif ${isNew ? "new" : ""}"><b>${esc(n.title)}</b><div>${esc(n.body)}</div>
      <span>${kind ? kind + " · " : ""}${esc(n.byName)} · ${fmtDT(n.createdAt)}</span>${link}</div>`;
  }).join("");
  return `<h2 style="margin-top:4px">Notifikasi</h2>${list || `<div class="empty">Belum ada notifikasi.</div>`}`;
}

function viewPengumuman() {
  const sent = notifs.filter(n => n.type === "announce");
  return `<h2 style="margin-top:4px">Pengumuman</h2>
    <div class="card" style="margin-bottom:14px"><b>Buat pengumuman untuk semua</b>
      <label for="an-title">Judul</label><input class="f" id="an-title" maxlength="100">
      <label for="an-body">Isi (bersifat umum, jangan sebut data atau nama anggota tertentu)</label>
      <textarea class="f" id="an-body" rows="3" maxlength="300"></textarea>
      <div class="err" id="an-err"></div>
      <button class="btn" style="margin-top:6px" data-act="announce">Kirim ke semua</button></div>
    <h2>Pengumuman terkirim (${sent.length})</h2>
    ${sent.length ? sent.map(n => `<div class="notif"><b>${esc(n.title)}</b><div>${esc(n.body)}</div>
      <span>${esc(n.byName)} · ${fmtDT(n.createdAt)}</span></div>`).join("") : `<div class="empty">Belum ada pengumuman.</div>`}`;
}

/* ---------- Sheet (jendela bawah) ---------- */
const openSheet = html => { $("#sheetBody").innerHTML = html; const d = $("#sheet"); if (!d.open) d.showModal(); };
const closeSheet = () => { const d = $("#sheet"); if (d.open) d.close(); };
const sheetErr = m => { const e = $("#sheetErr"); if (e) e.textContent = m; };
const txSummary = t => `<div class="card" style="margin:10px 0"><b>${esc(t.name)}</b><br>${esc(t.category)} · ${rp(t.amount)} · ${esc(t.date)}${t.memo ? "<br>" + esc(t.memo) : ""}</div>`;
const catOptions = (type, cur) => { const l = [...CATS[type]]; if (cur && !l.includes(cur)) l.unshift(cur); return l.map(c => `<option ${c === cur ? "selected" : ""}>${esc(c)}</option>`).join(""); };

function fieldsForm(t) {
  return `<label for="sf-type">Jenis</label>
    <select class="f" id="sf-type"><option value="out" ${t.type === "out" ? "selected" : ""}>Pengeluaran</option><option value="in" ${t.type === "in" ? "selected" : ""}>Pemasukan</option></select>
    <label for="sf-amount">Jumlah (Rp)</label>
    <input class="f amount" id="sf-amount" inputmode="numeric" value="${new Intl.NumberFormat("id-ID").format(t.amount)}" autocomplete="off">
    <label for="sf-cat">Kategori</label><select class="f" id="sf-cat">${catOptions(t.type, t.category)}</select>
    <label for="sf-memo">Catatan</label><input class="f" id="sf-memo" maxlength="80" value="${esc(t.memo)}">
    <label for="sf-date">Tanggal</label><input class="f" type="date" id="sf-date" value="${esc(t.date)}">`;
}
function readFields() {
  const amount = +$("#sf-amount").value.replace(/\D/g, "");
  if (!amount) { sheetErr("Isi jumlah lebih dari 0."); return null; }
  if (!$("#sf-date").value) { sheetErr("Pilih tanggal."); return null; }
  return { type: $("#sf-type").value, amount, category: $("#sf-cat").value, memo: $("#sf-memo").value.trim(), date: $("#sf-date").value };
}
const sheetButtons = (act, id, label) => `<div class="err" id="sheetErr"></div>
  <div class="actions"><button class="btn light" data-act="closeSheet">Batal</button><button class="btn" data-act="${act}" data-id="${id}">${label}</button></div>`;

function sheetFlag(t) {
  openSheet(`<h2 style="margin:0">Tandai data</h2>${txSummary(t)}
    <label for="sf-text">Alasan (kenapa data ini dianggap aneh)</label>
    <textarea class="f" id="sf-text" rows="3" maxlength="200"></textarea>
    <label for="sf-deadline">Batas waktu perbaikan</label>
    <input class="f" type="datetime-local" id="sf-deadline" value="${defDeadline()}">
    <p class="hint">Anggota mendapat notifikasi. Jika sampai batas waktu belum diperbaiki, admin boleh mengubah datanya dan perubahan itu tercatat atas nama admin.</p>
    ${sheetButtons("doFlag", t.id, "Kirim laporan")}`);
}
function sheetRespond(t) {
  openSheet(`<h2 style="margin:0">Perbaiki / tanggapi</h2>
    <div class="card" style="margin:10px 0"><b>Alasan (${esc(t.flagByName)}):</b> ${esc(t.flagReason)}<br>Batas waktu: ${fmtDT(deadlineOf(t))}</div>
    ${fieldsForm(t)}
    <label for="sf-text">Tanggapan / penjelasan</label>
    <textarea class="f" id="sf-text" rows="2" maxlength="200">${esc(t.reply || "")}</textarea>
    ${sheetButtons("doRespond", t.id, "Kirim")}`);
}
function sheetAdminFix(t) {
  openSheet(`<h2 style="margin:0">Ubah data (atas nama admin)</h2>
    <p class="hint">Batas waktu sudah lewat. Perubahan ini tercatat atas namamu dan tidak bisa dihapus.</p>
    ${fieldsForm(t)}
    <label for="sf-text">Alasan perubahan (wajib)</label>
    <textarea class="f" id="sf-text" rows="2" maxlength="200"></textarea>
    ${sheetButtons("doAdminFix", t.id, "Simpan perubahan")}`);
}
function sheetExtend(t) {
  openSheet(`<h2 style="margin:0">Perpanjang batas waktu</h2>${txSummary(t)}
    <p class="hint">Batas sekarang: ${fmtDT(deadlineOf(t))}. Batas waktu hanya boleh diperpanjang, tidak boleh dipersingkat.</p>
    <label for="sf-deadline">Batas waktu baru</label>
    <input class="f" type="datetime-local" id="sf-deadline" value="${defDeadline()}">
    ${sheetButtons("doExtend", t.id, "Perpanjang")}`);
}
async function showHistory(id) {
  const t = findTx(id); if (!t) return;
  openSheet(`<h2 style="margin:0">Riwayat data</h2>${txSummary(t)}<div id="hist">Memuat…</div>
    <div class="actions" style="grid-template-columns:1fr"><button class="btn light" data-act="closeSheet">Tutup</button></div>`);
  try {
    const s = await getDocs(query(collection(db, "audit"), where("ownerUid", "==", t.uid), where("txId", "==", id)));
    const rows = s.docs.map(d => d.data()).sort((a, b) => (ms(a.at) || 0) - (ms(b.at) || 0));
    $("#hist").innerHTML = rows.length ? rows.map(a => auditHtml(a, false)).join("") : `<p class="hint">Belum ada riwayat perubahan.</p>`;
  } catch (e) { $("#hist").textContent = friendly(e); }
}

/* ---------- Hapus riwayat (khusus founder) ---------- */
let clearPool = [];
function clearTargets() {
  const all = $("#cl-mode").value === "all", who = $("#cl-who").value;
  const from = $("#cl-from").value, to = $("#cl-to").value;
  const del = clearPool.filter(t => (!who || t.uid === who) && (all || (from && to && t.date >= from && t.date <= to)));
  return { all, who, from, to, del };
}
function updateClear() {
  const c = clearTargets();
  $("#cl-range").style.display = c.all ? "none" : "";
  $("#cl-preview").innerHTML = `<b>${c.del.length} transaksi</b> akan dihapus.`;
}
async function sheetClear() {
  const closeBtn = `<div class="actions" style="grid-template-columns:1fr"><button class="btn light" data-act="closeSheet">Tutup</button></div>`;
  openSheet(`<h2 style="margin:0">Hapus riwayat</h2><p class="hint">Memuat data…</p>`);
  try { const sn = await getDocs(collection(db, "transactions")); clearPool = sn.docs.map(mapDoc); }
  catch (e) { openSheet(`<h2 style="margin:0">Hapus riwayat</h2><p class="hint">${esc(friendly(e))}</p>${closeBtn}`); return; }
  const members = [...new Map(clearPool.map(t => [t.uid, t.name])).entries()];
  const first = clearPool.map(t => t.date).sort()[0] || todayStr();
  openSheet(`<h2 style="margin:0">Hapus riwayat</h2>
    <p class="hint">Dihapus permanen dan tidak bisa dikembalikan. Penghapusan ini tercatat di Riwayat.</p>
    <label for="cl-who">Milik siapa</label>
    <select class="f" id="cl-who"><option value="">Semua anggota</option>${members.map(([u, n]) => `<option value="${esc(u)}">${esc(n)}</option>`).join("")}</select>
    <label for="cl-mode">Yang dihapus</label>
    <select class="f" id="cl-mode"><option value="range">Rentang waktu tertentu</option><option value="all">Semua riwayat</option></select>
    <div id="cl-range"><label for="cl-from">Dari tanggal</label><input class="f" type="date" id="cl-from" value="${first}">
    <label for="cl-to">Sampai tanggal</label><input class="f" type="date" id="cl-to" value="${todayStr()}"></div>
    <div class="card" id="cl-preview" style="margin-top:12px"></div>
    <label for="cl-confirm">Ketik HAPUS untuk melanjutkan</label>
    <input class="f" id="cl-confirm" autocomplete="off" autocapitalize="characters">
    ${sheetButtons("doClear", "", "Hapus permanen")}`);
  updateClear();
}
async function doClear(btn) {
  const c = clearTargets();
  if (!c.all && (!c.from || !c.to || c.from > c.to)) return sheetErr("Tanggal awal harus sebelum tanggal akhir.");
  if (!c.del.length) return sheetErr("Tidak ada transaksi yang cocok.");
  if ($("#cl-confirm").value.trim().toUpperCase() !== "HAPUS") return sheetErr("Ketik HAPUS dulu.");
  const target = c.who ? (clearPool.find(t => t.uid === c.who) || {}).name || "" : "Semua anggota";
  btn.disabled = true;
  try {
    for (let i = 0; i < c.del.length; i += 199) {
      const b = writeBatch(db);
      if (i === 0) b.set(doc(collection(db, "purgeLog")), {
        actorUid: profile.uid, actorName: profile.name, scope: c.all ? "all" : "range", target,
        from: c.all ? "" : c.from, to: c.all ? "" : c.to, count: c.del.length, at: serverTimestamp()
      });
      c.del.slice(i, i + 199).forEach(t => b.delete(doc(db, "transactions", t.id)));
      await b.commit();
    }
    closeSheet(); toast(`${c.del.length} transaksi dihapus.`); clearPool = [];
    loadWeek();
  } catch (e) { sheetErr(friendly(e)); }
  btn.disabled = false;
}

/* ---------- Aksi tulis (satu paket: data + riwayat + notifikasi) ---------- */
function auditBase(t, action, reason, before, after, aid) {
  return {
    txId: t.id, ownerUid: t.uid, ownerName: t.name, action, actorUid: profile.uid, actorName: profile.name,
    actorRole: profile.role, reason, before, after, at: serverTimestamp()
  };
}
function notifBase(toUid, type, title, body, txId) {
  return { toUid, type, title: title.slice(0, 100), body: String(body).slice(0, 300), txId, by: profile.uid, byName: profile.name, createdAt: serverTimestamp() };
}
const editStamp = aid => ({ lastEditBy: profile.uid, lastEditByName: profile.name, lastEditRole: profile.role, lastEditAt: serverTimestamp(), lastAuditId: aid });

async function commit(btn, fn, okMsg) {
  if (btn) btn.disabled = true;
  try { const b = writeBatch(db); await fn(b); await b.commit(); closeSheet(); toast(okMsg); }
  catch (e) { sheetErr(friendly(e)); }
  if (btn) btn.disabled = false;
}

function doFlag(id, btn) {
  const t = findTx(id); if (!t) return;
  const reason = $("#sf-text").value.trim(); const dl = new Date($("#sf-deadline").value);
  if (reason.length < 3) return sheetErr("Tulis alasan minimal 3 huruf.");
  if (isNaN(dl) || dl.getTime() <= Date.now()) return sheetErr("Batas waktu harus di masa depan.");
  const aid = doc(collection(db, "audit")).id;
  commit(btn, b => {
    b.update(doc(db, "transactions", id), { flagStatus: "open", flagReason: reason, flagBy: profile.uid, flagByName: profile.name, flagDeadline: Timestamp.fromDate(dl), lastAuditId: aid });
    b.set(doc(db, "audit", aid), auditBase(t, "flag", reason, snapOf(t), snapOf(t)));
    b.set(doc(collection(db, "notifications")), notifBase(t.uid, "report", "Data transaksi ditandai", `${reason} (batas: ${fmtDT(dl)})`, id));
  }, "Laporan terkirim.");
}
function doExtend(id, btn) {
  const t = findTx(id); if (!t) return;
  const dl = new Date($("#sf-deadline").value); const old = deadlineOf(t);
  if (isNaN(dl) || dl.getTime() <= Date.now() || (old && dl.getTime() <= old.getTime())) return sheetErr("Batas baru harus di masa depan dan lebih lama dari batas sekarang.");
  const aid = doc(collection(db, "audit")).id;
  commit(btn, b => {
    b.update(doc(db, "transactions", id), { flagDeadline: Timestamp.fromDate(dl), lastAuditId: aid });
    b.set(doc(db, "audit", aid), auditBase(t, "extend", `Batas waktu diperpanjang sampai ${fmtDT(dl)}`, snapOf(t), snapOf(t)));
    b.set(doc(collection(db, "notifications")), notifBase(t.uid, "report", "Batas waktu diperpanjang", `Batas perbaikan baru: ${fmtDT(dl)}`, id));
  }, "Batas waktu diperpanjang.");
}
function doRespond(id, btn) {
  const t = findTx(id); if (!t) return;
  const f = readFields(); if (!f) return;
  const reply = $("#sf-text").value.trim();
  const changedAny = JSON.stringify(snapOf(t)) !== JSON.stringify(snapOf(f));
  if (!changedAny && !reply) return sheetErr("Ubah datanya atau tulis tanggapan.");
  const aid = doc(collection(db, "audit")).id;
  commit(btn, b => {
    b.update(doc(db, "transactions", id), { ...f, reply, flagStatus: "fixed", ...editStamp(aid) });
    b.set(doc(db, "audit", aid), auditBase(t, "edit_member", reply, snapOf(t), snapOf(f)));
    b.set(doc(collection(db, "notifications")), notifBase(t.flagBy, "reply", "Anggota menanggapi laporan", `${profile.name}: ${reply || "data diperbarui"}`, id));
  }, "Tanggapan terkirim.");
}
function doAdminFix(id, btn) {
  const t = findTx(id); if (!t) return;
  const f = readFields(); if (!f) return;
  const reason = $("#sf-text").value.trim();
  if (reason.length < 3) return sheetErr("Tulis alasan perubahan minimal 3 huruf.");
  const aid = doc(collection(db, "audit")).id;
  commit(btn, b => {
    b.update(doc(db, "transactions", id), { ...f, flagStatus: "admin_fixed", ...editStamp(aid) });
    b.set(doc(db, "audit", aid), auditBase(t, "edit_admin", reason, snapOf(t), snapOf(f)));
    b.set(doc(collection(db, "notifications")), notifBase(t.uid, "adminfix", "Datamu diubah oleh admin", `${profile.name}: ${reason}`, id));
  }, "Perubahan tersimpan dan tercatat.");
}
async function announce() {
  const title = $("#an-title").value.trim(), body = $("#an-body").value.trim();
  const err = $("#an-err");
  if (!title || !body) { err.textContent = "Isi judul dan isi pengumuman."; return; }
  try {
    await addDoc(collection(db, "notifications"), { toUid: "all", type: "announce", title, body, by: profile.uid, byName: profile.name, createdAt: serverTimestamp() });
    $("#an-title").value = ""; $("#an-body").value = ""; err.textContent = ""; toast("Pengumuman terkirim.");
  } catch (e) { err.textContent = friendly(e); }
}

/* ---------- Dialog catat transaksi ---------- */
function setType(t) {
  txType = t;
  document.querySelectorAll("#seg button").forEach(b => { b.className = b.dataset.t === t ? `on ${t}` : ""; });
  $("#cat").innerHTML = CATS[t].map(c => `<option>${c}</option>`).join("");
}
$("#seg").onclick = e => { if (e.target.dataset.t) setType(e.target.dataset.t); };
$("#cancel").onclick = () => $("#dlg").close();
$("#save").onclick = async () => {
  const amount = +$("#amount").value.replace(/\D/g, "");
  if (!amount) { $("#err").textContent = "Isi jumlah lebih dari 0."; return; }
  if (!$("#date").value) { $("#err").textContent = "Pilih tanggal."; return; }
  const btn = $("#save"); btn.disabled = true;
  try {
    await addDoc(collection(db, "transactions"), {
      uid: profile.uid, name: profile.name, type: txType, amount,
      category: $("#cat").value, memo: $("#memo").value.trim(),
      date: $("#date").value, createdAt: serverTimestamp()
    });
    month = $("#date").value.slice(0, 7);
    $("#dlg").close(); toast("Tersimpan.");
  } catch (e) { $("#err").textContent = friendly(e); }
  btn.disabled = false;
};

/* ---------- Event ---------- */
document.addEventListener("input", e => {
  if (e.target.id === "amount" || e.target.id === "sf-amount") {
    const d = e.target.value.replace(/\D/g, "").slice(0, 12);
    e.target.value = d ? new Intl.NumberFormat("id-ID").format(+d) : "";
  }
});
document.addEventListener("click", async e => {
  const el = e.target.closest("[data-act]"); if (!el || el.tagName === "SELECT") return;
  const a = el.dataset.act, id = el.dataset.id;
  if (a === "login") login();
  else if (a === "logout") signOut(auth);
  else if (a === "add") {
    setType("out"); $("#amount").value = ""; $("#memo").value = ""; $("#date").value = todayStr(); $("#err").textContent = "";
    $("#dlg").showModal(); $("#amount").focus();
  }
  else if (a === "tab") goTab(el.dataset.tab);
  else if (a === "back") goBack();
  else if (a === "prevWeek") { weekOffset--; loadWeek(); }
  else if (a === "nextWeek") { if (weekOffset < 0) { weekOffset++; loadWeek(); } }
  else if (a === "drill") {
    drill = { type: el.dataset.type, cat: el.dataset.cat };
    layers.push({ type: "drill" }); history.pushState({ l: layers.length }, "");
    render(); window.scrollTo(0, 0);
  }
  else if (a === "closeDrill") {
    if (layers.length && layers[layers.length - 1].type === "drill") history.back();
    else { drill = null; render(); }
  }
  else if (a === "approve") setRole(el.dataset.uid, "member");
  else if (a === "restore") setRole(el.dataset.uid, "member");
  else if (a === "remove") {
    const p = people.find(x => x.uid === el.dataset.uid);
    if (p && confirm(`Keluarkan ${p.name}? Ia tidak bisa mencatat lagi. Datanya tetap tersimpan dan tindakan ini tercatat.`)) setRole(el.dataset.uid, "removed");
  }
  else if (a === "flag") { const t = findTx(id); t && sheetFlag(t); }
  else if (a === "respond") { const t = findTx(id); t && sheetRespond(t); }
  else if (a === "adminfix") { const t = findTx(id); t && sheetAdminFix(t); }
  else if (a === "extend") { const t = findTx(id); t && sheetExtend(t); }
  else if (a === "history") showHistory(id);
  else if (a === "closeSheet") closeSheet();
  else if (a === "clear") sheetClear();
  else if (a === "doClear") doClear(el);
  else if (a === "doFlag") doFlag(id, el);
  else if (a === "doExtend") doExtend(id, el);
  else if (a === "doRespond") doRespond(id, el);
  else if (a === "doAdminFix") doAdminFix(id, el);
  else if (a === "announce") announce();
});
document.addEventListener("change", e => {
  if (e.target.id === "month") { month = e.target.value; render(); }
  else if (e.target.dataset.act === "setrole") setRole(e.target.dataset.uid, e.target.value);
  else if (["cl-who", "cl-mode", "cl-from", "cl-to"].includes(e.target.id)) updateClear();
  else if (e.target.id === "sf-type") $("#sf-cat").innerHTML = catOptions(e.target.value, "");
});
