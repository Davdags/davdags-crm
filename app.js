"use strict";
// DavDags CRM: a small single-page app on top of the bot's /whatsapp/crm API.
// Data flow: one "overview" load (cached for instant start), then "changes" every few seconds.

const API = "https://soxevflmqepqbritrpnl.supabase.co/functions/v1/whatsapp/crm/";
const VAPID_PUBLIC_KEY = "BCtPdOq8THqzILdS4TS8J5TkRLKXL52p9ByMlsflTjBV7bjJrgRWYcFVtWAXvJkTIC3MoK5NfSimg210S7rZ-Ww";
const POLL_VISIBLE_MS = 3000;
const POLL_HIDDEN_MS = 20000;
const FULL_REFRESH_MS = 5 * 60 * 1000;

const STATUS = { new: "New", qualified: "Quoted", deposit: "Deposit pending", won: "Paid", lost: "Lost" };
const PROJECT_STATUSES = ["Deposit pending", "Deposit paid", "In progress", "Preview sent", "Delivered", "Fully paid", "Cancelled"];
const LEAD_FIELDS = [
  ["offer", "Offer"], ["ref", "Came from"], ["name", "Name"], ["email", "Email"], ["business_name", "Business"],
  ["website_goal", "What they need"], ["budget", "Budget"], ["timeline", "Timeline"],
];
const MIN_PRICE = 300000;
// Handoffs you started yourself, not the bot asking you to quote.
const OWNER_HANDOFFS = ["You replied from the CRM", "Taken over from the CRM", "Blocked"];

// Same rules the server uses for the quality list (kept in sync with index.ts).
const BANK_WORDS = /\b(account|acct|acc no|a\/c|bank|opay|palmpay|moniepoint|kuda|gtb|access|zenith|uba|first ?bank|fidelity|wema|sterling|polaris|union|ecobank|fcmb|stanbic)\b/i;
const MONEY_REQUEST = /\b(send|give|borrow|dash)\b.{0,20}\b(money|cash|loan|data|airtime|recharge)\b|\bhelp\b.{0,20}\b(money|cash|loan)\b|\b(need|want)\b.{0,15}\b(loan|money to|some money|amount of money)\b|\bloan\b|\brecharge card\b/i;
const PRICE_OBJECTION = /\btoo (much|expensive|costly|high)\b|\bmoney (is|dey) (much|too much|plenty)\b|\bcan'?t afford\b|\bcannot afford\b|\bexpensive\b|\bout of my budget\b|\bdon'?t have (that|the|such) (money|amount)\b/i;
const NOT_A_REAL_MESSAGE = /^(\[Customer sent a (sticker|reaction|unsupported) message\]|ok(ay|ey)?|k|yes|no|yap|good|thanks?|thank you|hi|hello|👍+|🙏+|[\p{Extended_Pictographic}\s]+)[.!]*$/iu;
function looksLikeAccountNumber(text) {
  const numbers = (text.match(/\d[\d\s-]{8,14}\d/g) || []).map((n) => n.replace(/\D/g, ""));
  return numbers.some((n) => n.length === 10 || n.length === 11 || (n.length === 13 && n.startsWith("234")) || (n.length >= 9 && BANK_WORDS.test(text)));
}

// One-tap replies; they fill the box so you can edit before sending. {name} and {payment} are filled in.
const QUICK_REPLIES = [
  { label: "💼 Package & price", text: "Hi {name}! Our business website package starts from ₦300,000. It includes up to 30 products (or 5 pages), WhatsApp order buttons, a logo if you need one, domain and hosting for the first year, a mobile-friendly design and 2 rounds of changes. It's ready in 5 working days after we get your photos and prices. Shall we book your slot?" },
  { label: "💰 Budget?", text: "What budget do you have in mind for the website, {name}? Tell me and I'll put together the best option for you." },
  { label: "🏦 Deposit details", text: "Great, let's get started! 🎉 To book your slot, please pay the 50% deposit of ₦150,000 to:\n\n{payment}\n\nSend the receipt here once done, and we'll start right away." },
  { label: "⏰ Follow up", text: "Hi {name}, just checking in. Would you like us to go ahead with your website? I can hold a slot for you this week." },
  { label: "✅ Payment received", text: "Deposit received, thank you {name}! 🙌 Please send your product photos with prices, any text you'd like on the site, and your logo if you have one (if not, we'll design it for you). You'll get a preview to approve within 5 working days, and the balance is due before the site goes live." },
];

const VIEWS = [
  { key: "inbox", label: "Inbox", icon: "💬" },
  { key: "quality", label: "Quality", icon: "⭐" },
  { key: "pipeline", label: "Pipeline", icon: "📋" },
  { key: "clients", label: "Clients", icon: "💼" },
  { key: "leads", label: "Leads", icon: "👥" },
  { key: "stats", label: "Stats", icon: "📈" },
];

