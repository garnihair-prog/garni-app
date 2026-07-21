"""
GARNI アプリ - データベース層
Python標準ライブラリの sqlite3 のみを使用（外部パッケージ不要）。
"""
import sqlite3
import os
import uuid
import datetime

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "garni.db")

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
    status TEXT NOT NULL DEFAULT 'wait',  -- wait / visited / cancel
    style_photo_path TEXT,     -- お客様が予約時にアップロードした「希望スタイル」参考写真
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
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS closed_dates (
    date TEXT PRIMARY KEY,     -- YYYY-MM-DD。不定休など、特定の日だけを臨時休業日にする
    created_at TEXT
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
            "INSERT INTO salon_settings (id, open_time, close_time, closed_weekdays, updated_at) VALUES (1, '10:00', '19:00', '1', ?)",
            (now_iso(),),
        )
        conn.commit()
    # 既存DBに customers.gender / customers.age 列が無ければ追加する（旧バージョンからの移行）
    cust_cols = {row["name"] for row in conn.execute("PRAGMA table_info(customers)").fetchall()}
    if "gender" not in cust_cols:
        conn.execute("ALTER TABLE customers ADD COLUMN gender TEXT")
    if "age" not in cust_cols:
        conn.execute("ALTER TABLE customers ADD COLUMN age INTEGER")
    # 既存DBに reservations.style_photo_path / karte_entries.photo_path 列が無ければ追加する
    resv_cols = {row["name"] for row in conn.execute("PRAGMA table_info(reservations)").fetchall()}
    if "style_photo_path" not in resv_cols:
        conn.execute("ALTER TABLE reservations ADD COLUMN style_photo_path TEXT")
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

    # (id, name, meta, price, student_discount, duration_min, sort_order)
    menus = [
        ("m-cut", "カット", "シャンプー・ブロー込み", 4400, 0, 60, 0),
        ("m-color", "カラー", "一剤〜二剤", 6600, 500, 120, 1),
        ("m-perm", "パーマ", "コールド・デジタル選択可", 8800, 500, 120, 2),
        ("m-treat", "トリートメント", "集中補修", 3300, 0, 30, 3),
        ("m-straight", "縮毛矯正", "くせ毛矯正", 11000, 0, 180, 4),
    ]
    cur.executemany(
        "INSERT INTO menu_items (id, name, meta, price, student_discount, duration_min, sort_order) VALUES (?,?,?,?,?,?,?)",
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
    duration_by_menu = {m[1]: m[5] for m in menus}

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
    cur.execute(
        "INSERT INTO salon_settings (id, open_time, close_time, closed_weekdays, updated_at) VALUES (1, '10:00', '19:00', '1', ?)",
        (ts,),
    )

    conn.commit()


if __name__ == "__main__":
    if os.path.exists(DB_PATH):
        os.remove(DB_PATH)
    init_db()
    print(f"Initialized DB at {DB_PATH}")
