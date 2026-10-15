import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, addDoc, deleteDoc, writeBatch,
  collection, query, where, orderBy, limit, getDocs, getDocFromCache, onSnapshot, serverTimestamp, Timestamp,
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

// Harus sama dengan email founder di firestore.rules
const FOUNDER_EMAIL = "aljanedbagdady@gmail.com";

const ASSET_LANCAR = ["Saldo tunai", "Rekening tabungan", "Dompet digital", "Investasi cair"];
const ASSET_TETAP = ["Kendaraan", "Properti", "Investasi jangka panjang"];
const DEBT_CATS = ["Utang jangka pendek", "Utang jangka panjang"];
const CATS = {
  out: ["Makanan", "Transportasi", "Tagihan", "Cicilan", "Kesehatan", "Belanja", "Hiburan", "Hobi", "Nongkrong", "Lainnya"],
  in: ["Gaji", "Bonus", "Usaha", "Hadiah", "Lainnya"],
  asset: [...ASSET_LANCAR, ...ASSET_TETAP],
  debt: DEBT_CATS
};
const TYPE_LABEL = { in: "Pemasukan", out: "Pengeluaran", asset: "Aset", debt: "Utang" };
const TYPE_DOT = { in: "+", out: "−", asset: "A", debt: "U" };
const NEED_CATS = ["Makanan", "Transportasi", "Tagihan", "Cicilan", "Kesehatan"];
const WANT_CATS = ["Belanja", "Hiburan", "Hobi", "Nongkrong"];
const PALETTE = ["#52E3B1", "#FF8F91", "#101D40", "#6C8BD6", "#F4C95D", "#9B8AE0", "#2FB5A8", "#F29E6D", "#A9B6CE", "#C86B85"];
const colorAt = i => PALETTE[i % PALETTE.length];
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
// Cache lokal: data tetap terbaca offline, dan tulisan offline dikirim otomatis saat online.
let db;
try { db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }); }
catch (e) { db = getFirestore(app); }
const offlineMsg = "Butuh koneksi internet untuk tindakan ini.";

/* ---------- State ---------- */
let profile = null, unsubProfile = null, unsubs = [];
let tab = "catatan", myTx = [], flagged = [], nMine = [], nAll = [], notifs = [];
let month = todayStr().slice(0, 7);
let weekOffset = 0, weekTx = [], weekLoading = false, drill = null;
let people = [], auditFeed = [], roleLogs = [], purgeLogs = [], feedLoading = false, seenAtOpen = 0;
let txType = "out";
let layers = [];
let lastKey = "";
let dataReady = false, budgets = {}, skelUntil = 0;
let anaPeriod = "bulan", anaView = "out", anaSel = -1;
let anaFrom = todayStr().slice(0, 8) + "01", anaTo = todayStr();
const homeTab = () => isStaff() ? "masuk" : "catatan";
const mainTabs = () => isStaff() ? ["masuk", "laporan", "anggota", "lainnya"] : ["catatan", "revisi", "analisis"];

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
getRedirectResult(auth).catch(e => { if (e.code !== "auth/network-request-failed") onErr(e); });

const sleep = n => new Promise(r => setTimeout(r, n));
const splash = () => `<div class="splash"><img src="logo.png" alt="" width="88" height="88"><div class="st">Laporan Keuangan</div>
  <div class="dots" role="status" aria-label="Memuat"><span></span><span></span><span></span></div></div>`;
const skRow = () => `<div class="sk-row"><div class="sk" style="width:36px;height:36px;border-radius:50%"></div>
  <div style="flex:1;display:grid;gap:7px"><div class="sk line" style="width:55%"></div><div class="sk line" style="width:35%;height:11px"></div></div>
  <div class="sk" style="width:74px;height:26px;border-radius:8px"></div></div>`;
const skeleton = () => `<div class="sk" style="height:34px;width:60%;margin-bottom:14px"></div>
  <div class="sk" style="height:150px;border-radius:18px"></div>
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:12px 0 18px">
    <div class="sk" style="height:66px"></div><div class="sk" style="height:66px"></div><div class="sk" style="height:66px"></div></div>
  ${skRow()}${skRow()}${skRow()}`;
const skList = n => Array.from({ length: n }, skRow).join("");
function fatal(e) {
  $("#app").innerHTML = `<div class="center"><h1>Gagal memuat</h1><p>${esc(friendly(e))}</p><button class="btn" data-act="logout">Keluar</button></div>`;
}