// ---------- storage (best effort: private windows may block it) ----------
const store = {
  get(k, fallback) { try { const v = localStorage.getItem(k); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

// ---------- state ----------
const S = {
  key: store.get("crm_key", ""),
  view: store.get("crm_view", "inbox"),
  owner: "",
  contacts: new Map(),
  leads: new Map(),
  stats: new Map(), // wa_id → { last, lastCustomerAt, flagged, askedMoney, priceObjection, realMessages }
  paymentDetails: "",
  portfolio: [],
  reminders: [],
  since: null,
  afterId: 0,
  loaded: false,
  online: true,
  open: null,
  messages: [],
  pending: [],
  mediaUrls: new Map(),
  filter: "all",
  q: "",
  leadQ: "",
  leadStatus: "all",
  seen: store.get("crm_seen", {}),
  draft: {},
  sound: store.get("crm_sound", true),
  menuOpen: false,
};

// ---------- helpers ----------
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const fmtPhone = (w) => (w ? "+" + w : "");
const naira = (n) => (n === null || n === undefined || n === "" ? "—" : "₦" + Number(n).toLocaleString("en-NG"));
function initials(name, w) {
  const n = String(name || "").replace(/[^\p{L}\p{N}\s]/gu, "").trim();
  if (!n) return (w || "?").slice(-2);
  return n.split(/\s+/).slice(0, 2).map((p) => p[0]).join("").toUpperCase();
}
function daysAgo(iso) {
  const d = new Date(iso), now = new Date();
  return Math.floor((new Date(now.toDateString()) - new Date(d.toDateString())) / 864e5);
}
function when(iso) {
  if (!iso) return "";
  const d = new Date(iso), days = daysAgo(iso);
  if (days === 0) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
}
function dayLabel(iso) {
  const days = daysAgo(iso);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return new Date(iso).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
}
function endsLabel(d) {
  const today = new Date().toDateString(), tmr = new Date(Date.now() + 864e5).toDateString();
  const t = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === today ? `${t} today` : d.toDateString() === tmr ? `${t} tomorrow` : `${t} ${d.toLocaleDateString([], { day: "numeric", month: "short" })}`;
}
function source(lead) {
  const ref = lead?.ref || "";
  if (/^AD\b/i.test(ref)) return "Ad";
  if (ref) return "Link " + ref;
  return "Direct";
}
function budgetNaira(text) {
  const m = String(text || "").toLowerCase().replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*(k|m|million|thousand)?/);
  if (!m) return null;
  return Number(m[1]) * ({ k: 1e3, thousand: 1e3, m: 1e6, million: 1e6 }[m[2]] || 1);
}
let toastTimer;
function toast(text) {
  let el = $("#toast");
  if (!el) { el = document.createElement("div"); el.id = "toast"; el.className = "toast"; document.body.appendChild(el); }
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 3500);
}

async function api(path, opts = {}) {
  const isForm = opts.body instanceof FormData;
  const res = await fetch(API + path, {
    ...opts,
    headers: { "x-crm-key": S.key, ...(opts.body && !isForm ? { "content-type": "application/json" } : {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) { logout("Wrong password, please log in again."); throw new Error("unauthorized"); }
  if (!res.ok) throw new Error(body.error || "Something went wrong (" + res.status + ")");
  return body;
}
const post = (path, data) => api(path, { method: "POST", body: JSON.stringify(data) });

// ---------- derived data ----------
function stat(id) {
  let s = S.stats.get(id);
  if (!s) { s = { last: null, lastCustomerAt: null, flagged: null, askedMoney: null, priceObjection: null, realMessages: 0 }; S.stats.set(id, s); }
  return s;
}
function contact(id) {
  const c = S.contacts.get(id);
  if (!c) return null;
  const s = stat(id);
  return { ...c, lead: S.leads.get(id) || null, ...s, isOwner: id === S.owner };
}
let allCache = null, contactsCache = null;
// Every chat ever, including ones you deleted (for totals on the Stats page).
function allContacts() {
  if (allCache) return allCache;
  allCache = [...S.contacts.keys()].map(contact)
    .sort((a, b) => new Date(b.last?.created_at || b.created_at) - new Date(a.last?.created_at || a.created_at));
  return allCache;
}
// The chats you work with: deleted ones are hidden everywhere except the Stats totals.
function contacts() {
  if (!contactsCache) contactsCache = allContacts().filter((c) => !c.deleted_at);
  return contactsCache;
}
const dirty = () => { allCache = null; contactsCache = null; };
const blocked = (c) => c.opted_out && c.handoff_reason === "Blocked";
const unread = (c) => !c.isOwner && c.lastCustomerAt && (!S.seen[c.wa_id] || new Date(c.lastCustomerAt) > new Date(S.seen[c.wa_id]));
function hasLead(c) {
  const l = c.lead;
  return !!l && !!(l.name || l.email || l.offer || l.business_name || l.website_goal || l.budget);
}
function quality(c) {
  const l = c.lead || {};
  const budget = budgetNaira(l.budget);
  const checks = [
    ["Said what they sell or do", !!(l.website_goal || l.business_name)],
    ["At least 2 real messages (not stickers or \"ok\")", c.realMessages >= 2],
    ["Not asking for money, not flagged, not blocked", !c.askedMoney && !c.flagged && !blocked(c)],
    ["Budget is ₦300,000 or more (if they gave one)", budget === null || budget >= MIN_PRICE],
    ["Didn't say the price is too much", !c.priceObjection],
  ];
  const auto = !c.isOwner && l.status !== "lost" && checks.every(([, ok]) => ok);
  const override = l.quality || null; // "yes" / "no" set by you wins over the rules
  const is = override ? override === "yes" : auto;
  const hotWhy = [
    budget !== null && budget >= MIN_PRICE && "gave a budget",
    l.timeline && "gave a timeline",
    l.email && "gave an email",
    c.handoff && !OWNER_HANDOFFS.includes(c.handoff_reason) && "waiting for a quote",
    l.status === "deposit" && "ready to pay",
    /pay online|online payment|online store|card/i.test(l.website_goal || "") && !/\bno\b[^.;]{0,25}payment/i.test(l.website_goal || "") && "wants online payments",
  ].filter(Boolean);
  return { is, auto, override, checks, hot: is && hotWhy.length > 0, hotWhy };
}
function replyWindow(c) {
  if (!c.lastCustomerAt) return { open: false, ends: null };
  const ends = new Date(new Date(c.lastCustomerAt).getTime() + 24 * 3600e3);
  return { open: ends > new Date(), ends };
}

// Applies one message to the per-contact stats (used for both the initial load and live updates).
function countMessage(m) {
  const s = stat(m.wa_id);
  if (!s.last || m.id >= (s.last.id || 0)) s.last = m;
  if (m.sender !== "customer") return;
  if (!s.lastCustomerAt || m.created_at > s.lastCustomerAt) s.lastCustomerAt = m.created_at;
  if (m.wa_id === S.owner) return;
  const body = m.body || "";
  if (looksLikeAccountNumber(body)) s.flagged ??= body.slice(0, 120);
  if (MONEY_REQUEST.test(body)) s.askedMoney ??= body.slice(0, 120);
  if (PRICE_OBJECTION.test(body)) s.priceObjection ??= body.slice(0, 120);
  if (!NOT_A_REAL_MESSAGE.test(body.trim())) s.realMessages += 1;
}

// ---------- loading & live sync ----------
function hydrate(d) {
  S.owner = d.owner;
  S.contacts = new Map((d.contacts || []).map((c) => [c.wa_id, c]));
  S.leads = new Map((d.leads || []).map((l) => [l.wa_id, l]));
  S.stats = new Map();
  for (const [id, m] of Object.entries(d.last || {})) stat(id).last = m;
  for (const [id, t] of Object.entries(d.lastCustomerAt || {})) stat(id).lastCustomerAt = t;
  for (const [id, v] of Object.entries(d.flagged || {})) stat(id).flagged = v;
  for (const [id, v] of Object.entries(d.askedMoney || {})) stat(id).askedMoney = v;
  for (const [id, v] of Object.entries(d.priceObjection || {})) stat(id).priceObjection = v;
  for (const [id, v] of Object.entries(d.realMessages || {})) stat(id).realMessages = v;
  S.paymentDetails = d.paymentDetails || "";
  S.portfolio = d.portfolio || [];
  S.reminders = d.reminders || [];
  S.afterId = Math.max(S.afterId, d.maxId || 0);
  S.since = d.now || new Date().toISOString();
  S.loaded = true;
  dirty();
}

async function loadOverview() {
  const d = await api("overview");
  S.afterId = 0;
  hydrate(d);
  store.set("crm_cache", d);
}

async function poll() {
  const d = await api(`changes?since=${encodeURIComponent(S.since)}&after_id=${S.afterId}`);
  let changed = false;
  for (const c of d.contacts || []) { S.contacts.set(c.wa_id, c); changed = true; }
  for (const l of d.leads || []) { S.leads.set(l.wa_id, l); changed = true; }
  const incoming = [];
  let needOverview = false;
  for (const m of d.messages || []) {
    if (m.id <= S.afterId) continue;
    S.afterId = m.id;
    countMessage(m);
    if (!S.contacts.has(m.wa_id)) needOverview = true;
    if (m.sender === "customer" && m.wa_id !== S.owner) incoming.push(m);
    if (S.open === m.wa_id && !S.messages.some((x) => x.id === m.id)) {
      // Swap our optimistic bubble for the real one.
      const i = S.pending.findIndex((p) => p.wa_id === m.wa_id && m.sender === "human" && (p.body === m.body || p.media));
      if (i >= 0) removeBubble(S.pending.splice(i, 1)[0].id);
      S.messages.push(m);
      appendMessages([m]);
    }
    changed = true;
  }
  for (const st of d.statuses || []) {
    const m = S.messages.find((x) => x.id === st.id);
    if (m && m.status !== st.status) { m.status = st.status; updateTicks(m); }
  }
  S.since = d.now;
  if (needOverview) await loadOverview();
  if (changed) {
    dirty();
    refreshAfterChange();
  }
  if (incoming.length) announce(incoming);
}

let pollTimer, polling = false, lastFull = Date.now();
async function loop() {
  clearTimeout(pollTimer);
  if (!S.key || polling) return;
  polling = true;
  try {
    if (Date.now() - lastFull > FULL_REFRESH_MS) { await loadOverview(); lastFull = Date.now(); dirty(); refreshAfterChange(); }
    else await poll();
    setOnline(true);
  } catch (e) {
    if (e.message === "unauthorized") { polling = false; return; }
    setOnline(false);
  }
  polling = false;
  pollTimer = setTimeout(loop, document.hidden ? POLL_HIDDEN_MS : POLL_VISIBLE_MS);
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && S.key) loop(); });
window.addEventListener("online", () => S.key && loop());

function setOnline(on) {
  if (S.online === on) return;
  S.online = on;
  $("#sync").innerHTML = on ? `<span class="sync-dot"></span>Live` : `<span class="sync-dot off"></span>Reconnecting…`;
}

// ---------- alerts: sound, title badge, toast ----------
let audioCtx;
function ding() {
  if (!S.sound) return;
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    [880, 1320].forEach((f, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = f; o.type = "sine";
      g.gain.setValueAtTime(0.0001, t + i * 0.12);
      g.gain.exponentialRampToValueAtTime(0.25, t + i * 0.12 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.12 + 0.25);
      o.connect(g).connect(audioCtx.destination);
      o.start(t + i * 0.12); o.stop(t + i * 0.12 + 0.3);
    });
  } catch {}
}
function announce(msgs) {
  const others = msgs.filter((m) => !(m.wa_id === S.open && !document.hidden));
  if (!others.length) return;
  ding();
  const m = others[others.length - 1];
  const c = contact(m.wa_id);
  toast(`💬 ${c?.lead?.name || c?.name || fmtPhone(m.wa_id)}: ${(m.body || "").slice(0, 80)}`);
}
function updateBadges() {
  const all = contacts();
  const unreadN = all.filter(unread).length;
  const need = all.filter((c) => c.handoff && !c.isOwner && !blocked(c)).length;
  const qual = all.filter((c) => quality(c).is && replyWindow(c).open).length;
  const due = S.reminders.filter((r) => !r.done && new Date(r.due_at) <= new Date()).length;
  document.title = unreadN ? `(${unreadN}) DavDags CRM` : "DavDags CRM";
  try { unreadN ? navigator.setAppBadge?.(unreadN) : navigator.clearAppBadge?.(); } catch {}
  const counts = { inbox: need, quality: qual, pipeline: due };
  for (const v of VIEWS) {
    for (const el of $$(`[data-count="${v.key}"]`)) {
      const n = counts[v.key] || 0;
      el.textContent = n;
      el.classList.toggle("hidden", !n);
    }
  }
}

// ---------- shell ----------
function renderNav() {
  $("#tabs").innerHTML = VIEWS.map((v) =>
    `<button data-view="${v.key}" class="${S.view === v.key ? "on" : ""}">${v.label}<span class="count ${v.key === "quality" ? "good" : ""} hidden" data-count="${v.key}"></span></button>`).join("");
  const bottom = [...VIEWS.slice(0, 4), { key: "more", label: "More", icon: "☰" }];
  $("#bottom-nav").innerHTML = bottom.map((v) =>
    `<button data-view="${v.key}" class="${S.view === v.key || (v.key === "more" && ["leads", "stats"].includes(S.view)) ? "on" : ""}"><b>${v.icon}</b>${v.label}<span class="count ${v.key === "quality" ? "good" : ""} hidden" data-count="${v.key}"></span></button>`).join("");
  updateBadges();
}

function setView(view) {
  if (view === "more") return openMore();
  S.view = view;
  store.set("crm_view", view);
  if (view !== "inbox") { S.open = null; document.body.classList.remove("in-chat"); }
  $("#main").innerHTML = "";
  renderNav();
  render();
}

function render() {
  if (!S.loaded) { $("#main").innerHTML = skeleton(); return; }
  ({ inbox: renderInbox, quality: renderQuality, pipeline: renderPipeline, clients: renderClients, leads: renderLeads, stats: renderStats }[S.view] || renderInbox)();
  updateBadges();
}

// Re-renders whatever is on screen after live data changed, without disturbing typing.
function refreshAfterChange() {
  updateBadges();
  const active = document.activeElement;
  const typing = active && (active.matches("input, textarea, select") || active.isContentEditable);
  if (S.view === "inbox") {
    renderList();
    if (S.open) renderChatParts({ keepComposer: true });
  } else if (!typing) {
    render();
  }
}

function skeleton() {
  return `<div class="page"><div class="page-inner">${[...Array(6)].map(() => `<div class="skeleton" style="height:58px;margin-bottom:10px"></div>`).join("")}</div></div>`;
}

// ---------- inbox ----------
const FILTERS = { all: "All", unread: "Unread", quality: "⭐ Quality", need: "Needs you", leads: "Leads", ads: "From ads", flagged: "⚠ Flagged" };
function filtered() {
  const q = S.q.trim().toLowerCase();
  return contacts().filter((c) => {
    if (S.filter === "need" && !c.handoff) return false;
    if (S.filter === "leads" && !hasLead(c)) return false;
    if (S.filter === "ads" && source(c.lead) !== "Ad") return false;
    if (S.filter === "unread" && !unread(c)) return false;
    if (S.filter === "flagged" && !c.flagged) return false;
    if (S.filter === "quality" && !quality(c).is) return false;
    if (!q) return true;
    return [c.name, c.wa_id, c.last?.body, c.lead?.name, c.lead?.business_name].some((v) => String(v || "").toLowerCase().includes(q));
  });
}

function renderInbox() {
  const main = $("#main");
  if (!main.querySelector(".inbox")) {
    main.innerHTML = `
      <div class="inbox">
        <div class="list-pane">
          <div class="list-tools">
            <input class="field" id="search" placeholder="Search name, number or message" value="${esc(S.q)}">
            <div class="chips" id="chips"></div>
          </div>
          <div class="chat-list" id="chat-list"></div>
        </div>
        <div class="chat-pane" id="chat-pane"></div>
      </div>`;
    $("#search").addEventListener("input", (e) => { S.q = e.target.value; renderList(); });
  }
  main.querySelector(".inbox").classList.toggle("chat-open", !!S.open);
  document.body.classList.toggle("in-chat", !!S.open);
  renderList();
  renderChat();
}

function renderList() {
  const listEl = $("#chat-list");
  if (!listEl) return;
  const all = contacts();
  const counts = {
    all: all.length, unread: all.filter(unread).length, quality: all.filter((c) => quality(c).is).length,
    need: all.filter((c) => c.handoff).length, leads: all.filter(hasLead).length,
    ads: all.filter((c) => source(c.lead) === "Ad").length, flagged: all.filter((c) => c.flagged).length,
  };
  $("#chips").innerHTML = Object.keys(FILTERS).map((k) =>
    `<button class="chip ${S.filter === k ? "on" : ""}" data-filter="${k}">${FILTERS[k]} ${counts[k]}</button>`).join("");
  const rows = filtered();
  const scroll = listEl.scrollTop;
  listEl.innerHTML = rows.length ? rows.map((c) => {
    const q = quality(c);
    const who = c.last?.sender === "ai" ? "🤖 " : c.last?.sender === "human" ? "You: " : "";
    const tags = [
      c.isOwner ? `<span class="tag you">You</span>` : "",
      q.hot ? `<span class="tag hot">🔥 Hot</span>` : q.is ? `<span class="tag star">⭐</span>` : "",
      c.lead?.status === "deposit" ? `<span class="tag pay">💰 Pay</span>` : "",
      c.handoff && !blocked(c) ? `<span class="tag need">Needs you</span>` : "",
      c.flagged ? `<span class="tag need">⚠</span>` : "",
      blocked(c) ? `<span class="tag you">Blocked</span>` : "",
      source(c.lead) === "Ad" ? `<span class="tag ad">Ad</span>` : "",
    ].join("");
    const isUnread = unread(c) && S.open !== c.wa_id;
    return `<div class="row ${S.open === c.wa_id ? "on" : ""}" data-open="${esc(c.wa_id)}">
      <div class="avatar ${q.hot ? "hot" : ""}">${esc(initials(c.lead?.name || c.name, c.wa_id))}</div>
      <div class="row-main">
        <div class="row-name">${esc(c.lead?.name || c.name || fmtPhone(c.wa_id))}</div>
        <div class="row-last">${tags}${esc(who + previewText(c.last))}</div>
      </div>
      <div class="row-side"><span>${esc(when(c.last?.created_at || c.created_at))}</span>${isUnread ? `<span class="badge">●</span>` : ""}</div>
    </div>`;
  }).join("") : `<div class="empty">${all.length ? "No chats match." : "No chats yet. They'll appear here as soon as someone messages your WhatsApp number."}</div>`;
  listEl.scrollTop = scroll;
}

// Turns stored placeholders into something readable.
function previewText(m) {
  if (!m) return "";
  return displayText(m).replace(/\s+/g, " ").slice(0, 90) || (m.msg_type ? `[${m.msg_type}]` : "");
}
function displayText(m) {
  const body = m.body || "";
  let x = body.match(/^\[Customer sent a (image|video|document|sticker)(?: with caption: ([\s\S]*))?\]$/);
  if (x) return x[2] || (x[1] === "image" ? "📷 Photo" : x[1] === "video" ? "🎥 Video" : x[1] === "document" ? "📄 File" : "Sticker");
  x = body.match(/^\[Voice note\] ([\s\S]*)/);
  if (x) return "🎤 " + x[1];
  x = body.match(/^\[Template: reopen_chat\] (.*)$/);
  if (x) return `📨 "Still interested?" message: Hi ${x[1]}, thanks for your interest in a website from DavDags. Are you still looking to get one?`;
  x = body.match(/^\[Re-open message\] ([\s\S]*)$/);
  if (x) return `📨 "Still interested?" message: ${x[1]}`;
  x = body.match(/^\[Template: owner_alert\] (.*)$/);
  if (x) return `🔔 Alert to you: ${x[1]}`;
  x = body.match(/^\[Sent portfolio image: (.*) - (\S+)\]$/);
  if (x) return `${x[1]}\n${x[2]}`;
  if (/^\[(Image|Video|Audio|Document)\]$/.test(body)) return "";
  return body;
}

// ---------- chat ----------
async function openChat(id) {
  if (S.view !== "inbox") { S.view = "inbox"; store.set("crm_view", "inbox"); $("#main").innerHTML = ""; renderNav(); }
  S.open = id;
  S.messages = [];
  S.pending = [];
  S.menuOpen = false;
  history.replaceState(null, "", "?chat=" + id);
  render();
  try {
    const msgs = await api("messages?wa_id=" + encodeURIComponent(id));
    if (S.open !== id) return;
    S.messages = msgs;
    markSeen(id);
    renderChat();
  } catch (e) { if (e.message !== "unauthorized") toast(e.message); }
}
function closeChat() {
  S.open = null;
  history.replaceState(null, "", location.pathname);
  render();
}
function markSeen(id) {
  S.seen[id] = new Date().toISOString();
  store.set("crm_seen", S.seen);
  updateBadges();
}

function renderChat() {
  const pane = $("#chat-pane");
  if (!pane) return;
  const c = S.open && contact(S.open);
  if (!c) {
    pane.dataset.for = "";
    pane.innerHTML = `<div class="pick">Pick a chat on the left to read it and reply.</div>`;
    return;
  }
  pane.dataset.for = c.wa_id;
  pane.innerHTML = `
    <div class="chat-head" id="chat-head"></div>
    <div id="chat-banners"></div>
    <div class="messages" id="messages"></div>
    <div class="composer" id="composer"></div>`;
  renderChatParts({});
  const box = $("#messages");
  box.innerHTML = S.messages.length ? "" : `<div class="pick">Loading…</div>`;
  if (S.messages.length) appendMessages([...S.messages, ...S.pending], true);
}

// Header, banners and composer; the message list is appended to separately so media keeps playing.
function renderChatParts({ keepComposer }) {
  const c = S.open && contact(S.open);
  if (!c || $("#chat-pane")?.dataset.for !== c.wa_id) return;
  const l = c.lead || {};
  const w = replyWindow(c);

  $("#chat-head").innerHTML = `
    <button class="icon-btn back" data-action="back" aria-label="Back">←</button>
    <div class="avatar ${quality(c).hot ? "hot" : ""}" style="width:38px;height:38px">${esc(initials(l.name || c.name, c.wa_id))}</div>
    <div class="who">
      <div class="chat-title">${esc(l.name || c.name || fmtPhone(c.wa_id))}</div>
      <div class="chat-sub">${esc(fmtPhone(c.wa_id))}${w.open ? ` · reply by ${esc(endsLabel(w.ends))}` : " · 24h window closed"}</div>
    </div>
    ${blocked(c) ? `<span class="mode-label human">Blocked</span>` : c.handoff ? `<span class="mode-label human">You're handling</span>` : `<span class="mode-label bot">🤖 Bot replying</span>`}
    ${c.handoff && !blocked(c) ? `<button class="btn small primary" data-action="handback">Hand back</button>` : !blocked(c) && !c.isOwner ? `<button class="btn small" data-action="takeover">Take over</button>` : ""}
    <div class="menu">
      <button class="icon-btn" data-action="menu" aria-label="More">⋯</button>
      ${S.menuOpen ? `<div class="menu-list">
        <button data-action="remind">⏰ Set a reminder</button>
        ${l.project_status ? "" : `<button data-action="make-client">💼 Make client</button>`}
        <button data-action="portfolio">🖼 Send portfolio example</button>
        <a href="https://wa.me/${esc(c.wa_id)}" target="_blank" rel="noopener" style="text-decoration:none;color:inherit"><button>↗ Open in WhatsApp</button></a>
        ${blocked(c) ? `<button data-action="unblock">Unblock</button>` : c.isOwner ? "" : `<button data-action="block" class="danger">🚫 Block</button>`}
        <button data-action="delete-chat" class="danger">🗑 Delete chat</button>
      </div>` : ""}
    </div>`;

  // Banners hold the lead form; don't rebuild while you're typing in it.
  const banners = $("#chat-banners");
  if (!banners.contains(document.activeElement)) {
    const leadOpen = banners.querySelector("details")?.open ?? false;
    const due = S.reminders.filter((r) => r.wa_id === c.wa_id && !r.done);
    banners.innerHTML = `
      ${c.isOwner ? "" : qualityLine(c)}
      ${c.flagged ? `<div class="banner danger"><span class="tag need">⚠ Flagged</span> Sent what looks like a bank account or phone number: “${esc(c.flagged)}”. Often someone expecting money.</div>` : ""}
      ${c.handoff && c.handoff_reason && !OWNER_HANDOFFS.includes(c.handoff_reason) ? `<div class="banner"><span class="tag need">Why</span> ${esc(c.handoff_reason)}</div>` : ""}
      ${due.map((r) => `<div class="banner"><span class="tag you">⏰ ${esc(endsLabel(new Date(r.due_at)))}</span> ${esc(r.note || "Follow up")} <button class="btn small" style="margin-left:auto" data-reminder-done="${r.id}">Done</button></div>`).join("")}
      <details class="lead-card" ${leadOpen ? "open" : ""}>
        <summary>Lead details <span class="status ${esc(l.status || "new")}">${esc(STATUS[l.status] || "New")}</span> <span class="chat-sub">· ${esc(source(c.lead))}${l.project_status ? " · 💼 " + esc(l.project_status) : ""}</span></summary>
        <div class="lead-grid">
          ${LEAD_FIELDS.filter(([k]) => l[k]).map(([k, label]) => `<div><span>${label}</span>${esc(k === "ref" ? source(l) : l[k])}</div>`).join("") || `<div class="chat-sub">The bot hasn't saved any details yet.</div>`}
        </div>
        <div class="lead-edit">
          <textarea class="field" id="lead-notes" placeholder="Notes">${esc(l.notes ?? "")}</textarea>
          <div class="lead-actions">
            <select class="field" id="lead-status" style="width:auto">
              ${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${(l.status || "new") === k ? "selected" : ""}>${v}</option>`).join("")}
            </select>
            <button class="btn small primary" data-action="lead-save">Save</button>
            <span class="chat-sub" id="lead-msg"></span>
          </div>
        </div>
      </details>`;
  }

  // Composer: only rebuilt when the window opens/closes, so drafts and focus survive live updates.
  const composer = $("#composer");
  const mode = w.open ? "open" : "closed";
  if (keepComposer && composer.dataset.mode === mode) return;
  composer.dataset.mode = mode;
  const draft = S.draft[c.wa_id] ?? "";
  composer.innerHTML = w.open ? `
      <div class="quick">${QUICK_REPLIES.map((q, i) => `<button data-quick="${i}">${esc(q.label)}</button>`).join("")}</div>
      <div class="composer-row">
        <button class="icon-btn" data-action="attach" title="Send a photo or file">📎</button>
        <input type="file" id="file" class="hidden" accept="image/*,video/*,audio/*,application/pdf">
        <textarea class="field" id="reply" rows="1" placeholder="Type a reply…">${esc(draft)}</textarea>
        <button class="send-btn" data-action="send" aria-label="Send">➤</button>
      </div>
      <div class="error" id="send-error"></div>`
    : `<div class="notice">⏳ More than 24 hours since they last wrote, so WhatsApp only allows an approved message.
        <button class="btn small primary" data-action="reopen">Send “still interested?” message</button></div>
      <div class="chat-sub">Costs a few naira. When they reply, the chat opens again for 24 hours.</div>`;
  const reply = $("#reply");
  if (reply) {
    autosize(reply);
    reply.addEventListener("input", () => { S.draft[c.wa_id] = reply.value; autosize(reply); });
    reply.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !matchMedia("(max-width: 820px)").matches) { e.preventDefault(); send(); }
    });
    $("#file").addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) sendFile(f); });
  }
}
function autosize(t) { t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 160) + "px"; }

