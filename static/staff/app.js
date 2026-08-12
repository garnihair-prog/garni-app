/* GARNI アプリ - スタッフ管理画面フロントエンド（実APIと通信） */

let currentWeekStart = null; // ISO date string (Monday)
let CONSENT_FORMS = []; // 同意書マスタ（メニュー編集画面の割り当て用）

// ---- 電話予約（新規予約手動登録）フォーム用の状態 ----
let NR_MENUS = [];
let NR_STYLISTS = [];
let nrInitialized = false;
let nrSelectedMenus = new Set();
let nrCompanions = [];   // { id, name, age, menuIds: Set<string> }
let nrCompanionSeq = 0;

// ---- 予約一覧クリックでの内容編集用の状態 ----
let ER_ROWS = [];        // 直近に読み込んだ予約一覧（クリック時にidから引く）
let erEditingId = null;
let erSelectedMenus = new Set();

async function api(path, options) {
  const res = await fetch(path, Object.assign({ headers: { "Content-Type": "application/json" } }, options || {}));
  let data = null;
  try { data = await res.json(); } catch (e) { /* noop */ }
  if (res.status === 401 && path !== "/api/me" && path !== "/api/login") {
    // ログインセッションが切れている状態（サーバーの再起動・アプリの更新などで、ログイン状態の
    // 記録が失われた場合など）。そのまま操作を続けると、画面に何も表示されない・反応しないなど
    // わかりにくい形で失敗してしまうため、はっきりと伝えてログイン画面に戻す。
    alert("ログインの状態が切れました。もう一度ログインしてください。");
    location.reload();
    throw new Error("ログインの状態が切れました");
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || "エラーが発生しました");
    err.status = res.status;
    throw err;
  }
  return data;
}

