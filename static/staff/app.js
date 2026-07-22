/* GARNI アプリ - スタッフ管理画面フロントエンド（実APIと通信） */

let currentWeekStart = null; // ISO date string (Monday)

async function api(path, options) {
  const res = await fetch(path, Object.assign({ headers: { "Content-Type": "application/json" } }, options || {}));
  let data = null;
  try { data = await res.json(); } catch (e) { /* noop */ }
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
  if (id === "s-reserve") loadReserveDate();
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
    <tr><td>${timeRangeLabel(r.time, r.duration_min)}</td><td>${r.customer_name}</td><td>${r.menu_names}</td><td>${r.stylist_name}</td><td>${statusPillHtml(r.status)}</td></tr>
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

/* ---------------- RESERVE MANAGEMENT ---------------- */
function photoThumbHtml(path, alt) {
  if (!path) return `<span style="font-size:11px;color:var(--text-muted);">―</span>`;
  return `<a href="${path}" target="_blank" rel="noopener"><img class="thumb" src="${path}" alt="${alt || ''}"></a>`;
}

async function loadReserveDate() {
  const date = document.getElementById("reserve-date").value || todayISO();
  const rows = await api(`/api/staff/reservations?date=${date}`);
  document.getElementById("reserve-body").innerHTML = rows.map(r => `
    <tr>
      <td>${timeRangeLabel(r.time, r.duration_min)}</td><td>${r.customer_name}</td><td>${r.customer_phone}</td><td>${r.menu_names}</td>
      <td>${r.stylist_name}</td><td class="amt">¥${r.total_price.toLocaleString()}</td>
      <td>${photoThumbHtml(r.style_photo_path, "希望スタイル")}</td>
      <td>
        ${statusSelectHtml(r)}
        ${(r.status === "cancel" || r.status === "no_show") && r.cancellation_fee > 0 ? `<div style="font-size:11px;color:var(--critical);font-weight:700;margin-top:4px;">キャンセル料 ¥${r.cancellation_fee.toLocaleString()}</div>` : ""}
      </td>
    </tr>`).join("") || `<tr><td colspan="8" style="color:var(--text-muted);">この日の予約はありません</td></tr>`;
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

/* ---------------- KARTE ---------------- */
let selectedCustomerId = null;
async function loadCustomers() {
  const rows = await api("/api/staff/customers");
  document.getElementById("cust-list").innerHTML = rows.map(c => `
    <div class="cust-row ${c.id === selectedCustomerId ? "sel" : ""}" onclick="selectCustomer('${c.id}')">
      <div><div class="nm">${c.name}</div><div class="lv">${c.rank}</div></div>
      <div class="lv">最終来店 ${c.last_visit || "―"}</div>
    </div>`).join("");
  if (!selectedCustomerId && rows.length) selectCustomer(rows[0].id);
}
async function selectCustomer(id) {
  selectedCustomerId = id;
  document.querySelectorAll(".cust-row").forEach(r => r.classList.remove("sel"));
  const data = await api(`/api/staff/customers/${id}`);
  document.getElementById("karte-detail").innerHTML = `
    <div style="font-weight:700;font-size:15px;">${data.customer.name}</div>
    <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;">${data.customer.rank} ／ 電話：${data.customer.phone} ／ ${data.customer.points}pt</div>
    <div class="karte-history">
      ${data.history.map(h => `
        <div class="kh-item">
          <div class="kh-date">${h.date}</div>
          <div class="kh-menu">${h.menu_names}</div>
          <div class="kh-memo">${h.memo || "（メモなし）"}</div>
          <div class="photo-pair">
            <div class="ph-col">
              <div class="ph-label">お客様の希望スタイル</div>
              ${h.style_photo_path ? `<a href="${h.style_photo_path}" target="_blank" rel="noopener"><img class="thumb-lg" src="${h.style_photo_path}"></a>` : `<span style="font-size:11px;color:var(--text-muted);">写真なし</span>`}
            </div>
            <div class="ph-col">
              <div class="ph-label">施術後</div>
              ${h.photo_path ? `<a href="${h.photo_path}" target="_blank" rel="noopener"><img class="thumb-lg" src="${h.photo_path}"></a>` : `
                <label class="photo-upload-btn">＋ 施術後の写真を追加
                  <input type="file" accept="image/*" capture="environment" onchange="uploadKartePhoto('${h.id}', this)">
                </label>`}
            </div>
          </div>
        </div>`).join("") || `<div style="font-size:12px;color:var(--text-muted);">来店履歴はまだありません</div>`}
    </div>`;
  loadCustomers();
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

/* ---------------- SHIFT ---------------- */
const SHIFT_CYCLE = ["off", "9-18", "10-19"];
async function loadShift() {
  const data = await api(`/api/staff/shifts?weekStart=${currentWeekStart}`);
  let html = `<div class="hd"></div>` + data.days.map(d => `<div class="hd">${d.slice(5).replace("-", "/")}</div>`).join("");
  data.grid.forEach(row => {
    html += `<div class="nm-cell"><div class="av2">${row.name[0]}</div>${row.name}</div>`;
    row.cells.forEach(c => {
      const off = c.label === "off";
      html += `<button class="shift-cell ${off ? "off" : "on"}" onclick="cycleShift('${row.stylistId}','${c.date}','${c.label}')">${off ? "休み" : c.label}</button>`;
    });
  });
  document.getElementById("shift-grid").innerHTML = html;
}
async function cycleShift(stylistId, date, currentLabel) {
  const idx = SHIFT_CYCLE.indexOf(currentLabel);
  const next = SHIFT_CYCLE[(idx + 1) % SHIFT_CYCLE.length];
  await api("/api/staff/shifts", { method: "POST", body: JSON.stringify({ stylistId, date, label: next }) });
  loadShift();
}
function shiftWeek(days) {
  currentWeekStart = addDays(currentWeekStart, days);
  loadShift();
}

/* ---------------- MENU MANAGEMENT ---------------- */
async function loadMenus() {
  document.getElementById("menu-error").classList.remove("show");
  const rows = await api("/api/menus");
  document.getElementById("menu-body").innerHTML = rows.map(m => `
    <tr data-id="${m.id}">
      <td><input class="cell-input" id="m-name-${m.id}" value="${m.name}"></td>
      <td><input class="cell-input" id="m-meta-${m.id}" value="${m.meta || ""}"></td>
      <td><input class="cell-input" id="m-price-${m.id}" type="number" style="width:90px;" value="${m.price}"></td>
      <td style="text-align:center;"><input type="checkbox" id="m-from-${m.id}" ${m.price_is_from ? "checked" : ""} style="accent-color:var(--brand);" title="目安価格（〜表示）"></td>
      <td><input class="cell-input" id="m-discount-${m.id}" type="number" style="width:80px;" value="${m.student_discount || 0}"></td>
      <td><input class="cell-input" id="m-duration-${m.id}" type="number" style="width:70px;" value="${m.duration_min}">分</td>
      <td style="white-space:nowrap;">
        <button class="btn-ghost" style="width:auto;display:inline;padding:6px 12px;" onclick="saveMenu('${m.id}')">保存</button>
        <button class="btn-ghost" style="width:auto;display:inline;padding:6px 12px;color:var(--warning);" onclick="deleteMenu('${m.id}')">削除</button>
      </td>
    </tr>`).join("") || `<tr><td colspan="7" style="color:var(--text-muted);">メニューがまだありません</td></tr>`;
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
    if (!nameEl || !metaEl || !priceEl || !durationEl || !fromEl || !discountEl) {
      showMenuMsg("画面の項目が正しく読み込めていません。ページを再読み込みしてもう一度お試しください。", true);
      return;
    }
    const name = nameEl.value.trim();
    const meta = metaEl.value.trim();
    const price = parseInt(priceEl.value, 10);
    const durationMin = parseInt(durationEl.value, 10);
    const priceIsFrom = fromEl.checked;
    const studentDiscount = parseInt(discountEl.value, 10) || 0;
    if (!name || !(price >= 0) || !(durationMin > 0)) {
      showMenuMsg("メニュー名・価格・所要時間を正しく入力してください。", true);
      return;
    }
    await api(`/api/staff/menus/${id}`, { method: "PATCH", body: JSON.stringify({ name, meta, price, durationMin, priceIsFrom, studentDiscount }) });
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
    if (!name || !(price >= 0) || !(durationMin > 0)) {
      showMenuMsg("メニュー名・価格・所要時間を正しく入力してください。", true);
      return;
    }
    await api("/api/staff/menus", { method: "POST", body: JSON.stringify({ name, meta, price, durationMin, priceIsFrom, studentDiscount }) });
    document.getElementById("menu-new-name").value = "";
    document.getElementById("menu-new-meta").value = "";
    document.getElementById("menu-new-price").value = "";
    document.getElementById("menu-new-duration").value = "";
    document.getElementById("menu-new-discount").value = "";
    document.getElementById("menu-new-from").checked = false;
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

/* ---------------- INIT ---------------- */
document.getElementById("login-password").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
checkAuth();
