"""
軽量QRコード生成スクリプト。
libqrencode (システムにインストール済みの共有ライブラリ) を ctypes 経由で直接呼び出す。
pip 等のパッケージインストールが使えないサンドボックス環境向けの代替手段。
"""
import ctypes
import sys
from PIL import Image

QR_ECLEVEL_L = 0
QR_ECLEVEL_M = 1
QR_ECLEVEL_Q = 2
QR_ECLEVEL_H = 3

QR_MODE_8 = 2


class QRcode(ctypes.Structure):
    _fields_ = [
        ("version", ctypes.c_int),
        ("width", ctypes.c_int),
        ("data", ctypes.POINTER(ctypes.c_ubyte)),
    ]


def generate_qr_matrix(text, eclevel=QR_ECLEVEL_M):
    lib = ctypes.CDLL("libqrencode.so.4")
    lib.QRcode_encodeString.restype = ctypes.POINTER(QRcode)
    lib.QRcode_encodeString.argtypes = [
        ctypes.c_char_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int
    ]
    qr_ptr = lib.QRcode_encodeString(text.encode("utf-8"), 0, eclevel, QR_MODE_8, 1)
    if not qr_ptr:
        raise RuntimeError("QRコードの生成に失敗しました")
    qr = qr_ptr.contents
    width = qr.width
    matrix = [[bool(qr.data[y * width + x] & 1) for x in range(width)] for y in range(width)]
    lib.QRcode_free(qr_ptr)
    return matrix


def render_qr_png(text, out_path, scale=10, border=4, fg=(32, 29, 26), bg=(255, 255, 255)):
    matrix = generate_qr_matrix(text)
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
    img.save(out_path)
    return out_path


if __name__ == "__main__":
    text = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else "/tmp/qr_out.png"
    render_qr_png(text, out)
    print(f"saved: {out}")