// Date型から「その端末のローカル日付」のYYYY-MM-DD文字列を作る。
// toISOString() はUTCに変換するため、日本(UTC+9)では日付が1日ずれることがある
// （例: 深夜0時〜9時の間、todayISO()が前日の日付を返してしまう等）。
// 日付計算には必ずこちらを使う。
function toLocalDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function todayISO() {
  return toLocalDateStr(new Date());
}
function mondayOf(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const day = d.getDay(); // 0=Sun
  const diff = (day === 0 ? -6 : 1 - day);
  d.setDate(d.getDate() + diff);
  return toLocalDateStr(d);
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + n);
  return toLocalDateStr(d);
}
function timeRangeLabel(startTime, durationMin) {
  const [h, m] = startTime.split(":").map(Number);
  const total = h * 60 + m + (durationMin || 60);
  const end = `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
  return `${startTime}〜${end}`;
}

function statusPillHtml(status) {
  const map = { wait: ["wait", "未対応"], visited: ["visited", "来店済み"], cancel: ["cancel", "キャンセル"], no_show: ["cancel", "無断キャンセル"] };
  const [cls, label] = map[status];
  return `<span class="status-pill ${cls}">${label}</span>`;
}
function statusSelectHtml(r) {
  return `<select class="status-select" onchange="updateStatus('${r.id}', this.value)">
    <option value="wait" ${r.status === "wait" ? "selected" : ""}>未対応</option>
    <option value="visited" ${r.status === "visited" ? "selected" : ""}>来店済み</option>
    <option value="cancel" ${r.status === "cancel" ? "selected" : ""}>キャンセル</option>
    <option value="no_show" ${r.status === "no_show" ? "selected" : ""}>無断キャンセル</option>
  </select>`;
}

/* ---------------- AUTH ---------------- */
async function checkAuth() {
  const { authenticated } = await api("/api/me");
  document.getElementById("login-view").style.display = authenticated ? "none" : "block";
  document.getElementById("staff-view").style.display = authenticated ? "grid" : "none";
  if (authenticated) loadAllInit();
  return authenticated;
}
async function doLogin() {
  const password = document.getElementById("login-password").value;
  const errBox = document.getElementById("login-error");
  errBox.classList.remove("show");
  try {
    await api("/api/login", { method: "POST", body: JSON.stringify({ password }) });
    await checkAuth();
  } catch (e) {
    errBox.textContent = "パスワードが違います。";
    errBox.classList.add("show");
  }
}
async function doLogout() {
  await api("/api/logout", { method: "POST" });
  location.reload();
}

/* ---------------- NAV ---------------- */
function showSPanel(id) {
  document.querySelectorAll(".staff-panel").forEach(el => el.classList.toggle("active", el.id === id));
  document.querySelectorAll(".side-nav button[data-panel]").forEach(b => b.classList.toggle("active", b.dataset.panel === id));
  if (id === "s-dashboard") loadDashboard();
  if (id === "s-reserve") { loadReserveDate(); if (!nrInitialized) initNRForm(); }
  if (id === "s-karte") loadCustomers();
  if (id === "s-shift") loadShift();
  if (id === "s-menu") loadMenus();
  if (id === "s-settings") loadSettings();
}

function loadAllInit() {
  document.getElementById("reserve-date").value = todayISO();
  currentWeekStart = mondayOf(todayISO());
  loadDashboard();
}

/* ---------------- DASHBOARD ---------------- */
async function loadDashboard() {
  const data = await api(`/api/staff/dashboard?date=${todayISO()}`);
  document.getElementById("dash-stats").innerHTML = `
    <div class="stat-tile"><div class="label">本日の予約件数</div><div class="value">${data.todayCount}件</div></div>
    <div class="stat-tile"><div class="label">本日の売上（実績）</div><div class="value">¥${data.todaySales.toLocaleString()}</div></div>
    <div class="stat-tile"><div class="label">今月の新規顧客</div><div class="value">${data.newCustomersThisMonth}人</div></div>
    <div class="stat-tile"><div class="label">本日の予約数（対応待ち）</div><div class="value">${data.todayReservations.filter(r => r.status === "wait").length}件</div></div>
  `;
  document.getElementById("dash-reserve-body").innerHTML = data.todayReservations.map(r => `
    <tr><td>${timeRangeLabel(r.time, r.duration_min)}</td><td>${r.customer_name}${companionSummaryHtml(r)}</td><td>${r.menu_names}</td><td>${r.stylist_name}</td><td>${statusPillHtml(r.status)}</td></tr>
  `).join("") || `<tr><td colspan="5" style="color:var(--text-muted);">本日の予約はまだありません</td></tr>`;
  drawSalesChart(data.weeklySales);
  loadCustomerStats();
}

function barListHtml(items, unit) {
  if (!items.length) return `<div class="bl-empty">データがまだありません</div>`;
  return items.map(it => `
    <div class="bl-row">
      <div class="bl-top"><span class="bl-name">${it.name || it.label}</span><span class="bl-val">${it.count}${unit || "人"}（${it.percentage}%）</span></div>
      <div class="bl-track"><div class="bl-fill" style="width:${Math.min(it.percentage, 100)}%;"></div></div>
    </div>`).join("");
}

async function loadCustomerStats() {
  const data = await api("/api/staff/customer-stats");
  document.getElementById("stat-categories").innerHTML = barListHtml(data.categories);
  document.getElementById("stat-gender").innerHTML = barListHtml(data.gender);
  document.getElementById("stat-age").innerHTML = barListHtml(data.age);
}

function drawSalesChart(weeklySales) {
  const svg = document.getElementById("sales-chart");
  const w = svg.clientWidth || 560, h = 220;
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  const padL = 50, padB = 26, padT = 12, padR = 10;
  const chartW = w - padL - padR, chartH = h - padT - padB;
  const maxVal = Math.max(1, ...weeklySales.map(d => d.value)) * 1.15;
  const n = weeklySales.length, gap = 14;
  const barW = (chartW - gap * (n - 1)) / n;

  let gridlines = "";
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const y = padT + chartH - (chartH / steps) * i;
    const val = Math.round((maxVal / steps) * i);
    gridlines += `<line x1="${padL}" x2="${w - padR}" y1="${y}" y2="${y}" stroke="#e1e0d9" stroke-width="1"/>`;
    gridlines += `<text x="${padL - 8}" y="${y + 4}" font-size="10" fill="#898781" text-anchor="end">${val >= 1000 ? Math.round(val / 1000) + "k" : val}</text>`;
  }
  let bars = "";
  weeklySales.forEach((d, i) => {
    const bh = (d.value / maxVal) * chartH;
    const x = padL + i * (barW + gap);
    const y = padT + chartH - bh;
    bars += `<rect x="${x}" y="${y}" width="${barW}" height="${Math.max(bh,0)}" rx="4" ry="4" fill="#2a78d6" class="sales-bar" data-idx="${i}" style="cursor:pointer;"/>`;
    bars += `<text x="${x + barW / 2}" y="${h - 8}" font-size="10" fill="#898781" text-anchor="middle">${d.date.slice(5).replace("-", "/")}</text>`;
  });
  svg.innerHTML = `<line x1="${padL}" x2="${w - padR}" y1="${padT + chartH}" y2="${padT + chartH}" stroke="#c3c2b7" stroke-width="1"/>` + gridlines + bars;

  const tip = document.getElementById("bar-tip");
  svg.querySelectorAll(".sales-bar").forEach(bar => {
    bar.addEventListener("mousemove", (e) => {
      const idx = +bar.dataset.idx;
      const d = weeklySales[idx];
      const rect = svg.getBoundingClientRect();
      tip.style.left = (e.clientX - rect.left) + "px";
      tip.style.top = (e.clientY - rect.top) + "px";
      tip.textContent = `${d.date}: ¥${d.value.toLocaleString()}`;
      tip.style.opacity = 1;
    });
    bar.addEventListener("mouseleave", () => { tip.style.opacity = 0; });
  });
}

function escapeHtml(str) {
  return String(str == null ? "" : str).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// 複数人でのご来店（お連れ様）がいる予約に、その旨がひと目でわかるバッジを表示する
function companionSummaryHtml(r) {
  const comps = r.companions || [];
  if (!comps.length) return "";
  const title = comps.map(c => `${c.name}様${c.age != null ? "（" + c.age + "歳）" : ""}：${c.menuNames}（¥${c.price.toLocaleString()}）`).join("\n");
  return `<div class="companion-tag" title="${escapeHtml(title)}">＋お連れ様${comps.length}名</div>`;
}

/* ---------------- RESERVE MANAGEMENT ---------------- */
function photoThumbHtml(path, alt) {
  if (!path) return `<span style="font-size:11px;color:var(--text-muted);">―</span>`;
  return `<a href="${path}" target="_blank" rel="noopener"><img class="thumb" src="${path}" alt="${alt || ''}"></a>`;
}

function referralCouponCellHtml(r) {
  if (r.appliedReferralReward) {
    return `
      <div style="font-size:11px;color:var(--good);font-weight:700;margin-top:4px;">
        紹介クーポン ¥${r.appliedReferralReward.amount.toLocaleString()}引き 適用済み
        <button class="btn-ghost" style="width:auto;display:inline;padding:0 0 0 6px;font-size:11px;color:var(--text-muted);text-decoration:underline;" onclick="undoReferralReward('${r.appliedReferralReward.id}')">取り消す</button>
      </div>`;
  }
  if (r.activeReferralRewards && r.activeReferralRewards.length) {
    const rw = r.activeReferralRewards[0];
    const extra = r.activeReferralRewards.length > 1 ? `（他${r.activeReferralRewards.length - 1}枚保有）` : "";
    return `
      <div style="margin-top:4px;">
        <button class="btn-ghost" style="width:auto;padding:4px 8px;border:1px solid var(--brand);border-radius:8px;color:var(--brand-dark);font-size:11px;" onclick="applyReferralReward('${rw.id}','${r.id}')">紹介クーポン¥${rw.amount.toLocaleString()}を適用${extra}</button>
      </div>`;
  }
  return "";
}
// 予約一覧の日付選択（ブラウザ標準のカレンダー）には曜日ごとの色分けなどができないため、
// 定休日・臨時休業日の情報を別途取得し、選択中の日付が休みの場合はテキストで明示する。
let CLOSED_INFO = null; // { closedWeekdays: Set<number>, closedDates: Set<string> }
const WEEKDAY_LABELS_JA = ["日", "月", "火", "水", "木", "金", "土"];
async function ensureClosedInfoLoaded() {
  if (CLOSED_INFO) return CLOSED_INFO;
  const settings = await api("/api/staff/settings");
  CLOSED_INFO = {
    closedWeekdays: new Set(settings.closedWeekdays || []),
    closedDates: new Set(settings.closedDates || []),
  };
  const weeklyNote = document.getElementById("reserve-closed-weekly-note");
  if (weeklyNote) {
    const labels = [...CLOSED_INFO.closedWeekdays].sort().map(w => WEEKDAY_LABELS_JA[w] + "曜日");
    weeklyNote.textContent = labels.length ? `定休日：${labels.join("・")}` : "";
  }
  return CLOSED_INFO;
}
async function loadReserveDate() {
  const date = document.getElementById("reserve-date").value || todayISO();
  const closedInfo = await ensureClosedInfoLoaded();
  const closedNote = document.getElementById("reserve-date-closed-note");
  if (closedNote) {
    const weekday = new Date(date + "T00:00:00").getDay();
    if (closedInfo.closedDates.has(date)) {
      closedNote.textContent = "この日は臨時休業日です";
      closedNote.style.display = "block";
    } else if (closedInfo.closedWeekdays.has(weekday)) {
      closedNote.textContent = `この日は定休日です（${WEEKDAY_LABELS_JA[weekday]}曜日）`;
      closedNote.style.display = "block";
    } else {
      closedNote.style.display = "none";
    }
  }
  const rows = await api(`/api/staff/reservations?date=${date}`);
  const showCancelled = document.getElementById("reserve-show-cancelled").checked;
  const isCancelledStatus = r => r.status === "cancel" || r.status === "no_show";
  const visibleRows = showCancelled ? rows : rows.filter(r => !isCancelledStatus(r));
  const hiddenCount = rows.length - visibleRows.length;
  ER_ROWS = rows;

  document.getElementById("reserve-body").innerHTML = visibleRows.map(r => `
    <tr class="clickable-row" onclick="openEditReservation('${r.id}')">
      <td>${timeRangeLabel(r.time, r.duration_min)}</td><td>${r.customer_name}${companionSummaryHtml(r)}</td><td>${r.customer_phone}</td><td>${r.menu_names}</td>
      <td>${r.stylist_name}</td><td class="amt">¥${r.total_price.toLocaleString()}</td>
      <td onclick="event.stopPropagation()">${photoThumbHtml(r.style_photo_path, "希望スタイル")}</td>
      <td onclick="event.stopPropagation()">
        ${statusSelectHtml(r)}
        ${isCancelledStatus(r) && r.cancellation_fee > 0 ? `<div style="font-size:11px;color:var(--critical);font-weight:700;margin-top:4px;">キャンセル料 ¥${r.cancellation_fee.toLocaleString()}</div>` : ""}
        ${referralCouponCellHtml(r)}
      </td>
    </tr>`).join("") || (rows.length
      ? `<tr><td colspan="8" style="color:var(--text-muted);">この日の予約はすべてキャンセル・無断キャンセルです（「キャンセル・無断キャンセルも表示する」にチェックすると表示されます）</td></tr>`
      : `<tr><td colspan="8" style="color:var(--text-muted);">この日の予約はありません</td></tr>`);

  const hiddenNoteBox = document.getElementById("reserve-hidden-note");
  if (hiddenNoteBox) {
    hiddenNoteBox.textContent = hiddenCount > 0 ? `※ キャンセル・無断キャンセル ${hiddenCount}件を非表示中` : "";
  }
}
async function applyReferralReward(rewardId, reservationId) {
  const msg = document.getElementById("reserve-msg");
  try {
    await api(`/api/staff/referral-rewards/${rewardId}`, { method: "PATCH", body: JSON.stringify({ status: "used", reservationId }) });
    await loadReserveDate();
  } catch (e) {
    if (msg) {
      msg.textContent = e.message || "クーポンの適用に失敗しました";
      msg.classList.add("show");
    }
  }
}
async function undoReferralReward(rewardId) {
  await api(`/api/staff/referral-rewards/${rewardId}`, { method: "PATCH", body: JSON.stringify({ status: "active" }) });
  loadReserveDate();
}
async function updateStatus(id, status) {
  const updated = await api(`/api/staff/reservations/${id}`, { method: "PATCH", body: JSON.stringify({ status }) });
  loadReserveDate();
  loadDashboard();
  const msg = document.getElementById("reserve-msg");
  if ((status === "cancel" || status === "no_show") && updated.cancellation_fee > 0) {
    const label = status === "no_show" ? "無断キャンセル" : "土日祝のご予約のキャンセル";
    msg.textContent = `${label}のため、キャンセル料 ¥${updated.cancellation_fee.toLocaleString()} が発生します。お会計時にご案内ください。`;
    msg.classList.add("show");
  } else if (msg) {
    msg.classList.remove("show");
  }
}

/* ---------------- 電話予約（新規予約手動登録） ---------------- */
// 薬剤の関係上、同時（同じ方）に施術できないメニューの組み合わせ（お客様向け画面・サーバーと同じルール）。
const NR_MENU_CONFLICT_GROUPS = [
  [["ブリーチ"], ["パーマ", "縮毛矯正"]],
];
function nrMenuConflictMessage(menuIds) {
  const names = new Set([...menuIds].map(id => {
    const m = NR_MENUS.find(m => m.id === id);
    return m ? m.name : null;
  }));
  for (const [groupA, groupB] of NR_MENU_CONFLICT_GROUPS) {
    const aHit = groupA.filter(n => names.has(n));
    const bHit = groupB.filter(n => names.has(n));
    if (aHit.length && bHit.length) {
      return `${aHit.join("・")}は${bHit.join("・")}と同時にはご予約いただけません`;
    }
  }
  return null;
}
// 薬剤メニューは15歳以下不可（お客様向け画面・サーバーと同じルール。consent_form_idで判定）。
const NR_AGE_RESTRICTED_CONSENT_FORM_IDS = new Set(["cf-color", "cf-perm"]);
const NR_AGE_RESTRICTION_MIN_AGE = 16;
function nrAgeRequirementMessage(menuIds, age) {
  const names = [...new Set([...menuIds]
    .map(id => NR_MENUS.find(m => m.id === id))
    .filter(m => m && NR_AGE_RESTRICTED_CONSENT_FORM_IDS.has(m.consent_form_id))
    .map(m => m.name))];
  if (names.length === 0) return null;
  const label = names.join("・");
  if (age == null || Number.isNaN(age)) return `${label}をご予約の場合は、年齢の入力が必要です`;
  if (age < NR_AGE_RESTRICTION_MIN_AGE) return `${label}は15歳以下の方はご予約いただけません`;
  return null;
}

function showNRMsg(text, isError) {
  const errBox = document.getElementById("nr-error");
  errBox.textContent = text;
  errBox.style.background = isError ? "" : "#e7f6e7";
  errBox.style.borderColor = isError ? "" : "var(--good)";
  errBox.style.color = isError ? "" : "#0a6b0a";
  errBox.classList.add("show");
}
function clearNRMsg() {
  document.getElementById("nr-error").classList.remove("show");
}

async function initNRForm() {
  nrInitialized = true;
  const [menus, stylists] = await Promise.all([api("/api/menus"), api("/api/stylists")]);
  NR_MENUS = menus;
  NR_STYLISTS = stylists;
  document.getElementById("nr-stylist").innerHTML = stylists.map(s => `<option value="${s.id}">${s.name}</option>`).join("");
  document.getElementById("nr-date").value = todayISO();
  renderNRMenuList();
  renderNRCompanions();
  refreshNRTimeSlots();
}

function nrMenuRowHtml(m) {
  const checked = nrSelectedMenus.has(m.id) ? "checked" : "";
  return `
    <div class="menu-card">
      <div class="menu-row">
        <input type="checkbox" ${checked} onchange="toggleNRMenu('${m.id}')">
        <div><div class="mname">${m.name}</div>${m.meta ? `<div class="mmeta">${m.meta}</div>` : ""}</div>
      </div>
      <div class="price-col">
        <div class="mprice">¥${m.price.toLocaleString()}${m.price_is_from ? "〜" : ""}</div>
      </div>
    </div>`;
}
function renderNRMenuList() {
  document.getElementById("nr-menu-list").innerHTML = NR_MENUS.map(m => nrMenuRowHtml(m)).join("");
}
function toggleNRMenu(id) {
  clearNRMsg();
  if (nrSelectedMenus.has(id)) {
    nrSelectedMenus.delete(id);
  } else {
    nrSelectedMenus.add(id);
    const msg = nrMenuConflictMessage(nrSelectedMenus);
    if (msg) {
      nrSelectedMenus.delete(id);
      showNRMsg(msg, true);
      renderNRMenuList();
      return;
    }
  }
  renderNRMenuList();
  refreshNRTimeSlots();
}

function nrCompanionMenuRowHtml(comp, m) {
  const checked = comp.menuIds.has(m.id) ? "checked" : "";
  return `
    <label class="companion-menu-row">
      <input type="checkbox" ${checked} onchange="toggleNRCompanionMenu('${comp.id}','${m.id}')">
      <span class="companion-menu-name">${escapeHtml(m.name)}</span>
      <span class="companion-menu-price">¥${m.price.toLocaleString()}${m.price_is_from ? "〜" : ""}</span>
    </label>`;
}
function nrCompanionCardHtml(comp) {
  return `
    <div class="companion-card" id="nr-companion-${comp.id}">
      <div class="companion-card-head">
        <input type="text" class="companion-name-input" placeholder="お名前" value="${escapeHtml(comp.name)}" oninput="updateNRCompanionName('${comp.id}', this.value)">
        <input type="number" class="companion-age-input" placeholder="年齢" min="1" max="119" value="${comp.age === "" || comp.age == null ? "" : escapeHtml(comp.age)}" oninput="updateNRCompanionAge('${comp.id}', this.value)">
        <button type="button" class="companion-remove-btn" onclick="removeNRCompanion('${comp.id}')" aria-label="お連れ様を削除">✕</button>
      </div>
      <div class="companion-menu-list">
        ${NR_MENUS.map(m => nrCompanionMenuRowHtml(comp, m)).join("")}
      </div>
    </div>`;
}
function renderNRCompanions() {
  document.getElementById("nr-companion-list").innerHTML = nrCompanions.map(c => nrCompanionCardHtml(c)).join("");
}
function addNRCompanion() {
  nrCompanionSeq++;
  nrCompanions.push({ id: "nrcomp" + nrCompanionSeq, name: "", age: "", menuIds: new Set() });
  renderNRCompanions();
}
function removeNRCompanion(id) {
  nrCompanions = nrCompanions.filter(c => c.id !== id);
  renderNRCompanions();
  refreshNRTimeSlots();
}
function updateNRCompanionName(id, value) {
  const c = nrCompanions.find(c => c.id === id);
  if (c) c.name = value;
}
function updateNRCompanionAge(id, value) {
  const c = nrCompanions.find(c => c.id === id);
  if (c) c.age = value;
}
function toggleNRCompanionMenu(id, menuId) {
  clearNRMsg();
  const c = nrCompanions.find(c => c.id === id);
  if (!c) return;
  if (c.menuIds.has(menuId)) {
    c.menuIds.delete(menuId);
  } else {
    c.menuIds.add(menuId);
    const msg = nrMenuConflictMessage(c.menuIds);
    if (msg) {
      c.menuIds.delete(menuId);
      showNRMsg(msg, true);
      renderNRCompanions();
      return;
    }
  }
  renderNRCompanions();
  refreshNRTimeSlots();
}

// 選択中の日付・スタイリスト・メニュー（本人＋お連れ様）から、予約可能な時間の一覧を取得して
// 「お時間」のプルダウンに反映する。
async function onNRContextChanged() {
  refreshNRTimeSlots();
}
async function refreshNRTimeSlots() {
  const timeSel = document.getElementById("nr-time");
  const date = document.getElementById("nr-date").value;
  const stylistId = document.getElementById("nr-stylist").value;
  const allMenuIds = [...nrSelectedMenus, ...nrCompanions.flatMap(c => [...c.menuIds])];
  if (!date || !stylistId || allMenuIds.length === 0) {
    timeSel.innerHTML = `<option value="">先にご来店日・スタイリスト・メニューを選択してください</option>`;
    return;
  }
  const durationMin = allMenuIds.reduce((sum, id) => {
    const m = NR_MENUS.find(m => m.id === id);
    return sum + (m ? m.duration_min : 0);
  }, 0);
  const data = await api(`/api/availability?date=${date}&stylistId=${stylistId}&durationMin=${durationMin}&menuIds=${allMenuIds.join(",")}`);
  const available = data.slots.filter(s => s.available);
  if (!available.length) {
    timeSel.innerHTML = `<option value="">この日・このスタイリストに空き時間がありません</option>`;
    return;
  }
  timeSel.innerHTML = available.map(s => `<option value="${s.time}">${s.time}</option>`).join("");
}

async function lookupNRCustomerByPhone() {
  const phone = document.getElementById("nr-phone").value.replace(/\D/g, "");
  if (!phone) return;
  try {
    const customers = await api("/api/staff/customers");
    const cust = customers.find(c => (c.phone || "").replace(/\D/g, "") === phone);
    if (cust) {
      if (!document.getElementById("nr-name").value.trim()) document.getElementById("nr-name").value = cust.name || "";
      if (cust.gender === "男性" || cust.gender === "女性") document.getElementById("nr-gender").value = cust.gender;
      if (cust.age != null && !document.getElementById("nr-age").value) document.getElementById("nr-age").value = cust.age;
      showNRMsg(`既存のお客様「${cust.name}」様が見つかりました。内容を確認してください。`, false);
    }
  } catch (e) {
    // 検索失敗は致命的ではないため、入力自体は続行できるようにする
  }
}

async function submitNRReservation() {
  clearNRMsg();
  const phone = document.getElementById("nr-phone").value.trim();
  const name = document.getElementById("nr-name").value.trim();
  const gender = document.getElementById("nr-gender").value || null;
  const ageRaw = document.getElementById("nr-age").value;
  const age = ageRaw === "" ? null : parseInt(ageRaw, 10);
  const date = document.getElementById("nr-date").value;
  const stylistId = document.getElementById("nr-stylist").value;
  const time = document.getElementById("nr-time").value;
  const note = document.getElementById("nr-note").value.trim();

  if (!phone || !name || !date || !stylistId || nrSelectedMenus.size === 0 || !time) {
    showNRMsg("電話番号・お名前・ご来店日・スタイリスト・メニュー・お時間をすべて入力してください。", true);
    return;
  }
  const primaryAgeMsg = nrAgeRequirementMessage(nrSelectedMenus, age);
  if (primaryAgeMsg) {
    showNRMsg(primaryAgeMsg, true);
    return;
  }
  const validNRCompanions = nrCompanions.filter(c => c.name.trim() && c.menuIds.size > 0);
  for (const c of validNRCompanions) {
    const cAge = c.age === "" || c.age == null ? null : parseInt(c.age, 10);
    const cAgeMsg = nrAgeRequirementMessage(c.menuIds, cAge);
    if (cAgeMsg) {
      showNRMsg(`${c.name.trim()}様：${cAgeMsg}`, true);
      return;
    }
  }

  const payload = {
    date, time, stylistId,
    menuIds: [...nrSelectedMenus],
    customerName: name,
    customerPhone: phone,
    customerGender: gender,
    customerAge: age,
    note,
    companions: validNRCompanions.map(c => ({
      name: c.name.trim(),
      age: c.age === "" || c.age == null ? null : parseInt(c.age, 10),
      menuIds: [...c.menuIds],
    })),
  };
  try {
    await api("/api/staff/reservations", { method: "POST", body: JSON.stringify(payload) });
    showNRMsg("予約を登録しました。", false);
    document.getElementById("nr-phone").value = "";
    document.getElementById("nr-name").value = "";
    document.getElementById("nr-gender").value = "";
    document.getElementById("nr-age").value = "";
    document.getElementById("nr-note").value = "";
    nrSelectedMenus = new Set();
    nrCompanions = [];
    renderNRMenuList();
    renderNRCompanions();
    refreshNRTimeSlots();
    document.getElementById("reserve-date").value = date;
    loadReserveDate();
    loadDashboard();
  } catch (e) {
    showNRMsg(e.message || "予約の登録に失敗しました", true);
  }
}

/* ---------------- KARTE ---------------- */
let selectedCustomerId = null;
let editingCustomerId = null;
let currentKarteData = null;
async function loadCustomers() {
  const rows = await api("/api/staff/customers");
  document.getElementById("cust-list").innerHTML = rows.map(c => `
    <div class="cust-row ${c.id === selectedCustomerId ? "sel" : ""}" onclick="selectCustomer('${c.id}')">
      <div class="nm">${c.name}</div>
      <div class="lv">最終来店 ${c.last_visit || "―"}</div>
    </div>`).join("");
  if (!rows.length) {
    selectedCustomerId = null;
    document.getElementById("karte-detail").innerHTML = `<div style="font-size:12px;color:var(--text-muted);">お客様データがありません</div>`;
    return;
  }
  if (!selectedCustomerId || !rows.some(c => c.id === selectedCustomerId)) selectCustomer(rows[0].id);
}
async function selectCustomer(id) {
  selectedCustomerId = id;
  editingCustomerId = null;
  selectedKarteEntryId = null;
  document.querySelectorAll(".cust-row").forEach(r => r.classList.remove("sel"));
  currentKarteData = await api(`/api/staff/customers/${id}`);
  renderKarteDetail();
  loadCustomers();
}
function startEditCustomer(id) {
  editingCustomerId = id;
  renderKarteDetail();
}
function cancelCustomerEdit() {
  editingCustomerId = null;
  renderKarteDetail();
}
async function saveCustomerEdit(id) {
  const name = document.getElementById("edit-cust-name").value.trim();
  const kana = document.getElementById("edit-cust-kana").value.trim();
  const phone = document.getElementById("edit-cust-phone").value.trim();
  const msgBox = document.getElementById("karte-edit-msg");
  if (!name || !phone) {
    if (msgBox) { msgBox.textContent = "お名前と電話番号を入力してください"; msgBox.classList.add("show"); }
    return;
  }
  try {
    await api(`/api/staff/customers/${id}`, { method: "PATCH", body: JSON.stringify({ name, kana, phone }) });
    editingCustomerId = null;
    await selectCustomer(id);
  } catch (e) {
    if (msgBox) {
      msgBox.textContent = e.message || "保存に失敗しました";
      msgBox.classList.add("show");
    }
  }
}
// 顧客カルテの一番上に表示する「来店サマリー」（来店回数・累計利用金額・来店頻度・よく使うメニュー）。
// 来店履歴（karte_entries、施術が完了した予約のみ）から集計する。
function karteSummaryHtml(data) {
  const history = data.history || [];
  const visitCount = history.length;
  const totalSpend = history.reduce((sum, h) => sum + (h.total_price || 0), 0);

  let freqLabel = "―";
  if (visitCount >= 2) {
    const dates = history.map(h => new Date(h.date + "T00:00:00")).sort((a, b) => a - b);
    const totalDays = (dates[dates.length - 1] - dates[0]) / (1000 * 60 * 60 * 24);
    const avgDays = totalDays / (visitCount - 1);
    freqLabel = avgDays >= 1 ? `約${Math.round(avgDays)}日に1回` : "同日に複数回";
  }

  let favoriteMenu = "―";
  if (visitCount > 0) {
    const counts = {};
    history.forEach(h => {
      (h.menu_names || "").split("・").filter(Boolean).forEach(name => {
        counts[name] = (counts[name] || 0) + 1;
      });
    });
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (sorted.length) favoriteMenu = sorted[0][0];
  }

  return `
    <div class="karte-summary-grid">
      <div class="karte-summary-tile"><div class="label">来店回数</div><div class="value">${visitCount}回</div></div>
      <div class="karte-summary-tile"><div class="label">累計利用金額</div><div class="value">¥${totalSpend.toLocaleString()}</div></div>
      <div class="karte-summary-tile"><div class="label">来店頻度</div><div class="value" style="font-size:14px;">${freqLabel}</div></div>
      <div class="karte-summary-tile"><div class="label">よく使うメニュー</div><div class="value" style="font-size:14px;">${escapeHtml(favoriteMenu)}</div></div>
    </div>`;
}

// 顧客カルテのメイン表示で「現在選んでいる来店履歴（1件）」のid。
// お客様を切り替えたときは selectCustomer() 側でリセットする。
let selectedKarteEntryId = null;

function selectKarteEntry(id) {
  selectedKarteEntryId = id;
  renderKarteDetail();
}

function karteRecordListHtml(history, selectedId) {
  if (!history.length) return "";
  return `
    <div class="karte-record-list">
      ${history.map(h => `
        <div class="karte-record-row ${h.id === selectedId ? "sel" : ""}" onclick="selectKarteEntry('${h.id}')">
          <span class="kr-date">${h.date}</span>
          <span class="kr-menu">${escapeHtml(h.menu_names)}</span>
        </div>`).join("")}
    </div>`;
}

function karteLargePhotoHtml(path, label, emptyHtml) {
  if (path) {
    return `<a href="${path}" target="_blank" rel="noopener"><img class="karte-photo-lg" src="${path}" alt="${label}"></a>`;
  }
  return emptyHtml;
}

function karteEntryDetailHtml(h) {
  const stylePhoto = karteLargePhotoHtml(h.style_photo_path, "お客様の希望スタイル",
    `<div class="karte-photo-lg karte-photo-empty">写真なし</div>`);
  const afterPhoto = karteLargePhotoHtml(h.photo_path, "施術後",
    `<label class="karte-photo-lg karte-photo-empty" style="cursor:pointer;">＋ 施術後の写真を追加
      <input type="file" accept="image/*" capture="environment" style="display:none;" onchange="uploadKartePhoto('${h.id}', this)">
    </label>`);
  return `
    <div class="karte-entry-detail">
      <div class="ked-head">
        <div class="ked-date">${h.date}</div>
        <div class="ked-menu">${escapeHtml(h.menu_names)}</div>
      </div>
      ${h.memo ? `<div class="ked-memo">${escapeHtml(h.memo)}</div>` : ""}
      <div class="karte-photo-pair-lg">
        <div class="ph-col-lg"><div class="ph-label">お客様の希望スタイル</div>${stylePhoto}</div>
        <div class="ph-col-lg"><div class="ph-label">施術後</div>${afterPhoto}</div>
      </div>
      ${karteMedicineFormHtml(h, "perm", "パーマで使用した薬剤")}
      ${karteMedicineFormHtml(h, "color", "カラーで使用した薬剤")}
      <div class="error-banner" id="km-error-${h.id}"></div>
      <button class="btn-ghost" style="width:auto;padding:8px 16px;border:1px solid var(--brand);border-radius:8px;color:var(--brand-dark);font-weight:700;" onclick="saveKarteMedicine('${h.id}')">薬剤情報を保存</button>
    </div>`;
}

// 「使用した薬剤」欄（パーマ用・カラー用で共通のフォーム）。
// kind: "perm" または "color"。フィールドidの接頭辞は km<p|c>- とする（例: kmp-maker-, kmc-maker-）。
function karteMedicineFormHtml(h, kind, title) {
  const short = kind === "perm" ? "kmp" : "kmc";
  const val = (suffix) => escapeHtml(h[`${kind}_medicine_${suffix}`] || "");
  return `
      <div class="karte-medicine-form">
        <div class="km-title">${title}</div>
        <div class="field-row">
          <div class="field"><label>メーカー／ブランド</label><input type="text" id="${short}-maker-${h.id}" value="${val("maker")}"></div>
          <div class="field"><label>商品名</label><input type="text" id="${short}-product-${h.id}" value="${val("product")}"></div>
        </div>
        <div class="field-row">
          <div class="field"><label>レベル（号数）</label><input type="text" id="${short}-level-${h.id}" value="${val("level")}"></div>
          <div class="field"><label>配合／比率</label><input type="text" id="${short}-ratio-${h.id}" value="${val("ratio")}"></div>
        </div>
        <div class="field"><label>薬剤メモ</label><input type="text" id="${short}-memo-${h.id}" value="${val("memo")}" placeholder="例：根元のみ、放置15分など"></div>
      </div>`;
}

async function saveKarteMedicine(id) {
  const errBox = document.getElementById(`km-error-${id}`);
  if (errBox) errBox.classList.remove("show");
  try {
    await api(`/api/staff/karte/${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        permMedicineMaker: document.getElementById(`kmp-maker-${id}`).value.trim(),
        permMedicineProduct: document.getElementById(`kmp-product-${id}`).value.trim(),
        permMedicineLevel: document.getElementById(`kmp-level-${id}`).value.trim(),
        permMedicineRatio: document.getElementById(`kmp-ratio-${id}`).value.trim(),
        permMedicineMemo: document.getElementById(`kmp-memo-${id}`).value.trim(),
        colorMedicineMaker: document.getElementById(`kmc-maker-${id}`).value.trim(),
        colorMedicineProduct: document.getElementById(`kmc-product-${id}`).value.trim(),
        colorMedicineLevel: document.getElementById(`kmc-level-${id}`).value.trim(),
        colorMedicineRatio: document.getElementById(`kmc-ratio-${id}`).value.trim(),
        colorMedicineMemo: document.getElementById(`kmc-memo-${id}`).value.trim(),
      }),
    });
    if (selectedCustomerId) {
      currentKarteData = await api(`/api/staff/customers/${selectedCustomerId}`);
      renderKarteDetail();
    }
  } catch (e) {
    if (errBox) {
      errBox.textContent = e.message || "保存に失敗しました";
      errBox.classList.add("show");
    }
  }
}

