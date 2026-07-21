"""
GARNI アプリ用の「QRコードカード」を作成する。
店頭掲示・ショップカードなどにそのまま使える、ブランドカラー入りのQRコード画像を生成する。
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from qrgen import generate_qr_matrix, QR_ECLEVEL_H
from PIL import Image, ImageDraw, ImageFont

BRAND = (169, 118, 92)      # #a9765c
BRAND_DARK = (124, 86, 66)  # #7c5642
TEXT_MUTED = (137, 135, 129)
INK = (32, 29, 26)

FONT_BOLD = "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"
FONT_REG = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
FONT_LOGO = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"  # ロゴの半角 "G" 用（既存アイコンと統一）


def make_qr_image(text, scale=10, border=2, fg=INK, bg=(255, 255, 255)):
    matrix = generate_qr_matrix(text, eclevel=QR_ECLEVEL_H)
    n = len(matrix)
    size = (n + border * 2) * scale
    img = Image.new("RGB", (size, size), bg)
    px = img.load()
    for y in range(n):
        for x in range(n):
            if matrix[y][x]:
                x0 = (x + border) * scale
                y0 = (y + border) * scale
                for dy in range(scale):
                    for dx in range(scale):
                        px[x0 + dx, y0 + dy] = fg
    return img


def overlay_logo(qr_img, logo_ratio=0.22):
    size = qr_img.size[0]
    logo_size = int(size * logo_ratio)
    pad = int(logo_size * 0.12)
    box_size = logo_size + pad * 2

    logo_box = Image.new("RGBA", (box_size, box_size), (255, 255, 255, 255))
    draw = ImageDraw.Draw(logo_box)
    radius = int(box_size * 0.22)
    draw.rounded_rectangle([0, 0, box_size - 1, box_size - 1], radius=radius, fill=(255, 255, 255, 255), outline=(230, 227, 222, 255), width=3)

    mark_pad = pad + int(logo_size * 0.08)
    mark_box = [mark_pad, mark_pad, box_size - mark_pad, box_size - mark_pad]
    mark_radius = int((mark_box[2] - mark_box[0]) * 0.24)
    draw.rounded_rectangle(mark_box, radius=mark_radius, fill=BRAND)

    font = ImageFont.truetype(FONT_LOGO, int((mark_box[2] - mark_box[0]) * 0.56))
    letter = "G"
    bbox = draw.textbbox((0, 0), letter, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    cx = (mark_box[0] + mark_box[2]) / 2
    cy = (mark_box[1] + mark_box[3]) / 2
    draw.text((cx - tw / 2 - bbox[0], cy - th / 2 - bbox[1]), letter, fill=(255, 255, 255, 255), font=font)

    qr_img = qr_img.convert("RGBA")
    x = (qr_img.size[0] - box_size) // 2
    y = (qr_img.size[1] - box_size) // 2
    qr_img.alpha_composite(logo_box, (x, y))
    return qr_img.convert("RGB")


def make_card(url, out_path, caption="スマホのカメラで読み取ってご予約", show_url=True, is_placeholder=False):
    qr_img = make_qr_image(url, scale=10, border=2)
    qr_img = overlay_logo(qr_img)

    pad_x, pad_top, pad_between, pad_bottom = 60, 50, 28, 46
    header_h = 70
    caption_h = 40
    url_h = 34 if show_url else 0
    placeholder_h = 46 if is_placeholder else 0

    card_w = qr_img.width + pad_x * 2
    card_h = pad_top + header_h + pad_between + qr_img.height + pad_between + caption_h + (url_h if show_url else 0) + (placeholder_h if is_placeholder else 0) + pad_bottom

    card = Image.new("RGB", (card_w, card_h), (255, 255, 255))
    draw = ImageDraw.Draw(card)

    # header: mark + title
    mark_size = 52
    mark_x, mark_y = pad_x, pad_top
    draw.rounded_rectangle([mark_x, mark_y, mark_x + mark_size, mark_y + mark_size], radius=13, fill=BRAND)
    font_mark = ImageFont.truetype(FONT_LOGO, 30)
    bbox = draw.textbbox((0, 0), "G", font=font_mark)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.text((mark_x + mark_size / 2 - tw / 2 - bbox[0], mark_y + mark_size / 2 - th / 2 - bbox[1]), "G", fill=(255, 255, 255), font=font_mark)

    font_title = ImageFont.truetype(FONT_BOLD, 30)
    font_sub = ImageFont.truetype(FONT_REG, 17)
    title_x = mark_x + mark_size + 16
    draw.text((title_x, mark_y + 2), "GARNI アプリ", fill=INK, font=font_title)
    draw.text((title_x, mark_y + 38), "お客様向け ご予約はこちら", fill=BRAND_DARK, font=font_sub)

    # QR image
    qr_x = (card_w - qr_img.width) // 2
    qr_y = pad_top + header_h + pad_between
    card.paste(qr_img, (qr_x, qr_y))

    # caption
    font_caption = ImageFont.truetype(FONT_BOLD, 22)
    bbox = draw.textbbox((0, 0), caption, font=font_caption)
    cw = bbox[2] - bbox[0]
    caption_y = qr_y + qr_img.height + pad_between
    draw.text(((card_w - cw) / 2 - bbox[0], caption_y), caption, fill=INK, font=font_caption)

    next_y = caption_y + caption_h
    if show_url:
        font_url = ImageFont.truetype(FONT_REG, 15)
        bbox = draw.textbbox((0, 0), url, font=font_url)
        uw = bbox[2] - bbox[0]
        draw.text(((card_w - uw) / 2 - bbox[0], next_y), url, fill=TEXT_MUTED, font=font_url)
        next_y += url_h

    if is_placeholder:
        font_ph = ImageFont.truetype(FONT_BOLD, 16)
        ph_text = "※ サンプルURLです。デプロイ後に本物のURLで再作成します"
        bbox = draw.textbbox((0, 0), ph_text, font=font_ph)
        pw = bbox[2] - bbox[0]
        draw.text(((card_w - pw) / 2 - bbox[0], next_y), ph_text, fill=(200, 60, 60), font=font_ph)

    card.save(out_path)
    return out_path


if __name__ == "__main__":
    url = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else "/tmp/qr_card.png"
    placeholder = "--placeholder" in sys.argv
    make_card(url, out, is_placeholder=placeholder)
    print("saved:", out)