function ticks(m) {
  if (m.sender === "customer" || m.sender === "system") return "";
  const s = m.pending ? "sending" : m.status;
  if (s === "sending") return `<span class="ticks">🕓</span>`;
  if (s === "failed") return `<span class="ticks failed">⚠ not delivered</span>`;
  if (s === "read") return `<span class="ticks read">✓✓</span>`;
  if (s === "delivered") return `<span class="ticks">✓✓</span>`;
  if (s === "sent") return `<span class="ticks">✓</span>`;
  return "";
}
function bubble(m) {
  const who = { customer: "", ai: "🤖 Bot", human: "You", system: "Auto" }[m.sender] ?? "";
  const text = displayText(m);
  const media = m.media_path || m.media ? `<div class="media" data-media="${esc(m.id)}"></div>` : "";
  return `<div class="msg ${esc(m.sender)} ${m.pending ? "pending" : ""}" data-msg="${esc(m.id)}">${media}${esc(text || (media ? "" : "[" + (m.msg_type || "message") + "]"))}<div class="msg-meta">${who ? esc(who) + " · " : ""}${new Date(m.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} <span data-ticks>${ticks(m)}</span></div></div>`;
}
function appendMessages(list, reset) {
  const box = $("#messages");
  if (!box) return;
  const nearBottom = reset || box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  if (reset) box.innerHTML = "";
  box.querySelector(".pick")?.remove();
  let lastDay = box.dataset.lastDay || "";
  if (reset) lastDay = "";
  let html = "";
  for (const m of list) {
    if (box.querySelector(`[data-msg="${CSS.escape(String(m.id))}"]`)) continue;
    const day = new Date(m.created_at).toDateString();
    if (day !== lastDay) { html += `<div class="day">${esc(dayLabel(m.created_at))}</div>`; lastDay = day; }
    html += bubble(m);
  }
  box.dataset.lastDay = lastDay;
  box.insertAdjacentHTML("beforeend", html);
  hydrateMedia(box);
  if (nearBottom) box.scrollTop = box.scrollHeight;
}
function updateTicks(m) {
  const el = $(`[data-msg="${CSS.escape(String(m.id))}"] [data-ticks]`);
  if (el) el.innerHTML = ticks(m);
}
function removeBubble(id) { $(`[data-msg="${CSS.escape(String(id))}"]`)?.remove(); }

