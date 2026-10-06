"use strict";
// Sales team pages: Calls (booked calls), Team (agents, login codes, commission), the weekly score card,
// and the cut-down CRM a call agent sees after logging in with their 8-digit code.
// Loaded before app.js; everything here runs only after app.js has set up S, $, api, sheet, etc.

const OUTCOMES = { agreed: "✅ Agreed", callback: "📅 Call back later", no_answer: "📵 No answer", lost: "❌ Not buying" };
const ONBOARD_ITEMS = [
  ["logo", "Logo (or we design one)"],
  ["photos", "Product photos & prices"],
  ["details", "Business details (phone, address, socials)"],
  ["style", "Colours / sites they like"],
  ["domain", "Domain name chosen"],
];
const AGENT_VIEWS = [
  { key: "mycalls", label: "My calls", icon: "📞" },
  { key: "mydone", label: "Done", icon: "✅" },
  { key: "earnings", label: "Earnings", icon: "💰" },
];

const isAgent = () => S.role === "agent";
const callsList = () => [...S.calls.values()];
const openCallFor = (waId) => callsList().find((c) => c.wa_id === waId && c.status === "booked") || null;
const agentName = (id) => S.agents.find((a) => a.id === id)?.name || "";
const callIsDue = (c) => new Date(c.due_at) <= new Date(Date.now() + 5 * 60e3);
const byDue = (a, b) => new Date(a.due_at) - new Date(b.due_at);
function personName(waId) {
  const c = S.contacts.get(waId), l = S.leads.get(waId);
  return l?.name || c?.name || fmtPhone(waId);
}
function localInput(d) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
}
function at(hoursFromNow, setHour) {
  const d = new Date(Date.now() + hoursFromNow * 3600e3);
  d.setSeconds(0, 0);
  if (setHour !== undefined) d.setHours(setHour, 0);
  return d;
}
function tierTag(l) {
  if (!l?.tier) return "";
  return { hot: `<span class="tag hot">🔥 Hot</span>`, warm: `<span class="tag you">Warm</span>`, cold: `<span class="tag cold">Cold</span>` }[l.tier] || "";
}

// ---------- call cards ----------
function callCard(call) {
  const l = S.leads.get(call.wa_id) || {};
  const done = call.status !== "booked";
  const overdue = !done && new Date(call.due_at) < new Date(Date.now() - 10 * 60e3);
  const dueTxt = done
    ? `${esc(OUTCOMES[call.outcome] || (call.status === "cancelled" ? "Cancelled" : "Done"))}`
    : overdue ? `Overdue · was ${esc(endsLabel(new Date(call.due_at)))}`
    : callIsDue(call) ? "Call now" : esc(endsLabel(new Date(call.due_at)));
  const need = [l.website_goal || l.offer, l.business_name && "Business: " + l.business_name, l.budget && "Budget: " + l.budget]
    .filter(Boolean).map(esc).join(" · ");
  const owner = !isAgent();
  return `<div class="ccard ${overdue ? "overdue" : ""} ${done ? "done" : ""}">
    <div class="ccard-top">
      <strong>${esc(personName(call.wa_id))}</strong> ${tierTag(l)}
      <span class="when ${overdue || (!done && callIsDue(call)) ? "urgent" : done ? "closed" : ""}" style="margin-left:auto">${dueTxt}</span>
    </div>
    <div class="chat-sub">${esc(fmtPhone(call.wa_id))}${owner ? ` · ${call.agent_id ? "👤 " + esc(agentName(call.agent_id)) : "No agent"}` : ""}</div>
    ${call.summary ? `<div class="ccard-sum">${esc(call.summary)}</div>` : ""}
    ${need ? `<div class="chat-sub">${need}</div>` : ""}
    ${call.preferred_time && !done ? `<div class="chat-sub">They said: “${esc(call.preferred_time)}”</div>` : ""}
    ${call.attempts && !done ? `<div class="chat-sub">📵 No answer ${call.attempts}×</div>` : ""}
    ${done && call.outcome_note ? `<div class="chat-sub">📝 ${esc(call.outcome_note)}</div>` : ""}
    ${done ? "" : `<div class="ccard-actions">
      <a class="btn small primary" href="tel:+${esc(call.wa_id)}">📞 Call</a>
      <a class="btn small" href="https://wa.me/${esc(call.wa_id)}" target="_blank" rel="noopener">🟢 WhatsApp</a>
      <button class="btn small" ${owner ? `data-open="${esc(call.wa_id)}"` : `data-action="chat-view" data-id="${esc(call.wa_id)}"`}>💬 Chat</button>
      <button class="btn small primary" data-action="call-result" data-id="${call.id}">Log result</button>
      ${owner ? `<select class="field assign" data-assign="${call.id}">
        <option value="">No agent (me)</option>
        ${S.agents.filter((a) => a.active || a.id === call.agent_id).map((a) => `<option value="${a.id}" ${a.id === call.agent_id ? "selected" : ""}>👤 ${esc(a.name)}</option>`).join("")}
      </select>
      <button class="btn small ghost danger" data-action="cancel-call" data-id="${call.id}">Cancel</button>` : ""}
    </div>`}
  </div>`;
}

