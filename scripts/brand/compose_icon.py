"""Compose the 1024 macOS app-icon source: the Kairo mark on a deep-ink squircle plate.

Apple's Big Sur grid: 1024 canvas, 824x824 icon body centred (100px margin), continuous
(squircle) corners. Plate colour is the website's --surface-deep #141824, with a barely
-there vertical gradient so it isn't dead flat.
"""
import pathlib
import math
from png import read_png, write_png

ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC = str(ROOT / 'assets/brand/kairo-mark-source-1024.png')
OUT = 'kairo-icon-1024.png'

N = 1024
BODY = 824                 # Apple's icon body inside the 1024 canvas
MARK_W = 496               # mark width on the plate; leaves ~90px of body margin
SQUIRCLE_N = 5.0           # superellipse exponent ≈ Apple's continuous corner
TOP = (0x1a, 0x1f, 0x2e)
BOTTOM = (0x10, 0x14, 0x1f)


def mark_bbox(w, h, ch, px):
    x0, y0, x1, y1 = w, h, -1, -1
    for y in range(h):
        row = y * w
        for x in range(w):
            if px[(row + x) * ch + 3] > 8:
                if x < x0: x0 = x
                if x > x1: x1 = x
                if y < y0: y0 = y
                if y > y1: y1 = y
    return x0, y0, x1, y1


def resample(src, sw, sh, ch, box, tw, th):
    """Area-average `box` (x0,y0,x1,y1) of the source down to tw x th, premultiplied."""
    x0, y0, x1, y1 = box
    bw, bh = x1 - x0 + 1, y1 - y0 + 1
    out = bytearray(tw * th * 4)
    for ty in range(th):
        sy0 = y0 + ty * bh / th
        sy1 = y0 + (ty + 1) * bh / th
        iy0, iy1 = int(sy0), max(int(sy0) + 1, math.ceil(sy1))
        for tx in range(tw):
            sx0 = x0 + tx * bw / tw
            sx1 = x0 + (tx + 1) * bw / tw
            ix0, ix1 = int(sx0), max(int(sx0) + 1, math.ceil(sx1))
            ar = ag = ab = aa = n = 0.0
            for sy in range(iy0, min(iy1, sh)):
                base = sy * sw
                for sx in range(ix0, min(ix1, sw)):
                    o = (base + sx) * ch
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
                out[t + 3] = min(255, round(aa / n * 255))
    return out


def plate_alpha(x, y):
    """Anti-aliased coverage of the squircle at pixel centre (x, y)."""
    a = BODY / 2.0
    dx = abs(x + 0.5 - N / 2.0)
    dy = abs(y + 0.5 - N / 2.0)
    if dx > a + 2 or dy > a + 2:
        return 0.0
    if dx < 1e-6 and dy < 1e-6:
        return 1.0
    r = ((dx / a) ** SQUIRCLE_N + (dy / a) ** SQUIRCLE_N) ** (1.0 / SQUIRCLE_N)
    d = (1.0 - r) * math.hypot(dx, dy) / max(r, 1e-6)   # ≈ signed distance in px
    return min(1.0, max(0.0, 0.5 + d))


w, h, ch, px = read_png(SRC)
box = mark_bbox(w, h, ch, px)
bw, bh = box[2] - box[0] + 1, box[3] - box[1] + 1
mw = MARK_W
mh = max(1, round(bh * mw / bw))
mark = resample(px, w, h, ch, box, mw, mh)
print(f'mark bbox {box} -> {mw}x{mh}')

canvas = bytearray(N * N * 4)
for y in range(N):
    t = y / (N - 1)
    pr = round(TOP[0] + (BOTTOM[0] - TOP[0]) * t)
    pg = round(TOP[1] + (BOTTOM[1] - TOP[1]) * t)
    pb = round(TOP[2] + (BOTTOM[2] - TOP[2]) * t)
    for x in range(N):
        a = plate_alpha(x, y)
        if a <= 0:
            continue
        o = (y * N + x) * 4
        canvas[o], canvas[o + 1], canvas[o + 2], canvas[o + 3] = pr, pg, pb, round(a * 255)

ox, oy = (N - mw) // 2, (N - mh) // 2
for y in range(mh):
    for x in range(mw):
        s = (y * mw + x) * 4
        sa = mark[s + 3] / 255.0
        if sa <= 0:
            continue
        d = ((oy + y) * N + ox + x) * 4
        da = canvas[d + 3] / 255.0
        oa = sa + da * (1 - sa)
        for c in range(3):
            canvas[d + c] = round((mark[s + c] * sa + canvas[d + c] * da * (1 - sa)) / oa)
        canvas[d + 3] = round(oa * 255)

write_png(OUT, N, N, canvas)
print('wrote', OUT)
