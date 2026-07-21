/* GARNI アプリ - お客様向けフロントエンド（実APIと通信） */

let MENUS = [];
let STYLISTS = [];
let SETTINGS = { closedWeekdays: [] };
let selectedMenus = new Set();
let booking = { date: null, dateLabel: null, stylistId: null, stylistName: null, time: null };
let stylePhotoDataUrl = null;
const WEEKDAY_NAMES = ["日", "月", "火", "水", "木", "金", "土"];

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
        <div><div class="mname">${m.name}</div><div class="mmeta">${m.meta || ""} / ${m.duration_min}分</div></div>
      </div>
      <div class="mprice">¥${m.price.toLocaleString()}</div>
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
  renderCalendar();
  showCScreen("c-date");
}

function renderCalendar() {
  const today = new Date();
  const y = today.getFullYear(), m = today.getMonth();
  const closedNames = (SETTINGS.closedWeekdays || []).map(w => WEEKDAY_NAMES[w] + "曜日").join("・");
  document.getElementById("cal-month-label").textContent = `${y}年${m + 1}月` + (closedNames ? `（定休日：${closedNames}）` : "");
  const first = new Date(y, m, 1);
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  let html = WEEKDAY_NAMES.map(d => `<div class="dow">${d}</div>`).join("");
  for (let i = 0; i < first.getDay(); i++) html += `<button disabled></button>`;
  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(y, m, day);
    const isPast = d < new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const isClosed = (SETTINGS.closedWeekdays || []).includes(d.getDay());
    const iso = d.toISOString().slice(0, 10);
    const disabled = isPast || isClosed;
    html += `<button ${disabled ? "disabled" : ""} onclick="selectDate('${iso}', ${day})" id="cal-${day}" title="${isClosed ? "定休日" : ""}">${day}</button>`;
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
  document.getElementById("time-duration-hint").textContent = `合計所要時間：約${duration}分`;
  try {
    const data = await api(`/api/availability?date=${booking.date}&stylistId=${booking.stylistId}&durationMin=${duration}`);
    if (data.reason === "closed_weekday") {
      grid.innerHTML = "";
      errBox.textContent = "この日は定休日です。別の日を選んでください。";
      errBox.classList.add("show");
      return;
    }
    if (data.reason === "shift_off" || data.slots.length === 0) {
      grid.innerHTML = "";
      errBox.textContent = "この日は担当スタイリストが休みです。別の日を選んでください。";
      errBox.classList.add("show");
      return;
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
  const duration = totalDurationMin();
  document.getElementById("confirm-summary").innerHTML = `
    <div class="row"><span>来店日時</span><span>${booking.dateLabel} ${booking.time}〜${endTimeLabel(booking.time, duration)}</span></div>
    <div class="row"><span>メニュー</span><span>${names.map(m => m.name).join("・")}</span></div>
    <div class="row"><span>担当</span><span>${booking.stylistName}</span></div>
    <div class="row total"><span>合計</span><span>¥${total.toLocaleString()}</span></div>
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
    document.getElementById("mp-history").innerHTML = data.reservations.map(r => {
      const badge = r.status === "visited" ? '<span class="badge done">来店済み</span>'
                  : r.status === "cancel" ? '<span class="badge cancel">キャンセル</span>'
                  : '<span class="badge upcoming">予約済</span>';
      return `<div class="hist-item">
        <div><div style="font-weight:700;">${r.menu_names}</div><div class="d">${r.date} ${r.time}</div></div>
        ${badge}
      </div>`;
    }).join("") || `<div style="font-size:12.5px;color:var(--text-muted);">予約履歴はまだありません</div>`;
  } catch (e) {
    errBox.textContent = "取得に失敗しました。もう一度お試しください。";
    errBox.classList.add("show");
  }
}
function resetMyPage() {
  document.getElementById("mypage-lookup").style.display = "block";
  document.getElementById("mypage-result").style.display = "none";
  document.getElementById("mp-phone").value = "";
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