onAuthStateChanged(auth, async user => {
  unsubProfile && unsubProfile(); unsubs.forEach(f => f()); unsubs = [];
  layers = []; dataReady = false; budgets = {}; profile = null; myTx = []; flagged = []; weekTx = []; people = []; notifs = []; nMine = []; nAll = [];
  if (!user) { renderLogin(); return; }
  $("#app").innerHTML = splash();
  const t0 = Date.now();
  try {
    const ref = doc(db, "users", user.uid);
    let snap;
    try { snap = await getDoc(ref); }
    catch (e) { try { snap = await getDocFromCache(ref); } catch (e2) { throw e; } }
    if (!snap.exists()) {
      if (!navigator.onLine) throw { code: "unavailable" };
      const isF = user.email === FOUNDER_EMAIL && user.emailVerified;
      await setDoc(ref, {
        name: user.displayName || user.email, email: user.email, photo: user.photoURL || "",
        role: isF ? "founder" : "pending", createdAt: serverTimestamp()
      });
    }
    const wait = 1100 - (Date.now() - t0); if (wait > 0) await sleep(wait);
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
  myTx = []; flagged = []; nMine = []; nAll = []; notifs = []; budgets = {}; dataReady = false;
  skelUntil = Date.now() + 900;
  if (!isActive()) return;
  tab = isStaff() ? "masuk" : "catatan";
  const uid = profile.uid;
  setTimeout(() => { if (!dataReady) { dataReady = true; render(); } }, 6000);
  unsubs.push(onSnapshot(query(collection(db, "transactions"), where("uid", "==", uid)),
    { includeMetadataChanges: true },
    s => {
      myTx = s.docs.map(mapDoc);
      const left = skelUntil - Date.now();
      if (!dataReady && left > 0) setTimeout(() => { dataReady = true; render(); }, left); // beri waktu shimmer terlihat
      else dataReady = true;
      render();
    }, e => { dataReady = true; onErr(e); }));
  unsubs.push(onSnapshot(query(collection(db, "budgets"), where("uid", "==", uid)),
    s => { budgets = {}; s.docs.forEach(d => { const x = d.data(); budgets[x.month] = x; }); render(); }, onErr));
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
  if (!navigator.onLine) { toast(offlineMsg); return; }
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
    <img class="login-logo" src="logo.png" alt="" width="96" height="96">
    <h1 style="font-size:24px">Laporan Keuangan Tim</h1>
    <p>Masuk dengan akun Google untuk mencatat dan melaporkan keuangan.</p>
    <button class="btn" data-act="login">Masuk dengan Google</button></div>`;
}
function unreadCount() {
  const ls = ms(profile.lastSeen) || 0;
  return notifs.filter(n => n.by !== profile.uid && ms(n.createdAt) && ms(n.createdAt) > ls).length;
}
const badge = n => n ? `<span class="badge">${n}</span>` : "";

const logoImg = n => `<img src="logo.png" alt="" width="${n}" height="${n}" style="border-radius:${Math.round(n * .24)}px">`;
function header() {
  return `<header class="top"><div class="in">${logoImg(38)}
    <div class="ttl"><h1>Laporan Keuangan</h1>
      <div class="who">${esc(profile.name)} <span class="pill ${profile.role}">${ROLE_LABEL[profile.role]}</span></div></div>
    ${isActive() ? `<button class="ghost" data-act="tab" data-tab="notif" aria-label="Notifikasi">Notif${badge(unreadCount())}</button>` : ""}
    <button class="ghost" data-act="logout">Keluar</button></div></header>`;
}

function render() {
  if (!profile) return;
  const keep = {};
  ["an-title", "an-body"].forEach(id => { const e = document.getElementById(id); if (e) keep[id] = e.value; });

  if (profile.role === "pending") {
    $("#app").innerHTML = `${header()}<div class="wrap">
      <div class="center" style="min-height:60vh"><h1 style="font-size:20px">Menunggu persetujuan</h1>
      <p>Akunmu sudah terdaftar. Admin akan menyetujui sebelum kamu bisa mencatat. Halaman ini berubah otomatis setelah disetujui.</p></div></div>`;
    return;
  }
  if (profile.role === "removed") {
    $("#app").innerHTML = `${header()}<div class="wrap">
      <div class="center" style="min-height:60vh"><h1 style="font-size:20px">Akun dinonaktifkan</h1>
      <p>Kamu dikeluarkan dari tim oleh founder, jadi tidak bisa mencatat lagi. Data yang sudah kamu catat tetap tersimpan. Hubungi founder kalau ini keliru.</p></div></div>`;
    return;
  }
  if (isActive() && !dataReady) { $("#app").innerHTML = `${header()}<div class="wrap">${skeleton()}</div>`; return; }
  const staff = isStaff();
  const views = { lap_in: viewLapIn, lap_out: viewLapOut, lap_aset: viewLapAset, lap_utang: viewLapUtang, lap_nw: viewLapNW, catatan: viewCatatan, revisi: viewRevisi, masuk: viewMasuk, laporan: viewLaporan,
    anggota: viewAnggota, lainnya: viewLainnya, riwayat: viewRiwayat, notif: viewNotif, pengumuman: viewPengumuman, analisis: viewAnalisis };
  const openMine = myTx.filter(t => t.flagStatus === "open").length;
  const toReview = flagged.filter(t => t.flagStatus === "open" || t.flagStatus === "fixed").length;
  const items = staff
    ? [["masuk", "Data masuk"], ["laporan", "Laporan" + badge(toReview)], ["anggota", "Anggota"], ["lainnya", "Lainnya"]]
    : [["catatan", "Catatan"], ["revisi", "Revisi" + badge(openMine)], ["analisis", "Analisis"]];
  const on = t => staff ? (tab === t || (t === "lainnya" && ["catatan", "riwayat", "pengumuman", "analisis"].includes(tab) || t === "lainnya" && tab.startsWith("lap_")))
    : (tab === t || (t === "catatan" && tab.startsWith("lap_")));
  const nav = `<nav class="bar"><div class="in">${items.map(([t, l]) =>
    `<button data-act="tab" data-tab="${t}" class="${on(t) ? "on" : ""}">${l}</button>`).join("")}</div></nav>`;
  const fab = tab === "catatan" ? `<button class="fab" data-act="add" style="bottom:calc(76px + env(safe-area-inset-bottom))">+ Buat laporan</button>` : "";
  const key = [tab, anaPeriod, anaView, drill ? drill.type + drill.cat : "", weekOffset, weekLoading ? "L" : "D", feedLoading ? "L" : "D"].join("|");
  const animate = key !== lastKey; lastKey = key;
  $("#app").innerHTML = `${header()}<div class="wrap ${animate ? "enter" : ""}">${offlineBar()}${backBar()}${(views[tab] || viewCatatan)()}</div>${nav}${fab}`;
  Object.entries(keep).forEach(([id, v]) => { const e = document.getElementById(id); if (e) e.value = v; });
}

const offlineBar = () => navigator.onLine ? "" :
  `<div style="background:var(--warn-bg);color:var(--warn);border-radius:10px;padding:9px 12px;font-size:13px;margin-bottom:12px">Mode offline. Catatan baru disimpan di perangkat dan terkirim otomatis saat online.</div>`;
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
  const flow = t.type === "in" || t.type === "out";
  const title = o.showName ? t.name : (flow ? t.category : (t.memo || t.category));
  const sub = o.showName ? t.category + (t.memo ? " · " + t.memo : "") + " · " + t.date : (flow ? t.memo : `${t.category} · per ${t.date}`);
  const main = `<div class="tx ${t.type}"><div class="dot">${TYPE_DOT[t.type] || "?"}</div>
    <div class="t"><b>${esc(title)}${t.pending ? ' <span class="pill pending" style="animation:fade .3s ease 1.2s both">Menunggu terkirim</span>' : ""}</b>
      <span>${esc(sub)}</span></div>
    <div class="amt">${t.type === "in" ? "+" : t.type === "out" ? "-" : ""}${rp(t.amount)}</div>
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
/* ---------- Pembantu laporan ---------- */
const rpC = n => {
  const a = Math.abs(n), sg = n < 0 ? "-" : "", f = (v, u) => `${sg}Rp ${v.toFixed(1).replace(".", ",").replace(",0", "")} ${u}`;
  if (a >= 1e9) return f(a / 1e9, "M");
  if (a >= 1e6) return f(a / 1e6, "jt");
  if (a >= 1e3) return `${sg}Rp ${Math.round(a / 1e3)} rb`;
  return `${sg}Rp ${Math.round(a)}`;
};
const sumAmt = rows => rows.reduce((a, t) => a + t.amount, 0);
const isFlow = t => t.type === "in" || t.type === "out";
const byDateDesc = (a, b) => b.date.localeCompare(a.date);
const pct = (a, b) => b > 0 ? Math.round(a / b * 100) : 0;
const asOfOf = m => { const [y, mo] = m.split("-"); const end = ymd(new Date(+y, +mo, 0)); return end > todayStr() ? todayStr() : end; };
const prevMonth = m => { const [y, mo] = m.split("-").map(Number); const d = new Date(y, mo - 2, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
function positions(kind, asOf) {
  const m = new Map();
  myTx.filter(t => t.type === kind && t.date <= asOf)
    .sort((a, b) => a.date.localeCompare(b.date) || ((ms(a.createdAt) ?? 1e15) - (ms(b.createdAt) ?? 1e15)))
    .forEach(t => m.set(t.category + "|" + (t.memo || t.category).toLowerCase(), t));
  return [...m.values()];
}
function monthSelect() {
  const months = new Set(myTx.map(t => t.date.slice(0, 7))); months.add(month); months.add(todayStr().slice(0, 7));
  return `<select class="month" id="month" aria-label="Pilih bulan">${[...months].sort().reverse().map(m => `<option value="${m}" ${m === month ? "selected" : ""}>${monthLabel(m)}</option>`).join("")}</select>`;
}
const repHead = title => `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><h2 style="margin:0">${title}</h2>${monthSelect()}</div>`;
function dayList(rows) {
  let out = "", last = "";
  rows.forEach(t => { if (t.date !== last) { last = t.date; out += `<div class="day">${longDay(t.date)}</div>`; } out += txRow(t); });
  return out;
}

function viewCatatan() {
  const cur = myTx.filter(t => isFlow(t) && t.date.startsWith(month)).sort(byDateDesc);
  const inT = sumAmt(cur.filter(t => t.type === "in")), outT = sumAmt(cur.filter(t => t.type === "out"));
  const bal = inT - outT;
  const asOf = asOfOf(month);
  const aset = sumAmt(positions("asset", asOf).filter(t => t.amount > 0)), utang = sumAmt(positions("debt", asOf).filter(t => t.amount > 0));
  const nw = aset - utang;
  return `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
      <h2 style="margin:0">Catatan saya</h2>${monthSelect()}</div>
    <section class="balance"><small>Saldo bulan ini</small>
      <div class="big">${bal < 0 ? "-" : ""}${rp(Math.abs(bal))}</div>
      <div class="split">
        <button class="i" data-act="tab" data-tab="lap_in"><small>Pemasukan</small><b>${rp(inT)}</b><em>Lihat laporan ›</em></button>
        <button class="o" data-act="tab" data-tab="lap_out"><small>Pengeluaran</small><b>${rp(outT)}</b><em>Lihat laporan ›</em></button></div></section>
    <div class="tiles">
      <button class="tile" data-act="tab" data-tab="lap_aset"><span class="dt" style="background:var(--mint)"></span><small>Aset</small><b>${rpC(aset)}</b></button>
      <button class="tile" data-act="tab" data-tab="lap_utang"><span class="dt" style="background:var(--coral)"></span><small>Liabilitas</small><b>${rpC(utang)}</b></button>
      <button class="tile" data-act="tab" data-tab="lap_nw"><span class="dt" style="background:var(--navy)"></span><small>Net worth</small><b>${rpC(nw)}</b></button></div>
    <h2>Transaksi</h2>
    ${cur.length ? dayList(cur) : `<div class="empty">Belum ada transaksi di ${monthLabel(month)}.<br>Ketuk “Buat laporan” untuk mulai.</div>`}
    ${cur.length ? `<p class="hint">Hanya founder yang dapat menghapus riwayat transaksi.</p>` : ""}
`;
}

/* ---------- Laporan arus kas masuk / keluar ---------- */
function flowReport(type) {
  const rows = myTx.filter(t => t.type === type && t.date.startsWith(month)).sort(byDateDesc);
  const total = sumAmt(rows), g = groupDesc(rows, type), max = g.length ? g[0][1] : 1;
  const title = type === "in" ? "Laporan arus kas masuk" : "Laporan arus kas keluar";
  let split = "";
  if (type === "out" && total > 0) {
    const need = sumAmt(rows.filter(t => NEED_CATS.includes(t.category))), want = sumAmt(rows.filter(t => WANT_CATS.includes(t.category)));
    const line = (n, v) => `<div class="bud"><div class="r"><span>${n}</span><b>${rp(v)}</b></div><small>${pct(v, total)}% dari pengeluaran</small></div>`;
    split = `<h2>Kebutuhan dan keinginan</h2><div class="card">${line("Kebutuhan wajib", need)}${line("Keinginan", want)}${line("Lain-lain", total - need - want)}</div>`;
  }
  const bars = g.length ? `<div class="card chart ${type}">${g.map(([c, v]) =>
    `<div class="row" style="cursor:default"><span class="lab">${esc(c)}</span><span class="track"><i style="width:${Math.max(3, v / max * 100)}%"></i></span><span class="val">${rp(v)}</span></div>`).join("")}</div>`
    : `<div class="empty">Belum ada data di ${monthLabel(month)}.</div>`;
  return repHead(title) + `<div class="card"><small class="muted">Total ${type === "in" ? "pemasukan" : "pengeluaran"} ${monthLabel(month)}</small>
      <div class="bignum">${rp(total)}</div><small class="muted">${rows.length} transaksi</small></div>`
    + `<h2>${type === "in" ? "Per sumber" : "Per kategori"}</h2>${bars}${split}` + (rows.length ? `<h2>Daftar transaksi</h2>${dayList(rows)}` : "");
}
const viewLapIn = () => flowReport("in");
const viewLapOut = () => flowReport("out");

/* ---------- Laporan aset, liabilitas, net worth ---------- */
function itemRow(t, kind) {
  return `<div class="txc"><div class="tx ${kind}"><div class="dot">${TYPE_DOT[kind]}</div>
    <div class="t"><b>${esc(t.memo || t.category)}</b><span>${esc(t.category)} · per ${esc(t.date)}</span></div>
    <div class="amt">${rp(t.amount)}</div></div>
    <div class="extra"><div class="btns"><button class="ghost small" data-act="add" data-type="${kind}" data-cat="${esc(t.category)}" data-memo="${esc(t.memo || "")}">Perbarui nilai</button>
    <button class="ghost small" data-act="history" data-id="${t.id}">Riwayat</button></div></div></div>`;
}
function posSection(title, desc, items, kind) {
  const tot = sumAmt(items);
  return `<h2 style="margin-bottom:2px">${title}</h2><p class="hint" style="margin:0 0 8px">${desc}</p>
    <div class="card" style="margin-bottom:10px"><small class="muted">Subtotal</small><div class="bignum" style="font-size:20px">${rp(tot)}</div></div>`
    + (items.length ? items.map(t => itemRow(t, kind)).join("") : `<div class="empty">Belum ada data.</div>`);
}
function viewLapAset() {
  const asOf = asOfOf(month);
  const items = positions("asset", asOf).filter(t => t.amount > 0).sort((a, b) => b.amount - a.amount);
  const lancar = items.filter(t => ASSET_LANCAR.includes(t.category)), tetap = items.filter(t => !ASSET_LANCAR.includes(t.category));
  return repHead("Laporan aset")
    + `<div class="card"><small class="muted">Total aset per ${esc(asOf)}</small><div class="bignum">${rp(sumAmt(items))}</div></div>`
    + `<div style="margin:12px 0"><button class="btn small" data-act="add" data-type="asset">+ Tambah aset</button></div>`
    + posSection("Aset lancar", "Saldo tunai, rekening tabungan, dompet digital, dan investasi cair (emas, reksa dana pasar uang).", lancar, "asset")
    + posSection("Aset tetap / tidak lancar", "Kendaraan, properti, atau investasi jangka panjang.", tetap, "asset");
}
function viewLapUtang() {
  const asOf = asOfOf(month);
  const items = positions("debt", asOf).filter(t => t.amount > 0).sort((a, b) => b.amount - a.amount);
  const pendek = items.filter(t => t.category === "Utang jangka pendek"), panjang = items.filter(t => t.category !== "Utang jangka pendek");
  return repHead("Laporan liabilitas")
    + `<div class="card"><small class="muted">Total sisa cicilan atau pinjaman yang masih harus dibayar, per ${esc(asOf)}</small><div class="bignum">${rp(sumAmt(items))}</div></div>`
    + `<div style="margin:12px 0"><button class="btn small" data-act="add" data-type="debt">+ Tambah utang</button></div>`
    + posSection("Utang jangka pendek", "Dibayar dalam waktu dekat, misalnya kartu kredit atau pinjaman singkat.", pendek, "debt")
    + posSection("Utang jangka panjang", "Cicilan atau pinjaman yang masih lama, misalnya KPR atau kendaraan.", panjang, "debt");
}
function viewLapNW() {
  const now = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(new Date().getFullYear(), new Date().getMonth() - i, 1), m = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`, asOf = asOfOf(m);
    const a = sumAmt(positions("asset", asOf).filter(t => t.amount > 0)), u = sumAmt(positions("debt", asOf).filter(t => t.amount > 0));
    now.push({ m, a, u, nw: a - u });
  }
  const cur = now[now.length - 1], prev = now[now.length - 2], diff = cur.nw - prev.nw;
  const has = myTx.some(t => t.type === "asset" || t.type === "debt");
  const head = `<h2 style="margin:4px 0 10px">Laporan net worth</h2>`;
  if (!has) return head + `<div class="empty">Belum ada data aset atau utang.<br>Tambahkan dulu supaya kekayaan bersihmu bisa dihitung.</div>
    <div style="margin-top:12px;display:flex;gap:8px"><button class="btn small" data-act="add" data-type="asset">+ Tambah aset</button><button class="btn small" data-act="add" data-type="debt">+ Tambah utang</button></div>`;
  const verdict = diff === 0 ? `Kekayaan bersihmu <b>tidak berubah</b> dibanding akhir bulan lalu.`
    : diff > 0 ? `Kekayaan bersihmu <b>bertambah ${rp(diff)}</b> dibanding akhir bulan lalu.` : `Kekayaan bersihmu <b>berkurang ${rp(-diff)}</b> dibanding akhir bulan lalu.`;
  const rows = now.slice().reverse().map((r, i, arr) => {
    const nxt = arr[i + 1]; const dl = nxt ? r.nw - nxt.nw : null;
    const arrow = dl === null ? "" : dl > 0 ? `<span style="color:var(--in-ink)">▲ ${rpC(dl)}</span>` : dl < 0 ? `<span style="color:var(--out-ink)">▼ ${rpC(-dl)}</span>` : "–";
    return `<div style="display:grid;grid-template-columns:1.1fr 1fr 1fr 1.1fr;gap:6px;padding:8px 0;border-bottom:1px solid var(--line);font-size:12px;font-variant-numeric:tabular-nums">
      <span>${esc(monthLabel(r.m).replace(" 20", " '"))}</span><span>${rpC(r.a)}</span><span>${rpC(r.u)}</span><b>${rpC(r.nw)}</b></div>
      ${dl !== null ? `<div style="text-align:right;font-size:11px;margin-top:-4px;padding-bottom:4px">${arrow}</div>` : ""}`;
  }).join("");
  return head + `<section class="balance"><small>Net worth saat ini (total aset − total utang)</small>
      <div class="big" style="margin-bottom:10px">${cur.nw < 0 ? "-" : ""}${rp(Math.abs(cur.nw))}</div>
      <div class="split"><div class="i"><small>Total aset</small><b>${rp(cur.a)}</b></div><div class="o"><small>Total utang</small><b>${rp(cur.u)}</b></div></div></section>
    <div class="alert ${diff >= 0 ? "ok" : ""}" style="margin-top:12px">${verdict}</div>
    <h2>Perkembangan 6 bulan</h2><div class="card">
      <div style="display:grid;grid-template-columns:1.1fr 1fr 1fr 1.1fr;gap:6px;padding-bottom:6px;border-bottom:1px solid var(--line);font-size:11px;color:var(--muted)"><span>Bulan</span><span>Aset</span><span>Utang</span><span>Net worth</span></div>${rows}</div>
    <p class="hint">Tujuan utamanya melihat apakah kekayaan bersih bertambah dari bulan ke bulan.</p>`;
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
  if (weekLoading) body = skList(3);
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
  if (!people.length) return `<h2 style="margin-top:4px">Anggota</h2>${skList(4)}`;
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


/* ---------- Analisis ---------- */
const groupDesc = (rows, type) => group(rows, type).reverse();
function anaRange() {
  const now = new Date();
  if (anaPeriod === "minggu") { const st = weekStart(now), e = new Date(st); e.setDate(e.getDate() + 6); return [ymd(st), ymd(e), "Minggu ini"]; }
  if (anaPeriod === "custom") return [anaFrom, anaTo, "Rentang kustom"];
  return [ymd(new Date(now.getFullYear(), now.getMonth(), 1)), ymd(new Date(now.getFullYear(), now.getMonth() + 1, 0)), "Bulan ini"];
}
const budgetMonthNow = () => { const to = anaRange()[1]; return (to > todayStr() ? todayStr() : to).slice(0, 7); };
function anaData() {
  const [from, to, plabel] = anaRange();
  const lower = { bulan: "bulan ini", minggu: "minggu ini", custom: "periode ini" }[anaPeriod];
  const cap = to > todayStr() ? todayStr() : to;
  const flows = myTx.filter(t => isFlow(t) && t.date >= from && t.date <= to);
  const inRows = flows.filter(t => t.type === "in"), outRows = flows.filter(t => t.type === "out");
  const needRows = outRows.filter(t => NEED_CATS.includes(t.category)), wantRows = outRows.filter(t => WANT_CATS.includes(t.category));
  const otherRows = outRows.filter(t => !NEED_CATS.includes(t.category) && !WANT_CATS.includes(t.category));
  const inT = sumAmt(inRows), outT = sumAmt(outRows);
  return { from, to, cap, plabel, lower, inRows, outRows, inT, outT, net: inT - outT,
    needRows, wantRows, otherRows, needT: sumAmt(needRows), wantT: sumAmt(wantRows), otherT: sumAmt(otherRows) };
}
function anaSlices(d) {
  if (anaView === "out" || anaView === "in") {
    const rows = anaView === "out" ? d.outRows : d.inRows;
    return groupDesc(rows, anaView).map(([c, v], i) => ({ label: c, value: v, color: colorAt(i), rows: rows.filter(t => t.category === c) }));
  }
  if (anaView === "aset" || anaView === "utang") {
    const items = positions(anaView === "aset" ? "asset" : "debt", d.cap).filter(t => t.amount > 0);
    const by = {}; items.forEach(t => { by[t.category] = (by[t.category] || 0) + t.amount; });
    return Object.entries(by).sort((a, b) => b[1] - a[1]).map(([c, v], i) => ({ label: c, value: v, color: colorAt(i), rows: items.filter(t => t.category === c) }));
  }
  const out = [
    { label: "Kebutuhan wajib", value: d.needT, color: "#101D40", rows: d.needRows },
    { label: "Keinginan", value: d.wantT, color: "#FF8F91", rows: d.wantRows },
    { label: "Lain-lain", value: d.otherT, color: "#A9B6CE", rows: d.otherRows }
  ];
  if (d.net > 0) out.push({ label: "Sisa / tabungan", value: d.net, color: "#52E3B1", rows: [], note: "Uang masuk yang belum terpakai." });
  return out.filter(x => x.value > 0);
}
function donutSvg(slices, total, sel) {
  const R = 70, C = 2 * Math.PI * R, gap = slices.length > 1 ? 2.5 : 0; let off = 0;
  const segs = slices.map((sl, i) => {
    const frac = sl.value / total, len = Math.max(0.5, frac * C - gap);
    const el = `<circle class="seg-c" data-act="seg" data-i="${i}" cx="100" cy="100" r="${R}" fill="none" stroke="${sl.color}"
      stroke-width="${i === sel ? 30 : 22}" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}"
      transform="rotate(-90 100 100)" style="opacity:${sel >= 0 && i !== sel ? 0.4 : 1}" tabindex="0" role="button" aria-label="${esc(sl.label)} ${rp(sl.value)}"/>`;
    off += frac * C; return el;
  }).join("");
  const c = sel >= 0 ? slices[sel] : null;
  const l1 = c ? (c.label.length > 17 ? c.label.slice(0, 16) + "…" : c.label) : "Total";
  const l2 = c ? rpC(c.value) : rpC(total), l3 = c ? pct(c.value, total) + "%" : "";
  return `<svg viewBox="0 0 200 200" role="img" aria-label="Grafik doughnut"><circle cx="100" cy="100" r="${R}" fill="none" stroke="#E1E7F0" stroke-width="22"/>${segs}
    <text x="100" y="${c ? 92 : 98}" text-anchor="middle" font-size="11" fill="#78849A">${esc(l1)}</text>
    <text x="100" y="${c ? 111 : 118}" text-anchor="middle" font-size="16" font-weight="700" fill="#17233F">${esc(l2)}</text>
    ${l3 ? `<text x="100" y="127" text-anchor="middle" font-size="11" fill="#78849A">${l3}</text>` : ""}</svg>`;
}
function sliceDetail(sl, d) {
  if (!sl) return `<p class="hint" style="text-align:center;margin:8px 0 0">Ketuk bagian grafik atau daftar di atas untuk melihat rinciannya.</p>`;
  if (sl.note) return `<div class="alert ok" style="margin-top:8px">${esc(sl.note)} Totalnya ${rp(sl.value)}.</div>`;
  const rows = sl.rows.slice().sort(byDateDesc);
  if (anaView === "alokasi") {
    return `<h2>Isi ${esc(sl.label)}</h2><div class="card">${groupDesc(rows, "out").map(([c, v]) =>
      `<div class="bud"><div class="r"><span>${esc(c)}</span><b>${rp(v)}</b></div><small>${pct(v, sl.value)}% dari ${esc(sl.label.toLowerCase())}</small></div>`).join("")}</div>`;
  }
  return `<h2>${esc(sl.label)} · ${rows.length} ${anaView === "aset" || anaView === "utang" ? "item" : "transaksi"}</h2>${anaView === "aset" || anaView === "utang" ? rows.map(t => txRow(t)).join("") : dayList(rows)}`;
}

function budgetStatus(bm) {
  const b = budgets[bm], items = (b && b.items) || {};
  const real = {}; myTx.filter(t => t.type === "out" && t.date.startsWith(bm)).forEach(t => { real[t.category] = (real[t.category] || 0) + t.amount; });
  const list = Object.keys(items).filter(c => items[c] > 0).map(c => {
    const r = real[c] || 0, ratio = r / items[c];
    return { cat: c, jatah: items[c], real: r, ratio, status: r > items[c] ? "over" : ratio >= 0.8 ? "near" : "ok" };
  });
  return { b, list, unb: Object.keys(real).filter(c => !(items[c] > 0)).map(c => ({ cat: c, real: real[c] })),
    over: list.filter(x => x.status === "over"), near: list.filter(x => x.status === "near") };
}
function alertsHtml(d, bm, bs) {
  const A = [];
  if (d.net < 0) A.push(["bad", `<b>Defisit ${rp(-d.net)}</b> ${d.lower}. Uang keluar lebih besar dari uang masuk.`]);
  bs.over.forEach(x => A.push(["bad", `<b>JEBOL: ${esc(x.cat)}</b> ${rp(x.real)} dari jatah ${rp(x.jatah)} (lebih ${rp(x.real - x.jatah)}).`]));
  bs.near.forEach(x => A.push(["warn", `<b>Hampir habis: ${esc(x.cat)}</b> sudah ${Math.round(x.ratio * 100)}% dari jatah.`]));
  const base = d.inT > 0 ? d.inT : d.outT;
  if (base > 0 && d.wantT / base > 0.3) A.push(["warn", `<b>Keinginan besar</b>: ${pct(d.wantT, base)}% dari ${d.inT > 0 ? "pemasukan" : "pengeluaran"} (batas wajar 30%).`]);
  if (!bs.list.length) A.push(["info", `Belum ada jatah untuk ${monthLabel(bm)}. <button class="ghost small" data-act="budget" style="margin-left:4px">Atur jatah</button>`]);
  else if (!bs.over.length && !bs.near.length) A.push(["ok", "Semua pos masih dalam jatah."]);
  return `<h2>Peringatan</h2>` + A.map(([t, h]) => `<div class="alert ${t === "bad" ? "" : t}">${h}</div>`).join("");
}
function conclusionHtml(d, bs) {
  if (!d.inT && !d.outT) return `<div class="empty">Belum ada catatan ${d.lower}.</div>`;
  const C = [], base = d.inT > 0 ? d.inT : d.outT, baseName = d.inT > 0 ? "pemasukan" : "pengeluaran";
  const verdict = d.net >= 0
    ? `<div class="verdict">SURPLUS ${rp(d.net)}. Uang masuk lebih besar dari uang keluar${d.inT > 0 ? ` (${pct(d.net, d.inT)}% dari pemasukan)` : ""}. Berhasil menabung ${d.lower}.</div>`
    : `<div class="verdict bad">DEFISIT ${rp(-d.net)}. Uang keluar lebih besar dari uang masuk. Cari pos yang jebol dan perbaiki.</div>`;
  if (d.net < 0) {
    const top = groupDesc(d.outRows, "out").slice(0, 3).map(([c, v]) => `${esc(c)} ${rp(v)}`).join(", ");
    C.push(["bad", bs.over.length ? `<b>Pos yang jebol:</b> ${bs.over.map(x => `${esc(x.cat)} (+${rp(x.real - x.jatah)})`).join(", ")}.`
      : `<b>Pos terbesar:</b> ${top}. ${bs.list.length ? "" : "Atur jatah supaya pos yang jebol terlihat jelas."}`]);
  }
  const nr = pct(d.needT, base), wr = pct(d.wantT, base);
  C.push([nr <= 50 ? "ok" : nr <= 70 ? "warn" : "bad",
    `<b>Kebutuhan wajib</b> (makan, transportasi, tagihan, cicilan, kesehatan): ${rp(d.needT)} = ${nr}% dari ${baseName}. ${nr <= 50 ? "Terkendali." : nr <= 70 ? "Agak tinggi, perlu diawasi." : "Terlalu tinggi, ruang tabungan sempit."}`]);
  C.push([wr <= 30 ? "ok" : "bad",
    `<b>Keinginan</b> (belanja, hiburan, hobi, nongkrong): ${rp(d.wantT)} = ${wr}% dari ${baseName}. ${wr <= 30 ? "Wajar, tidak berlebihan." : "Berlebihan, batas wajar 30%."}`]);
  let sr = null;
  if (d.inT > 0) {
    sr = pct(d.net, d.inT);
    C.push([d.net < 0 ? "bad" : sr >= 20 ? "ok" : "warn", `<b>Tabungan</b>: ${d.net < 0 ? "tidak ada, malah defisit" : sr + "% dari pemasukan"}. ${d.net >= 0 && sr >= 20 ? "Target 20% tercapai." : "Target idealnya 20%."}`]);
  }
  const tw = groupDesc(d.wantRows, "out")[0];
  if (d.wantT > 0 && (wr > 30 || d.net < 0 || (sr !== null && sr < 20))) C.push(["warn", `<b>Prioritas:</b> keinginan jangan sampai menggerus kebutuhan dan tabungan. Kurangi ${tw ? esc(tw[0]) : "pos keinginan"} lebih dulu.`]);
  else C.push(["ok", `<b>Pola sehat:</b> kebutuhan aman, keinginan wajar, dan tabungan terjaga.`]);
  return verdict + `<div class="card">${C.map(([t, h]) => `<div class="cn ${t === "ok" ? "" : t}"><i></i><span>${h}</span></div>`).join("")}
    <p class="hint">Dihitung dari catatanmu sendiri. Hanya gambaran, bukan saran keuangan.</p></div>`;
}
function budgetHtml(bm, bs) {
  const rows = bs.list.map(x => {
    const lab = { over: "JEBOL", near: "HAMPIR HABIS", ok: "AMAN" }[x.status], w = Math.round(x.real / Math.max(x.jatah, x.real, 1) * 100), diff = x.real - x.jatah;
    return `<div class="bud"><div class="r"><b>${esc(x.cat)}</b><span class="tag ${x.status === "ok" ? "" : x.status}">${lab}</span></div>
      <div class="pb ${x.status === "ok" ? "" : x.status}"><i style="width:${Math.max(3, w)}%"></i></div>
      <small>Jatah ${rp(x.jatah)} · Realisasi ${rp(x.real)} · ${diff > 0 ? "Lebih " + rp(diff) : "Sisa " + rp(-diff)}</small></div>`;
  }).join("");
  const unb = bs.unb.length ? `<p class="hint">Tanpa jatah: ${bs.unb.map(x => `${esc(x.cat)} ${rp(x.real)}`).join(", ")}.</p>` : "";
  return `<h2>Jatah vs realisasi · ${monthLabel(bm)}</h2><div class="card">
    ${rows || `<p class="hint" style="margin:0 0 8px">Belum ada jatah. Isi target awal bulan, misalnya jatah nongkrong Rp 500.000, lalu bandingkan dengan kenyataannya di akhir bulan.</p>`}${unb}
    <div class="btns"><button class="btn small" data-act="budget">${bs.list.length ? "Ubah jatah" : "Atur jatah"}</button></div></div>`;
}
function correctionHtml(bm, bs) {
  const notes = (bs.b && bs.b.notes) || {};
  const cur = bs.over.map(x => `<div class="bud"><div class="r"><b>${esc(x.cat)}</b><span class="tag over">JEBOL</span></div>
    <small>Lebih ${rp(x.real - x.jatah)} dari jatah ${monthLabel(bm)}.</small>
    <div style="margin-top:4px;font-size:14px">${notes[x.cat] ? esc(notes[x.cat]) : `<span class="muted">Belum ada catatan.</span>`}</div>
    <div class="btns"><button class="ghost small" data-act="note" data-cat="${esc(x.cat)}">${notes[x.cat] ? "Ubah catatan" : "Tulis catatan koreksi"}</button></div></div>`).join("");
  const pm = prevMonth(bm), pbs = budgetStatus(pm), pn = (pbs.b && pbs.b.notes) || {};
  const prev = pbs.over.map(x => `<div class="alert warn"><b>Jaga rem: ${esc(x.cat)}</b> jebol ${monthLabel(pm)} (${rp(x.real)} dari jatah ${rp(x.jatah)}).${pn[x.cat] ? `<br>Catatan: ${esc(pn[x.cat])}` : ""}</div>`).join("");
  return `<h2>Catatan koreksi</h2>`
    + (prev ? `<p class="hint" style="margin:0 0 6px">Pos yang jebol bulan lalu, supaya bulan ini lebih dijaga:</p>${prev}` : "")
    + `<div class="card">${cur || `<p class="hint" style="margin:0">Belum ada pos yang jebol bulan ini.</p>`}</div>`;
}

function viewAnalisis() {
  const head = `<h2 style="margin:4px 0 10px">Analisis</h2>`;
  if (!myTx.length) return head + `<div class="empty">Belum ada catatan untuk dianalisis.<br>Buat laporan dulu.</div>`;
  const d = anaData(), bm = budgetMonthNow(), bs = budgetStatus(bm);
  const chip = (act, key, val, label, cur) => `<button class="chip ${cur === val ? "on" : ""}" data-act="${act}" data-${key}="${val}">${label}</button>`;
  const periods = `<div class="chips">${[["bulan", "Bulan ini"], ["minggu", "Minggu ini"], ["custom", "Kustom"]].map(([v, l]) => chip("anaPeriod", "p", v, l, anaPeriod)).join("")}</div>`;
  const custom = anaPeriod === "custom" ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:6px">
    <div><label for="ana-from" style="margin-top:0">Dari</label><input class="f" type="date" id="ana-from" value="${esc(anaFrom)}"></div>
    <div><label for="ana-to" style="margin-top:0">Sampai</label><input class="f" type="date" id="ana-to" value="${esc(anaTo)}"></div></div>` : "";
  const views = `<div class="chips">${[["out", "Pengeluaran"], ["in", "Pemasukan"], ["alokasi", "Alokasi"], ["aset", "Aset"], ["utang", "Utang"]].map(([v, l]) => chip("anaView", "v", v, l, anaView)).join("")}</div>`;
  const slices = anaSlices(d), total = slices.reduce((a, x) => a + x.value, 0);
  const sel = anaSel >= 0 && anaSel < slices.length ? anaSel : -1;
  const note = anaView === "aset" || anaView === "utang" ? `Posisi per ${esc(d.cap)}` : `${d.plabel}: ${esc(d.from)} s/d ${esc(d.to)}`;
  const donut = total > 0
    ? `<div class="card"><div class="donut">${donutSvg(slices, total, sel)}</div>
        ${slices.map((sl, i) => `<button class="lg ${i === sel ? "on" : ""}" data-act="seg" data-i="${i}"><i style="background:${sl.color}"></i><span class="n">${esc(sl.label)}</span><span class="v">${rp(sl.value)}</span><span class="p">${pct(sl.value, total)}%</span></button>`).join("")}
        <p class="hint" style="text-align:center">${note}</p></div>${sliceDetail(sel >= 0 ? slices[sel] : null, d)}`
    : `<div class="card"><div class="donut">${`<svg viewBox="0 0 200 200"><circle cx="100" cy="100" r="70" fill="none" stroke="#E1E7F0" stroke-width="22"/><text x="100" y="105" text-anchor="middle" font-size="12" fill="#78849A">Belum ada data</text></svg>`}</div><p class="hint" style="text-align:center">${note}</p></div>`;
  return head + periods + custom + alertsHtml(d, bm, bs)
    + `<h2>Grafik</h2>${views}${donut}`
    + `<h2>Kesimpulan ${d.lower}</h2>${conclusionHtml(d, bs)}`
    + budgetHtml(bm, bs) + correctionHtml(bm, bs);
}

/* ---------- Jatah & catatan koreksi (jendela) ---------- */
function sheetBudget() {
  const bm = budgetMonthNow(), items = (budgets[bm] && budgets[bm].items) || {};
  openSheet(`<h2 style="margin:0">Atur jatah ${monthLabel(bm)}</h2>
    <p class="hint">Isi batas pengeluaran per pos untuk bulan ini. Kosongkan kalau tidak dibatasi.</p>
    ${CATS.out.map((c, i) => `<label for="bg-${i}">${esc(c)}</label><input class="f" id="bg-${i}" inputmode="numeric" autocomplete="off" placeholder="0" value="${items[c] ? new Intl.NumberFormat("id-ID").format(items[c]) : ""}">`).join("")}
    ${sheetButtons("doBudget", bm, "Simpan jatah")}`);
}
function saveBudget(bm, items, notes) {
  setDoc(doc(db, "budgets", `${profile.uid}_${bm}`), { uid: profile.uid, month: bm, items, notes, updatedAt: serverTimestamp() }).catch(e => toast(friendly(e)));
  closeSheet(); toast(navigator.onLine ? "Tersimpan." : "Tersimpan di perangkat. Terkirim otomatis saat online.");
}
function doBudget(bm) {
  const items = {};
  CATS.out.forEach((c, i) => { const v = +($(`#bg-${i}`).value.replace(/\D/g, "")); if (v > 0) items[c] = v; });
  saveBudget(bm, items, (budgets[bm] && budgets[bm].notes) || {});
}
function sheetNote(cat) {
  const bm = budgetMonthNow(), notes = (budgets[bm] && budgets[bm].notes) || {};
  openSheet(`<h2 style="margin:0">Catatan koreksi: ${esc(cat)}</h2>
    <p class="hint">Tulis kenapa pos ini jebol dan rencana supaya bulan depan lebih terjaga.</p>
    <textarea class="f" id="sf-text" rows="4" maxlength="200">${esc(notes[cat] || "")}</textarea>
    ${sheetButtons("doNote", cat, "Simpan catatan")}`);
}
function doNote(cat) {
  const bm = budgetMonthNow(), b = budgets[bm] || {}, notes = { ...(b.notes || {}) }, text = $("#sf-text").value.trim();
  if (text) notes[cat] = text; else delete notes[cat];
  saveBudget(bm, b.items || {}, notes);
}

function viewLainnya() {
  return `<h2 style="margin-top:4px">Lainnya</h2><div class="menu">
    <button data-act="tab" data-tab="pengumuman">Pengumuman</button>
    <button data-act="tab" data-tab="catatan">Catatan saya</button>
    <button data-act="tab" data-tab="analisis">Analisis saya</button>
    <button data-act="tab" data-tab="riwayat">Riwayat perubahan (semua)</button>
    ${profile.role === "founder" ? `<button data-act="clear" style="color:var(--out)">Hapus riwayat</button>` : ""}</div>`;
}

function diffText(a) {
  const f = { type: "Jenis", amount: "Jumlah", category: "Kategori", date: "Tanggal", memo: "Catatan" };
  const show = (k, v) => k === "amount" ? rp(v) : (k === "type" ? (TYPE_LABEL[v] || v) : (v || "—"));
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
    + (feedLoading ? skList(3)
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
    <select class="f" id="sf-type">${["in", "out", "debt", "asset"].map(k => `<option value="${k}" ${t.type === k ? "selected" : ""}>${TYPE_LABEL[k]}</option>`).join("")}</select>
    <label for="sf-amount">Jumlah (Rp)</label>
    <input class="f amount" id="sf-amount" inputmode="numeric" value="${new Intl.NumberFormat("id-ID").format(t.amount)}" autocomplete="off">
    <label for="sf-cat">Kategori</label><select class="f" id="sf-cat">${catOptions(t.type, t.category)}</select>
    <label for="sf-memo">Catatan</label><input class="f" id="sf-memo" maxlength="80" value="${esc(t.memo)}">
    <label for="sf-date">Tanggal</label><input class="f" type="date" id="sf-date" value="${esc(t.date)}">`;
}
function readFields() {
  const raw = $("#sf-amount").value.replace(/\D/g, ""), amount = +raw, ty = $("#sf-type").value;
  if (raw === "" || ((ty === "in" || ty === "out") && amount === 0)) { sheetErr("Isi jumlah lebih dari 0."); return null; }
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
  if (!navigator.onLine) return sheetErr(offlineMsg);
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
  if (!navigator.onLine) { sheetErr(offlineMsg); return; }
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
  if (!navigator.onLine) { $("#an-err").textContent = offlineMsg; return; }
  const title = $("#an-title").value.trim(), body = $("#an-body").value.trim();
  const err = $("#an-err");
  if (!title || !body) { err.textContent = "Isi judul dan isi pengumuman."; return; }
  try {
    await addDoc(collection(db, "notifications"), { toUid: "all", type: "announce", title, body, by: profile.uid, byName: profile.name, createdAt: serverTimestamp() });
    $("#an-title").value = ""; $("#an-body").value = ""; err.textContent = ""; toast("Pengumuman terkirim.");
  } catch (e) { err.textContent = friendly(e); }
}

/* ---------- Dialog buat laporan ---------- */
const LBL = {
  in: { amt: "Jumlah (Rp)", cat: "Sumber pemasukan", memo: "Catatan (opsional)", ph: "Misal: gaji bulan ini", date: "Tanggal", hint: "" },
  out: { amt: "Jumlah (Rp)", cat: "Kategori", memo: "Catatan (opsional)", ph: "Misal: makan siang", date: "Tanggal", hint: "" },
  asset: { amt: "Nilai saat ini (Rp)", cat: "Jenis aset", memo: "Nama aset", ph: "Misal: BCA, Motor Beat, Emas", date: "Per tanggal", hint: "Catat nilai terbarunya. Untuk memperbarui, buat laporan baru dengan nama yang sama." },
  debt: { amt: "Sisa utang (Rp)", cat: "Jenis utang", memo: "Nama utang", ph: "Misal: Cicilan motor", date: "Per tanggal", hint: "Catat sisa yang masih harus dibayar. Isi 0 kalau sudah lunas." }
};
function setType(t) {
  txType = t; const L = LBL[t];
  document.querySelectorAll("#seg button").forEach(b => { b.className = b.dataset.t === t ? `on ${t}` : ""; });
  $("#cat").innerHTML = CATS[t].map(c => `<option>${c}</option>`).join("");
  document.querySelector('label[for="amount"]').textContent = L.amt;
  document.querySelector('label[for="cat"]').textContent = L.cat;
  document.querySelector('label[for="memo"]').textContent = L.memo;
  document.querySelector('label[for="date"]').textContent = L.date;
  $("#memo").placeholder = L.ph; $("#typeHint").textContent = L.hint;
}
function openAdd(type, cat, memo) {
  setType(type || "out");
  if (cat) $("#cat").value = cat;
  $("#amount").value = ""; $("#memo").value = memo || ""; $("#date").value = todayStr(); $("#err").textContent = "";
  $("#dlg").showModal(); $("#amount").focus();
}
$("#seg").onclick = e => { if (e.target.dataset.t) setType(e.target.dataset.t); };
$("#cancel").onclick = () => $("#dlg").close();
$("#save").onclick = () => {
  const raw = $("#amount").value.replace(/\D/g, ""), amount = +raw, flow = txType === "in" || txType === "out";
  if (raw === "" || (flow && amount === 0)) { $("#err").textContent = "Isi jumlah lebih dari 0."; return; }
  if (!$("#date").value) { $("#err").textContent = "Pilih tanggal."; return; }
  let memo = $("#memo").value.trim(); if (!flow && !memo) memo = $("#cat").value;
  addDoc(collection(db, "transactions"), {
    uid: profile.uid, name: profile.name, type: txType, amount,
    category: $("#cat").value, memo,
    date: $("#date").value, createdAt: serverTimestamp()
  }).catch(e => toast(friendly(e)));
  month = $("#date").value.slice(0, 7);
  $("#dlg").close();
  toast(navigator.onLine ? "Tersimpan." : "Tersimpan di perangkat. Terkirim otomatis saat online.");
};

/* ---------- Event ---------- */
document.addEventListener("input", e => {
  if (e.target.id === "amount" || e.target.id === "sf-amount" || (e.target.id || "").startsWith("bg-")) {
    const d = e.target.value.replace(/\D/g, "").slice(0, 12);
    e.target.value = d ? new Intl.NumberFormat("id-ID").format(+d) : "";
  }
});
document.addEventListener("click", async e => {
  const el = e.target.closest("[data-act]"); if (!el || el.tagName === "SELECT") return;
  const a = el.dataset.act, id = el.dataset.id;
  if (a === "login") login();
  else if (a === "logout") signOut(auth);
  else if (a === "add") openAdd(el.dataset.type, el.dataset.cat, el.dataset.memo);
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
  else if (a === "anaPeriod") { anaPeriod = el.dataset.p; anaSel = -1; render(); }
  else if (a === "anaView") { anaView = el.dataset.v; anaSel = -1; render(); }
  else if (a === "seg") { const k = +el.dataset.i; anaSel = anaSel === k ? -1 : k; render(); }
  else if (a === "budget") sheetBudget();
  else if (a === "doBudget") doBudget(id);
  else if (a === "note") sheetNote(el.dataset.cat);
  else if (a === "doNote") doNote(id);
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
  else if (e.target.id === "ana-from" || e.target.id === "ana-to") {
    if (e.target.id === "ana-from") anaFrom = e.target.value || anaFrom; else anaTo = e.target.value || anaTo;
    if (anaFrom > anaTo) { const x = anaFrom; anaFrom = anaTo; anaTo = x; }
    anaSel = -1; render();
  }
  else if (e.target.id === "sf-type") $("#sf-cat").innerHTML = catOptions(e.target.value, "");
});

window.addEventListener("online", () => { toast("Kembali online. Data dikirim otomatis."); render(); });
window.addEventListener("offline", () => { toast("Kamu sedang offline."); render(); });