function renderKarteDetail() {
  const data = currentKarteData;
  if (!data) return;
  const c = data.customer;
  const isEditing = editingCustomerId === c.id;
  const headerHtml = isEditing ? `
      <div style="flex:1;">
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;">顧客コード：${escapeHtml(c.customer_code || "―")}</div>
        <input id="edit-cust-name" type="text" value="${escapeHtml(c.name)}" placeholder="お名前" style="font-weight:700;font-size:14px;width:100%;padding:6px 8px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px;box-sizing:border-box;">
        <input id="edit-cust-kana" type="text" value="${escapeHtml(c.kana || "")}" placeholder="フリガナ" style="font-size:13px;width:100%;padding:6px 8px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px;box-sizing:border-box;">
        <input id="edit-cust-phone" type="tel" value="${escapeHtml(c.phone)}" placeholder="電話番号" style="font-size:13px;width:100%;padding:6px 8px;border:1px solid var(--border);border-radius:8px;box-sizing:border-box;">
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;flex:0 0 auto;">
        <button class="btn-ghost" style="width:auto;padding:4px 10px;border:1px solid var(--brand);border-radius:8px;color:var(--brand);font-size:11.5px;" onclick="saveCustomerEdit('${c.id}')">保存</button>
        <button class="btn-ghost" style="width:auto;padding:4px 10px;border:1px solid var(--border);border-radius:8px;font-size:11.5px;" onclick="cancelCustomerEdit()">キャンセル</button>
      </div>` : `
      <div>
        <div style="font-size:11px;color:var(--text-muted);">顧客コード：${escapeHtml(c.customer_code || "―")}</div>
        <div style="font-weight:700;font-size:15px;">${escapeHtml(c.name)}</div>
        ${c.kana ? `<div style="font-size:11px;color:var(--text-muted);">${escapeHtml(c.kana)}</div>` : ""}
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;">電話：${escapeHtml(c.phone)} ／ ${c.points}pt</div>
      </div>
      <div style="display:flex;gap:6px;flex:0 0 auto;">
        <button class="btn-ghost" style="width:auto;padding:4px 10px;border:1px solid var(--border);border-radius:8px;font-size:11.5px;" onclick="startEditCustomer('${c.id}')">編集</button>
        <button class="btn-ghost" style="width:auto;padding:4px 10px;border:1px solid var(--critical);border-radius:8px;color:var(--critical);font-size:11.5px;" onclick="deleteCustomer('${c.id}', '${c.name.replace(/'/g, "\\'")}')">お客様を削除</button>
      </div>`;

  const history = data.history || [];
  if (!history.some(h => h.id === selectedKarteEntryId)) {
    selectedKarteEntryId = history.length ? history[0].id : null;
  }
  const selectedEntry = history.find(h => h.id === selectedKarteEntryId);
  const historySectionHtml = history.length ? `
    <div class="karte-history-wrap">
      ${karteRecordListHtml(history, selectedKarteEntryId)}
      ${selectedEntry ? karteEntryDetailHtml(selectedEntry) : ""}
    </div>` : `<div style="font-size:12px;color:var(--text-muted);">来店履歴はまだありません</div>`;

  document.getElementById("karte-detail").innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;">
      ${headerHtml}
    </div>
    <div class="error-banner" id="karte-msg"></div>
    <div class="error-banner" id="karte-edit-msg"></div>
    ${karteSummaryHtml(data)}
    ${referralInfoHtml(data)}
    ${consentInfoHtml(data)}
    ${historySectionHtml}`;
}

async function deleteCustomer(id, name) {
  const ok = confirm(`${name}様を顧客一覧から削除します。\n過去の予約・カルテ・売上データは削除されず、ダッシュボード等の集計にはそのまま残ります。\nよろしいですか？`);
  if (!ok) return;
  try {
    await api(`/api/staff/customers/${id}`, { method: "DELETE" });
    selectedCustomerId = null;
    loadCustomers();
  } catch (e) {
    const msgBox = document.getElementById("karte-msg");
    if (msgBox) {
      msgBox.textContent = e.message || "削除に失敗しました";
      msgBox.classList.add("show");
    }
  }
}

/* ---------------- お客様紹介（スタッフ側） ---------------- */
function referralRewardStatusLabel(status) {
  if (status === "used") return { text: "使用済み", cls: "done" };
  if (status === "expired") return { text: "期限切れ", cls: "cancel" };
  return { text: "利用可能", cls: "upcoming" };
}
function referralInfoHtml(data) {
  const c = data.customer;
  const referredLine = data.referredByName
    ? `<div style="font-size:12px;color:var(--text-muted);margin-bottom:4px;">${data.referredByName}様のご紹介でご来店</div>`
    : "";
  const rewards = data.referralRewards || [];
  const rewardRows = rewards.map(r => {
    const st = referralRewardStatusLabel(r.status);
    return `
      <div class="rf-reward-row" style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--gridline);font-size:12px;">
        <div>
          <div>${r.referred_customer_name || "―"}様のご紹介 ／ ¥${r.amount.toLocaleString()}引き</div>
          <div style="color:var(--text-muted);font-size:11px;">発行 ${r.issued_at} ／ 期限 ${r.expires_at}${r.used_at ? ` ／ 使用日 ${r.used_at.slice(0,10)}` : ""}</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <span class="badge ${st.cls}">${st.text}</span>
          ${r.status === "active" ? `<button class="btn-ghost" style="width:auto;padding:4px 10px;border:1px solid var(--border);border-radius:8px;" onclick="setReferralRewardStatus('${r.id}','used')">使用済みにする</button>` : ""}
          ${r.status === "used" ? `<button class="btn-ghost" style="width:auto;padding:4px 10px;border:1px solid var(--border);border-radius:8px;" onclick="setReferralRewardStatus('${r.id}','active')">取り消す</button>` : ""}
        </div>
      </div>`;
  }).join("") || `<div style="font-size:12px;color:var(--text-muted);">紹介クーポンはありません</div>`;
  return `
    <div style="background:var(--page-plane);border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:12px;">
      <div style="font-size:12px;font-weight:700;margin-bottom:4px;">お客様紹介</div>
      ${referredLine}
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;">このお客様の紹介コード：<strong style="color:var(--text-primary);">${c.referral_code || "―"}</strong></div>
      <div class="error-banner" id="referral-msg" style="margin-bottom:8px;"></div>
      ${rewardRows}
    </div>`;
}
async function setReferralRewardStatus(rewardId, status) {
  try {
    await api(`/api/staff/referral-rewards/${rewardId}`, { method: "PATCH", body: JSON.stringify({ status }) });
    if (selectedCustomerId) selectCustomer(selectedCustomerId);
  } catch (e) {
    const msg = document.getElementById("referral-msg");
    if (msg) {
      msg.textContent = e.message || "操作に失敗しました";
      msg.classList.add("show");
    }
  }
}

/* ---------------- 同意書の同意履歴（スタッフ側） ---------------- */
function consentInfoHtml(data) {
  const agreements = data.consentAgreements || [];
  if (agreements.length === 0) return "";
  const rows = agreements.map(a => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--gridline);font-size:12px;">
      <div>${a.form_title}${a.reservation_date ? `（${a.reservation_date}のご予約）` : ""}</div>
      <div style="color:var(--text-muted);font-size:11px;">同意日時 ${a.agreed_at ? a.agreed_at.replace("T", " ") : "―"}</div>
    </div>`).join("");
  return `
    <div style="background:var(--page-plane);border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:12px;">
      <div style="font-size:12px;font-weight:700;margin-bottom:4px;">同意書への同意履歴</div>
      ${rows}
    </div>`;
}

