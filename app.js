import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, addDoc, deleteDoc,
  collection, query, where, getDocs, onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

// Harus sama dengan email founder di firestore.rules
const FOUNDER_EMAIL = "aljanedbagdady@gmail.com";

const CATS = {
  out: ["Makanan", "Transportasi", "Belanja", "Tagihan", "Hiburan", "Kesehatan", "Lainnya"],
  in: ["Gaji", "Bonus", "Usaha", "Hadiah", "Lainnya"]
};
const ROLE_LABEL = { pending: "Menunggu", member: "Anggota", admin: "Admin", founder: "Founder" };

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const rp = n => "Rp " + new Intl.NumberFormat("id-ID").format(Math.round(n));
const pad = n => String(n).padStart(2, "0");
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => ymd(new Date());
const longDay = s => new Date(s + "T00:00").toLocaleDateString("id-ID", { weekday: "long", day: "numeric", month: "long" });
const monthLabel = m => { const [y, mo] = m.split("-"); return new Date(y, mo - 1, 1).toLocaleDateString("id-ID", { month: "long", year: "numeric" }); };
const isStaff = () => profile && (profile.role === "admin" || profile.role === "founder");
const isActive = () => profile && ["member", "admin", "founder"].includes(profile.role);

function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), 3200);
}
function friendly(e) {
  if (e && e.code === "permission-denied") return "Akses ditolak. Cek status akunmu atau aturan Firestore.";
  if (e && e.code === "unavailable") return "Tidak ada koneksi. Coba lagi sebentar.";
  return "Terjadi kesalahan: " + (e && (e.code || e.message) || "tidak diketahui");
}

/* ---------- Firebase ---------- */
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

/* ---------- State ---------- */
let profile = null, unsubProfile = null, unsubTx = null;
let tab = "catatan", myTx = [], month = todayStr().slice(0, 7);
let weekOffset = 0, weekTx = [], weekLoading = false, drill = null, people = [];
let txType = "out";

/* ---------- Auth ---------- */
async function login() {
  const p = new GoogleAuthProvider();
  try { await signInWithPopup(auth, p); }
  catch (e) {
    if (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment") {
      try { await signInWithRedirect(auth, p); } catch (e2) { toast(friendly(e2)); }
    } else if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") {
      toast(friendly(e));
    }
  }
}
getRedirectResult(auth).catch(e => toast(friendly(e)));

onAuthStateChanged(auth, async user => {
  unsubProfile && unsubProfile(); unsubTx && unsubTx();
  profile = null; myTx = []; weekTx = []; people = [];
  if (!user) { renderLogin(); return; }
  $("#app").innerHTML = `<div class="center"><p>Memuat…</p></div>`;
  try {
    const ref = doc(db, "users", user.uid);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      const isFounder = user.email === FOUNDER_EMAIL && user.emailVerified;
      await setDoc(ref, {
        name: user.displayName || user.email, email: user.email, photo: user.photoURL || "",
        role: isFounder ? "founder" : "pending", createdAt: serverTimestamp()
      });
    }
    unsubProfile = onSnapshot(ref, s => {
      if (!s.exists()) return;
      const prevRole = profile && profile.role;
      profile = { uid: user.uid, ...s.data() };
      if (prevRole !== profile.role) startData();
      render();
    }, e => { $("#app").innerHTML = `<div class="center"><h1>Gagal memuat</h1><p>${esc(friendly(e))}</p><button class="btn" data-act="logout">Keluar</button></div>`; });
  } catch (e) {
    $("#app").innerHTML = `<div class="center"><h1>Gagal memuat</h1><p>${esc(friendly(e))}</p><button class="btn" data-act="logout">Keluar</button></div>`;
  }
});

