"""
GARNI アプリ - サーバー本体
Python標準ライブラリのみで動作（http.server + sqlite3）。追加インストール不要。

起動:  python3 server.py [PORT]
既定ポート: 8000
"""
import json
import os
import re
import sys
import uuid
import base64
import binascii
import mimetypes
import calendar
import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import db

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
UPLOADS_DIR = os.path.join(STATIC_DIR, "uploads")
MAX_PHOTO_BYTES = 6 * 1024 * 1024  # 6MB（アップロード前にブラウザ側でリサイズ済みの想定）

STAFF_PASSWORD = os.environ.get("GARNI_STAFF_PASSWORD", "garni2026")
SESSIONS = {}  # token -> created_at (in-memory; MVP用。本番では永続セッションストアを推奨)

SLOT_TIMES = ["10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00"]
DEFAULT_OPEN_MIN = 10 * 60   # 設定が無い場合のデフォルト営業開始 10:00
DEFAULT_CLOSE_MIN = 19 * 60  # 設定が無い場合のデフォルト営業終了 19:00
TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")  # HH:MM 形式のチェック用


# ---------------------------------------------------------------- helpers
def json_default(o):
    return str(o)


def time_to_min(hhmm):
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def min_to_time(total_min):
    return f"{total_min // 60:02d}:{total_min % 60:02d}"


def parse_shift_range(label):
    """'10-19' -> (600, 1140)。'off' や None は None を返す。"""
    if not label or label == "off":
        return None
    m = re.match(r"^(\d{1,2})-(\d{1,2})$", label)
    if not m:
        return None
    return int(m.group(1)) * 60, int(m.group(2)) * 60


def ranges_overlap(a_start, a_end, b_start, b_end):
    return a_start < b_end and b_start < a_end


def menu_duration_total(conn, menu_ids):
    rows = conn.execute(
        "SELECT * FROM menu_items WHERE id IN (%s)" % ",".join("?" * len(menu_ids)), menu_ids
    ).fetchall()
    return rows, sum(r["duration_min"] for r in rows), sum(r["price"] for r in rows)


def row_to_dict(row):
    return {k: row[k] for k in row.keys()}


def rows_to_list(rows):
    return [row_to_dict(r) for r in rows]


def month_range(month_str):
    """'YYYY-MM' -> (first_day, last_day) as 'YYYY-MM-DD' strings"""
    y, m = [int(x) for x in month_str.split("-")]
    last = calendar.monthrange(y, m)[1]
    return f"{y:04d}-{m:02d}-01", f"{y:04d}-{m:02d}-{last:02d}"


def save_data_url_image(data_url, dest_subdir, filename_base):
    """'data:image/jpeg;base64,....' 形式の文字列をファイルとして static/uploads/ 配下に保存し、
    公開URLパス（'/static/uploads/...'）を返す。不正な入力の場合は None を返す。"""
    if not data_url or not isinstance(data_url, str) or not data_url.startswith("data:image/"):
        return None
    try:
        header, b64data = data_url.split(",", 1)
    except ValueError:
        return None
    ext = "jpg"
    if "png" in header:
        ext = "png"
    elif "webp" in header:
        ext = "webp"
    elif "jpeg" in header or "jpg" in header:
        ext = "jpg"
    try:
        raw = base64.b64decode(b64data, validate=True)
    except (binascii.Error, ValueError):
        return None
    if not raw or len(raw) > MAX_PHOTO_BYTES:
        return None
    dest_dir = os.path.join(UPLOADS_DIR, dest_subdir)
    os.makedirs(dest_dir, exist_ok=True)
    filename = f"{filename_base}.{ext}"
    full_path = os.path.join(dest_dir, filename)
    with open(full_path, "wb") as f:
        f.write(raw)
    rel = os.path.relpath(full_path, STATIC_DIR).replace(os.sep, "/")
    return f"/static/{rel}"


AGE_BUCKET_ORDER = ["10代以下", "20代", "30代", "40代", "50代", "60代以上", "未回答"]


def age_bucket(age):
    if age is None:
        return "未回答"
    if age < 20:
        return "10代以下"
    if age >= 60:
        return "60代以上"
    return f"{(age // 10) * 10}代"


def pct(count, total):
    return round((count / total) * 100, 1) if total else 0.0