async function uploadKartePhoto(karteId, input) {
  if (!input.files || !input.files[0]) return;
  const label = input.closest(".photo-upload-btn");
  try {
    const photo = await resizeImageFileToDataUrl(input.files[0]);
    await api(`/api/staff/karte/${karteId}/photo`, { method: "POST", body: JSON.stringify({ photo }) });
    if (selectedCustomerId) selectCustomer(selectedCustomerId);
  } catch (e) {
    if (label) label.insertAdjacentHTML("afterend", `<div style="font-size:11px;color:var(--warning);margin-top:4px;">写真のアップロードに失敗しました：${e.message}</div>`);
  }
}

/* ---------------- SHIFT（休憩時間の設定） ---------------- */
// スタイリストごとの勤務日・時間帯の個別シフト設定は廃止し、営業時間中は常に稼働している前提にした。
// 定休日・臨時休業日・営業時間は「設定」画面で管理し、ここでは休憩時間の設定のみを行う。
async function loadShift() {
  const data = await api(`/api/staff/shifts?weekStart=${currentWeekStart}`);

  // 休憩時間設定フォームの「対象日」「スタイリスト」プルダウンは、表示中の週のデータから作る。
  const dateSel = document.getElementById("sb-date");
  if (dateSel) {
    const prevDate = dateSel.value;
    dateSel.innerHTML = data.days.map(d => `<option value="${d}">${d.slice(5).replace("-", "/")}（${["日", "月", "火", "水", "木", "金", "土"][new Date(d + "T00:00:00").getDay()]}）</option>`).join("");
    if (data.days.includes(prevDate)) dateSel.value = prevDate;
  }
  const stylistSel = document.getElementById("sb-stylist");
  if (stylistSel) {
    const prevStylist = stylistSel.value;
    stylistSel.innerHTML = data.stylists.map(s => `<option value="${s.id}">${s.name}</option>`).join("");
    if (data.stylists.some(s => s.id === prevStylist)) stylistSel.value = prevStylist;
  }
  renderShiftBreaks(data.breaks || []);
}