function callSections(list) {
  const open = list.filter((c) => c.status === "booked").sort(byDue);
  const now = open.filter(callIsDue), later = open.filter((c) => !callIsDue(c));
  return `
    <div class="qsection">Call now (${now.length})</div>
    ${now.map(callCard).join("") || `<div class="empty" style="padding:16px">Nobody to call right now.</div>`}
    <div class="qsection">Coming up (${later.length})</div>
    ${later.map(callCard).join("") || `<div class="empty" style="padding:16px">No calls booked for later.</div>`}`;
}

// ---------- owner: Calls page ----------
function renderCalls() {
  const all = callsList();
  const today0 = new Date(new Date().toDateString());
  const doneToday = all.filter((c) => c.status !== "booked" && c.completed_at && new Date(c.completed_at) >= today0)
    .sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at));
  const activeAgents = S.agents.filter((a) => a.active).length;
  $("#main").innerHTML = `
    <div class="page"><div class="page-inner narrow">
      <div class="criteria" style="margin-bottom:6px">
        <strong>How calls work</strong>
        <div class="chat-sub" style="margin-top:4px">The bot books a call when a hot lead agrees to talk. The next free agent gets an alert on their phone, calls, then taps <b>Log result</b>. On ✅ Agreed the customer automatically gets a recap with the bank details. You can also book a call from any chat (⋯ → 📞 Book a call).</div>
        ${activeAgents ? "" : `<div class="notice" style="margin-top:8px">No call agents yet, so calls come to you. <button class="btn small" data-view="team">Add agents</button></div>`}
      </div>
      ${callSections(all)}
      <div class="qsection">Done today (${doneToday.length})</div>
      ${doneToday.map(callCard).join("") || `<div class="empty" style="padding:16px">No results logged today.</div>`}
    </div></div>`;
}

