"""Menu-bar template icon: the mark as one black+alpha glyph AppKit can tint.

tray-icon normalises the status item to 18pt tall, so we ship 2x pixels (36px tall) and let
NSImage.setSize scale it down — crisp on Retina. Ink = the violet body + the eyes; the white
face is punched out to transparent.
"""
import pathlib
from png import read_png, write_png

ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC = str(ROOT / 'assets/brand/kairo-mark-source-1024.png')
OUT = 'kairo-tray-template.png'
TARGET_H = 36  # 18pt @2x

w, h, ch, px = read_png(SRC)

# Per-pixel ink coverage: opaque + not-white. The ramp keeps the violet/face and face/eye
# antialiasing smooth instead of stair-stepping the punch-out.
ink = [0.0] * (w * h)
x0, y0, x1, y1 = w, h, -1, -1
for y in range(h):
    for x in range(w):
        o = (y * w + x) * ch
        a = px[o + 3] / 255.0
        if a <= 0:
            continue
        lo = min(px[o], px[o + 1], px[o + 2])
        white = min(1.0, max(0.0, (lo - 120) / 130.0))
        v = a * (1.0 - white)
        if v > 0.004:
            ink[y * w + x] = v
            if x < x0: x0 = x
            if x > x1: x1 = x
            if y < y0: y0 = y
            if y > y1: y1 = y

bw, bh = x1 - x0 + 1, y1 - y0 + 1
th = TARGET_H
tw = max(1, round(bw * th / bh))
out = bytearray(tw * th * 4)
for ty in range(th):
    sy0, sy1 = y0 + ty * bh / th, y0 + (ty + 1) * bh / th
    for tx in range(tw):
        sx0, sx1 = x0 + tx * bw / tw, x0 + (tx + 1) * bw / tw
        acc = n = 0.0
        for sy in range(int(sy0), max(int(sy0) + 1, int(sy1 + 0.999))):
            if sy >= h:
                break
            for sx in range(int(sx0), max(int(sx0) + 1, int(sx1 + 0.999))):
                if sx >= w:
                    break
                acc += ink[sy * w + sx]
                n += 1
        t = (ty * tw + tx) * 4
        out[t] = out[t + 1] = out[t + 2] = 0
        out[t + 3] = round(min(1.0, acc / n) * 255) if n else 0

write_png(OUT, tw, th, out)
print(f'wrote {OUT} {tw}x{th} (bbox {bw}x{bh})')
