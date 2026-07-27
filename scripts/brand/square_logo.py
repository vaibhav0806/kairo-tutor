"""Square, padded, transparent PNGs of the mark for third-party dashboards.

Both targets crop or frame the image themselves, so the mark is inset inside a square canvas
rather than filling it, and the background stays transparent — the mark reads on light AND dark
(violet ring, white face) so one asset covers both themes.

  google-oauth-logo-120.png  OAuth consent screen. Google wants square, >=120x120, <=1MB,
                             PNG/JPG/BMP. 120 is their stated minimum and what they display.
  dodo-logo-512.png          Dodo Settings -> Business / Design -> General. Their docs ask for a
                             high-res PNG, minimum 300x300, because it also prints on invoices.
"""
import math
import pathlib
from png import read_png, write_png

ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC = str(ROOT / 'assets/brand/kairo-mark-source-1024.png')

TARGETS = [('google-oauth-logo-120.png', 120), ('dodo-logo-512.png', 512)]
INSET = 0.12  # share of the canvas left as breathing room on the tightest axis


def bbox(src, w, h, ch):
    x0, y0, x1, y1 = w, h, -1, -1
    for y in range(h):
        for x in range(w):
            if src[((y * w) + x) * ch + 3] > 8:
                x0, y0 = min(x0, x), min(y0, y)
                x1, y1 = max(x1, x), max(y1, y)
    return x0, y0, x1, y1


def resample(src, sw, sh, ch, box, tw, th):
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


w, h, ch, px = read_png(SRC)
box = bbox(px, w, h, ch)
bw, bh = box[2] - box[0] + 1, box[3] - box[1] + 1

for name, size in TARGETS:
    avail = size * (1 - 2 * INSET)
    scale = avail / max(bw, bh)          # the taller axis sets the size, so nothing clips
    mw, mh = max(1, round(bw * scale)), max(1, round(bh * scale))
    mark = resample(px, w, h, ch, box, mw, mh)
    canvas = bytearray(size * size * 4)
    ox, oy = (size - mw) // 2, (size - mh) // 2
    for y in range(mh):
        for x in range(mw):
            s = (y * mw + x) * 4
            d = ((oy + y) * size + ox + x) * 4
            canvas[d:d + 4] = mark[s:s + 4]
    write_png(name, size, size, canvas)
    print(f'wrote {name} {size}x{size} (mark {mw}x{mh})')