// ---------- logging a result ----------
let outcomeChoice = null;
function openCallResult(t) {
  const call = S.calls.get(Number(t.dataset.id));
  if (!call) return;
  outcomeChoice = null;
  sheet(`<h3>How did the call with ${esc(personName(call.wa_id))} go?</h3>
    <div class="outcomes">${Object.entries(OUTCOMES).map(([k, v]) => `<button class="btn" data-action="pick-outcome" data-id="${k}">${v}</button>`).join("")}</div>
    <div id="outcome-extra"></div>
    <textarea class="field" id="outcome-note" rows="2" placeholder="Notes from the call (optional)"></textarea>
    <div class="error" id="outcome-error"></div>
    <div style="margin-top:10px;display:flex;gap:8px;justify-content:flex-end">
      <button class="btn" data-action="close-sheet">Cancel</button>
      <button class="btn primary" data-action="save-outcome" data-id="${call.id}">Save</button>
    </div>`);
}
function pickOutcome(t) {
  outcomeChoice = t.dataset.id;
  $$(".outcomes .btn").forEach((b) => b.classList.toggle("primary", b === t));
  const call = S.calls.get(Number($('[data-action="save-outcome"]').dataset.id));
  const l = S.leads.get(call?.wa_id) || {};
  const guess = l.agreed_price || (budgetNaira(l.budget) >= MIN_PRICE ? budgetNaira(l.budget) : MIN_PRICE);
  $("#outcome-extra").innerHTML = {
    agreed: `<label class="chat-sub">Agreed price (₦)</label>
      <input class="field" id="outcome-price" inputmode="numeric" value="${esc(guess)}">
      <div class="chat-sub" style="margin:4px 0 8px">They'll get a WhatsApp recap with the 50% deposit and bank details right away.</div>`,
    callback: `<div class="chips" style="margin-bottom:8px">
        ${[["In 1 hour", at(1)], ["In 3 hours", at(3)], ["Tomorrow 10am", at(24, 10)], ["Tomorrow 4pm", at(24, 16)]]
          .map(([txt, d]) => `<button class="chip" data-action="set-callback" data-id="${localInput(d)}">${txt}</button>`).join("")}
      </div>
      <input class="field" type="datetime-local" id="outcome-at" value="${localInput(at(24, 10))}">
      <div class="chat-sub" style="margin:4px 0 8px">You'll get an alert when it's time.</div>`,
    no_answer: `<div class="chat-sub" style="margin-bottom:8px">We'll message them on WhatsApp to pick a time, and remind you to try again in 2 hours. After 3 misses the bot takes over again.</div>`,
    lost: `<label class="chat-sub">Why?</label>
      <select class="field" id="outcome-reason">${(S.lostReasons || []).map((r) => `<option>${esc(r)}</option>`).join("")}</select>
      <div style="height:8px"></div>`,
  }[outcomeChoice] || "";
}
async function saveOutcome(t) {
  if (!outcomeChoice) { $("#outcome-error").textContent = "Pick what happened first."; return; }
  const body = { id: Number(t.dataset.id), outcome: outcomeChoice, note: $("#outcome-note").value };
  if (outcomeChoice === "agreed") body.agreed_price = $("#outcome-price").value.replace(/[^\d]/g, "");
  if (outcomeChoice === "callback") body.callback_at = new Date($("#outcome-at").value).toISOString();
  if (outcomeChoice === "lost") body.lost_reason = $("#outcome-reason").value;
  t.disabled = true;
  try {
    const res = await post("call-outcome", body);
    closeSheet();
    toast(res.message || "Saved");
    await refreshCalls();
  } catch (e) {
    t.disabled = false;
    if (e.message !== "unauthorized") $("#outcome-error").textContent = e.message;
  }
}
async function refreshCalls() {
  if (isAgent()) await loadOverview();
  else await poll().catch(() => {});
  dirty();
  render();
}