// Loads pictures, voice notes and files into their bubbles.
async function hydrateMedia(root) {
  for (const el of $$(".media[data-media]:not([data-loaded])", root)) {
    el.dataset.loaded = "1";
    const id = el.dataset.media;
    const m = S.messages.find((x) => String(x.id) === id) || S.pending.find((x) => String(x.id) === id);
    try {
      let info;
      if (m?.media?.localUrl) info = { url: m.media.localUrl, type: m.media.type };
      else {
        const cached = S.mediaUrls.get(id);
        info = cached && cached.exp > Date.now() ? cached : { ...(await api("media?id=" + encodeURIComponent(id))), exp: Date.now() + 50 * 60e3 };
        S.mediaUrls.set(id, info);
      }
      const t = info.type || "";
      el.innerHTML = t.startsWith("image") ? `<img src="${esc(info.url)}" alt="" loading="lazy" data-zoom="${esc(info.url)}">`
        : t.startsWith("audio") ? `<audio controls preload="metadata" src="${esc(info.url)}"></audio>`
        : t.startsWith("video") ? `<video controls preload="metadata" src="${esc(info.url)}"></video>`
        : `<a class="file" href="${esc(info.url)}" target="_blank" rel="noopener">📄 Open file</a>`;
    } catch {
      el.innerHTML = `<span class="file chat-sub">File not available</span>`;
    }
  }
}