function renderShiftBreaks(breaks) {
  const box = document.getElementById("shift-breaks-list");
  if (!box) return;
  if (!breaks.length) {
    box.innerHTML = `<div style="font-size:12px;color:var(--text-muted);">この週に登録されている休憩時間はありません。</div>`;
    return;
  }
  const dow = ["日", "月", "火", "水", "木", "金", "土"];
  box.innerHTML = breaks.map(b => {
    const label = `${b.date.slice(5).replace("-", "/")}（${dow[new Date(b.date + "T00:00:00").getDay()]}） ${b.stylistName}：${b.start}〜${b.end}${b.note ? "　" + escapeHtml(b.note) : ""}`;
    return `
    <div style="display:flex;align-items:center;justify-content:space-between;background:var(--brand-tint);border-radius:10px;padding:8px 12px;font-size:13px;">
      <span>${label}</span>
      <button onclick="deleteShiftBreak('${b.id}')" style="background:none;border:none;color:var(--critical);font-size:12px;cursor:pointer;">削除</button>
    </div>`;
  }).join("");
}

function showSBMsg(text) {
  const errBox = document.getElementById("sb-error");
  errBox.textContent = text;
  errBox.classList.add("show");
}
async function addShiftBreak() {
  document.getElementById("sb-error").classList.remove("show");
  const stylistId = document.getElementById("sb-stylist").value;
  const date = document.getElementById("sb-date").value;
  const start = document.getElementById("sb-start").value;
  const end = document.getElementById("sb-end").value;
  const note = document.getElementById("sb-note").value.trim();
  if (!stylistId || !date || !start || !end) {
    showSBMsg("対象日・スタイリスト・開始時刻・終了時刻をすべて入力してください。");
    return;
  }
  try {
    await api("/api/staff/shift-breaks", { method: "POST", body: JSON.stringify({ stylistId, date, start, end, note }) });
    document.getElementById("sb-start").value = "";
    document.getElementById("sb-end").value = "";
    document.getElementById("sb-note").value = "";
    loadShift();
  } catch (e) {
    showSBMsg(e.message || "休憩時間の登録に失敗しました");
  }
}
async function deleteShiftBreak(id) {
  await api(`/api/staff/shift-breaks/${id}`, { method: "DELETE" });
  loadShift();
}
function shiftWeek(days) {
  currentWeekStart = addDays(currentWeekStart, days);
  loadShift();
}