// ---------- owner: booking a call from a chat ----------
function openBookCall() {
  S.menuOpen = false;
  renderChatParts({ keepComposer: true });
  const l = S.leads.get(S.open) || {};
  const existing = openCallFor(S.open);
  const summary = existing?.summary || [l.business_name, l.website_goal, l.budget && "budget " + l.budget].filter(Boolean).join(" · ");
  sheet(`<h3>📞 ${existing ? "Move the call with" : "Book a call with"} ${esc(personName(S.open))}</h3>
    <label class="chat-sub">Who calls</label>
    <select class="field" id="book-agent">
      <option value="auto">Next free agent</option>
      ${S.agents.filter((a) => a.active).map((a) => `<option value="${a.id}" ${existing?.agent_id === a.id ? "selected" : ""}>👤 ${esc(a.name)}</option>`).join("")}
      <option value="">Me</option>
    </select>
    <div style="height:8px"></div>
    <label class="chat-sub">When</label>
    <div class="chips" style="margin-bottom:8px">
      ${[["Now", new Date()], ["In 1 hour", at(1)], ["Tomorrow 10am", at(24, 10)]]
        .map(([txt, d]) => `<button class="chip" data-action="set-book-time" data-id="${localInput(d)}">${txt}</button>`).join("")}
    </div>
    <input class="field" type="datetime-local" id="book-at" value="${localInput(existing ? new Date(existing.due_at) : new Date())}">
    <div style="height:8px"></div>
    <input class="field" id="book-summary" placeholder="One line for the agent: what they want, budget" value="${esc(summary)}">
    <div class="error" id="book-error"></div>
    <div style="margin-top:10px;display:flex;gap:8px;justify-content:flex-end">
      <button class="btn" data-action="close-sheet">Cancel</button>
      <button class="btn primary" data-action="save-booking">Book call</button>
    </div>`);
}
async function saveBooking(t) {
  t.disabled = true;
  try {
    const res = await post("book-call", {
      wa_id: S.open,
      agent_id: $("#book-agent").value,
      due_at: new Date($("#book-at").value).toISOString(),
      summary: $("#book-summary").value,
    });
    closeSheet();
    toast(res.agent ? `Booked with ${res.agent}. They've been alerted.` : "Booked. You'll get the alert.");
    await refreshCalls();
  } catch (e) {
    t.disabled = false;
    if (e.message !== "unauthorized") $("#book-error").textContent = e.message;
  }
}
async function cancelCall(t) {
  const call = S.calls.get(Number(t.dataset.id));
  if (!call || !confirm(`Cancel the call with ${personName(call.wa_id)}?`)) return;
  try { await post("call-cancel", { id: call.id }); toast("Call cancelled"); await refreshCalls(); }
  catch (e) { if (e.message !== "unauthorized") toast(e.message); }
}
async function assignCall(id, agentId) {
  try {
    await post("call-assign", { id: Number(id), agent_id: agentId ? Number(agentId) : null });
    toast(agentId ? `Given to ${agentName(Number(agentId))}. They've been alerted.` : "Unassigned");
    await refreshCalls();
  } catch (e) { if (e.message !== "unauthorized") toast(e.message); }
}

// Banner at the top of a chat with a booked call.
function callBanner(waId) {
  const call = openCallFor(waId);
  if (!call) return "";
  return `<div class="banner"><span class="tag hot">📞 Call</span> ${esc(callIsDue(call) ? "due now" : endsLabel(new Date(call.due_at)))} · ${esc(call.agent_id ? agentName(call.agent_id) : "no agent")}
    <span style="margin-left:auto;display:flex;gap:6px"><button class="btn small" data-action="book-call">Move</button><button class="btn small primary" data-action="call-result" data-id="${call.id}">Log result</button></span></div>`;
}

