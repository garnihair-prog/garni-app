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
    archived_at TEXT,                   -- 転勤等で削除されたお客様の削除日時。NULLなら通常のお客様（顧客一覧に表示）。
                                         -- 過去の予約・カルテ・売上データは削除後も保持され、ダッシュボード等の集計にはそのまま反映される。
                                         -- 同じ電話番号で再度ご予約が入った場合は自動的に元に戻る（NULLに戻す）。
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

CREATE TABLE IF NOT EXISTS consent_forms (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body_html TEXT NOT NULL,   -- 同意書本文（表示用HTML）
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS consent_agreements (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    reservation_id TEXT NOT NULL,
    consent_form_id TEXT NOT NULL,
    agreed_at TEXT NOT NULL,   -- お客様が「同意します」をクリックした日時
    FOREIGN KEY (customer_id) REFERENCES customers(id),
    FOREIGN KEY (reservation_id) REFERENCES reservations(id),
    FOREIGN KEY (consent_form_id) REFERENCES consent_forms(id)
);
"""


def _consent_html(intro, articles):
    """(見出し, 本文) のリストから同意書表示用のHTMLを組み立てる。"""
    parts = [f"<p>{intro}</p>"]
    for heading, body in articles:
        body_html = body.replace("\n", "<br>")
        parts.append(f"<p><strong>{heading}</strong><br>{body_html}</p>")
    return "".join(parts)


_COLOR_CONSENT_INTRO = (
    "本同意書は、美容サロン（以下「当店」という。）において、利用者（以下「施術者」という。）が"
    "ブリーチ・ヘアカラー等の施術を受けるにあたり、施術に伴うリスク、禁止事項、アフターケア等について"
    "理解し、同意する事項を定めるものである。"
)

_COLOR_CONSENT_ARTICLES = [
    ("第1条（目的）",
     "本同意書は、ブリーチおよびヘアカラー施術に関連して生じ得る健康・美容上の影響、損害、トラブル等を"
     "事前に確認し、施術者が自己の責任において施術を受けることに同意することを目的とする。"),
    ("第2条（施術内容）",
     "1　施術者は、当店が行うブリーチ、ダブルカラー、トリプルカラー、ハイライト、インナーカラーその他これらに"
     "付随する施術の内容を理解した上で受けるものとする。\n"
     "2　施術の過程においては、髪質・履歴・体質・施術者の希望色等によって、仕上がり色やダメージの程度に"
     "個人差が生じることを承認する。"),
    ("第3条（健康状態・アレルギー申告義務）",
     "1　施術者は、施術前に自身の健康状態、アレルギー、頭皮疾患、薬剤への過敏症、金属アレルギー、"
     "妊娠中・授乳中の状況など、施術に影響する事項を正確に申告しなければならない。\n"
     "2　施術者が申告を怠った場合、または虚偽申告を行ったことにより損害や症状が発生した場合、"
     "当店はその責任を負わない。\n"
     "3　施術中に異常・刺激・痛みなどを感じた場合、施術者は直ちに当店へ申し出るものとする。"),
    ("第4条（ブリーチおよび薬剤施術のリスク）",
     "施術者は、ブリーチ・カラー施術に次のリスクが伴うことを理解し、承諾する。\n"
     "1　髪の損傷（切れ毛、枝毛、乾燥、ゴワつき、強度低下など）\n"
     "2　頭皮刺激（かゆみ、ひりつき、赤み、炎症、痛み、発疹など）\n"
     "3　希望色との不一致、色ムラ、想定外の色味が出る可能性\n"
     "4　過去の縮毛矯正・パーマ・黒染め等による履歴の影響で、仕上がりに制限が生じること\n"
     "5　複数回の施術が必要となる場合があること\n"
     "6　施術直後および施術後数日にわたり、色落ち・変色・退色が発生すること\n"
     "7　薬剤の個人差によりアレルギー反応・皮膚症状が発生するおそれ"),
    ("第5条（期待する仕上がりに関する免責）",
     "1　ブリーチを伴う施術は、髪質・ダメージ度合い・履歴等により結果に大きな差異が生じるため、"
     "当店は希望通りの色味・明度・透明感を完全に保証するものではない。\n"
     "2　施術後に「思っていた色と違う」などの理由による返金、損害賠償は行わない。\n"
     "3　施術後に希望と異なると施術者が判断した場合であっても、追加施術が必要な場合には別途料金が"
     "発生する場合がある。"),
    ("第6条（施術後のアフターケア）",
     "1　施術後の色持ち、ダメージ進行、頭皮状態の変化は施術者の自宅ケア方法に大きく依存することを"
     "理解する。\n"
     "2　施術者は、当店が案内するシャンプー・トリートメント・ドライ方法等のアフターケアを適切に"
     "行うものとする。\n"
     "3　施術後の生活行動（プール、温泉、海水、ヘアアイロンの多用など）による退色・ダメージについて、"
     "当店は責任を負わない。"),
    ("第7条（再施術・補償）",
     "1　施術後に不具合が発生した場合、施術日から〇日以内に当店へ連絡があったときに限り、"
     "当店の判断で再施術を行うことがある。\n"
     "2　前項の再施術は、当店の技術起因であると合理的に認められる場合に限る。\n"
     "3　薬剤反応・アレルギー症状・施術者の事前申告漏れ・アフターケア不備に起因する問題については、"
     "補償対象外とする。"),
    ("第8条（禁止事項）",
     "施術者は、次の行為を行ってはならない。\n"
     "1　施術前の健康状態・施術履歴を故意に隠す行為\n"
     "2　施術中に異常を感じても申告せず放置する行為\n"
     "3　当店の指示するアフターケアを著しく守らない行為\n"
     "4　薬剤アレルギーが疑われるにもかかわらず施術を強行する行為"),
    ("第9条（免責事項）",
     "1　施術者が本同意書に反する行為を行った場合、当店は一切の責任を負わない。\n"
     "2　施術によって生じた頭皮・毛髪の状態変化、アレルギー反応等について、当店に故意・重過失がない限り、"
     "損害賠償責任を負わない。\n"
     "3　天災その他当店の責に帰さない事由により施術継続が困難となった場合、当店は責任を負わない。"),
    ("第10条（個人情報の取扱い）",
     "当店は、本同意書に基づき取得した個人情報を、施術記録の管理、健康管理、安全配慮、"
     "施術サービス向上の目的に必要な範囲で利用するものとし、施術者の同意なく第三者に提供しない。"),
    ("第11条（準拠法・紛争解決）",
     "本同意書に関して生じた紛争については、日本法を準拠法とし、当店所在地を管轄する裁判所を"
     "専属的合意管轄とする。"),
    ("第12条（同意）",
     "施術者は、本同意書の内容を十分に理解し、疑問点について説明を受け、すべての内容に同意したうえで"
     "施術を受けることに合意する。"),
]

COLOR_CONSENT_HTML = _consent_html(_COLOR_CONSENT_INTRO, _COLOR_CONSENT_ARTICLES)

_PERM_CONSENT_INTRO = (
    "本同意書（以下「本同意書」という。）は、施術を受ける者（以下「お客様」という。）が、"
    "美容事業者（以下「当店」という。）によるパーマ・縮毛矯正施術に関し、施術内容・リスク・注意事項等を"
    "十分に理解し、これに同意したことを確認するために締結するものである。"
)

_PERM_CONSENT_ARTICLES = [
    ("第1条（目的）",
     "本同意書は、当店が提供するパーマ・縮毛矯正施術に関し、その内容・効果・リスクおよび施術後の"
     "注意事項をお客様に明確に説明し、お客様がその内容を理解したうえで施術を受けることに同意することを"
     "目的とする。"),
    ("第2条（施術内容）",
     "1　当店は、お客様の髪質・毛量・頭皮状態・既存のダメージ等を確認した上で、適切と判断する薬剤・"
     "施術方法を用いてパーマ・縮毛矯正施術を行う。\n"
     "2　施術工程には、薬剤処理・加温・中和操作等が含まれ、その効果および仕上がりには個人差があることを"
     "お客様は了承する。"),
    ("第3条（リスク説明および承諾）",
     "お客様は、パーマ・縮毛矯正施術に伴い、以下のようなリスクが発生し得ることを理解し、これを承諾する。\n"
     "1　髪の乾燥、損傷、切れ毛、枝毛、チリつきが発生する可能性\n"
     "2　薬剤による頭皮刺激・かゆみ・赤み・発疹・炎症\n"
     "3　薬剤アレルギー（事前申告がなかった場合を含む）\n"
     "4　希望した仕上がりと実際の仕上がりに差が生じる可能性\n"
     "5　既存のダメージ、縮毛矯正歴、カラー履歴等により、施術効果が出にくい・または予定外の結果となる"
     "可能性\n"
     "6　体調、ホルモンバランス、薬剤使用歴等の個人的要因による予期せぬ反応の可能性"),
    ("第4条（お客様の申告義務）",
     "1　お客様は、以下の事項について事前に正確に申告するものとする。\n"
     "　①　過去のパーマ、カラー、縮毛矯正等の履歴\n"
     "　②　頭皮トラブル、皮膚疾患、アレルギー歴\n"
     "　③　妊娠・授乳中の有無\n"
     "　④　医師の治療・投薬状況\n"
     "2　前項の事項に関し虚偽申告または申告漏れがあった場合に生じる不具合・損害について、"
     "当店は責任を負わない。"),
    ("第5条（施術後のケアおよび注意事項）",
     "1　お客様は、当店が説明したアフターケア（濡れた状態での放置を避ける、適切なヘアケア剤を使用する等）"
     "を遵守するものとする。\n"
     "2　施術後24〜48時間以内のシャンプー、強い摩擦、強い結び癖、高温器具の使用等は、パーマの持続性に"
     "影響を及ぼすことがある。\n"
     "3　施術後の自己管理不足による仕上がりの変化・持続性低下について、当店は責任を負わない。"),
    ("第6条（再施術・返金対応）",
     "1　施術結果が不十分であるとお客様が感じた場合、当店は状況を確認した上で、技術的に可能かつ安全と"
     "判断した場合に限り、一定期間内に無償・有償での再施術対応を行うことがある。\n"
     "2　お客様の自己管理不足、申告漏れ、髪質特性など、当店の責めによらない事由による仕上がり不満については、"
     "再施術および返金対応の対象外とする。\n"
     "3　返金を行った場合でも、当店の責任は返金額の範囲内に限られる。"),
    ("第7条（免責事項）",
     "1　パーマ・縮毛矯正施術による結果には個人差があり、当店は特定の仕上がりを保証するものではない。\n"
     "2　お客様の申告内容に誤りがある場合、自己ケア不足、または不可抗力によるトラブルについては、"
     "当店は責任を負わない。\n"
     "3　医療行為が必要となる症状が発生した場合は、速やかに医療機関を受診するものとする。"),
    ("第8条（個人情報の取扱い）",
     "当店は、本同意書に関連して取得したお客様の個人情報を、施術管理、リスク防止、および"
     "アフターケア案内の目的でのみ利用し、法令に従い適切に管理する。"),
    ("第9条（準拠法・管轄）",
     "本同意書は日本法に準拠するものとし、本同意書に関して紛争が生じた場合には、当店所在地を管轄する"
     "裁判所を第一審の専属的合意管轄裁判所とする。"),
]

PERM_CONSENT_HTML = _consent_html(_PERM_CONSENT_INTRO, _PERM_CONSENT_ARTICLES)


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
    if "archived_at" not in cust_cols:
        conn.execute("ALTER TABLE customers ADD COLUMN archived_at TEXT")
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
    if "consent_form_id" not in menu_cols:
        conn.execute("ALTER TABLE menu_items ADD COLUMN consent_form_id TEXT")
    # 同意書マスタが未投入なら初期の2種類（カラー・ブリーチ用／パーマ・縮毛矯正用）を投入し、
    # メニュー名のキーワードから対応する同意書を自動で割り当てる（未割り当てのメニューのみ）
    has_consent_forms = conn.execute("SELECT COUNT(*) c FROM consent_forms").fetchone()["c"] > 0
    if not has_consent_forms:
        seed_consent_forms(conn)
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


def seed_consent_forms(conn):
    """同意書マスタの初期データを投入し、既存メニューにキーワードで自動割り当てる。"""
    forms = [
        ("cf-color", "ブリーチ・カラー施術同意書", COLOR_CONSENT_HTML, 0),
        ("cf-perm", "パーマ・縮毛矯正施術同意書", PERM_CONSENT_HTML, 1),
    ]
    conn.executemany(
        "INSERT INTO consent_forms (id, title, body_html, sort_order) VALUES (?,?,?,?)",
        forms,
    )
    conn.execute(
        "UPDATE menu_items SET consent_form_id='cf-color' "
        "WHERE (name LIKE '%カラー%' OR name LIKE '%ブリーチ%') AND consent_form_id IS NULL"
    )
    conn.execute(
        "UPDATE menu_items SET consent_form_id='cf-perm' "
        "WHERE (name LIKE '%パーマ%' OR name LIKE '%縮毛矯正%') AND consent_form_id IS NULL"
    )
    conn.commit()


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