/* ---------------- MENU MANAGEMENT ---------------- */
function consentFormOptionsHtml(selectedId) {
  const noneOpt = `<option value="" ${!selectedId ? "selected" : ""}>なし</option>`;
  const opts = CONSENT_FORMS.map(f => `<option value="${f.id}" ${f.id === selectedId ? "selected" : ""}>${f.title}</option>`).join("");
  return noneOpt + opts;
}
async function loadMenus() {
  document.getElementById("menu-error").classList.remove("show");
  const [rows, forms] = await Promise.all([api("/api/menus"), api("/api/consent-forms")]);
  CONSENT_FORMS = forms;
  document.getElementById("menu-new-consent").innerHTML = consentFormOptionsHtml(null);
  document.getElementById("menu-body").innerHTML = rows.map(m => `
    <tr data-id="${m.id}">
      <td><input class="cell-input" id="m-name-${m.id}" value="${m.name}"></td>
      <td><input class="cell-input" id="m-meta-${m.id}" value="${m.meta || ""}"></td>
      <td><input class="cell-input" id="m-price-${m.id}" type="number" style="width:90px;" value="${m.price}"></td>
      <td style="text-align:center;"><input type="checkbox" id="m-from-${m.id}" ${m.price_is_from ? "checked" : ""} style="accent-color:var(--brand);" title="目安価格（〜表示）"></td>
      <td><input class="cell-input" id="m-discount-${m.id}" type="number" style="width:80px;" value="${m.student_discount || 0}"></td>
      <td><input class="cell-input" id="m-duration-${m.id}" type="number" style="width:70px;" value="${m.duration_min}">分</td>
      <td><select class="cell-input" id="m-consent-${m.id}">${consentFormOptionsHtml(m.consent_form_id)}</select></td>
      <td style="white-space:nowrap;">
        <button class="btn-ghost" style="width:auto;display:inline;padding:6px 12px;" onclick="saveMenu('${m.id}')">保存</button>
        <button class="btn-ghost" style="width:auto;display:inline;padding:6px 12px;color:var(--warning);" onclick="deleteMenu('${m.id}')">削除</button>
      </td>
    </tr>`).join("") || `<tr><td colspan="8" style="color:var(--text-muted);">メニューがまだありません</td></tr>`;
}
function showMenuMsg(text, isError) {
  const errBox = document.getElementById("menu-error");
  errBox.textContent = text;
  errBox.style.background = isError ? "" : "#e7f6e7";
  errBox.style.borderColor = isError ? "" : "var(--good)";
  errBox.style.color = isError ? "" : "#0a6b0a";
  errBox.classList.add("show");
}
async function saveMenu(id) {
  const errBox = document.getElementById("menu-error");
  errBox.classList.remove("show");
  try {
    const nameEl = document.getElementById(`m-name-${id}`);
    const metaEl = document.getElementById(`m-meta-${id}`);
    const priceEl = document.getElementById(`m-price-${id}`);
    const durationEl = document.getElementById(`m-duration-${id}`);
    const fromEl = document.getElementById(`m-from-${id}`);
    const discountEl = document.getElementById(`m-discount-${id}`);
    const consentEl = document.getElementById(`m-consent-${id}`);
    if (!nameEl || !metaEl || !priceEl || !durationEl || !fromEl || !discountEl || !consentEl) {
      showMenuMsg("画面の項目が正しく読み込めていません。ページを再読み込みしてもう一度お試しください。", true);
      return;
    }
    const name = nameEl.value.trim();
    const meta = metaEl.value.trim();
    const price = parseInt(priceEl.value, 10);
    const durationMin = parseInt(durationEl.value, 10);
    const priceIsFrom = fromEl.checked;
    const studentDiscount = parseInt(discountEl.value, 10) || 0;
    const consentFormId = consentEl.value || null;
    if (!name || !(price >= 0) || !(durationMin > 0)) {
      showMenuMsg("メニュー名・価格・所要時間を正しく入力してください。", true);
      return;
    }
    await api(`/api/staff/menus/${id}`, { method: "PATCH", body: JSON.stringify({ name, meta, price, durationMin, priceIsFrom, studentDiscount, consentFormId }) });
    await loadMenus();
    showMenuMsg("保存しました。", false);
  } catch (e) {
    showMenuMsg("保存に失敗しました：" + e.message, true);
  }
}
async function deleteMenu(id) {
  try {
    await api(`/api/staff/menus/${id}`, { method: "DELETE" });
    loadMenus();
  } catch (e) {
    showMenuMsg("削除に失敗しました：" + e.message, true);
  }
}
async function addMenu() {
  const errBox = document.getElementById("menu-error");
  errBox.classList.remove("show");
  try {
    const name = document.getElementById("menu-new-name").value.trim();
    const meta = document.getElementById("menu-new-meta").value.trim();
    const price = parseInt(document.getElementById("menu-new-price").value, 10);
    const durationMin = parseInt(document.getElementById("menu-new-duration").value, 10);
    const priceIsFrom = document.getElementById("menu-new-from").checked;
    const studentDiscount = parseInt(document.getElementById("menu-new-discount").value, 10) || 0;
    const consentFormId = document.getElementById("menu-new-consent").value || null;
    if (!name || !(price >= 0) || !(durationMin > 0)) {
      showMenuMsg("メニュー名・価格・所要時間を正しく入力してください。", true);
      return;
    }
    await api("/api/staff/menus", { method: "POST", body: JSON.stringify({ name, meta, price, durationMin, priceIsFrom, studentDiscount, consentFormId }) });
    document.getElementById("menu-new-name").value = "";
    document.getElementById("menu-new-meta").value = "";
    document.getElementById("menu-new-price").value = "";
    document.getElementById("menu-new-duration").value = "";
    document.getElementById("menu-new-discount").value = "";
    document.getElementById("menu-new-from").checked = false;
    document.getElementById("menu-new-consent").value = "";
    await loadMenus();
    showMenuMsg("追加しました。", false);
  } catch (e) {
    showMenuMsg("追加に失敗しました：" + e.message, true);
  }
}