// ---------- owner: Team page ----------
function agentStats(a) {
  const calls = callsList().filter((c) => c.agent_id === a.id);
  const done = calls.filter((c) => c.status === "done" && c.outcome && c.outcome !== "callback");
  const agreed = done.filter((c) => c.outcome === "agreed").length;
  const clients = [...S.leads.values()].filter((l) => l.agent_id === a.id);
  const received = clients.reduce((t, l) => t + (l.amount_paid || 0), 0);
  const earned = Math.round((received * Number(a.commission_pct)) / 100);
  return {
    open: calls.filter((c) => c.status === "booked").length, done: done.length, agreed,
    rate: done.length ? Math.round((agreed / done.length) * 100) + "%" : "—",
    received, earned, owed: Math.max(0, earned - (a.paid_out || 0)),
  };
}
function renderTeam() {
  const rows = S.agents.map((a) => ({ a, s: agentStats(a) }));
  $("#main").innerHTML = `
    <div class="page"><div class="page-inner">
      <div class="panel" style="margin-bottom:14px">
        <h3>Add a call agent</h3>
        <div class="team-form">
          <input class="field" id="agent-name" placeholder="Name, e.g. Tolu Ade">
          <input class="field" id="agent-phone" placeholder="Their phone (optional)" inputmode="tel">
          <input class="field" id="agent-pct" value="10" inputmode="decimal" title="Commission %" style="max-width:90px">
          <button class="btn primary" data-action="add-agent">Add agent</button>
        </div>
        <div class="chat-sub" style="margin-top:6px">Commission % is paid on the money that comes in from clients they close. Each agent gets an 8-digit code to log in at <b>crm.davdags.com</b>. They only see their own calls.</div>
      </div>
      ${rows.length ? `<table>
        <thead><tr><th>Agent</th><th>Open calls</th><th class="hide-sm">Calls done</th><th>Agreed</th><th class="hide-sm">Close rate</th><th class="hide-sm">Money in</th><th>Commission owed</th><th></th></tr></thead>
        <tbody>${rows.map(({ a, s }) => `<tr class="${a.active ? "" : "inactive"}">
          <td><strong>${esc(a.name)}</strong>${a.active ? "" : ` <span class="tag cold">Off</span>`}<div class="chat-sub">${esc(a.phone || "")} · ${esc(a.commission_pct)}%</div></td>
          <td>${s.open}</td><td class="hide-sm">${s.done}</td><td>${s.agreed}</td><td class="hide-sm">${s.rate}</td>
          <td class="hide-sm">${naira(s.received)}</td>
          <td><strong>${naira(s.owed)}</strong><div class="chat-sub">paid ${naira(a.paid_out || 0)}</div></td>
          <td><div class="row-actions">
            <button class="btn small" data-action="agent-payout" data-id="${a.id}">Record payout</button>
            <button class="btn small" data-action="agent-code" data-id="${a.id}">New code</button>
            <button class="btn small ghost ${a.active ? "danger" : ""}" data-action="agent-toggle" data-id="${a.id}">${a.active ? "Switch off" : "Switch on"}</button>
          </div></td>
        </tr>`).join("")}</tbody></table>`
      : `<div class="empty">No agents yet. Add your first one above.</div>`}
    </div></div>`;
}
function showCode(name, code) {
  sheet(`<h3>Login code for ${esc(name)}</h3>
    <div class="code-big">${esc(code.slice(0, 4))} ${esc(code.slice(4))}</div>
    <div class="chat-sub" style="margin:10px 0">Send this to ${esc(name)} privately. They open <b>crm.davdags.com</b> on their phone, type the code in the password box, then turn on notifications in ⚙️ Settings. This is the only time you'll see it; tap <b>New code</b> on the Team page if they lose it.</div>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button class="btn" data-action="copy-code" data-id="${esc(code)}">Copy code</button>
      <button class="btn primary" data-action="close-sheet">Done</button>
    </div>`);
}
async function addAgent(t) {
  const name = $("#agent-name").value.trim();
  if (!name) return toast("Type the agent's name");
  t.disabled = true;
  try {
    const res = await post("agent", { name, phone: $("#agent-phone").value, commission_pct: $("#agent-pct").value });
    S.agents.push(res.agent);
    render();
    showCode(name, res.code);
  } catch (e) { t.disabled = false; if (e.message !== "unauthorized") toast(e.message); }
}
async function newCode(t) {
  const a = S.agents.find((x) => x.id === Number(t.dataset.id));
  if (!a || !confirm(`Make a new login code for ${a.name}? Their old code stops working.`)) return;
  try { const res = await post("agent-code", { id: a.id }); showCode(a.name, res.code); }
  catch (e) { if (e.message !== "unauthorized") toast(e.message); }
}
async function toggleAgent(t) {
  const a = S.agents.find((x) => x.id === Number(t.dataset.id));
  if (!a) return;
  if (a.active && !confirm(`Switch off ${a.name}? They can't log in and get no new calls. Their booked calls stay with them until you reassign them on the Calls page.`)) return;
  try { await post("agent", { id: a.id, active: !a.active }); a.active = !a.active; render(); }
  catch (e) { if (e.message !== "unauthorized") toast(e.message); }
}
async function recordPayout(t) {
  const a = S.agents.find((x) => x.id === Number(t.dataset.id));
  if (!a) return;
  const owed = agentStats(a).owed;
  const amount = prompt(`How much commission did you pay ${a.name}? (₦)`, owed ? String(owed) : "");
  if (!amount) return;
  try {
    await post("agent-payout", { id: a.id, amount });
    a.paid_out = (a.paid_out || 0) + Math.round(Number(amount.replace(/[^\d.-]/g, "")) || 0);
    render(); toast("Payout recorded");
  } catch (e) { if (e.message !== "unauthorized") toast(e.message); }
}

