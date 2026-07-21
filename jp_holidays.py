"""
日本の祝日を計算するモジュール（外部パッケージ不要・Python標準ライブラリのみ）。

固定日の祝日・ハッピーマンデー（第◯月曜日）の祝日・春分の日／秋分の日（近似計算式）・
振替休日・国民の休日（祝日に挟まれた平日）に対応しています。

対応範囲の目安は1980年〜2099年です（春分・秋分の近似式がこの範囲で高精度なため）。
これより先の年については、必要に応じて計算式の更新が必要になる場合があります。
なお、2019年の即位の日など、その年限りの特別な祝日は含んでいません
（本アプリの運用開始が2026年以降のため、影響はありません）。
"""
import datetime
import functools


def _nth_monday(year, month, n):
    """year年month月の第n月曜日の日付を返す。"""
    d = datetime.date(year, month, 1)
    # 0=月曜 ... 6=日曜
    offset = (0 - d.weekday()) % 7
    first_monday = d + datetime.timedelta(days=offset)
    return first_monday + datetime.timedelta(days=7 * (n - 1))


def _vernal_equinox_day(year):
    """春分の日（近似計算式。1980〜2099年で高精度）。"""
    if 1980 <= year <= 2099:
        day = int(20.8431 + 0.242194 * (year - 1980) - (year - 1980) // 4)
    else:
        day = 20
    return datetime.date(year, 3, day)


def _autumnal_equinox_day(year):
    """秋分の日（近似計算式。1980〜2099年で高精度）。"""
    if 1980 <= year <= 2099:
        day = int(23.2488 + 0.242194 * (year - 1980) - (year - 1980) // 4)
    else:
        day = 23
    return datetime.date(year, 9, day)


@functools.lru_cache(maxsize=None)
def _base_holidays(year):
    """振替休日・国民の休日を適用する前の「本来の祝日」の集合を返す。"""
    h = {}

    def add(d, name):
        h[d] = name

    add(datetime.date(year, 1, 1), "元日")
    add(_nth_monday(year, 1, 2), "成人の日")
    add(datetime.date(year, 2, 11), "建国記念の日")
    add(datetime.date(year, 2, 23), "天皇誕生日")
    add(_vernal_equinox_day(year), "春分の日")
    add(datetime.date(year, 4, 29), "昭和の日")
    add(datetime.date(year, 5, 3), "憲法記念日")
    add(datetime.date(year, 5, 4), "みどりの日")
    add(datetime.date(year, 5, 5), "こどもの日")
    add(_nth_monday(year, 7, 3), "海の日")
    add(datetime.date(year, 8, 11), "山の日")
    add(_nth_monday(year, 9, 3), "敬老の日")
    add(_autumnal_equinox_day(year), "秋分の日")
    add(_nth_monday(year, 10, 2), "スポーツの日")
    add(datetime.date(year, 11, 3), "文化の日")
    add(datetime.date(year, 11, 23), "勤労感謝の日")
    return h


@functools.lru_cache(maxsize=None)
def _holidays_for_year(year):
    """振替休日・国民の休日を適用した、その年の祝日集合（date -> 名称）を返す。
    前後の年をまたぐケース（12/31や1/1付近）に対応するため、前年末〜翌年始も考慮する。"""
    merged = {}
    for y in (year - 1, year, year + 1):
        merged.update(_base_holidays(y))

    result = dict(merged)

    # 振替休日：祝日が日曜日の場合、その後の最初の「祝日でない日」を休日にする
    for d, name in sorted(merged.items()):
        if d.weekday() == 6:  # 日曜
            sub = d + datetime.timedelta(days=1)
            while sub in result:
                sub += datetime.timedelta(days=1)
            result[sub] = "振替休日"

    # 国民の休日：前日・翌日がともに祝日で、その日自体が祝日でない平日を休日にする
    all_dates = sorted(result.keys())
    for d in list(all_dates):
        candidate = d + datetime.timedelta(days=1)
        if candidate not in result and (candidate - datetime.timedelta(days=1)) in result and (candidate + datetime.timedelta(days=1)) in result:
            result[candidate] = "国民の休日"

    return {d: n for d, n in result.items() if d.year == year}


def is_jp_holiday(date_obj):
    """date_obj（datetime.date）が日本の祝日かどうかを返す。"""
    return date_obj in _holidays_for_year(date_obj.year)


def holiday_name(date_obj):
    """祝日名を返す。祝日でなければNone。"""
    return _holidays_for_year(date_obj.year).get(date_obj)