/* ---------------- SETTINGS ---------------- */
const WEEKDAY_NAMES = ["日", "月", "火", "水", "木", "金", "土"];
async function loadSettings() {
  const s = await api("/api/staff/settings");
  document.getElementById("set-open").value = s.openTime;
  document.getElementById("set-close").value = s.closeTime;
  document.getElementById("set-closed-weekdays").innerHTML = WEEKDAY_NAMES.map((name, i) => `
    <label style="display:flex;align-items:center;gap:5px;font-size:12.5px;">
      <input type="checkbox" value="${i}" ${s.closedWeekdays.includes(i) ? "checked" : ""} style="accent-color:var(--brand);">${name}曜日
    </label>`).join("");
  renderClosedDates(s.closedDates || []);
  document.getElementById("combo-last-order").value = s.comboPermColorLastOrder || "";
  document.getElementById("cancel-fee-percent").value = s.cancellationFeePercent != null ? s.cancellationFeePercent : 50;
  document.getElementById("cancel-fee-percent-full").value = s.cancellationFeePercentFull != null ? s.cancellationFeePercentFull : 100;
  const menus = await api("/api/menus");
  document.getElementById("last-order-list").innerHTML = menus.map(m => `
    <div style="display:flex;align-items:center;gap:12px;">
      <span style="min-width:110px;font-size:13px;font-weight:600;">${m.name}</span>
      <input type="time" id="lo-${m.id}" value="${m.last_order_time || ""}" style="max-width:150px;border-radius:10px;border:1px solid var(--border);padding:8px 10px;font-size:13px;">
    </div>`).join("") || `<div style="font-size:12px;color:var(--text-muted);">メニューがまだありません</div>`;
}

async function saveLastOrderSettings() {
  const msg = document.getElementById("last-order-msg");
  msg.classList.remove("show");
  try {
    const menus = await api("/api/menus");
    for (const m of menus) {
      const input = document.getElementById(`lo-${m.id}`);
      if (!input) continue;
      const lastOrderTime = input.value || "";
      if (lastOrderTime === (m.last_order_time || "")) continue;
      await api(`/api/staff/menus/${m.id}`, { method: "PATCH", body: JSON.stringify({ lastOrderTime }) });
    }
    await api("/api/staff/settings", {
      method: "POST",
      body: JSON.stringify({
        openTime: document.getElementById("set-open").value,
        closeTime: document.getElementById("set-close").value,
        closedWeekdays: [...document.querySelectorAll("#set-closed-weekdays input:checked")].map(el => parseInt(el.value, 10)),
        comboPermColorLastOrder: document.getElementById("combo-last-order").value || "",
      }),
    });
    msg.textContent = "最終受付時間を保存しました。";
    msg.style.background = "#e7f6e7";
    msg.style.borderColor = "var(--good)";
    msg.style.color = "#0a6b0a";
    msg.classList.add("show");
    loadSettings();
  } catch (e) {
    msg.textContent = "保存に失敗しました：" + e.message;
    msg.style.background = "";
    msg.style.borderColor = "";
    msg.style.color = "";
    msg.classList.add("show");
  }
}

async function saveCancelFeeSettings() {
  const msg = document.getElementById("cancel-fee-msg");
  msg.classList.remove("show");
  const percentEl = document.getElementById("cancel-fee-percent");
  const percentFullEl = document.getElementById("cancel-fee-percent-full");
  const percent = parseInt(percentEl.value, 10);
  const percentFull = parseInt(percentFullEl.value, 10);
  if (isNaN(percent) || percent < 0 || percent > 100 || isNaN(percentFull) || percentFull < 0 || percentFull > 100) {
    msg.textContent = "0〜100の数値で入力してください。";
    msg.classList.add("show");
    return;
  }
  try {
    await api("/api/staff/settings", {
      method: "POST",
      body: JSON.stringify({
        openTime: document.getElementById("set-open").value,
        closeTime: document.getElementById("set-close").value,
        closedWeekdays: [...document.querySelectorAll("#set-closed-weekdays input:checked")].map(el => parseInt(el.value, 10)),
        cancellationFeePercent: percent,
        cancellationFeePercentFull: percentFull,
      }),
    });
    msg.textContent = "キャンセルポリシーを保存しました。";
    msg.style.background = "#e7f6e7";
    msg.style.borderColor = "var(--good)";
    msg.style.color = "#0a6b0a";
    msg.classList.add("show");
    loadSettings();
  } catch (e) {
    msg.textContent = "保存に失敗しました：" + e.message;
    msg.style.background = "";
    msg.style.borderColor = "";
    msg.style.color = "";
    msg.classList.add("show");
  }
}

function renderClosedDates(dates) {
  const box = document.getElementById("closed-date-list");
  if (!dates.length) {
    box.innerHTML = `<div style="font-size:12px;color:var(--text-muted);">登録されている臨時休業日はありません。</div>`;
    return;
  }
  box.innerHTML = [...dates].sort().map(d => `
    <div style="display:flex;align-items:center;justify-content:space-between;background:var(--brand-tint);border-radius:10px;padding:8px 12px;font-size:13px;">
      <span>${d}</span>
      <button onclick="removeClosedDate('${d}')" style="background:none;border:none;color:var(--critical);font-size:12px;cursor:pointer;">削除</button>
    </div>`).join("");
}

async function addClosedDate() {
  const msg = document.getElementById("closed-date-msg");
  msg.classList.remove("show");
  const date = document.getElementById("closed-date-input").value;
  if (!date) {
    msg.textContent = "日付を選択してください。";
    msg.classList.add("show");
    return;
  }
  try {
    const res = await api("/api/staff/closed-dates", { method: "POST", body: JSON.stringify({ date }) });
    document.getElementById("closed-date-input").value = "";
    renderClosedDates(res.closedDates || []);
  } catch (e) {
    msg.textContent = "登録に失敗しました：" + e.message;
    msg.classList.add("show");
  }
}