function qualityLine(c) {
  const q = quality(c);
  const who = q.override ? " (marked by you)" : "";
  const label = q.is
    ? `<span class="tag ${q.hot ? "hot" : "star"}">${q.hot ? "🔥 Hot lead" : "⭐ Quality lead"}</span>${esc(who)}${q.hot ? ` <span class="chat-sub">${esc(q.hotWhy.join(", "))}</span>` : ""}`
    : `<span class="chat-sub">Not a quality lead${esc(who)}${q.override ? "" : ": " + esc(q.checks.filter(([, ok]) => !ok).map(([t]) => t.toLowerCase()).join("; "))}</span>`;
  const buttons = [
    q.is ? "" : `<button class="btn small" data-quality="yes">⭐ Mark quality</button>`,
    q.is ? `<button class="btn small" data-quality="no">✕ Not quality</button>` : "",
    q.override ? `<button class="btn small" data-quality="auto">Use the rules</button>` : "",
  ].join("");
  return `<div class="qline">${label}<span style="margin-left:auto;display:flex;gap:6px">${buttons}</span></div>`;
}

// ---------- chat actions ----------
let pendingSeq = 0;
async function send() {
  const id = S.open, box = $("#reply");
  const text = box?.value.trim();
  if (!text) return;
  const p = { id: "p" + ++pendingSeq, wa_id: id, sender: "human", body: text, created_at: new Date().toISOString(), pending: true };
  S.pending.push(p);
  appendMessages([p]);
  box.value = ""; S.draft[id] = ""; autosize(box); box.focus();
  $("#send-error").textContent = "";
  try {
    await post("reply", { wa_id: id, text });
    setTimeout(loop, 400); // pick up the stored message and ticks quickly
  } catch (e) {
    S.pending = S.pending.filter((x) => x !== p);
    removeBubble(p.id);
    if (e.message !== "unauthorized") { $("#send-error").textContent = e.message; box.value = text; S.draft[id] = text; }
  }
}

async function sendFile(file) {
  const id = S.open;
  const caption = $("#reply")?.value.trim() || "";
  const localUrl = URL.createObjectURL(file);
  const p = { id: "p" + ++pendingSeq, wa_id: id, sender: "human", body: caption, created_at: new Date().toISOString(), pending: true, media: { localUrl, type: file.type } };
  S.pending.push(p);
  appendMessages([p]);
  if (caption) { $("#reply").value = ""; S.draft[id] = ""; }
  const form = new FormData();
  form.append("wa_id", id);
  form.append("file", file);
  form.append("caption", caption);
  try {
    await api("send-media", { method: "POST", body: form });
    setTimeout(loop, 400);
  } catch (e) {
    S.pending = S.pending.filter((x) => x !== p);
    removeBubble(p.id);
    if (e.message !== "unauthorized") toast(e.message);
  }
}

function fillQuick(i) {
  const c = contact(S.open);
  const first = String(c?.lead?.name || c?.name || "").trim().split(/\s+/)[0] || "";
  const text = QUICK_REPLIES[i].text
    .replace(/ \{name\}/g, first ? " " + first : "")
    .replace(/\{name\}/g, first)
    .replace(/\{payment\}/g, S.paymentDetails || "[ADD YOUR BANK DETAILS]");
  const box = $("#reply");
  box.value = text;
  S.draft[S.open] = text;
  autosize(box);
  box.focus();
}

async function act(fn, okText) {
  try {
    await fn();
    if (okText) toast(okText);
    await poll().catch(() => {});
    dirty();
    refreshAfterChange();
  } catch (e) { if (e.message !== "unauthorized") toast(e.message); }
}
const setHandoff = (on) => act(() => post("handoff", { wa_id: S.open, handoff: on }), on ? "You're handling this chat" : "Bot is replying again");
const setQuality = (v) => act(() => post("lead", { wa_id: S.open, quality: v === "auto" ? null : v }));
async function setBlocked(block) {
  const c = contact(S.open);
  if (block && !confirm(`Block ${c?.lead?.name || c?.name || fmtPhone(S.open)}? They won't be able to message your WhatsApp number any more.`)) return;
  act(() => post("block", { wa_id: S.open, unblock: !block }), block ? "Blocked" : "Unblocked");
}
async function deleteChat() {
  const id = S.open, c = contact(id);
  if (!confirm(`Delete the chat with ${c?.lead?.name || c?.name || fmtPhone(id)}? It disappears from your lists but still counts in your Stats totals. If they message again it comes back. (It doesn't block them.)`)) return;
  try {
    await post("delete", { wa_id: id });
    S.contacts.set(id, { ...S.contacts.get(id), deleted_at: new Date().toISOString(), handoff: false }); dirty();
    closeChat();
    toast("Chat deleted");
  } catch (e) { if (e.message !== "unauthorized") toast(e.message); }
}
const makeClient = () => act(() => post("lead", { wa_id: S.open, project_status: "Deposit pending", status: "deposit", agreed_price: S.leads.get(S.open)?.agreed_price ?? MIN_PRICE }), "Added to Clients");
async function saveLead() {
  $("#lead-msg").textContent = "Saving…";
  await act(() => post("lead", { wa_id: S.open, status: $("#lead-status").value, notes: $("#lead-notes").value }), "Saved");
}
async function reopenChat() {
  if (!confirm("Send the approved “Are you still interested?” message? WhatsApp charges a few naira for it.")) return;
  act(() => post("reopen", { wa_id: S.open }), "Message sent. If they reply, the chat opens again.");
}

// ---------- sheets (bottom panels) ----------
function sheet(html) {
  $("#overlay").innerHTML = `<div class="sheet" data-action="close-sheet"><div class="sheet-card">${html}</div></div>`;
}
const closeSheet = () => { $("#overlay").innerHTML = ""; };

function openPortfolio() {
  S.menuOpen = false;
  renderChatParts({ keepComposer: true });
  sheet(`<h3>Send a portfolio example</h3>
    <div class="portfolio-grid">${S.portfolio.map((p) => `<button data-send-portfolio="${esc(p.key)}"><img src="${esc(p.image)}" alt="" loading="lazy"><span>${esc(p.name)}</span></button>`).join("")}</div>
    <div style="margin-top:12px;text-align:right"><button class="btn" data-action="close-sheet">Cancel</button></div>`);
}
async function sendPortfolio(key) {
  closeSheet();
  const item = S.portfolio.find((p) => p.key === key);
  const p = { id: "p" + ++pendingSeq, wa_id: S.open, sender: "human", body: `[Sent portfolio image: ${item.name} - ${item.url}]`, created_at: new Date().toISOString(), pending: true, media: { localUrl: item.image, type: "image" } };
  S.pending.push(p);
  appendMessages([p]);
  try { await post("send-portfolio", { wa_id: S.open, key }); setTimeout(loop, 400); }
  catch (e) { S.pending = S.pending.filter((x) => x !== p); removeBubble(p.id); if (e.message !== "unauthorized") toast(e.message); }
}

function openReminder() {
  S.menuOpen = false;
  renderChatParts({ keepComposer: true });
  const c = contact(S.open);
  const at = (d) => { const x = new Date(d); x.setSeconds(0, 0); return x; };
  const tomorrow10 = at(new Date(Date.now() + 864e5)); tomorrow10.setHours(10, 0);
  const inHours = (h) => at(Date.now() + h * 3600e3);
  const nextMon = at(new Date()); nextMon.setDate(nextMon.getDate() + ((8 - nextMon.getDay()) % 7 || 7)); nextMon.setHours(10, 0);
  const local = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
  sheet(`<h3>⏰ Remind me about ${esc(c?.lead?.name || c?.name || fmtPhone(S.open))}</h3>
    <div class="chips" style="margin-bottom:10px">
      ${[["In 3 hours", inHours(3)], ["Tomorrow 10am", tomorrow10], ["Monday 10am", nextMon]].map(([t, d]) => `<button class="chip" data-preset="${local(d)}">${t}</button>`).join("")}
    </div>
    <input class="field" type="datetime-local" id="rem-at" value="${local(tomorrow10)}">
    <div style="height:8px"></div>
    <input class="field" id="rem-note" placeholder="What to do, e.g. Send the quote" value="Follow up">
    <div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end">
      <button class="btn" data-action="close-sheet">Cancel</button>
      <button class="btn primary" data-action="save-reminder">Save reminder</button>
    </div>`);
}
async function saveReminder() {
  const due = $("#rem-at").value, note = $("#rem-note").value;
  try {
    await post("reminder", { wa_id: S.open, due_at: new Date(due).toISOString(), note });
    closeSheet();
    toast("Reminder set. You'll get a notification.");
    await loadOverview(); dirty(); refreshAfterChange();
  } catch (e) { if (e.message !== "unauthorized") toast(e.message); }
}
async function reminderDone(id) {
  try {
    await post("reminder-done", { id });
    S.reminders = S.reminders.filter((r) => r.id !== Number(id));
    refreshAfterChange();
    if (S.view === "pipeline") render();
  } catch (e) { if (e.message !== "unauthorized") toast(e.message); }
}

function openMore() {
  sheet(`<h3>More</h3>
    <div style="display:grid;gap:8px">
      <button class="btn" data-view="leads">👥 Leads</button>
      <button class="btn" data-view="stats">📈 Stats</button>
      <button class="btn" data-action="settings">⚙️ Notifications & settings</button>
    </div>`);
}

