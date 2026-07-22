/* GARNI アプリ - お客様向けフロントエンド（実APIと通信） */

let MENUS = [];
let STYLISTS = [];
let SETTINGS = { closedWeekdays: [] };
let selectedMenus = new Set();
let booking = { date: null, dateLabel: null, stylistId: null, stylistName: null, time: null };
let stylePhotoDataUrl = null;
let mpReservations = [];
let mpEditPhotos = {};
let calMonthOffset = 0; // 0=今月、1=来月...（カレンダーの月移動用）
const MAX_CAL_MONTHS_AHEAD = 2; // 何ヶ月先まで予約可能にするか（今月含めて3ヶ月分）
const WEEKDAY_NAMES = ["日", "月", "火", "水", "木", "金", "土"];

// Date型から「その端末のローカル日付」のYYYY-MM-DD文字列を作る。
// d.toISOString() はUTCに変換してしまうため、日本(UTC+9)では日付が1日ずれることがあり
// （例: 7/30 0:00 JST → toISOString()は"2026-07-29..."になる）、休業日判定や予約日がずれる
// 原因になっていた。カレンダー表示・選択には必ずこちらを使う。
function toLocalDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

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

function showCScreen(id) {
  document.querySelectorAll(".cscreen").forEach(el => el.classList.toggle("active", el.id === id));
  document.querySelectorAll(".phone-tabbar button").forEach(b => b.classList.toggle("active", b.dataset.tab === id));
  document.querySelector(".phone-screen").scrollTop = 0;
}

function menuCardHtml(m, withCheckbox) {
  const checked = selectedMenus.has(m.id) ? "checked" : "";
  return `
    <div class="menu-card">
      <div class="menu-row">
        ${withCheckbox ? `<input type="checkbox" ${checked} onchange="toggleMenu('${m.id}')">` : ""}
        <div><div class="mname">${m.name}</div>${m.meta ? `<div class="mmeta">${m.meta}</div>` : ""}</div>
      </div>
      <div class="price-col">
        <div class="mprice">¥${m.price.toLocaleString()}${m.price_is_from ? "〜" : ""}</div>
        ${m.student_discount > 0 ? `<div class="mdiscount">学割 -¥${m.student_discount.toLocaleString()}</div>` : ""}
      </div>
    </div>`;
}

function renderMenuList() {
  document.getElementById("menu-list").innerHTML = MENUS.map(m => menuCardHtml(m, true)).join("");
  document.getElementById("home-menu-list").innerHTML = MENUS.slice(0, 3).map(m => menuCardHtml(m, false)).join("");
}
function toggleMenu(id) {
  if (selectedMenus.has(id)) selectedMenus.delete(id); else selectedMenus.add(id);
  renderMenuList();
}

function startBooking() {
  if (selectedMenus.size === 0 && MENUS.length) selectedMenus.add(MENUS[0].id);
  calMonthOffset = 0;
  renderCalendar();
  showCScreen("c-date");
}

function changeCalMonth(delta) {
  const next = calMonthOffset + delta;
  if (next < 0 || next > MAX_CAL_MONTHS_AHEAD) return;
  calMonthOffset = next;
  renderCalendar();
}

function renderCalendar() {
  const today = new Date();
  const base = new Date(today.getFullYear(), today.getMonth() + calMonthOffset, 1);
  const y = base.getFullYear(), m = base.getMonth();
  const closedNames = (SETTINGS.closedWeekdays || []).map(w => WEEKDAY_NAMES[w] + "曜日").join("・");
  document.getElementById("cal-month-label").textContent = `${y}年${m + 1}月` + (closedNames ? `（定休日：${closedNames}）` : "");
  document.getElementById("cal-prev").disabled = calMonthOffset <= 0;
  document.getElementById("cal-next").disabled = calMonthOffset >= MAX_CAL_MONTHS_AHEAD;
  const first = new Date(y, m, 1);
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  let html = WEEKDAY_NAMES.map(d => `<div class="dow">${d}</div>`).join("");
  for (let i = 0; i < first.getDay(); i++) html += `<button disabled></button>`;
  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(y, m, day);
    const isPast = d < new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const iso = toLocalDateStr(d);
    const isClosedWeekday = (SETTINGS.closedWeekdays || []).includes(d.getDay());
    const isClosedDate = (SETTINGS.closedDates || []).includes(iso);
    const isClosed = isClosedWeekday || isClosedDate;
    const disabled = isPast || isClosed;
    html += `<button ${disabled ? "disabled" : ""} onclick="selectDate('${iso}', ${day})" id="cal-${day}" title="${isClosed ? "休業日" : ""}">${day}</button>`;
  }
  document.getElementById("cal-grid").innerHTML = html;
}