// ---------- clients: content checklist ----------
function onboardCount(l) {
  const o = l.onboarding || {};
  return ONBOARD_ITEMS.filter(([k]) => o[k]).length;
}
function openOnboarding(t) {
  const id = t.dataset.id, l = S.leads.get(id) || {};
  const o = l.onboarding || {};
  sheet(`<h3>Content from ${esc(personName(id))}</h3>
    <div class="chat-sub" style="margin-bottom:8px">Tick what they've sent. The 5-day clock starts when everything is in.</div>
    <div style="display:grid;gap:8px">${ONBOARD_ITEMS.map(([k, label]) => `<label class="check"><input type="checkbox" data-onboard="${k}" ${o[k] ? "checked" : ""}> ${esc(label)}</label>`).join("")}</div>
    <div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end">
      <button class="btn" data-open="${esc(id)}">Open chat</button>
      <button class="btn primary" data-action="save-onboard" data-id="${esc(id)}">Save</button>
    </div>`);
}
async function saveOnboarding(t) {
  const id = t.dataset.id;
  const onboarding = {};
  for (const box of $$("[data-onboard]")) if (box.checked) onboarding[box.dataset.onboard] = new Date().toISOString().slice(0, 10);
  try {
    await post("lead", { wa_id: id, onboarding });
    S.leads.set(id, { ...(S.leads.get(id) || {}), onboarding });
    closeSheet(); dirty(); render(); toast("Saved");
  } catch (e) { if (e.message !== "unauthorized") toast(e.message); }
}