async function openSettings() {
  const pushOn = store.get("crm_push", false) && "Notification" in window && Notification.permission === "granted";
  const ios = /iphone|ipad/i.test(navigator.userAgent);
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  sheet(`<h3>Notifications & settings</h3>
    <div style="display:grid;gap:12px">
      <div class="card" style="box-shadow:none">
        <strong>🔔 Phone notifications</strong>
        <div class="chat-sub" style="margin:4px 0 10px">Alerts for new leads, people who need you, payments and reminders, even when the CRM is closed.</div>
        ${ios && !standalone ? `<div class="notice">On iPhone: tap Share → <b>Add to Home Screen</b>, open the CRM from the new icon, then come back here.</div>` : ""}
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn primary" data-action="enable-push">${pushOn ? "✓ On (turn on again)" : "Turn on notifications"}</button>
          <button class="btn" data-action="test-push">Send a test</button>
        </div>
      </div>
      <div class="card" style="box-shadow:none">
        <strong>📲 Install as an app</strong>
        <div class="chat-sub" style="margin-top:4px">${standalone ? "Installed ✓" : ios ? "Share → Add to Home Screen." : "Chrome menu ⋮ → Install app / Add to Home screen."}</div>
      </div>
      <label class="card" style="box-shadow:none;display:flex;gap:10px;align-items:center">
        <input type="checkbox" id="sound-toggle" ${S.sound ? "checked" : ""}> <span><strong>🔊 Sound</strong> for new messages while the CRM is open</span>
      </label>
      <button class="btn danger" data-action="logout">Log out</button>
    </div>`);
  $("#sound-toggle").addEventListener("change", (e) => { S.sound = e.target.checked; store.set("crm_sound", S.sound); if (S.sound) ding(); });
}

function b64ToBytes(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
async function enablePush() {
  try {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      return toast("This browser can't do notifications. On iPhone, add the CRM to your Home Screen first.");
    }
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return toast("Notifications are blocked. Allow them in your browser settings.");
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(VAPID_PUBLIC_KEY) });
    const res = await post("push-subscribe", sub.toJSON());
    store.set("crm_push", true);
    toast(res.enabled ? "Notifications are on ✓" : "Saved. Alerts start once the server key is added.");
    openSettings();
  } catch (e) { if (e.message !== "unauthorized") toast("Couldn't turn on notifications: " + e.message); }
}
async function testPush() {
  try { await post("push-test", {}); toast("Test sent. Check your notifications."); }
  catch (e) { if (e.message !== "unauthorized") toast(e.message); }
}

// ---------- quality ----------
function renderQuality() {
  const list = contacts().filter((c) => quality(c).is).map((c) => ({ c, q: quality(c), w: replyWindow(c) }));
  const open = list.filter((x) => x.w.open).sort((a, b) => a.w.ends - b.w.ends);
  const closed = list.filter((x) => !x.w.open).sort((a, b) => new Date(b.c.lastCustomerAt || 0) - new Date(a.c.lastCustomerAt || 0));
  const card = ({ c, q, w }) => {
    const l = c.lead || {};
    const hoursLeft = w.open ? (w.ends - Date.now()) / 3600e3 : 0;
    const whenTxt = w.open
      ? `<span class="when ${hoursLeft < 4 ? "urgent" : ""}">Reply before ${esc(endsLabel(w.ends))}</span>`
      : `<span class="when closed">Window closed</span>`;
    const details = [l.website_goal, l.business_name && "Business: " + l.business_name, l.budget && "Budget: " + l.budget, l.timeline && "When: " + l.timeline, l.email]
      .filter(Boolean).map(esc).join(" · ");
    return `<div class="qcard" data-open="${esc(c.wa_id)}">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <strong>${esc(l.name || c.name || fmtPhone(c.wa_id))}</strong>
        ${q.hot ? `<span class="tag hot">🔥 Hot</span>` : `<span class="tag star">⭐ Quality</span>`}
        ${c.handoff && !blocked(c) ? `<span class="tag need">Needs you</span>` : ""}
        <span class="status ${esc(l.status || "new")}">${esc(STATUS[l.status] || "New")}</span>
        <span style="margin-left:auto">${whenTxt}</span>
      </div>
      <div style="margin-top:6px">${details || `<span class="chat-sub">No details saved yet</span>`}</div>
      ${q.hot ? `<div class="chat-sub" style="margin-top:4px">🔥 ${esc(q.hotWhy.join(", "))}</div>` : ""}
      <div class="chat-sub" style="margin-top:4px">Last: ${esc((c.last?.sender === "customer" ? "" : c.last?.sender === "ai" ? "Bot: " : "You: ") + previewText(c.last))}</div>
    </div>`;
  };
  $("#main").innerHTML = `
    <div class="page"><div class="page-inner">
      <details class="criteria">
        <summary><strong>Who gets on this list</strong> <span class="chat-sub">(tap to see the 5 rules)</span></summary>
        <ol>
          <li>They said what they sell or do</li>
          <li>They sent at least 2 real messages (stickers, "ok" and "hi" don't count)</li>
          <li>They aren't asking for money, aren't flagged and aren't blocked</li>
          <li>If they gave a budget, it's ₦300,000 or more</li>
          <li>They didn't say the price is too much</li>
        </ol>
        <div class="chat-sub" style="margin-top:6px">🔥 Hot = also gave a budget, timeline or email, wants online payments, is ready to pay, or waiting for a quote. Open any chat to ⭐ add or ✕ remove someone by hand.</div>
      </details>
      <div class="qsection">Reply now (${open.length}), soonest deadline first</div>
      ${open.map(card).join("") || `<div class="empty" style="padding:16px">Nobody waiting right now.</div>`}
      <div class="qsection">Window closed (${closed.length})</div>
      ${closed.map(card).join("") || `<div class="empty" style="padding:16px">None.</div>`}
    </div></div>`;
}

// ---------- pipeline (board + reminders) ----------
const DONE_PROJECT = ["Delivered", "Fully paid"];
const PIPE = [
  { key: "new", title: "New leads", match: (c) => (!c.lead?.status || c.lead.status === "new") && (quality(c).is || hasLead(c)) && !blocked(c) && !c.isOwner },
  { key: "qualified", title: "Quoted", match: (c) => c.lead?.status === "qualified" },
  { key: "deposit", title: "💰 Deposit pending", match: (c) => c.lead?.status === "deposit" },
  { key: "won", title: "Paid · building", match: (c) => c.lead?.status === "won" && !DONE_PROJECT.includes(c.lead?.project_status) },
  { key: "done", title: "✅ Delivered", match: (c) => c.lead?.status === "won" && DONE_PROJECT.includes(c.lead?.project_status) },
];
const MOVE_LABELS = { new: "New lead", qualified: "Quoted", deposit: "Deposit pending", won: "Paid · building", done: "Delivered", lost: "Lost" };

function renderPipeline() {
  const all = contacts();
  const cols = PIPE.map((p) => ({ ...p, items: all.filter(p.match) }));
  const rems = [...S.reminders].filter((r) => !r.done).sort((a, b) => new Date(a.due_at) - new Date(b.due_at));
  $("#main").innerHTML = `
    <div class="page"><div class="pipe">
      <div style="min-width:0">
        <div class="page-tools"><span class="chat-sub">Drag cards between columns (or use "Move to" on a phone). Tap a name to open the chat.</span></div>
        <div class="board">${cols.map((col) => `
          <div class="col" data-col="${col.key}">
            <h4>${esc(col.title)} <small>${col.items.length}${col.key !== "new" ? " · " + naira(col.items.reduce((t, c) => t + (c.lead?.agreed_price || 0), 0)) : ""}</small></h4>
            ${col.items.map((c) => pipeCard(c, col.key)).join("") || `<div class="chat-sub" style="padding:8px">Empty</div>`}
          </div>`).join("")}
        </div>
      </div>
      <div class="reminders">
        <div class="qsection" style="margin-top:0">⏰ Reminders</div>
        ${rems.map((r) => {
          const c = contact(r.wa_id);
          const overdue = new Date(r.due_at) <= new Date();
          return `<div class="rem ${overdue ? "overdue" : ""}">
            <div class="due">${overdue ? "Due " : ""}${esc(endsLabel(new Date(r.due_at)))}</div>
            <div><strong class="clickable" data-open="${esc(r.wa_id)}" style="cursor:pointer">${esc(c?.lead?.name || c?.name || fmtPhone(r.wa_id))}</strong>: ${esc(r.note || "Follow up")}</div>
            <div style="margin-top:6px;display:flex;gap:6px"><button class="btn small" data-open="${esc(r.wa_id)}">Open chat</button><button class="btn small" data-reminder-done="${r.id}">Done ✓</button></div>
          </div>`;
        }).join("") || `<div class="chat-sub">No reminders. Open a chat → ⋯ → ⏰ Set a reminder.</div>`}
      </div>
    </div></div>`;
}
function pipeCard(c, col) {
  const l = c.lead || {};
  return `<div class="pcard" draggable="true" data-card="${esc(c.wa_id)}">
    <div class="t clickable" data-open="${esc(c.wa_id)}">${esc(l.name || c.name || fmtPhone(c.wa_id))} ${quality(c).hot ? `<span class="tag hot">🔥</span>` : ""}</div>
    <div class="chat-sub">${esc(l.business_name || l.website_goal || l.offer || "")}</div>
    ${l.agreed_price ? `<div class="chat-sub">${naira(l.agreed_price)}${l.amount_paid ? " · paid " + naira(l.amount_paid) : ""}</div>` : ""}
    <select class="field" data-move="${esc(c.wa_id)}">
      <option value="">Move to…</option>
      ${Object.entries(MOVE_LABELS).filter(([k]) => k !== col).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}
    </select>
  </div>`;
}
async function moveCard(id, to) {
  const l = S.leads.get(id) || {};
  const ps = l.project_status;
  const price = l.agreed_price ?? MIN_PRICE;
  const payload = {
    new: { status: "new" },
    qualified: { status: "qualified" },
    deposit: { status: "deposit", project_status: "Deposit pending", agreed_price: price },
    won: { status: "won", project_status: ps && !["Deposit pending", "Cancelled", ...DONE_PROJECT].includes(ps) ? ps : "Deposit paid", agreed_price: price },
    done: { status: "won", project_status: "Delivered", agreed_price: price },
    lost: { status: "lost", ...(ps ? { project_status: "Cancelled" } : {}) },
  }[to];
  if (!payload) return;
  try {
    await post("lead", { wa_id: id, ...payload });
    S.leads.set(id, { ...l, ...payload, wa_id: id, updated_at: new Date().toISOString() });
    dirty();
    render();
    toast(`Moved to ${MOVE_LABELS[to]}`);
  } catch (e) { if (e.message !== "unauthorized") toast(e.message); }
}