function selectDate(iso, day) {
  booking.date = iso;
  booking.dateLabel = iso.replace(/-/g, "/");
  document.querySelectorAll("#cal-grid button").forEach(b => b.classList.remove("sel"));
  document.getElementById("cal-" + day).classList.add("sel");
  renderStylists();
  showCScreen("c-stylist");
}

function renderStylists() {
  document.getElementById("stylist-row").innerHTML = STYLISTS.map(s => `
    <div class="stylist-chip" id="sty-${s.id}" onclick="selectStylist('${s.id}', '${s.name}')">
      <div class="av">${s.name[0]}</div>
      <div class="nm">${s.name}</div>
      <div class="rl">${s.role}</div>
    </div>`).join("");
}

async function selectStylist(id, name) {
  booking.stylistId = id;
  booking.stylistName = name;
  document.querySelectorAll(".stylist-chip").forEach(c => c.classList.remove("sel"));
  document.getElementById("sty-" + id).classList.add("sel");
  await renderSlots();
  showCScreen("c-time");
}

function totalDurationMin() {
  return [...selectedMenus].reduce((sum, id) => {
    const m = MENUS.find(x => x.id === id);
    return sum + (m ? m.duration_min : 0);
  }, 0);
}

async function renderSlots() {
  const errBox = document.getElementById("time-error");
  errBox.classList.remove("show");
  const grid = document.getElementById("slot-grid");
  grid.innerHTML = `<div style="font-size:12px;color:var(--text-muted);">読み込み中...</div>`;
  const duration = totalDurationMin();
  const menuIds = [...selectedMenus].join(",");
  document.getElementById("time-duration-hint").textContent = `合計所要時間：約${duration}分`;
  try {
    const data = await api(`/api/availability?date=${booking.date}&stylistId=${booking.stylistId}&durationMin=${duration}&menuIds=${encodeURIComponent(menuIds)}`);
    if (data.reason === "closed_weekday" || data.reason === "closed_date") {
      grid.innerHTML = "";
      errBox.textContent = "この日は休業日です。別の日を選んでください。";
      errBox.classList.add("show");
      return;
    }
    if (data.reason === "shift_off" || data.slots.length === 0) {
      grid.innerHTML = "";
      errBox.textContent = "この日は担当スタイリストが休みです。別の日を選んでください。";
      errBox.classList.add("show");
      return;
    }
    if (data.lastOrderTime) {
      document.getElementById("time-duration-hint").textContent += `／選択したメニューの最終受付：${data.lastOrderTime}`;
    }
    if (data.sameDayMinTime) {
      document.getElementById("time-duration-hint").textContent += `／本日のご予約は${data.sameDayMinTime}以降のお時間からご案内できます`;
    }
    grid.innerHTML = data.slots.map(s => `
      <button ${s.available ? "" : "disabled"} onclick="selectTime('${s.time}')" id="slot-${s.time.replace(":", "")}">${s.time}</button>
    `).join("");
  } catch (e) {
    errBox.textContent = "空き状況の取得に失敗しました。もう一度お試しください。";
    errBox.classList.add("show");
  }
}

function selectTime(t) {
  booking.time = t;
  document.querySelectorAll("#slot-grid button").forEach(b => b.classList.remove("sel"));
  document.getElementById("slot-" + t.replace(":", "")).classList.add("sel");
  showCScreen("c-info");
}