// ---------- stats: weekly score card ----------
function weekNumbers(start, end) {
  const inRange = (iso) => iso && new Date(iso) >= start && new Date(iso) < end;
  const people = allContacts().filter((c) => !c.isOwner && inRange(c.created_at));
  const calls = callsList();
  const done = calls.filter((c) => c.outcome && c.outcome !== "callback" && c.status === "done" && inRange(c.completed_at));
  const agreed = done.filter((c) => c.outcome === "agreed").length;
  const paidLeads = [...S.leads.values()].filter((l) => inRange(l.paid_at));
  return {
    chats: people.length,
    hot: people.filter((c) => c.lead?.tier === "hot" || quality(c).hot).length,
    booked: calls.filter((c) => inRange(c.created_at)).length,
    done: done.length,
    agreed,
    deposits: paidLeads.length,
    revenue: paidLeads.reduce((t, l) => t + (l.amount_paid || 0), 0),
    rate: done.length ? Math.round((agreed / done.length) * 100) : null,
  };
}
function scorecardHtml() {
  const now = new Date(), wk = 7 * 864e5;
  const cur = weekNumbers(new Date(now - wk), new Date(+now + 60e3));
  const prev = weekNumbers(new Date(now - 2 * wk), new Date(now - wk));
  const spend = Number(store.get("crm_adspend", "")) || 0;
  const delta = (a, b) => (b === null || a === null || a === b ? "" : `<span class="delta ${a > b ? "up" : "down"}">${a > b ? "▲" : "▼"} ${Math.abs(a - b)}</span>`);
  const tile = (num, label, a, b) => `<div class="card"><div class="num">${num}</div><div class="lbl">${label} ${delta(a, b)}</div></div>`;
  return `<div class="panel" style="margin-bottom:12px">
    <h3>This week's score <span class="chat-sub">(last 7 days, ▲▼ vs the week before)</span></h3>
    <div class="cards" style="margin-bottom:10px">
      ${tile(cur.chats, "New chats", cur.chats, prev.chats)}
      ${tile(cur.hot, "🔥 Hot leads", cur.hot, prev.hot)}
      ${tile(cur.booked, "📞 Calls booked", cur.booked, prev.booked)}
      ${tile(cur.agreed, "✅ Agreed on calls", cur.agreed, prev.agreed)}
      ${tile(cur.rate === null ? "—" : cur.rate + "%", "Close rate (agreed ÷ calls done)", cur.rate, prev.rate)}
      ${tile(cur.deposits, "💰 Deposits paid", cur.deposits, prev.deposits)}
      ${tile(naira(cur.revenue), "Money in", cur.revenue, prev.revenue)}
    </div>
    <div class="spend-row">
      <label>Ad spend this week (₦) <input class="field" id="ad-spend" inputmode="numeric" value="${spend || ""}" placeholder="e.g. 70000"></label>
      <div><div class="num-sm">${spend && cur.hot ? naira(spend / cur.hot) : "—"}</div><div class="chat-sub">Cost per hot lead</div></div>
      <div><div class="num-sm">${spend && cur.deposits ? naira(spend / cur.deposits) : "—"}</div><div class="chat-sub">Cost per sale</div></div>
    </div>
    <div class="chat-sub" style="margin-top:6px">Type what Ads Manager says you spent in the last 7 days. Scale the ads and niches with the lowest cost per sale.</div>
  </div>`;
}
function lostReasonsHtml() {
  const pairs = Object.entries([...S.leads.values()].filter((l) => l.lost_reason)
    .reduce((m, l) => { m[l.lost_reason] = (m[l.lost_reason] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]);
  if (!pairs.length) return `<div class="chat-sub">Nothing yet.</div>`;
  const top = Math.max(...pairs.map((p) => p[1]));
  return pairs.map(([k, n]) => `<div class="hrow"><span>${esc(k)}</span><strong>${n}</strong><div class="hbar"><i style="width:${(n / top) * 100}%"></i></div></div>`).join("");
}

// ---------- the call agent's CRM ----------
function hydrateAgent(d) {
  S.role = "agent";
  S.me = d.agent;
  S.calls = new Map((d.calls || []).map((c) => [c.id, c]));
  S.contacts = new Map((d.contacts || []).map((c) => [c.wa_id, c]));
  S.leads = new Map((d.leads || []).map((l) => [l.wa_id, l]));
  S.closed = d.closed || [];
  S.earned = d.earned || 0;
  S.owed = d.owed || 0;
  S.lostReasons = d.lostReasons || [];
  S.since = d.now;
  S.loaded = true;
  if (!AGENT_VIEWS.some((v) => v.key === S.view)) S.view = "mycalls";
  dirty();
}
function renderMyCalls() {
  $("#main").innerHTML = `<div class="page"><div class="page-inner narrow">
    <div class="hello">Hi ${esc(firstWord(S.me?.name))} 👋 Call each customer when it's time, then tap <b>Log result</b>.</div>
    ${callSections(callsList())}
  </div></div>`;
}
function renderMyDone() {
  const done = callsList().filter((c) => c.status !== "booked").sort((a, b) => new Date(b.completed_at || b.updated_at) - new Date(a.completed_at || a.updated_at));
  $("#main").innerHTML = `<div class="page"><div class="page-inner narrow">
    <div class="qsection" style="margin-top:0">Last 45 days (${done.length})</div>
    ${done.map(callCard).join("") || `<div class="empty">No finished calls yet.</div>`}
  </div></div>`;
}
function renderEarnings() {
  const month0 = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const month = callsList().filter((c) => c.status === "done" && c.outcome !== "callback" && new Date(c.completed_at) >= month0);
  const agreed = month.filter((c) => c.outcome === "agreed").length;
  $("#main").innerHTML = `<div class="page"><div class="page-inner narrow">
    <div class="cards">
      <div class="card"><div class="num">${naira(S.owed)}</div><div class="lbl">Owed to you</div></div>
      <div class="card"><div class="num">${naira(S.earned)}</div><div class="lbl">Earned so far (${esc(S.me?.commission_pct)}%)</div></div>
      <div class="card"><div class="num">${naira(S.me?.paid_out || 0)}</div><div class="lbl">Paid to you</div></div>
      <div class="card"><div class="num">${month.length ? Math.round((agreed / month.length) * 100) + "%" : "—"}</div><div class="lbl">Close rate this month (${agreed}/${month.length})</div></div>
    </div>
    <div class="chat-sub" style="margin-bottom:10px">You earn ${esc(S.me?.commission_pct)}% of the money each of your clients pays, as it comes in.</div>
    ${S.closed.length ? `<table><thead><tr><th>Client</th><th>Agreed</th><th>Paid</th><th class="hide-sm">Status</th></tr></thead><tbody>
      ${S.closed.map((l) => `<tr><td>${esc(l.name || fmtPhone(l.wa_id))}</td><td>${naira(l.agreed_price)}</td><td>${naira(l.amount_paid || 0)}</td><td class="hide-sm">${esc(l.project_status || "")}</td></tr>`).join("")}
    </tbody></table>` : `<div class="empty">Clients you close will show here.</div>`}
  </div></div>`;
}
const firstWord = (s) => String(s || "").trim().split(/\s+/)[0];

// Read-only chat for agents (and context before a call).
async function openChatSheet(waId) {
  sheet(`<h3>💬 ${esc(personName(waId))} <span class="chat-sub">${esc(fmtPhone(waId))}</span></h3>
    <div class="messages sheet-msgs" id="sheet-msgs"><div class="pick">Loading…</div></div>
    <div style="margin-top:10px;display:flex;gap:8px;justify-content:flex-end">
      <a class="btn" href="tel:+${esc(waId)}">📞 Call</a>
      <button class="btn primary" data-action="close-sheet">Close</button>
    </div>`);
  try {
    const msgs = await api("messages?wa_id=" + encodeURIComponent(waId));
    S.messages = msgs;
    const box = $("#sheet-msgs");
    if (!box) return;
    box.innerHTML = msgs.map(bubble).join("") || `<div class="pick">No messages.</div>`;
    hydrateMedia(box);
    box.scrollTop = box.scrollHeight;
  } catch (e) { if (e.message !== "unauthorized") toast(e.message); }
}

// Actions used from the shared click handler in app.js (buttons use data-action + data-id).
const CALL_ACTIONS = {
  "call-result": openCallResult, "pick-outcome": pickOutcome, "save-outcome": saveOutcome,
  "set-callback": (t) => { $("#outcome-at").value = t.dataset.id; },
  "book-call": openBookCall, "save-booking": saveBooking, "set-book-time": (t) => { $("#book-at").value = t.dataset.id; },
  "cancel-call": cancelCall, "chat-view": (t) => openChatSheet(t.dataset.id),
  "add-agent": addAgent, "agent-code": newCode, "agent-toggle": toggleAgent, "agent-payout": recordPayout,
  "copy-code": (t) => { navigator.clipboard?.writeText(t.dataset.id).then(() => toast("Copied"), () => {}); },
  onboard: openOnboarding, "save-onboard": saveOnboarding,
};

document.addEventListener("change", (e) => {
  const sel = e.target.closest("[data-assign]");
  if (sel) assignCall(sel.dataset.assign, sel.value);
  if (e.target.id === "ad-spend") { store.set("crm_adspend", e.target.value.replace(/[^\d]/g, "")); render(); }
});