// ---------- clients ----------
const leadStatusFor = (ps) => (ps === "Cancelled" ? "lost" : ps === "Deposit pending" ? "deposit" : "won");
function clients() {
  return contacts().filter((c) => !c.isOwner && c.lead?.project_status)
    .sort((a, b) => new Date(b.lead.updated_at) - new Date(a.lead.updated_at));
}
function renderClients() {
  const list = clients();
  const active = list.filter((c) => c.lead.project_status !== "Cancelled");
  const agreed = active.reduce((t, c) => t + (c.lead.agreed_price || 0), 0);
  const received = active.reduce((t, c) => t + (c.lead.amount_paid || 0), 0);
  $("#main").innerHTML = `
    <div class="page"><div class="page-inner">
      <div class="cards">
        <div class="card"><div class="num">${active.length}</div><div class="lbl">Clients</div></div>
        <div class="card"><div class="num">${active.filter((c) => c.lead.project_status === "Deposit pending").length}</div><div class="lbl">Deposit pending</div></div>
        <div class="card"><div class="num">${naira(agreed)}</div><div class="lbl">Total agreed</div></div>
        <div class="card"><div class="num">${naira(received)}</div><div class="lbl">Received</div></div>
        <div class="card"><div class="num">${naira(Math.max(0, agreed - received))}</div><div class="lbl">Still to collect</div></div>
      </div>
      <div class="page-tools">
        <span class="chat-sub">Clients appear when the bot books them, when you tap 💼 Make client, or when you move them on the Pipeline. Changes also update your Google Sheet.</span>
        <button class="btn small" data-action="export-clients" style="margin-left:auto">Download Excel (CSV)</button>
      </div>
      ${list.length ? `<table>
        <thead><tr><th>Client</th><th>Agreed price</th><th>Paid so far</th><th>Balance</th><th>Status</th><th class="hide-sm">Delivery date</th><th></th></tr></thead>
        <tbody>${list.map((c) => {
          const l = c.lead;
          const bal = l.agreed_price ? Math.max(0, l.agreed_price - (l.amount_paid || 0)) : null;
          return `<tr data-client="${esc(c.wa_id)}">
            <td><strong class="clickable" data-open="${esc(c.wa_id)}" style="cursor:pointer">${esc(l.name || c.name || fmtPhone(c.wa_id))}</strong>
              <div class="chat-sub">${esc(fmtPhone(c.wa_id))}${l.business_name ? " · " + esc(l.business_name) : ""}</div></td>
            <td><input class="field" style="width:120px" inputmode="numeric" data-f="agreed_price" value="${esc(l.agreed_price ?? "")}" placeholder="300000"></td>
            <td><input class="field" style="width:120px" inputmode="numeric" data-f="amount_paid" value="${esc(l.amount_paid ?? 0)}"></td>
            <td><strong>${naira(bal)}</strong></td>
            <td><select class="field" data-f="project_status">${PROJECT_STATUSES.map((p) => `<option ${p === l.project_status ? "selected" : ""}>${p}</option>`).join("")}</select></td>
            <td class="hide-sm"><input class="field" type="date" data-f="delivery_date" value="${esc(l.delivery_date ?? "")}"></td>
            <td><button class="btn small primary" data-save-client="${esc(c.wa_id)}">Save</button></td>
          </tr>`;
        }).join("")}</tbody></table>`
      : `<div class="empty">No clients yet. When someone agrees to go ahead, they'll show up here.</div>`}
    </div></div>`;
}
async function saveClient(id) {
  const row = $(`tr[data-client="${CSS.escape(id)}"]`);
  const get = (f) => $(`[data-f="${f}"]`, row)?.value;
  const ps = get("project_status");
  const payload = {
    agreed_price: (get("agreed_price") || "").replace(/[^\d]/g, "") || null,
    amount_paid: (get("amount_paid") || "").replace(/[^\d]/g, "") || 0,
    project_status: ps,
    delivery_date: get("delivery_date") ?? undefined,
    status: leadStatusFor(ps),
  };
  try {
    await post("lead", { wa_id: id, ...payload });
    const l = S.leads.get(id) || {};
    S.leads.set(id, { ...l, ...payload, agreed_price: payload.agreed_price ? Number(payload.agreed_price) : null, amount_paid: Number(payload.amount_paid) });
    dirty(); render(); toast("Saved");
  } catch (e) { if (e.message !== "unauthorized") toast(e.message); }
}
function downloadCsv(name, cols, rows) {
  const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = "﻿" + [cols.map(cell).join(","), ...rows.map((r) => r.map(cell).join(","))].join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  a.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function exportClients() {
  downloadCsv("davdags-clients", ["Date", "Name", "WhatsApp", "Business", "Website", "Agreed price", "Paid", "Balance", "Status", "Delivery date", "Source"],
    clients().map((c) => {
      const l = c.lead;
      return [c.created_at.slice(0, 10), l.name || c.name || "", "+" + c.wa_id, l.business_name || "", l.website_goal || l.offer || "",
        l.agreed_price ?? "", l.amount_paid ?? 0, l.agreed_price ? Math.max(0, l.agreed_price - (l.amount_paid || 0)) : "", l.project_status, l.delivery_date || "", source(l)];
    }));
}

// ---------- leads ----------
function renderLeads() {
  const q = S.leadQ.trim().toLowerCase();
  const rows = contacts().filter((c) => hasLead(c) && !c.isOwner)
    .filter((c) => S.leadStatus === "all" || (c.lead.status || "new") === S.leadStatus)
    .filter((c) => !q || [c.lead.name, c.name, c.wa_id, c.lead.email, c.lead.business_name, c.lead.offer, c.lead.website_goal].some((v) => String(v || "").toLowerCase().includes(q)))
    .sort((a, b) => new Date(b.lead.updated_at) - new Date(a.lead.updated_at));
  $("#main").innerHTML = `
    <div class="page"><div class="page-inner">
      <div class="page-tools">
        <input class="field" id="lead-search" placeholder="Search leads" value="${esc(S.leadQ)}">
        <div class="chips">${[["all", "All"], ...Object.entries(STATUS)].map(([k, v]) => `<button class="chip ${S.leadStatus === k ? "on" : ""}" data-lstatus="${k}">${v}</button>`).join("")}</div>
        <button class="btn small" data-action="export-leads" style="margin-left:auto">Download Excel (CSV)</button>
      </div>
      ${rows.length ? `<table>
        <thead><tr><th>Name</th><th>Offer</th><th class="hide-sm">Needs / budget</th><th class="hide-sm">From</th><th>Status</th><th class="hide-sm">Updated</th></tr></thead>
        <tbody>${rows.map((c) => `
          <tr class="clickable" data-open="${esc(c.wa_id)}">
            <td><strong>${esc(c.lead.name || c.name || "")}</strong><div class="chat-sub">${esc(fmtPhone(c.wa_id))}${c.lead.business_name ? " · " + esc(c.lead.business_name) : ""}</div></td>
            <td>${esc(c.lead.offer || "")}</td>
            <td class="hide-sm">${esc(c.lead.website_goal || "")}${c.lead.budget ? `<div class="chat-sub">Budget: ${esc(c.lead.budget)}</div>` : ""}</td>
            <td class="hide-sm">${esc(source(c.lead))}</td>
            <td><span class="status ${esc(c.lead.status || "new")}">${esc(STATUS[c.lead.status] || "New")}</span></td>
            <td class="hide-sm">${esc(when(c.lead.updated_at))}</td>
          </tr>`).join("")}</tbody></table>`
      : `<div class="empty">No leads match.</div>`}
    </div></div>`;
  $("#lead-search").addEventListener("input", (e) => {
    S.leadQ = e.target.value;
    const pos = e.target.selectionStart;
    renderLeads();
    const s = $("#lead-search"); s.focus(); s.setSelectionRange(pos, pos);
  });
}
function exportLeads() {
  const cols = ["name", "wa_id", "email", "business_name", "offer", "website_goal", "budget", "timeline", "status", "source", "notes", "created_at"];
  downloadCsv("davdags-leads", cols, contacts().filter((c) => hasLead(c) && !c.isOwner).map((c) => {
    const r = { ...c.lead, name: c.lead.name || c.name || "", wa_id: "+" + c.wa_id, status: STATUS[c.lead.status] || "New", source: source(c.lead) };
    return cols.map((k) => r[k]);
  }));
}

// ---------- stats ----------
function renderStats() {
  const all = allContacts().filter((c) => !c.isOwner); // includes deleted chats
  const deleted = all.filter((c) => c.deleted_at).length;
  const leads = all.filter(hasLead);
  const dayMs = 864e5, today0 = new Date(new Date().toDateString()).getTime();
  const newToday = all.filter((c) => new Date(c.created_at).getTime() >= today0).length;
  const new7 = all.filter((c) => new Date(c.created_at).getTime() >= today0 - 6 * dayMs).length;
  const paid = leads.filter((c) => c.lead.status === "won").length;
  const funnel = [
    ["Messaged", all.length],
    ["Said what they want", all.filter((c) => c.lead?.website_goal || c.lead?.business_name).length],
    ["⭐ Quality lead", all.filter((c) => quality(c).is).length],
    ["Gave a budget", all.filter((c) => c.lead?.budget).length],
    ["Deposit pending", all.filter((c) => c.lead?.status === "deposit").length],
    ["Paid", paid],
  ];
  const days = [...Array(14)].map((_, i) => {
    const start = today0 - (13 - i) * dayMs;
    return { start, n: all.filter((c) => { const t = new Date(c.created_at).getTime(); return t >= start && t < start + dayMs; }).length };
  });
  const max = Math.max(1, ...days.map((d) => d.n));
  const tally = (arr, fn) => Object.entries(arr.reduce((m, x) => { const k = fn(x); m[k] = (m[k] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]);
  const hlist = (pairs) => {
    if (!pairs.length) return `<div class="chat-sub">Nothing yet.</div>`;
    const top = Math.max(...pairs.map((p) => p[1]));
    return pairs.map(([k, n]) => `<div class="hrow"><span>${esc(k)}</span><strong>${n}</strong><div class="hbar"><i style="width:${(n / top) * 100}%"></i></div></div>`).join("");
  };
  $("#main").innerHTML = `
    <div class="page"><div class="page-inner">
      <div class="cards">
        <div class="card"><div class="num">${all.length}</div><div class="lbl">People who messaged</div></div>
        <div class="card"><div class="num">${newToday}</div><div class="lbl">New today</div></div>
        <div class="card"><div class="num">${new7}</div><div class="lbl">New in last 7 days</div></div>
        <div class="card"><div class="num">${all.filter((c) => quality(c).is).length}</div><div class="lbl">⭐ Quality leads</div></div>
        <div class="card"><div class="num">${all.filter((c) => c.handoff && !blocked(c) && !c.deleted_at).length}</div><div class="lbl">Waiting for you</div></div>
        <div class="card"><div class="num">${deleted}</div><div class="lbl">🗑 Deleted chats</div></div>
        <div class="card"><div class="num">${paid}</div><div class="lbl">Paid</div></div>
      </div>
      <div class="panel" style="margin-bottom:12px"><h3>Sales funnel</h3>
        <div class="funnel">${funnel.map(([label, n]) => `<div class="frow"><span>${esc(label)}</span><div class="fbar"><i style="width:${all.length ? (n / all.length) * 100 : 0}%"></i></div><strong>${n}${all.length && label !== "Messaged" ? ` · ${Math.round((n / all.length) * 100)}%` : ""}</strong></div>`).join("")}</div>
      </div>
      <div class="panels">
        <div class="panel"><h3>New chats per day (last 14 days)</h3>
          <div class="bars">${days.map((d) => `<div class="bar" title="${d.n}"><span>${d.n || ""}</span><i style="height:${(d.n / max) * 100}%"></i><span>${new Date(d.start).getDate()}</span></div>`).join("")}</div>
        </div>
        <div class="panel"><h3>Leads by offer</h3>${hlist(tally(leads.filter((c) => c.lead.offer), (c) => c.lead.offer))}</div>
        <div class="panel"><h3>Where chats come from</h3>${hlist(tally(all, (c) => source(c.lead)))}</div>
      </div>
      <p class="chat-sub" style="margin-top:14px">Your own number isn't counted. "Ad" means they tapped a WhatsApp ad; "Link" means one of your offer links or QR codes.</p>
    </div></div>`;
}

// ---------- events ----------
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-view],[data-filter],[data-open],[data-action],[data-quick],[data-quality],[data-lstatus],[data-save-client],[data-send-portfolio],[data-preset],[data-reminder-done],[data-zoom]");
  if (!t) {
    if (S.menuOpen && !e.target.closest(".menu")) { S.menuOpen = false; renderChatParts({ keepComposer: true }); }
    return;
  }
  if (t.dataset.action === "close-sheet" && e.target !== t && !e.target.closest("button")) return; // clicks inside the sheet card
  if (t.dataset.view) { closeSheet(); setView(t.dataset.view); }
  else if (t.dataset.filter) { S.filter = t.dataset.filter; renderList(); }
  else if (t.dataset.open) { if (!e.target.closest("select")) openChat(t.dataset.open); }
  else if (t.dataset.quick) fillQuick(Number(t.dataset.quick));
  else if (t.dataset.quality) setQuality(t.dataset.quality);
  else if (t.dataset.lstatus) { S.leadStatus = t.dataset.lstatus; renderLeads(); }
  else if (t.dataset.saveClient) saveClient(t.dataset.saveClient);
  else if (t.dataset.sendPortfolio) sendPortfolio(t.dataset.sendPortfolio);
  else if (t.dataset.preset) $("#rem-at").value = t.dataset.preset;
  else if (t.dataset.reminderDone) reminderDone(t.dataset.reminderDone);
  else if (t.dataset.zoom) $("#overlay").innerHTML = `<div class="lightbox" data-action="close-lightbox"><img src="${esc(t.dataset.zoom)}" alt=""></div>`;
  else ({
    back: closeChat, send, attach: () => $("#file").click(), menu: () => { S.menuOpen = !S.menuOpen; renderChatParts({ keepComposer: true }); },
    takeover: () => setHandoff(true), handback: () => setHandoff(false), block: () => setBlocked(true), unblock: () => setBlocked(false),
    "delete-chat": deleteChat, "make-client": makeClient, "lead-save": saveLead, reopen: reopenChat, portfolio: openPortfolio,
    remind: openReminder, "save-reminder": saveReminder, "close-sheet": closeSheet, "close-lightbox": closeSheet, settings: () => { closeSheet(); openSettings(); },
    "enable-push": enablePush, "test-push": testPush, logout: () => { closeSheet(); logout(); },
    "export-clients": exportClients, "export-leads": exportLeads,
  }[t.dataset.action] || (() => {}))();
});

document.addEventListener("change", (e) => {
  const sel = e.target.closest("[data-move]");
  if (sel && sel.value) moveCard(sel.dataset.move, sel.value);
});

// Drag and drop on the pipeline board.
document.addEventListener("dragstart", (e) => {
  const card = e.target.closest?.("[data-card]");
  if (!card) return;
  e.dataTransfer.setData("text/plain", card.dataset.card);
  card.classList.add("dragging");
});
document.addEventListener("dragend", (e) => e.target.closest?.("[data-card]")?.classList.remove("dragging"));
document.addEventListener("dragover", (e) => {
  const col = e.target.closest?.("[data-col]");
  if (!col) return;
  e.preventDefault();
  $$(".col.drop").forEach((c) => c !== col && c.classList.remove("drop"));
  col.classList.add("drop");
});
document.addEventListener("drop", (e) => {
  const col = e.target.closest?.("[data-col]");
  $$(".col.drop").forEach((c) => c.classList.remove("drop"));
  if (!col) return;
  e.preventDefault();
  const id = e.dataTransfer.getData("text/plain");
  if (id) moveCard(id, col.dataset.col);
});

window.addEventListener("popstate", () => { if (S.open && !location.search.includes("chat=")) closeChat(); });
navigator.serviceWorker?.addEventListener("message", (e) => { if (e.data?.openChat) openChat(e.data.openChat); });

// ---------- login & start ----------
function logout(message) {
  S.key = ""; S.loaded = false; S.open = null;
  clearTimeout(pollTimer);
  store.del("crm_key"); store.del("crm_cache");
  $("#app").classList.add("hidden");
  $("#login").classList.remove("hidden");
  $("#login-error").textContent = message || "";
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  S.key = $("#password").value;
  $("#login-error").textContent = "Checking…";
  try {
    await loadOverview();
    store.set("crm_key", S.key);
    $("#password").value = "";
    start();
  } catch (err) {
    if (err.message !== "unauthorized") $("#login-error").textContent = err.message;
  }
});

function start() {
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
  renderNav();
  const chat = new URLSearchParams(location.search).get("chat");
  if (chat && S.contacts.has(chat)) openChat(chat);
  else render();
  loop();
}

(async () => {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  if (!S.key) return logout();
  const cached = store.get("crm_cache", null);
  if (cached) { hydrate(cached); start(); } // instant open from the last session
  try {
    await loadOverview();
    lastFull = Date.now();
    if (!cached) start(); else { dirty(); refreshAfterChange(); }
  } catch (e) {
    if (e.message !== "unauthorized" && !cached) logout(e.message);
  }
})();