function goConfirm() {
  const name = document.getElementById("in-name").value.trim();
  const phone = document.getElementById("in-phone").value.trim();
  const errBox = document.getElementById("stylist-error");
  if (!name || !phone) {
    errBox.textContent = "お名前と電話番号を入力してください。";
    errBox.classList.add("show");
    return;
  }
  errBox.classList.remove("show");
  renderConfirm();
  showCScreen("c-confirm");
}

function endTimeLabel(startTime, durationMin) {
  const [h, m] = startTime.split(":").map(Number);
  const total = h * 60 + m + durationMin;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function renderConfirm() {
  const names = [...selectedMenus].map(id => MENUS.find(m => m.id === id));
  const total = names.reduce((a, m) => a + m.price, 0);
  const hasFromPrice = names.some(m => m.price_is_from);
  const totalStudentDiscount = names.reduce((a, m) => a + (m.student_discount || 0), 0);
  const duration = totalDurationMin();
  document.getElementById("confirm-summary").innerHTML = `
    <div class="row"><span>来店日時</span><span>${booking.dateLabel} ${booking.time}〜${endTimeLabel(booking.time, duration)}</span></div>
    <div class="row"><span>メニュー</span><span>${names.map(m => m.name).join("・")}</span></div>
    <div class="row"><span>担当</span><span>${booking.stylistName}</span></div>
    <div class="row total"><span>合計</span><span>¥${total.toLocaleString()}${hasFromPrice ? "〜" : ""}</span></div>
    ${hasFromPrice ? `<div class="row"><span></span><span style="font-size:11px;color:var(--text-muted);">※目安料金を含みます。実際の料金は状態により変動します</span></div>` : ""}
    ${totalStudentDiscount > 0 ? `<div class="row"><span></span><span style="font-size:11px;color:var(--brand-dark);">学生証のご提示で ¥${totalStudentDiscount.toLocaleString()} 引きになります（当日お会計時に適用）</span></div>` : ""}
    ${stylePhotoDataUrl ? `<div class="row"><span>希望スタイル写真</span><span><img src="${stylePhotoDataUrl}" style="width:60px;height:60px;object-fit:cover;border-radius:8px;"></span></div>` : ""}
  `;
}

async function onStylePhotoSelected(input) {
  const preview = document.getElementById("style-photo-preview");
  if (!input.files || !input.files[0]) {
    stylePhotoDataUrl = null;
    preview.innerHTML = "";
    return;
  }
  try {
    stylePhotoDataUrl = await resizeImageFileToDataUrl(input.files[0]);
    preview.innerHTML = `<img src="${stylePhotoDataUrl}" style="width:100px;height:100px;object-fit:cover;border-radius:10px;border:1px solid var(--border);">`;
  } catch (e) {
    stylePhotoDataUrl = null;
    preview.innerHTML = `<div style="font-size:11.5px;color:var(--warning);">写真の読み込みに失敗しました。もう一度お試しください。</div>`;
  }
}

async function finishBooking() {
  const btn = document.getElementById("btn-confirm");
  const errBox = document.getElementById("confirm-error");
  errBox.classList.remove("show");
  btn.disabled = true;
  try {
    await api("/api/reservations", {
      method: "POST",
      body: JSON.stringify({
        date: booking.date,
        time: booking.time,
        stylistId: booking.stylistId,
        menuIds: [...selectedMenus],
        customerName: document.getElementById("in-name").value.trim(),
        customerPhone: document.getElementById("in-phone").value.trim(),
        customerGender: document.getElementById("in-gender").value || null,
        customerAge: document.getElementById("in-age").value ? parseInt(document.getElementById("in-age").value, 10) : null,
        note: document.getElementById("in-note").value.trim(),
        stylePhoto: stylePhotoDataUrl,
      }),
    });
    stylePhotoDataUrl = null;
    document.getElementById("style-photo-preview").innerHTML = "";
    document.getElementById("in-style-photo").value = "";
    showCScreen("c-success");
  } catch (e) {
    errBox.textContent = e.message + "（別の時間帯を選び直してください）";
    errBox.classList.add("show");
  } finally {
    btn.disabled = false;
  }
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function toICSUTCStamp(date) {
  return `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}T${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}${pad2(date.getUTCSeconds())}Z`;
}

function buildReservationICS(dateStr, timeStr, durationMin, menuNames) {
  const [y, mo, d] = dateStr.split("-");
  const [h, mi] = timeStr.split(":");
  const startDt = `${y}${mo}${d}T${h}${mi}00`;
  const endLabel = endTimeLabel(timeStr, durationMin || 60).replace(":", "");
  const endDt = `${y}${mo}${d}T${endLabel}00`;
  const uid = `${dateStr}-${timeStr.replace(":", "")}-${Math.random().toString(36).slice(2)}@garni-app`;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//GARNI//Reservation//JP",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${toICSUTCStamp(new Date())}`,
    `DTSTART:${startDt}`,
    `DTEND:${endDt}`,
    `SUMMARY:GARNI ご予約（${menuNames}）`,
    "DESCRIPTION:GARNIでのご予約です。",
    "LOCATION:GARNI",
    "BEGIN:VALARM",
    "TRIGGER:-P1D",
    "ACTION:DISPLAY",
    "DESCRIPTION:明日はGARNIのご予約日です",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.join("\r\n");
}

function downloadICS(dateStr, timeStr, durationMin, menuNames) {
  const ics = buildReservationICS(dateStr, timeStr, durationMin, menuNames);
  const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "garni-reservation.ics";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadBookingICS() {
  const names = [...selectedMenus].map(id => MENUS.find(m => m.id === id)).filter(Boolean);
  const menuNames = names.map(m => m.name).join("・") || "ご予約";
  downloadICS(booking.date, booking.time, totalDurationMin(), menuNames);
}

async function lookupMyPage() {
  const phone = document.getElementById("mp-phone").value.trim();
  const errBox = document.getElementById("mypage-error");
  errBox.classList.remove("show");
  if (!phone) { errBox.textContent = "電話番号を入力してください。"; errBox.classList.add("show"); return; }
  try {
    const data = await api(`/api/mypage?phone=${encodeURIComponent(phone)}`);
    if (!data.found) {
      errBox.textContent = "ご予約情報が見つかりませんでした。予約時と同じ電話番号でお試しください。";
      errBox.classList.add("show");
      return;
    }
    document.getElementById("mypage-lookup").style.display = "none";
    document.getElementById("mypage-result").style.display = "block";
    document.getElementById("mp-rank").textContent = "会員ランク：" + data.customer.rank;
    document.getElementById("mp-pts").textContent = data.customer.points.toLocaleString() + " pt";
    mpEditPhotos = {};
    mpReservations = data.reservations;
    renderMpHistory();
  } catch (e) {
    errBox.textContent = "取得に失敗しました。もう一度お試しください。";
    errBox.classList.add("show");
  }
}

function mpPhotoHtml(path, label, placeholder) {
  return `<div class="ph-col">
    <div class="ph-label">${label}</div>
    ${path
      ? `<a href="${path}" target="_blank"><img class="thumb-lg" src="${path}"></a>`
      : `<div style="font-size:11px;color:var(--text-muted);">${placeholder}</div>`}
  </div>`;
}

function mpHistoryItemHtml(r) {
  const badge = r.status === "visited" ? '<span class="badge done">来店済み</span>'
              : r.status === "cancel" ? '<span class="badge cancel">キャンセル</span>'
              : r.status === "no_show" ? '<span class="badge cancel">無断キャンセル</span>'
              : '<span class="badge upcoming">予約済</span>';
  const isWait = r.status === "wait";
  const staged = mpEditPhotos[r.id];
  const stylePhotoForDisplay = staged || r.style_photo_path;
  let editSection = "";
  if (isWait) {
    const noteVal = (r.note || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    editSection = `
      <div class="field" style="margin-top:10px;">
        <label>ご要望・リクエスト</label>
        <textarea id="mp-note-${r.id}" placeholder="例：前回より短めにしたいです">${noteVal}</textarea>
      </div>
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <label class="photo-upload-btn">
          ＋ 希望スタイル写真を選ぶ
          <input type="file" accept="image/*" onchange="onMpPhotoSelected('${r.id}', this)">
        </label>
        <div id="mp-photo-preview-${r.id}">${staged ? `<img src="${staged}" style="width:56px;height:56px;object-fit:cover;border-radius:8px;">` : ""}</div>
      </div>
      <div class="error-banner" id="mp-msg-${r.id}" style="margin-top:8px;"></div>
      <button class="btn-primary" style="margin-top:8px;max-width:160px;" onclick="saveMyPageEdit('${r.id}')">保存する</button>
      <button class="btn-ghost" style="border:1px dashed var(--brand);border-radius:10px;color:var(--brand-dark);margin-top:8px;padding:8px;" onclick="downloadICS('${r.date}', '${r.time}', ${r.duration_min || 60}, '${(r.menu_names || "").replace(/'/g, "\\'")}')">📅 カレンダーに追加</button>
    `;
  } else if (r.note) {
    editSection = `<div style="font-size:12px;color:var(--text-muted);margin-top:8px;">ご要望：${r.note}</div>`;
  }
  return `
    <div class="hist-block">
      <div class="hist-item">
        <div><div style="font-weight:700;">${r.menu_names}</div><div class="d">${r.date} ${r.time}</div></div>
        ${badge}
      </div>
      <div class="photo-pair">
        ${mpPhotoHtml(stylePhotoForDisplay, "希望スタイル", "写真なし")}
        ${mpPhotoHtml(r.after_photo_path, "施術後", isWait ? "来店後に追加されます" : "写真なし")}
      </div>
      ${editSection}
    </div>`;
}

function renderMpHistory() {
  document.getElementById("mp-history").innerHTML = mpReservations.map(mpHistoryItemHtml).join("")
    || `<div style="font-size:12.5px;color:var(--text-muted);">予約履歴はまだありません</div>`;
}

async function onMpPhotoSelected(id, input) {
  const preview = document.getElementById(`mp-photo-preview-${id}`);
  if (!input.files || !input.files[0]) return;
  try {
    const dataUrl = await resizeImageFileToDataUrl(input.files[0]);
    mpEditPhotos[id] = dataUrl;
    if (preview) preview.innerHTML = `<img src="${dataUrl}" style="width:56px;height:56px;object-fit:cover;border-radius:8px;">`;
  } catch (e) {
    if (preview) preview.innerHTML = `<div style="font-size:11px;color:var(--warning);">写真の読み込みに失敗しました</div>`;
  }
}

async function saveMyPageEdit(id) {
  const msgBox = document.getElementById(`mp-msg-${id}`);
  if (msgBox) msgBox.classList.remove("show");
  try {
    const phone = document.getElementById("mp-phone").value.trim();
    const noteEl = document.getElementById(`mp-note-${id}`);
    const note = noteEl ? noteEl.value.trim() : "";
    const body = { phone, note };
    if (mpEditPhotos[id]) body.stylePhoto = mpEditPhotos[id];
    const updated = await api(`/api/mypage/reservations/${id}`, { method: "PATCH", body: JSON.stringify(body) });
    delete mpEditPhotos[id];
    const idx = mpReservations.findIndex(r => r.id === id);
    if (idx !== -1) mpReservations[idx] = updated;
    renderMpHistory();
    const newMsgBox = document.getElementById(`mp-msg-${id}`);
    if (newMsgBox) {
      newMsgBox.textContent = "保存しました。";
      newMsgBox.style.background = "#e7f6e7";
      newMsgBox.style.borderColor = "var(--good)";
      newMsgBox.style.color = "#0a6b0a";
      newMsgBox.classList.add("show");
    }
  } catch (e) {
    if (msgBox) {
      msgBox.textContent = "保存に失敗しました：" + e.message;
      msgBox.classList.add("show");
    }
  }
}

function resetMyPage() {
  document.getElementById("mypage-lookup").style.display = "block";
  document.getElementById("mypage-result").style.display = "none";
  document.getElementById("mp-phone").value = "";
  mpReservations = [];
  mpEditPhotos = {};
}

async function init() {
  [MENUS, STYLISTS, SETTINGS] = await Promise.all([
    api("/api/menus"),
    api("/api/stylists"),
    api("/api/settings"),
  ]);
  renderMenuList();
}
init();