function startData() {
  unsubTx && unsubTx(); unsubTx = null;
  if (!isActive()) return;
  tab = isStaff() ? "masuk" : "catatan";
  unsubTx = onSnapshot(
    query(collection(db, "transactions"), where("uid", "==", profile.uid)),
    s => { myTx = s.docs.map(d => ({ id: d.id, pending: d.metadata.hasPendingWrites, ...d.data() })); render(); },
    e => toast(friendly(e))
  );
  if (isStaff()) loadWeek();
}

/* ---------- Data loaders (admin/founder) ---------- */
const weekStart = d => { const x = new Date(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); x.setHours(0, 0, 0, 0); return x; };
function weekRange() {
  const s = weekStart(new Date()); s.setDate(s.getDate() + weekOffset * 7);
  const e = new Date(s); e.setDate(e.getDate() + 6); return [s, e];
}
async function loadWeek() {
  const [s, e] = weekRange(); drill = null; weekLoading = true; render();
  try {
    const snap = await getDocs(query(collection(db, "transactions"), where("date", ">=", ymd(s)), where("date", "<=", ymd(e))));
    weekTx = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (err) { toast(friendly(err)); weekTx = []; }
  weekLoading = false; render();
}
async function loadPeople() {
  try {
    const snap = await getDocs(collection(db, "users"));
    const order = { pending: 0, founder: 1, admin: 2, member: 3 };
    people = snap.docs.map(d => ({ uid: d.id, ...d.data() }))
      .sort((a, b) => (order[a.role] - order[b.role]) || String(a.name).localeCompare(String(b.name)));
  } catch (err) { toast(friendly(err)); }
  render();
}
async function setRole(uid, role) {
  try { await updateDoc(doc(db, "users", uid), { role }); toast("Peran diperbarui."); await loadPeople(); }
  catch (e) { toast(friendly(e)); }
}

/* ---------- Render ---------- */
function renderLogin() {
  $("#app").innerHTML = `
    <div class="center">
      <h1 style="font-size:24px">Laporan Keuangan Tim</h1>
      <p>Masuk dengan akun Google untuk mencatat dan melaporkan keuangan.</p>
      <button class="btn" data-act="login">Masuk dengan Google</button>
    </div>`;
}

function header() {
  return `<header class="top">
    <div><h1>Laporan Keuangan</h1>
      <div class="who">${esc(profile.name)} <span class="pill ${profile.role}">${ROLE_LABEL[profile.role]}</span></div></div>
    <button class="ghost" data-act="logout">Keluar</button></header>`;
}

function render() {
  if (!profile) return;
  if (profile.role === "pending") {
    $("#app").innerHTML = `<div class="wrap">${header()}
      <div class="center" style="min-height:60vh"><h1 style="font-size:20px">Menunggu persetujuan</h1>
      <p>Akunmu sudah terdaftar. Admin akan menyetujui sebelum kamu bisa mencatat. Halaman ini akan berubah otomatis setelah disetujui.</p></div></div>`;
    return;
  }
  const views = { catatan: viewCatatan, masuk: viewMasuk, anggota: viewAnggota };
  const nav = isStaff() ? `<nav class="bar"><div class="in">
      <button data-act="tab" data-tab="masuk" class="${tab === "masuk" ? "on" : ""}">Data masuk</button>
      <button data-act="tab" data-tab="anggota" class="${tab === "anggota" ? "on" : ""}">Anggota</button>
      <button data-act="tab" data-tab="catatan" class="${tab === "catatan" ? "on" : ""}">Catatan saya</button>
    </div></nav>` : "";
  const fab = tab === "catatan" ? `<button class="fab" data-act="add">+ Catat transaksi</button>` : "";
  $("#app").innerHTML = `<div class="wrap">${header()}${views[tab]()}</div>${nav}${fab}`;
}

function canDelete(t) {
  if (t.pending) return true;
  return t.createdAt && (Date.now() - t.createdAt.toMillis()) < 3600e3;
}

function txRow(t, opts = {}) {
  return `<div class="tx ${t.type}"><div class="dot">${t.type === "in" ? "+" : "−"}</div>
    <div class="t"><b>${esc(opts.showName ? t.name : t.category)}</b>
      <span>${esc(opts.showName ? t.category + (t.memo ? " · " + t.memo : "") : t.memo)}</span></div>
    <div class="amt">${t.type === "in" ? "+" : "-"}${rp(t.amount)}</div>
    ${opts.del && canDelete(t) ? `<button class="del" data-act="del" data-id="${t.id}" aria-label="Hapus transaksi">×</button>` : ""}</div>`;
}

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
    ${cur.length ? `<p class="hint">Transaksi bisa dihapus dalam 1 jam setelah dicatat. Setelah itu tercatat permanen.</p>` : ""}`;
}

function group(type) {
  const m = {};
  weekTx.filter(t => t.type === type).forEach(t => { m[t.category] = (m[t.category] || 0) + t.amount; });
  return Object.entries(m).sort((a, b) => a[1] - b[1]);
}
function chart(type, title) {
  const rows = group(type); const max = rows.length ? rows[rows.length - 1][1] : 1;
  return `<h2>${title}</h2><div class="card chart ${type}">${rows.length ? rows.map(([c, v]) =>
    `<button class="row" data-act="drill" data-type="${type}" data-cat="${esc(c)}" aria-label="Lihat transaksi ${esc(c)}">
      <span class="lab">${esc(c)}</span><span class="track"><i style="width:${Math.max(3, v / max * 100)}%"></i></span>
      <span class="val">${rp(v)}</span></button>`).join("") + `<p class="hint">Urut dari terkecil ke terbesar. Ketuk batang untuk melihat transaksinya.</p>`
    : `<p class="hint" style="margin:0">Belum ada data minggu ini.</p>`}</div>`;
}
function viewMasuk() {
  const [s, e] = weekRange(); const f = d => d.toLocaleDateString("id-ID", { day: "numeric", month: "short" });
  const inT = weekTx.filter(t => t.type === "in").reduce((a, t) => a + t.amount, 0);
  const outT = weekTx.filter(t => t.type === "out").reduce((a, t) => a + t.amount, 0);
  const bal = inT - outT;
  let body = "";
  if (weekLoading) body = `<div class="empty">Memuat data…</div>`;
  else if (drill) {
    const rows = weekTx.filter(t => t.type === drill.type && t.category === drill.cat).sort((a, b) => b.date.localeCompare(a.date));
    body = `<h2>${esc(drill.cat)} · ${drill.type === "in" ? "pemasukan" : "pengeluaran"}</h2>
      <button class="ghost small" data-act="closeDrill" style="margin-bottom:10px">← Kembali ke grafik</button>
      ${rows.map(t => `<div class="day" style="margin:10px 0 4px">${longDay(t.date)}</div>${txRow(t, { showName: true })}`).join("")}`;
  } else body = chart("out", "Pengeluaran per kategori") + chart("in", "Pemasukan per sumber");
  return `<div class="weeknav"><button class="ghost" data-act="prevWeek" aria-label="Minggu sebelumnya">←</button>
      <b>${f(s)} – ${f(e)} ${e.getFullYear()}${weekOffset === 0 ? " (minggu ini)" : ""}</b>
      <button class="ghost" data-act="nextWeek" aria-label="Minggu berikutnya" ${weekOffset >= 0 ? "disabled" : ""}>→</button></div>
    <section class="balance"><small>Selisih minggu ini</small>
      <div class="big">${bal < 0 ? "-" : ""}${rp(Math.abs(bal))}</div>
      <div class="split"><div class="i"><small>Pemasukan</small><b>${rp(inT)}</b></div>
      <div class="o"><small>Pengeluaran</small><b>${rp(outT)}</b></div></div></section>${body}`;
}

function viewAnggota() {
  if (!people.length) return `<h2>Anggota</h2><div class="empty">Memuat daftar anggota…</div>`;
  const pend = people.filter(p => p.role === "pending");
  const rest = people.filter(p => p.role !== "pending");
  const av = p => p.photo ? `<img src="${esc(p.photo)}" alt="" referrerpolicy="no-referrer">` : `<div class="av">${esc((p.name || "?")[0].toUpperCase())}</div>`;
  const row = (p, action) => `<div class="person">${av(p)}<div class="t"><b>${esc(p.name)}</b><span>${esc(p.email)}</span></div>${action}</div>`;
  const roleCtl = p => {
    if (p.role === "founder" || p.uid === profile.uid) return `<span class="pill ${p.role}">${ROLE_LABEL[p.role]}</span>`;
    if (profile.role === "founder") return `<select class="month" data-act="setrole" data-uid="${p.uid}" aria-label="Peran ${esc(p.name)}">
      ${["member", "admin"].map(r => `<option value="${r}" ${p.role === r ? "selected" : ""}>${ROLE_LABEL[r]}</option>`).join("")}</select>`;
    return `<span class="pill ${p.role}">${ROLE_LABEL[p.role]}</span>`;
  };
  return `<h2 style="margin-top:4px">Menunggu persetujuan (${pend.length})</h2>
    <div class="card">${pend.length ? pend.map(p => row(p, `<button class="btn small" data-act="approve" data-uid="${p.uid}">Setujui</button>`)).join("") : `<p class="hint" style="margin:0">Tidak ada pendaftar baru.</p>`}</div>
    <h2>Anggota aktif (${rest.length})</h2>
    <div class="card">${rest.map(p => row(p, roleCtl(p))).join("")}</div>
    ${profile.role === "founder" ? `<p class="hint">Hanya founder yang bisa mengangkat atau mencopot admin.</p>` : ""}`;
}

/* ---------- Dialog ---------- */
function setType(t) {
  txType = t;
  document.querySelectorAll("#seg button").forEach(b => { b.className = b.dataset.t === t ? `on ${t}` : ""; });
  $("#cat").innerHTML = CATS[t].map(c => `<option>${c}</option>`).join("");
}
$("#seg").onclick = e => { if (e.target.dataset.t) setType(e.target.dataset.t); };
$("#amount").oninput = e => {
  const d = e.target.value.replace(/\D/g, "").slice(0, 12);
  e.target.value = d ? new Intl.NumberFormat("id-ID").format(+d) : "";
};
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

/* ---------- Events ---------- */
document.addEventListener("click", async e => {
  const el = e.target.closest("[data-act]"); if (!el || el.tagName === "SELECT") return;
  const a = el.dataset.act;
  if (a === "login") login();
  else if (a === "logout") signOut(auth);
  else if (a === "add") {
    setType("out"); $("#amount").value = ""; $("#memo").value = ""; $("#date").value = todayStr(); $("#err").textContent = "";
    $("#dlg").showModal(); $("#amount").focus();
  }
  else if (a === "tab") { tab = el.dataset.tab; render(); if (tab === "masuk") loadWeek(); if (tab === "anggota") loadPeople(); }
  else if (a === "prevWeek") { weekOffset--; loadWeek(); }
  else if (a === "nextWeek") { if (weekOffset < 0) { weekOffset++; loadWeek(); } }
  else if (a === "drill") { drill = { type: el.dataset.type, cat: el.dataset.cat }; render(); window.scrollTo(0, 0); }
  else if (a === "closeDrill") { drill = null; render(); }
  else if (a === "approve") setRole(el.dataset.uid, "member");
  else if (a === "del") {
    if (!confirm("Hapus transaksi ini?")) return;
    try { await deleteDoc(doc(db, "transactions", el.dataset.id)); toast("Dihapus."); }
    catch (err) { toast(friendly(err)); }
  }
});
document.addEventListener("change", e => {
  if (e.target.id === "month") { month = e.target.value; render(); }
  else if (e.target.dataset.act === "setrole") setRole(e.target.dataset.uid, e.target.value);
});