async function removeClosedDate(date) {
  try {
    await api(`/api/staff/closed-dates/${date}`, { method: "DELETE" });
    loadSettings();
  } catch (e) {
    const msg = document.getElementById("closed-date-msg");
    msg.textContent = "削除に失敗しました：" + e.message;
    msg.classList.add("show");
  }
}
async function saveSettings() {
  const msg = document.getElementById("settings-msg");
  msg.classList.remove("show");
  const closedWeekdays = [...document.querySelectorAll("#set-closed-weekdays input:checked")].map(el => parseInt(el.value, 10));
  try {
    await api("/api/staff/settings", {
      method: "POST",
      body: JSON.stringify({
        openTime: document.getElementById("set-open").value,
        closeTime: document.getElementById("set-close").value,
        closedWeekdays,
      }),
    });
    msg.textContent = "設定を保存しました。";
    msg.style.background = "#e7f6e7";
    msg.style.borderColor = "var(--good)";
    msg.style.color = "#0a6b0a";
    msg.classList.add("show");
  } catch (e) {
    msg.textContent = "保存に失敗しました：" + e.message;
    msg.style.background = "";
    msg.style.borderColor = "";
    msg.style.color = "";
    msg.classList.add("show");
  }
}

/* ---------------- 予約一覧クリックでの内容編集 ---------------- */
function showERMsg(text, isError) {
  const errBox = document.getElementById("er-error");
  errBox.textContent = text;
  errBox.style.background = isError ? "" : "#e7f6e7";
  errBox.style.borderColor = isError ? "" : "var(--good)";
  errBox.style.color = isError ? "" : "#0a6b0a";
  errBox.classList.add("show");
}
function clearERMsg() {
  document.getElementById("er-error").classList.remove("show");
}

// お連れ様・希望写真は編集対象外（閲覧のみ）。参考情報としてそのまま表示する。
function erReadonlyHtml(r) {
  const comps = r.companions || [];
  let html = "";
  if (comps.length) {
    const compList = comps.map(c => `${escapeHtml(c.name)}様${c.age != null ? "（" + c.age + "歳）" : ""}：${escapeHtml(c.menuNames)}（¥${c.price.toLocaleString()}）`).join("<br>");
    html += `<div class="readonly-box"><div class="ro-title">お連れ様（編集対象外）</div>${compList}</div>`;
  }
  if (r.style_photo_path) {
    html += `<div class="readonly-box"><div class="ro-title">希望スタイル写真（編集対象外）</div>${photoThumbHtml(r.style_photo_path, "希望スタイル")}</div>`;
  }
  return html;
}

function erMenuRowHtml(m) {
  const checked = erSelectedMenus.has(m.id) ? "checked" : "";
  return `
    <div class="menu-card">
      <div class="menu-row">
        <input type="checkbox" ${checked} onchange="toggleERMenu('${m.id}')">
        <div><div class="mname">${m.name}</div>${m.meta ? `<div class="mmeta">${m.meta}</div>` : ""}</div>
      </div>
      <div class="price-col">
        <div class="mprice">¥${m.price.toLocaleString()}${m.price_is_from ? "〜" : ""}</div>
      </div>
    </div>`;
}
function renderERMenuList() {
  document.getElementById("er-menu-list").innerHTML = NR_MENUS.map(m => erMenuRowHtml(m)).join("");
}
function toggleERMenu(id) {
  clearERMsg();
  if (erSelectedMenus.has(id)) {
    erSelectedMenus.delete(id);
  } else {
    erSelectedMenus.add(id);
    const msg = nrMenuConflictMessage(erSelectedMenus);
    if (msg) {
      erSelectedMenus.delete(id);
      showERMsg(msg, true);
      renderERMenuList();
      return;
    }
  }
  renderERMenuList();
  refreshERTimeSlots();
}

async function onERContextChanged() {
  refreshERTimeSlots();
}
async function refreshERTimeSlots() {
  const timeSel = document.getElementById("er-time");
  const date = document.getElementById("er-date").value;
  const stylistId = document.getElementById("er-stylist").value;
  const menuIds = [...erSelectedMenus];
  if (!date || !stylistId || menuIds.length === 0) {
    timeSel.innerHTML = `<option value="">先にご来店日・スタイリスト・メニューを選択してください</option>`;
    return;
  }
  const durationMin = menuIds.reduce((sum, id) => {
    const m = NR_MENUS.find(m => m.id === id);
    return sum + (m ? m.duration_min : 0);
  }, 0);
  const row = ER_ROWS.find(r => r.id === erEditingId);
  const currentTime = row ? row.time : "";
  const data = await api(`/api/availability?date=${date}&stylistId=${stylistId}&durationMin=${durationMin}&menuIds=${menuIds.join(",")}`);
  let available = data.slots.filter(s => s.available);
  // 編集中の予約自身がその時間帯を占有しているため、現在の日付・スタイリストのままなら
  // 現在の時間も選択肢に残す（他の予約とは重複していないので選べるようにする）。
  if (row && date === row.date && stylistId === row.stylist_id && !available.some(s => s.time === currentTime) && currentTime) {
    available = [{ time: currentTime, available: true }, ...available].sort((a, b) => a.time.localeCompare(b.time));
  }
  if (!available.length) {
    timeSel.innerHTML = `<option value="">この日・このスタイリストに空き時間がありません</option>`;
    return;
  }
  timeSel.innerHTML = available.map(s => `<option value="${s.time}" ${s.time === currentTime ? "selected" : ""}>${s.time}</option>`).join("");
}

// 予約の「メニュー」は menu_names（表示用に「・」で連結した名称文字列）のみ保存されており、
// 選択されたメニューIDそのものは保存されていない（お連れ様の内訳と同じ制約）。
// そのため、編集画面を開く際は名称からメニューマスタを逆引きしてIDを推測する。
// 同名メニューが複数存在する場合など、完全な復元ができない可能性がある点に注意。
function menuNamesToIds(menuNamesStr) {
  const names = (menuNamesStr || "").split("・").map(s => s.trim()).filter(Boolean);
  const ids = [];
  names.forEach(n => {
    const m = NR_MENUS.find(m => m.name === n);
    if (m) ids.push(m.id);
  });
  return ids;
}

async function openEditReservation(id) {
  const r = ER_ROWS.find(r => r.id === id);
  if (!r) return;
  erEditingId = id;
  clearERMsg();
  document.getElementById("er-phone").value = r.customer_phone || "";
  document.getElementById("er-name").value = r.customer_name || "";
  document.getElementById("er-gender").value = "";
  document.getElementById("er-age").value = "";
  document.getElementById("er-date").value = r.date;
  document.getElementById("er-stylist").innerHTML = NR_STYLISTS.map(s => `<option value="${s.id}">${s.name}</option>`).join("");
  document.getElementById("er-stylist").value = r.stylist_id;
  document.getElementById("er-note").value = r.note || "";
  document.getElementById("er-readonly").innerHTML = erReadonlyHtml(r);

  erSelectedMenus = new Set(menuNamesToIds(r.menu_names));
  renderERMenuList();
  refreshERTimeSlots();

  document.getElementById("er-overlay").classList.remove("hidden");

  // 性別・年齢は予約データ自体には保存されていないため、顧客マスタから取得する（届くまでは未選択のまま表示）。
  try {
    const customers = await api("/api/staff/customers");
    const cust = customers.find(c => c.id === r.customer_id);
    if (cust && erEditingId === id) {
      if (cust.gender === "男性" || cust.gender === "女性") document.getElementById("er-gender").value = cust.gender;
      if (cust.age != null) document.getElementById("er-age").value = cust.age;
    }
  } catch (e) {
    // 取得失敗は致命的ではないため、性別・年齢は未選択のまま編集を続行できるようにする
  }
}
function closeEditReservation() {
  document.getElementById("er-overlay").classList.add("hidden");
  erEditingId = null;
}

async function saveEditReservation() {
  clearERMsg();
  if (!erEditingId) return;
  const phone = document.getElementById("er-phone").value.trim();
  const name = document.getElementById("er-name").value.trim();
  const gender = document.getElementById("er-gender").value || null;
  const ageRaw = document.getElementById("er-age").value;
  const age = ageRaw === "" ? null : parseInt(ageRaw, 10);
  const date = document.getElementById("er-date").value;
  const stylistId = document.getElementById("er-stylist").value;
  const time = document.getElementById("er-time").value;
  const note = document.getElementById("er-note").value.trim();

  if (!phone || !name || !date || !stylistId || erSelectedMenus.size === 0 || !time) {
    showERMsg("電話番号・お名前・ご来店日・スタイリスト・メニュー・お時間をすべて入力してください。", true);
    return;
  }
  const ageMsg = nrAgeRequirementMessage(erSelectedMenus, age);
  if (ageMsg) {
    showERMsg(ageMsg, true);
    return;
  }

  const payload = {
    date, time, stylistId,
    menuIds: [...erSelectedMenus],
    customerName: name,
    customerPhone: phone,
    customerGender: gender,
    customerAge: age,
    note,
  };
  try {
    await api(`/api/staff/reservations/${erEditingId}`, { method: "PATCH", body: JSON.stringify(payload) });
    closeEditReservation();
    loadReserveDate();
    loadDashboard();
  } catch (e) {
    showERMsg(e.message || "更新に失敗しました", true);
  }
}

/* ---------------- INIT ---------------- */
document.getElementById("login-password").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
checkAuth();
