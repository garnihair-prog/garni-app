"""
GARNI アプリ - データベース層
Python標準ライブラリの sqlite3 のみを使用（外部パッケージ不要）。
"""
import sqlite3
import os
import uuid
import datetime
import random

_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
# GARNI_DATA_DIR を設定すると、データベースファイルの保存先を変更できる
# （Dockerなどで永続ボリュームをマウントし、アプリ本体の更新とは切り離してデータを永続化する場合に使用）。
# 未設定の場合は従来通りアプリと同じフォルダに保存される。
DATA_DIR = os.environ.get("GARNI_DATA_DIR") or _BASE_DIR
os.makedirs(DATA_DIR, exist_ok=True)
DB_PATH = os.path.join(DATA_DIR, "garni.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS stylists (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS menu_items (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    meta TEXT,
    price INTEGER NOT NULL,
    price_is_from INTEGER NOT NULL DEFAULT 0,  -- 1の場合、お客様向け表示は「¥○○〜」（目安価格）になる
    student_discount INTEGER NOT NULL DEFAULT 0,  -- 学割の割引額（円）。0の場合は学割なし
    last_order_time TEXT,       -- このメニューの最終受付時間（HH:MM）。NULLなら営業時間内はいつでも受付
    duration_min INTEGER NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT UNIQUE NOT NULL,
    rank TEXT NOT NULL DEFAULT '新規',
    points INTEGER NOT NULL DEFAULT 0,
    gender TEXT,        -- '男性' / '女性' / NULL（未回答）
    age INTEGER,         -- 予約時にお客様が任意入力
    referral_code TEXT UNIQUE,          -- お客様紹介機能：このお客様自身の紹介コード
    referred_by_customer_id TEXT,       -- お客様紹介機能：このお客様を紹介してくれた既存客のcustomer_id（新規客のみ設定）
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reservations (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    customer_phone TEXT NOT NULL,
    date TEXT NOT NULL,        -- YYYY-MM-DD
    time TEXT NOT NULL,        -- HH:MM
    stylist_id TEXT NOT NULL,
    menu_names TEXT NOT NULL,  -- comma-joined for display
    total_price INTEGER NOT NULL,
    duration_min INTEGER NOT NULL DEFAULT 60,
    note TEXT,
    status TEXT NOT NULL DEFAULT 'wait',  -- wait / visited / cancel / no_show
    style_photo_path TEXT,     -- お客様が予約時にアップロードした「希望スタイル」参考写真
    cancellation_fee INTEGER,  -- 土日祝キャンセル時に自動計算されるキャンセル料（円）。対象外ならNULLまたは0
    created_at TEXT NOT NULL,
    FOREIGN KEY (customer_id) REFERENCES customers(id),
    FOREIGN KEY (stylist_id) REFERENCES stylists(id)
);

CREATE TABLE IF NOT EXISTS karte_entries (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    date TEXT NOT NULL,
    menu_names TEXT NOT NULL,
    memo TEXT,
    reservation_id TEXT,
    photo_path TEXT,           -- スタッフが追加する「施術後」写真
    FOREIGN KEY (customer_id) REFERENCES customers(id)
);

CREATE TABLE IF NOT EXISTS shifts (
    id TEXT PRIMARY KEY,
    stylist_id TEXT NOT NULL,
    date TEXT NOT NULL,        -- YYYY-MM-DD
    label TEXT NOT NULL,       -- e.g. "10-19" or "off"
    UNIQUE(stylist_id, date)
);

CREATE TABLE IF NOT EXISTS salon_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    open_time TEXT NOT NULL DEFAULT '10:00',
    close_time TEXT NOT NULL DEFAULT '19:00',
    closed_weekdays TEXT NOT NULL DEFAULT '1',   -- comma区切り。0=日,1=月,...,6=土
    combo_perm_color_last_order TEXT,            -- パーマ＋カラーを同時予約する場合の最終受付時間（HH:MM）
    cancellation_fee_percent INTEGER NOT NULL DEFAULT 50,  -- 土日祝の前日キャンセル時のキャンセル料（予約金額に対する割合%）
    cancellation_fee_percent_full INTEGER NOT NULL DEFAULT 100,  -- 土日祝の当日キャンセル・無断キャンセル時のキャンセル料（%）
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS closed_dates (
    date TEXT PRIMARY KEY,     -- YYYY-MM-DD。不定休など、特定の日だけを臨時休業日にする
    created_at TEXT
);

CREATE TABLE IF NOT EXISTS referral_rewards (
    id TEXT PRIMARY KEY,
    referrer_customer_id TEXT NOT NULL,   -- クーポンを受け取る側（紹介した既存客）
    referred_customer_id TEXT NOT NULL,   -- 紹介された新規客
    referred_customer_name TEXT,          -- 表示用（紹介された方のお名前のスナップショット）
    amount INTEGER NOT NULL DEFAULT 500,  -- 割引額（円）
    status TEXT NOT NULL DEFAULT 'active',  -- active（未使用）/ used（使用済み）/ expired（期限切れ）
    issued_at TEXT NOT NULL,   -- 付与日（紹介された方が来店済みになった日）
    expires_at TEXT NOT NULL,  -- 有効期限（付与日から6ヶ月後）
    used_at TEXT,
    used_reservation_id TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (referrer_customer_id) REFERENCES customers(id),
    FOREIGN KEY (referred_customer_id) REFERENCES customers(id)
);
"""


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def now_iso():
    return datetime.datetime.now().isoformat(timespec="seconds")


def new_id():
    return uuid.uuid4().hex[:12]


# 紹介コードに使う文字（0/O、1/I など見間違えやすい文字を除いた大文字英数字）
_REFERRAL_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def generate_referral_code(conn):
    """他の誰とも重複しない6桁の紹介コードを発行する。"""
    for _ in range(20):
        code = "".join(random.choice(_REFERRAL_CODE_ALPHABET) for _ in range(6))
        exists = conn.execute("SELECT 1 FROM customers WHERE referral_code=?", (code,)).fetchone()
        if not exists:
            return code
    # 極めて低確率だが、20回試しても衝突する場合はIDベースでユニーク性を保証する
    return (new_id() + "000000")[:6].upper()


def init_db():
    conn = get_conn()
    conn.executescript(SCHEMA)
    conn.commit()
    seeded = conn.execute("SELECT COUNT(*) c FROM stylists").fetchone()["c"] > 0
    if not seeded:
        seed(conn)
    # 既存DBを新しいバージョンで起動した場合など、salon_settings行が無ければ補う
    has_settings = conn.execute("SELECT COUNT(*) c FROM salon_settings WHERE id=1").fetchone()["c"] > 0
    if not has_settings:
        conn.execute(
            "INSERT INTO salon_settings (id, open_time, close_time, closed_weekdays, combo_perm_color_last_order, cancellation_fee_percent, cancellation_fee_percent_full, updated_at) VALUES (1, '10:00', '19:00', '1', '15:00', 50, 100, ?)",
            (now_iso(),),
        )
        conn.commit()
    # 既存DBに customers.gender / customers.age 列が無ければ追加する（旧バージョンからの移行）
    cust_cols = {row["name"] for row in conn.execute("PRAGMA table_info(customers)").fetchall()}
    if "gender" not in cust_cols:
        conn.execute("ALTER TABLE customers ADD COLUMN gender TEXT")
    if "age" not in cust_cols:
        conn.execute("ALTER TABLE customers ADD COLUMN age INTEGER")
    if "referral_code" not in cust_cols:
        conn.execute("ALTER TABLE customers ADD COLUMN referral_code TEXT")
    if "referred_by_customer_id" not in cust_cols:
        conn.execute("ALTER TABLE customers ADD COLUMN referred_by_customer_id TEXT")
    # 紹介コードが未発行の既存顧客（お客様紹介機能の追加前から登録されている顧客）に発行する
    no_code_rows = conn.execute("SELECT id FROM customers WHERE referral_code IS NULL").fetchall()
    for row in no_code_rows:
        conn.execute(
            "UPDATE customers SET referral_code=? WHERE id=?",
            (generate_referral_code(conn), row["id"]),
        )
    # 既存DBに reservations.style_photo_path / karte_entries.photo_path 列が無ければ追加する
    resv_cols = {row["name"] for row in conn.execute("PRAGMA table_info(reservations)").fetchall()}
    if "style_photo_path" not in resv_cols:
        conn.execute("ALTER TABLE reservations ADD COLUMN style_photo_path TEXT")
    if "cancellation_fee" not in resv_cols:
        conn.execute("ALTER TABLE reservations ADD COLUMN cancellation_fee INTEGER")
    karte_cols = {row["name"] for row in conn.execute("PRAGMA table_info(karte_entries)").fetchall()}
    if "photo_path" not in karte_cols:
        conn.execute("ALTER TABLE karte_entries ADD COLUMN photo_path TEXT")
    # 既存DBに menu_items.price_is_from / student_discount 列が無ければ追加する（旧バージョンからの移行）
    menu_cols = {row["name"] for row in conn.execute("PRAGMA table_info(menu_items)").fetchall()}
    if "price_is_from" not in menu_cols:
        conn.execute("ALTER TABLE menu_items ADD COLUMN price_is_from INTEGER NOT NULL DEFAULT 0")
    if "student_discount" not in menu_cols:
        conn.execute("ALTER TABLE menu_items ADD COLUMN student_discount INTEGER NOT NULL DEFAULT 0")
        # 移行時、既存メニューの「カラー」「パーマ」には自動で学割500円引きを設定する
        conn.execute("UPDATE menu_items SET student_discount=500 WHERE name IN ('カラー', 'パーマ')")
    if "last_order_time" not in menu_cols:
        conn.execute("ALTER TABLE menu_items ADD COLUMN last_order_time TEXT")
        # 移行時、既存メニューには指定された最終受付時間を自動で設定する
        conn.execute("UPDATE menu_items SET last_order_time='17:00' WHERE name='カット'")
        conn.execute("UPDATE menu_items SET last_order_time='16:00' WHERE name IN ('パーマ', 'カラー')")
        conn.execute("UPDATE menu_items SET last_order_time='15:00' WHERE name='縮毛矯正'")
    settings_cols = {row["name"] for row in conn.execute("PRAGMA table_info(salon_settings)").fetchall()}
    if "combo_perm_color_last_order" not in settings_cols:
        conn.execute("ALTER TABLE salon_settings ADD COLUMN combo_perm_color_last_order TEXT")
        conn.execute("UPDATE salon_settings SET combo_perm_color_last_order='15:00' WHERE id=1")
    if "cancellation_fee_percent" not in settings_cols:
        conn.execute("ALTER TABLE salon_settings ADD COLUMN cancellation_fee_percent INTEGER NOT NULL DEFAULT 50")
    if "cancellation_fee_percent_full" not in settings_cols:
        conn.execute("ALTER TABLE salon_settings ADD COLUMN cancellation_fee_percent_full INTEGER NOT NULL DEFAULT 100")
    # 個人店化に伴い、旧サンプルのスタイリストA/B（従業員なし）を削除する（旧バージョンからの移行）。
    # 該当スタイリストの予約は店長（s-m）に付け替え、シフトは削除する。
    old_ids = [row["id"] for row in conn.execute(
        "SELECT id FROM stylists WHERE id IN ('s-a', 's-b')"
    ).fetchall()]
    if old_ids:
        placeholders = ",".join("?" * len(old_ids))
        conn.execute(f"UPDATE reservations SET stylist_id='s-m' WHERE stylist_id IN ({placeholders})", old_ids)
        conn.execute(f"DELETE FROM shifts WHERE stylist_id IN ({placeholders})", old_ids)
        conn.execute(f"DELETE FROM stylists WHERE id IN ({placeholders})", old_ids)
    conn.commit()
    conn.close()


def seed(conn):
    """初期データを投入する（初回起動時のみ）"""
    cur = conn.cursor()

    stylists = [
        ("s-m", "店長 GARNI", "店長", 0),
    ]
    cur.executemany(
        "INSERT INTO stylists (id, name, role, sort_order) VALUES (?,?,?,?)", stylists
    )

    # (id, name, meta, price, student_discount, last_order_time, duration_min, sort_order)
    menus = [
        ("m-cut", "カット", "シャンプー・ブロー込み", 4400, 0, "17:00", 60, 0),
        ("m-color", "カラー", "一剤〜二剤", 6600, 500, "16:00", 120, 1),
        ("m-perm", "パーマ", "コールド・デジタル選択可", 8800, 500, "16:00", 120, 2),
        ("m-treat", "トリートメント", "集中補修", 3300, 0, None, 30, 3),
        ("m-straight", "縮毛矯正", "くせ毛矯正", 11000, 0, "15:00", 180, 4),
    ]
    cur.executemany(
        "INSERT INTO menu_items (id, name, meta, price, student_discount, last_order_time, duration_min, sort_order) VALUES (?,?,?,?,?,?,?,?)",
        menus,
    )

    customers = [
        ("c-1", "田中 美咲", "09011110001", "ゴールド会員", 1240, "女性", 34),
        ("c-2", "佐藤 ひろし", "09022220002", "シルバー会員", 480, "男性", 45),
        ("c-3", "鈴木 あかり", "09033330003", "ゴールド会員", 1580, "女性", 27),
        ("c-4", "高橋 直人", "09044440004", "新規", 20, "男性", 52),
    ]
    ts = now_iso()
    cur.executemany(
        "INSERT INTO customers (id, name, phone, rank, points, gender, age, created_at) VALUES (?,?,?,?,?,?,?,?)",
        [(cid, name, phone, rank, pts, gender, age, ts) for (cid, name, phone, rank, pts, gender, age) in customers],
    )

    karte = [
        ("c-1", "2026-06-28", "カラー＋トリートメント", "アッシュベージュ。次回は根元のみでOK。"),
        ("c-1", "2026-04-15", "カット", "毛量多め、レイヤー多めに。"),
        ("c-2", "2026-07-10", "カット＋縮毛矯正", "くせが強い前髪中心。次回90分確保。"),
        ("c-3", "2026-07-15", "パーマ", "デジタルパーマ、コテ巻き風。"),
        ("c-3", "2026-05-02", "カラー", "ピンクベージュ、色持ち相談あり。"),
        ("c-4", "2026-07-18", "カット", "初回来店。ビジネス向けの短め希望。"),
    ]
    cur.executemany(
        "INSERT INTO karte_entries (id, customer_id, date, menu_names, memo) VALUES (?,?,?,?,?)",
        [(new_id(), cid, d, m, memo) for (cid, d, m, memo) in karte],
    )

    # メニュー名 -> 所要時間(分) のマップ（座席重複チェック用）
    duration_by_menu = {m[1]: m[6] for m in menus}

    # 1人で対応するため、同じ日でも予約時間が重ならないように順番に並べる
    # （カラー10:00-12:00 → カット12:00-13:00 → パーマ13:00-15:00 → 縮毛矯正15:00-18:00）
    reservations = [
        ("c-1", "田中 美咲", "09011110001", "2026-07-19", "10:00", "s-m", "カラー", 6600, "visited"),
        ("c-4", "高橋 直人", "09044440004", "2026-07-19", "12:00", "s-m", "カット", 4400, "visited"),
        ("c-3", "鈴木 あかり", "09033330003", "2026-07-19", "13:00", "s-m", "パーマ", 8800, "wait"),
        ("c-2", "佐藤 ひろし", "09022220002", "2026-07-19", "15:00", "s-m", "縮毛矯正", 11000, "wait"),
    ]
    cur.executemany(
        """INSERT INTO reservations
           (id, customer_id, customer_name, customer_phone, date, time, stylist_id, menu_names, total_price, duration_min, note, status, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        [
            (new_id(), cid, name, phone, d, t, sid, menu, price, duration_by_menu.get(menu, 60), "", status, ts)
            for (cid, name, phone, d, t, sid, menu, price, status) in reservations
        ],
    )

    # 今週のシフト（7/20〜7/26）
    shift_days = ["2026-07-20", "2026-07-21", "2026-07-22", "2026-07-23", "2026-07-24", "2026-07-25", "2026-07-26"]
    shift_map = {
        "s-m": ["off", "10-19", "10-19", "10-19", "10-19", "9-18", "9-18"],
    }
    shift_rows = []
    for sid, labels in shift_map.items():
        for d, label in zip(shift_days, labels):
            shift_rows.append((new_id(), sid, d, label))
    cur.executemany(
        "INSERT INTO shifts (id, stylist_id, date, label) VALUES (?,?,?,?)", shift_rows
    )

    # 営業時間・定休日の初期設定（月曜定休、10:00〜19:00）。スタッフ設定画面から変更可能。
    # パーマ＋カラーを同時予約する場合の最終受付は15:00。土日祝キャンセル時のキャンセル料は初期値50%。
    cur.execute(
        "INSERT INTO salon_settings (id, open_time, close_time, closed_weekdays, combo_perm_color_last_order, cancellation_fee_percent, updated_at) VALUES (1, '10:00', '19:00', '1', '15:00', 50, ?)",
        (ts,),
    )

    conn.commit()


if __name__ == "__main__":
    if os.path.exists(DB_PATH):
        os.remove(DB_PATH)
    init_db()
    print(f"Initialized DB at {DB_PATH}")