def get_settings(conn):
    row = conn.execute("SELECT * FROM salon_settings WHERE id=1").fetchone()
    return row_to_dict(row) if row else {
        "open_time": "10:00", "close_time": "19:00", "closed_weekdays": "1",
    }


def closed_weekdays_set(settings):
    raw = (settings.get("closed_weekdays") or "").strip()
    if not raw:
        return set()
    return {int(x) for x in raw.split(",") if x.strip().isdigit()}


def closed_dates_set(conn):
    """不定休など、個別に指定された臨時休業日（YYYY-MM-DD）の集合を返す。"""
    rows = conn.execute("SELECT date FROM closed_dates").fetchall()
    return {r["date"] for r in rows}


def weekday_js(date_str):
    """YYYY-MM-DD -> JS流の曜日番号 (0=日曜 ... 6=土曜)"""
    d = datetime.date.fromisoformat(date_str)
    return (d.weekday() + 1) % 7  # Python: 月=0..日=6 -> JS: 日=0..土=6


def business_hours_range(settings):
    try:
        return time_to_min(settings["open_time"]), time_to_min(settings["close_time"])
    except Exception:
        return DEFAULT_OPEN_MIN, DEFAULT_CLOSE_MIN


def effective_last_order_min(conn, settings, menu_ids):
    """選択されたメニューから、その日の最終受付時刻（分）を計算する。
    各メニューに設定された最終受付時刻のうち最も早いものを採用し、
    さらに「パーマ」と「カラー」が両方含まれる場合は、専用の最終受付時刻も考慮する。
    該当する制限が無ければ None を返す（営業時間いっぱいまで受付可）。"""
    if not menu_ids:
        return None
    rows = conn.execute(
        "SELECT name, last_order_time FROM menu_items WHERE id IN (%s)" % ",".join("?" * len(menu_ids)),
        menu_ids,
    ).fetchall()
    names = {r["name"] for r in rows}
    candidates = [time_to_min(r["last_order_time"]) for r in rows if r["last_order_time"]]
    combo_time = settings.get("combo_perm_color_last_order")
    if combo_time and "パーマ" in names and "カラー" in names:
        candidates.append(time_to_min(combo_time))
    return min(candidates) if candidates else None


