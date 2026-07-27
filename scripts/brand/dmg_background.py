"""Compose the DMG volume background: the site's canvas + dot field, the mark, and a drag arrow.

660x400 to match Tauri's default dmg window (bundle.dmg.window_size). Finder draws the background
at its natural size, so this must stay 1:1 with that window — don't render it at 2x.

The app icon sits at (180, 170) and the Applications alias at (480, 170) (Tauri's defaults), so the
arrow lives in the gap between them.
"""
import math
import pathlib
from png import read_png, write_png

ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC = str(ROOT / 'assets/brand/kairo-mark-source-1024.png')
OUT = 'kairo-dmg-background.png'

W, H = 660, 400
CANVAS = (0xf5, 0xf7, 0xfb)
DOT = (0x0b, 0x0d, 0x12)
KAIRO = (0x66, 0x5c, 0xff)

MARK_W = 48
MARK_TOP = 30
ARROW_Y = 170          # same baseline as the two icons
ARROW_X0, ARROW_X1 = 286, 380
ARROW_THICK = 3.5
HEAD_LEN, HEAD_HALF = 17.0, 9.0


def blend(buf, x, y, rgb, a):
    if a <= 0 or not (0 <= x < W and 0 <= y < H):
        return
    a = min(1.0, a)
    o = (y * W + x) * 4
    for c in range(3):
        buf[o + c] = round(rgb[c] * a + buf[o + c] * (1 - a))


def resample(src, sw, sh, ch, box, tw, th):
    """Area-average `box` of the source down to tw x th (premultiplied)."""
    x0, y0, x1, y1 = box
    bw, bh = x1 - x0 + 1, y1 - y0 + 1
    out = bytearray(tw * th * 4)
    for ty in range(th):
        sy0, sy1 = y0 + ty * bh / th, y0 + (ty + 1) * bh / th
        for tx in range(tw):
            sx0, sx1 = x0 + tx * bw / tw, x0 + (tx + 1) * bw / tw
            ar = ag = ab = aa = n = 0.0
            for sy in range(int(sy0), max(int(sy0) + 1, math.ceil(sy1))):
                if sy >= sh:
                    break
                for sx in range(int(sx0), max(int(sx0) + 1, math.ceil(sx1))):
                    if sx >= sw:
                        break
                    o = (sy * sw + sx) * ch
                    a = src[o + 3] / 255.0
                    ar += src[o] * a
                    ag += src[o + 1] * a
                    ab += src[o + 2] * a
                    aa += a
                    n += 1
            t = (ty * tw + tx) * 4
            if n and aa > 0:
                out[t] = min(255, round(ar / aa))
                out[t + 1] = min(255, round(ag / aa))
                out[t + 2] = min(255, round(ab / aa))
                out[t + 3] = round(aa / n * 255)
    return out


def bbox(src, w, h, ch):
    x0, y0, x1, y1 = w, h, -1, -1
    for y in range(h):
        for x in range(w):
            if src[((y * w) + x) * ch + 3] > 8:
                x0, y0 = min(x0, x), min(y0, y)
                x1, y1 = max(x1, x), max(y1, y)
    return x0, y0, x1, y1


canvas = bytearray()
for _ in range(W * H):
    canvas += bytes((*CANVAS, 255))

# The site's dot field: a 23px grid, faded top and bottom the same way the hero masks it.
for gy in range(0, H + 23, 23):
    t = gy / H
    fade = min(1.0, max(0.0, min((t - 0.02) / 0.16, (1.0 - t) / 0.14)))
    if fade <= 0:
        continue
    for gx in range(0, W + 23, 23):
        blend(canvas, gx, gy, DOT, 0.17 * 0.5 * fade)

# Drag arrow, centred in the gap between the app icon and the Applications alias.
half = ARROW_THICK / 2
shaft_end = ARROW_X1 - HEAD_LEN
for y in range(int(ARROW_Y - HEAD_HALF - 2), int(ARROW_Y + HEAD_HALF + 3)):
    for x in range(ARROW_X0 - 2, ARROW_X1 + 3):
        dy = y - ARROW_Y
        cover = 0.0
        if ARROW_X0 <= x <= shaft_end:                       # shaft
            cover = min(1.0, max(0.0, half + 0.5 - abs(dy)))
        if x > shaft_end:                                    # head
            span = HEAD_HALF * (ARROW_X1 - x) / HEAD_LEN
            if x <= ARROW_X1:
                cover = max(cover, min(1.0, max(0.0, span + 0.5 - abs(dy))))
        blend(canvas, x, y, KAIRO, cover)

# The mark, top-centre.
w, h, ch, px = read_png(SRC)
box = bbox(px, w, h, ch)
bw, bh = box[2] - box[0] + 1, box[3] - box[1] + 1
mh = round(bh * MARK_W / bw)
mark = resample(px, w, h, ch, box, MARK_W, mh)
ox = (W - MARK_W) // 2
for y in range(mh):
    for x in range(MARK_W):
        s = (y * MARK_W + x) * 4
        a = mark[s + 3] / 255.0
        if a > 0:
            blend(canvas, ox + x, MARK_TOP + y, (mark[s], mark[s + 1], mark[s + 2]), a)

write_png(OUT, W, H, canvas)
print(f'wrote {OUT} {W}x{H}')