# ---------------------------------------------------------------- handler
class Handler(BaseHTTPRequestHandler):
    server_version = "GarniApp/1.0"

    def do_HEAD(self):
        # Render等のホスティングサービスがヘルスチェックでHEADリクエストを送ってくることがあるため、
        # 常に200 OKを返す（ログに 501 Unsupported method が出るのを防ぐ）。
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    # ---------- low level send helpers ----------
    def send_json(self, status, obj, extra_headers=None):
        body = json.dumps(obj, ensure_ascii=False, default=json_default).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if extra_headers:
            for k, v in extra_headers.items():
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path, content_type=None):
        if not os.path.isfile(path):
            self.send_json(404, {"error": "not found"})
            return
        if content_type is None:
            content_type, _ = mimetypes.guess_type(path)
            content_type = content_type or "application/octet-stream"
        with open(path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", content_type + ("; charset=utf-8" if content_type.startswith("text") or "javascript" in content_type else ""))
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_raw(self):
        if not hasattr(self, "_raw_body"):
            length = int(self.headers.get("Content-Length", 0) or 0)
            self._raw_body = self.rfile.read(length) if length else b""
        return self._raw_body

    def read_json(self):
        raw = self.read_raw()
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def get_cookie(self, name):
        cookie_header = self.headers.get("Cookie", "")
        for part in cookie_header.split(";"):
            part = part.strip()
            if part.startswith(name + "="):
                return part[len(name) + 1:]
        return None

    def require_staff(self):
        token = self.get_cookie("garni_session")
        if token and token in SESSIONS:
            return True
        self.send_json(401, {"error": "スタッフログインが必要です"})
        return False

    # ---------- routing ----------
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = {k: v[0] for k, v in parse_qs(parsed.query).items()}

        if path == "/" or path == "/index.html":
            return self.send_file(os.path.join(STATIC_DIR, "customer", "index.html"))
        if path == "/staff" or path == "/staff/" or path == "/staff/index.html":
            return self.send_file(os.path.join(STATIC_DIR, "staff", "index.html"))
        if path.startswith("/static/"):
            rel = path[len("/static/"):]
            full = os.path.normpath(os.path.join(STATIC_DIR, rel))
            if not full.startswith(STATIC_DIR):
                return self.send_json(403, {"error": "forbidden"})
            return self.send_file(full)

        # ---- public API ----
        if path == "/api/menus":
            conn = db.get_conn()
            rows = conn.execute("SELECT * FROM menu_items ORDER BY sort_order").fetchall()
            conn.close()
            return self.send_json(200, rows_to_list(rows))

        if path == "/api/stylists":
            conn = db.get_conn()
            rows = conn.execute("SELECT * FROM stylists ORDER BY sort_order").fetchall()
            conn.close()
            return self.send_json(200, rows_to_list(rows))

        if path == "/api/availability":
            date = qs.get("date")
            stylist_id = qs.get("stylistId")
            try:
                duration = int(qs.get("durationMin", "60"))
            except ValueError:
                duration = 60
            menu_ids = [x for x in (qs.get("menuIds") or "").split(",") if x]
            if not date or not stylist_id:
                return self.send_json(400, {"error": "date, stylistId が必要です"})
            conn = db.get_conn()
            settings = get_settings(conn)
            if weekday_js(date) in closed_weekdays_set(settings):
                conn.close()
                return self.send_json(200, {"slots": [], "reason": "closed_weekday"})
            if date in closed_dates_set(conn):
                conn.close()
                return self.send_json(200, {"slots": [], "reason": "closed_date"})
            shift = conn.execute(
                "SELECT label FROM shifts WHERE stylist_id=? AND date=?", (stylist_id, date)
            ).fetchone()
            if shift and shift["label"] == "off":
                conn.close()
                return self.send_json(200, {"slots": [], "reason": "shift_off"})
            business_range = business_hours_range(settings)
            shift_range = parse_shift_range(shift["label"]) if shift else business_range
            if shift_range is None:
                shift_range = business_range
            open_min, close_min = shift_range
            # 営業時間の外側にはみ出さないようクリップする
            open_min = max(open_min, business_range[0])
            close_min = min(close_min, business_range[1])
            last_order_min = effective_last_order_min(conn, settings, menu_ids)

            existing = conn.execute(
                "SELECT time, duration_min FROM reservations WHERE date=? AND stylist_id=? AND status != 'cancel'",
                (date, stylist_id),
            ).fetchall()
            conn.close()
            busy_ranges = [(time_to_min(r["time"]), time_to_min(r["time"]) + r["duration_min"]) for r in existing]

            slots = []
            for t in SLOT_TIMES:
                start = time_to_min(t)
                end = start + duration
                fits_hours = start >= open_min and end <= close_min
                within_last_order = last_order_min is None or start <= last_order_min
                conflict = any(ranges_overlap(start, end, bs, be) for bs, be in busy_ranges)
                slots.append({"time": t, "available": fits_hours and within_last_order and not conflict})
            return self.send_json(200, {
                "slots": slots,
                "reason": None,
                "closeTime": min_to_time(close_min),
                "lastOrderTime": min_to_time(last_order_min) if last_order_min is not None else None,
            })

        if path == "/api/mypage":
            phone = qs.get("phone", "").strip()
            conn = db.get_conn()
            cust = conn.execute("SELECT * FROM customers WHERE phone=?", (phone,)).fetchone()
            if not cust:
                conn.close()
                return self.send_json(200, {"found": False})
            resv = conn.execute(
                "SELECT * FROM reservations WHERE customer_id=? ORDER BY date DESC, time DESC",
                (cust["id"],),
            ).fetchall()
            conn.close()
            return self.send_json(200, {"found": True, "customer": row_to_dict(cust), "reservations": rows_to_list(resv)})

        if path == "/api/me":
            token = self.get_cookie("garni_session")
            return self.send_json(200, {"authenticated": bool(token and token in SESSIONS)})

        if path == "/api/settings":
            conn = db.get_conn()
            settings = get_settings(conn)
            closed_dates = sorted(closed_dates_set(conn))
            conn.close()
            return self.send_json(200, {
                "openTime": settings["open_time"],
                "closeTime": settings["close_time"],
                "closedWeekdays": sorted(closed_weekdays_set(settings)),
                "closedDates": closed_dates,
                "comboPermColorLastOrder": settings.get("combo_perm_color_last_order"),
            })

        # ---- staff API (auth required) ----
        if path == "/api/staff/settings":
            if not self.require_staff():
                return
            conn = db.get_conn()
            settings = get_settings(conn)
            closed_dates = sorted(closed_dates_set(conn))
            conn.close()
            return self.send_json(200, {
                "openTime": settings["open_time"],
                "closeTime": settings["close_time"],
                "closedWeekdays": sorted(closed_weekdays_set(settings)),
                "closedDates": closed_dates,
                "comboPermColorLastOrder": settings.get("combo_perm_color_last_order"),
            })
        if path == "/api/staff/reservations":
            if not self.require_staff():
                return
            date = qs.get("date") or datetime.date.today().isoformat()
            conn = db.get_conn()
            rows = conn.execute(
                "SELECT r.*, s.name as stylist_name FROM reservations r JOIN stylists s ON r.stylist_id = s.id "
                "WHERE r.date=? ORDER BY r.time",
                (date,),
            ).fetchall()
            conn.close()
            return self.send_json(200, rows_to_list(rows))

        if path == "/api/staff/customers":
            if not self.require_staff():
                return
            conn = db.get_conn()
            rows = conn.execute(
                """SELECT c.*, (SELECT MAX(date) FROM reservations r WHERE r.customer_id=c.id) as last_visit
                   FROM customers c ORDER BY last_visit DESC"""
            ).fetchall()
            conn.close()
            return self.send_json(200, rows_to_list(rows))

        m = re.match(r"^/api/staff/customers/([\w-]+)$", path)
        if m:
            if not self.require_staff():
                return
            cid = m.group(1)
            conn = db.get_conn()
            cust = conn.execute("SELECT * FROM customers WHERE id=?", (cid,)).fetchone()
            if not cust:
                conn.close()
                return self.send_json(404, {"error": "not found"})
            karte = conn.execute(
                "SELECT k.*, r.style_photo_path as style_photo_path FROM karte_entries k "
                "LEFT JOIN reservations r ON k.reservation_id = r.id "
                "WHERE k.customer_id=? ORDER BY k.date DESC",
                (cid,),
            ).fetchall()
            conn.close()
            return self.send_json(200, {"customer": row_to_dict(cust), "history": rows_to_list(karte)})

        if path == "/api/staff/shifts":
            if not self.require_staff():
                return
            week_start = qs.get("weekStart")
            if not week_start:
                return self.send_json(400, {"error": "weekStart が必要です"})
            start = datetime.date.fromisoformat(week_start)
            days = [(start + datetime.timedelta(days=i)).isoformat() for i in range(7)]
            conn = db.get_conn()
            stylists = conn.execute("SELECT * FROM stylists ORDER BY sort_order").fetchall()
            shift_rows = conn.execute(
                "SELECT * FROM shifts WHERE date IN (%s)" % ",".join("?" * len(days)), days
            ).fetchall()
            conn.close()
            shift_map = {}
            for r in shift_rows:
                shift_map.setdefault(r["stylist_id"], {})[r["date"]] = r["label"]
            grid = []
            for s in stylists:
                row = {"stylistId": s["id"], "name": s["name"], "cells": []}
                for d in days:
                    row["cells"].append({"date": d, "label": shift_map.get(s["id"], {}).get(d, "off")})
                grid.append(row)
            return self.send_json(200, {"days": days, "grid": grid})

        if path == "/api/staff/customer-stats":
            if not self.require_staff():
                return
            conn = db.get_conn()
            menu_rows = conn.execute("SELECT id, name FROM menu_items ORDER BY sort_order").fetchall()
            resv_rows = conn.execute(
                "SELECT customer_id, menu_names FROM reservations WHERE status != 'cancel'"
            ).fetchall()
            all_customers = conn.execute("SELECT gender, age FROM customers").fetchall()
            conn.close()

            # カテゴリー別：そのメニューを一度でも予約したことがある「お客様数」と割合
            customer_categories = {}
            visited_customer_ids = set()
            for r in resv_rows:
                visited_customer_ids.add(r["customer_id"])
                names = set(r["menu_names"].split("・")) if r["menu_names"] else set()
                customer_categories.setdefault(r["customer_id"], set()).update(names)
            total_customers_with_reservation = len(visited_customer_ids)
            categories = []
            for m in menu_rows:
                count = sum(1 for cats in customer_categories.values() if m["name"] in cats)
                categories.append({
                    "id": m["id"],
                    "name": m["name"],
                    "count": count,
                    "percentage": pct(count, total_customers_with_reservation),
                })

            # 性別・年齢層別：登録されている全お客様が対象
            total_all_customers = len(all_customers)
            gender_counts = {"男性": 0, "女性": 0, "未回答": 0}
            age_counts = {label: 0 for label in AGE_BUCKET_ORDER}
            for c in all_customers:
                g = c["gender"] if c["gender"] in ("男性", "女性") else "未回答"
                gender_counts[g] += 1
                age_counts[age_bucket(c["age"])] += 1
            gender = [
                {"label": label, "count": count, "percentage": pct(count, total_all_customers)}
                for label, count in gender_counts.items()
            ]
            age = [
                {"label": label, "count": age_counts[label], "percentage": pct(age_counts[label], total_all_customers)}
                for label in AGE_BUCKET_ORDER
            ]
            return self.send_json(200, {
                "totalCustomersWithReservation": total_customers_with_reservation,
                "totalCustomers": total_all_customers,
                "categories": categories,
                "gender": gender,
                "age": age,
            })

        if path == "/api/staff/dashboard":
            if not self.require_staff():
                return
            date = qs.get("date") or datetime.date.today().isoformat()
            conn = db.get_conn()
            today_resv = conn.execute(
                "SELECT r.*, s.name as stylist_name FROM reservations r JOIN stylists s ON r.stylist_id=s.id "
                "WHERE r.date=? ORDER BY r.time", (date,)
            ).fetchall()
            d = datetime.date.fromisoformat(date)
            week = [(d - datetime.timedelta(days=(6 - i))).isoformat() for i in range(7)]
            sales = []
            for wd in week:
                row = conn.execute(
                    "SELECT COALESCE(SUM(total_price),0) as v FROM reservations WHERE date=? AND status != 'cancel'",
                    (wd,),
                ).fetchone()
                sales.append({"date": wd, "value": row["v"]})
            month_first, _ = month_range(d.strftime("%Y-%m"))
            new_cust = conn.execute(
                "SELECT COUNT(*) c FROM customers WHERE created_at >= ?", (month_first,)
            ).fetchone()["c"]
            conn.close()
            active = [r for r in today_resv if r["status"] != "cancel"]
            today_total = sum(r["total_price"] for r in active)
            return self.send_json(200, {
                "todayCount": len(active),
                "todaySales": today_total,
                "newCustomersThisMonth": new_cust,
                "weeklySales": sales,
                "todayReservations": rows_to_list(today_resv),
            })

        return self.send_json(404, {"error": "not found"})

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        body = self.read_json()

        if path == "/api/login":
            password = body.get("password", "")
            if password == STAFF_PASSWORD:
                token = uuid.uuid4().hex
                SESSIONS[token] = db.now_iso()
                cookie = f"garni_session={token}; Path=/; HttpOnly; SameSite=Lax"
                return self.send_json(200, {"ok": True}, extra_headers={"Set-Cookie": cookie})
            return self.send_json(401, {"ok": False, "error": "パスワードが違います"})

        if path == "/api/logout":
            token = self.get_cookie("garni_session")
            if token in SESSIONS:
                del SESSIONS[token]
            return self.send_json(200, {"ok": True}, extra_headers={"Set-Cookie": "garni_session=; Path=/; Max-Age=0"})

        if path == "/api/reservations":
            required = ["date", "time", "stylistId", "menuIds", "customerName", "customerPhone"]
            if not all(k in body and body[k] for k in required):
                return self.send_json(400, {"error": "入力が不足しています"})
            date, time_, stylist_id = body["date"], body["time"], body["stylistId"]
            menu_ids = body["menuIds"]
            name, phone = body["customerName"].strip(), re.sub(r"\D", "", body["customerPhone"])
            note = body.get("note", "")
            gender = body.get("customerGender") or None
            if gender not in ("男性", "女性"):
                gender = None
            age_raw = body.get("customerAge")
            age = None
            if isinstance(age_raw, (int, float)) and 0 < age_raw < 120:
                age = int(age_raw)

            conn = db.get_conn()
            settings = get_settings(conn)
            if weekday_js(date) in closed_weekdays_set(settings):
                conn.close()
                return self.send_json(409, {"error": "その日は定休日です"})
            if date in closed_dates_set(conn):
                conn.close()
                return self.send_json(409, {"error": "その日は臨時休業日です"})
            menu_rows, total_duration, total_price = menu_duration_total(conn, menu_ids)
            if not menu_rows:
                conn.close()
                return self.send_json(400, {"error": "メニューを選択してください"})
            menu_names = "・".join(r["name"] for r in menu_rows)

            shift = conn.execute(
                "SELECT label FROM shifts WHERE stylist_id=? AND date=?", (stylist_id, date)
            ).fetchone()
            if shift and shift["label"] == "off":
                conn.close()
                return self.send_json(409, {"error": "指定のスタイリストは休みの日です"})
            business_range = business_hours_range(settings)
            shift_range = parse_shift_range(shift["label"]) if shift else business_range
            if shift_range is None:
                shift_range = business_range
            open_min, close_min = shift_range
            open_min = max(open_min, business_range[0])
            close_min = min(close_min, business_range[1])
            req_start = time_to_min(time_)
            req_end = req_start + total_duration
            if req_start < open_min or req_end > close_min:
                conn.close()
                return self.send_json(409, {"error": f"選択したメニューの所要時間（{total_duration}分）だと営業時間内に収まりません"})
            last_order_min = effective_last_order_min(conn, settings, menu_ids)
            if last_order_min is not None and req_start > last_order_min:
                conn.close()
                return self.send_json(409, {"error": f"選択したメニューの最終受付時間（{min_to_time(last_order_min)}）を過ぎています"})

            existing = conn.execute(
                "SELECT time, duration_min FROM reservations WHERE date=? AND stylist_id=? AND status != 'cancel'",
                (date, stylist_id),
            ).fetchall()
            for r in existing:
                bs = time_to_min(r["time"])
                be = bs + r["duration_min"]
                if ranges_overlap(req_start, req_end, bs, be):
                    conn.close()
                    return self.send_json(409, {"error": "この時間帯はすでに予約が入っています"})

            cust = conn.execute("SELECT * FROM customers WHERE phone=?", (phone,)).fetchone()
            if cust:
                customer_id = cust["id"]
                if cust["name"] != name:
                    conn.execute("UPDATE customers SET name=? WHERE id=?", (name, customer_id))
                if gender is not None:
                    conn.execute("UPDATE customers SET gender=? WHERE id=?", (gender, customer_id))
                if age is not None:
                    conn.execute("UPDATE customers SET age=? WHERE id=?", (age, customer_id))
            else:
                customer_id = db.new_id()
                conn.execute(
                    "INSERT INTO customers (id, name, phone, rank, points, gender, age, created_at) VALUES (?,?,?,?,?,?,?,?)",
                    (customer_id, name, phone, "新規", 0, gender, age, db.now_iso()),
                )

            resv_id = db.new_id()
            conn.execute(
                """INSERT INTO reservations
                   (id, customer_id, customer_name, customer_phone, date, time, stylist_id, menu_names, total_price, duration_min, note, status, created_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (resv_id, customer_id, name, phone, date, time_, stylist_id, menu_names, total_price, total_duration, note, "wait", db.now_iso()),
            )
            style_photo_path = save_data_url_image(body.get("stylePhoto"), "reservations", resv_id)
            if style_photo_path:
                conn.execute("UPDATE reservations SET style_photo_path=? WHERE id=?", (style_photo_path, resv_id))
            conn.commit()
            created = conn.execute("SELECT * FROM reservations WHERE id=?", (resv_id,)).fetchone()
            conn.close()
            return self.send_json(201, row_to_dict(created))

        if path == "/api/staff/shifts":
            if not self.require_staff():
                return
            stylist_id, date, label = body.get("stylistId"), body.get("date"), body.get("label")
            if not stylist_id or not date or not label:
                return self.send_json(400, {"error": "入力が不足しています"})
            conn = db.get_conn()
            existing = conn.execute(
                "SELECT id FROM shifts WHERE stylist_id=? AND date=?", (stylist_id, date)
            ).fetchone()
            if existing:
                conn.execute("UPDATE shifts SET label=? WHERE id=?", (label, existing["id"]))
            else:
                conn.execute(
                    "INSERT INTO shifts (id, stylist_id, date, label) VALUES (?,?,?,?)",
                    (db.new_id(), stylist_id, date, label),
                )
            conn.commit()
            conn.close()
            return self.send_json(200, {"ok": True})

        if path == "/api/staff/settings":
            if not self.require_staff():
                return
            open_time = body.get("openTime")
            close_time = body.get("closeTime")
            closed_weekdays = body.get("closedWeekdays", [])
            if not open_time or not close_time or not isinstance(closed_weekdays, list):
                return self.send_json(400, {"error": "入力が不足しています"})
            conn = db.get_conn()
            if "comboPermColorLastOrder" in body:
                combo_last_order = (body.get("comboPermColorLastOrder") or "").strip() or None
                if combo_last_order and not TIME_RE.match(combo_last_order):
                    conn.close()
                    return self.send_json(400, {"error": "パーマ＋カラーの最終受付時間はHH:MM形式で入力してください"})
            else:
                combo_last_order = get_settings(conn).get("combo_perm_color_last_order")
            closed_str = ",".join(str(int(x)) for x in closed_weekdays)
            conn.execute(
                "UPDATE salon_settings SET open_time=?, close_time=?, closed_weekdays=?, combo_perm_color_last_order=?, updated_at=? WHERE id=1",
                (open_time, close_time, closed_str, combo_last_order, db.now_iso()),
            )
            conn.commit()
            conn.close()
            return self.send_json(200, {"ok": True})

        if path == "/api/staff/closed-dates":
            if not self.require_staff():
                return
            date = body.get("date")
            if not date or not re.match(r"^\d{4}-\d{2}-\d{2}$", date):
                return self.send_json(400, {"error": "日付を正しく指定してください"})
            conn = db.get_conn()
            conn.execute("INSERT OR IGNORE INTO closed_dates (date, created_at) VALUES (?, ?)", (date, db.now_iso()))
            conn.commit()
            rows = conn.execute("SELECT date FROM closed_dates ORDER BY date").fetchall()
            conn.close()
            return self.send_json(201, {"closedDates": [r["date"] for r in rows]})

        if path == "/api/staff/menus":
            if not self.require_staff():
                return
            name = (body.get("name") or "").strip()
            price = body.get("price")
            duration_min = body.get("durationMin")
            if not name or not isinstance(price, (int, float)) or price < 0 or not isinstance(duration_min, (int, float)) or duration_min <= 0:
                return self.send_json(400, {"error": "メニュー名・価格・所要時間を正しく入力してください"})
            meta = (body.get("meta") or "").strip()
            price_is_from = 1 if body.get("priceIsFrom") else 0
            student_discount = body.get("studentDiscount", 0)
            if not isinstance(student_discount, (int, float)) or student_discount < 0:
                student_discount = 0
            last_order_time = (body.get("lastOrderTime") or "").strip() or None
            if last_order_time and not TIME_RE.match(last_order_time):
                return self.send_json(400, {"error": "最終受付時間はHH:MM形式で入力してください"})
            conn = db.get_conn()
            max_sort = conn.execute("SELECT COALESCE(MAX(sort_order), -1) m FROM menu_items").fetchone()["m"]
            mid = db.new_id()
            conn.execute(
                "INSERT INTO menu_items (id, name, meta, price, price_is_from, student_discount, last_order_time, duration_min, sort_order) VALUES (?,?,?,?,?,?,?,?,?)",
                (mid, name, meta, int(price), price_is_from, int(student_discount), last_order_time, int(duration_min), max_sort + 1),
            )
            conn.commit()
            row = conn.execute("SELECT * FROM menu_items WHERE id=?", (mid,)).fetchone()
            conn.close()
            return self.send_json(201, row_to_dict(row))

        m = re.match(r"^/api/staff/karte/([\w-]+)/photo$", path)
        if m:
            if not self.require_staff():
                return
            kid = m.group(1)
            conn = db.get_conn()
            entry = conn.execute("SELECT * FROM karte_entries WHERE id=?", (kid,)).fetchone()
            if not entry:
                conn.close()
                return self.send_json(404, {"error": "not found"})
            photo_path = save_data_url_image(body.get("photo"), "karte", kid)
            if not photo_path:
                conn.close()
                return self.send_json(400, {"error": "写真の形式が正しくありません"})
            conn.execute("UPDATE karte_entries SET photo_path=? WHERE id=?", (photo_path, kid))
            conn.commit()
            updated = conn.execute("SELECT * FROM karte_entries WHERE id=?", (kid,)).fetchone()
            conn.close()
            return self.send_json(200, row_to_dict(updated))

        return self.send_json(404, {"error": "not found"})

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = parsed.path

        m = re.match(r"^/api/staff/menus/([\w-]+)$", path)
        if m:
            if not self.require_staff():
                return
            mid = m.group(1)
            conn = db.get_conn()
            conn.execute("DELETE FROM menu_items WHERE id=?", (mid,))
            conn.commit()
            conn.close()
            return self.send_json(200, {"ok": True})

        m = re.match(r"^/api/staff/closed-dates/(\d{4}-\d{2}-\d{2})$", path)
        if m:
            if not self.require_staff():
                return
            date = m.group(1)
            conn = db.get_conn()
            conn.execute("DELETE FROM closed_dates WHERE date=?", (date,))
            conn.commit()
            conn.close()
            return self.send_json(200, {"ok": True})

        return self.send_json(404, {"error": "not found"})

    def do_PATCH(self):
        parsed = urlparse(self.path)
        path = parsed.path
        body = self.read_json()

        m = re.match(r"^/api/staff/menus/([\w-]+)$", path)
        if m:
            if not self.require_staff():
                return
            mid = m.group(1)
            conn = db.get_conn()
            existing = conn.execute("SELECT * FROM menu_items WHERE id=?", (mid,)).fetchone()
            if not existing:
                conn.close()
                return self.send_json(404, {"error": "not found"})
            name = (body.get("name") or existing["name"]).strip()
            meta = body.get("meta", existing["meta"])
            price = body.get("price", existing["price"])
            duration_min = body.get("durationMin", existing["duration_min"])
            price_is_from = 1 if body.get("priceIsFrom", existing["price_is_from"]) else 0
            student_discount = body.get("studentDiscount", existing["student_discount"])
            if not isinstance(student_discount, (int, float)) or student_discount < 0:
                student_discount = existing["student_discount"]
            if "lastOrderTime" in body:
                lot = (body.get("lastOrderTime") or "").strip()
                if lot and not TIME_RE.match(lot):
                    conn.close()
                    return self.send_json(400, {"error": "最終受付時間はHH:MM形式で入力してください"})
                last_order_time = lot or None
            else:
                last_order_time = existing["last_order_time"]
            if not name or not isinstance(price, (int, float)) or price < 0 or not isinstance(duration_min, (int, float)) or duration_min <= 0:
                conn.close()
                return self.send_json(400, {"error": "メニュー名・価格・所要時間を正しく入力してください"})
            conn.execute(
                "UPDATE menu_items SET name=?, meta=?, price=?, price_is_from=?, student_discount=?, last_order_time=?, duration_min=? WHERE id=?",
                (name, meta, int(price), price_is_from, int(student_discount), last_order_time, int(duration_min), mid),
            )
            conn.commit()
            row = conn.execute("SELECT * FROM menu_items WHERE id=?", (mid,)).fetchone()
            conn.close()
            return self.send_json(200, row_to_dict(row))

        m = re.match(r"^/api/staff/reservations/([\w-]+)$", path)
        if m:
            if not self.require_staff():
                return
            rid = m.group(1)
            status = body.get("status")
            if status not in ("wait", "visited", "cancel"):
                return self.send_json(400, {"error": "不正なステータスです"})
            conn = db.get_conn()
            resv = conn.execute("SELECT * FROM reservations WHERE id=?", (rid,)).fetchone()
            if not resv:
                conn.close()
                return self.send_json(404, {"error": "not found"})
            conn.execute("UPDATE reservations SET status=? WHERE id=?", (status, rid))
            if status == "visited":
                exists = conn.execute(
                    "SELECT id FROM karte_entries WHERE reservation_id=?", (rid,)
                ).fetchone()
                if not exists:
                    conn.execute(
                        "INSERT INTO karte_entries (id, customer_id, date, menu_names, memo, reservation_id) VALUES (?,?,?,?,?,?)",
                        (db.new_id(), resv["customer_id"], resv["date"], resv["menu_names"], resv["note"] or "", rid),
                    )
                conn.execute(
                    "UPDATE customers SET points = points + ? WHERE id = ?",
                    (resv["total_price"] // 100, resv["customer_id"]),
                )
            conn.commit()
            updated = conn.execute("SELECT * FROM reservations WHERE id=?", (rid,)).fetchone()
            conn.close()
            return self.send_json(200, row_to_dict(updated))

        return self.send_json(404, {"error": "not found"})


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    db.init_db()
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"GARNI app running on http://0.0.0.0:{port}  (staff password: {STAFF_PASSWORD})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
