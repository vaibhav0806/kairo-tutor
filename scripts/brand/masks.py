"""Split the Kairo mark PNG into three trace masks: body silhouette, face blob, eyes."""
import pathlib
from png import read_png, write_pbm

ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC = str(ROOT / 'assets/brand/kairo-mark-source-1024.png')

VIOLET = (0x5c, 0x26, 0xf1)
WHITE = (0xfe, 0xfe, 0xfe)
EYE = (0x0f, 0x0e, 0x1a)


def nearest(r, g, b):
    best, bi = None, 0
    for i, (cr, cg, cb) in enumerate((VIOLET, WHITE, EYE)):
        d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2
        if best is None or d < best:
            best, bi = d, i
    return bi  # 0 violet, 1 white, 2 eye


w, h, ch, px = read_png(SRC)
body = bytearray(w * h)
face = bytearray(w * h)
eyes = bytearray(w * h)

for y in range(h):
    for x in range(w):
        o = (y * w + x) * ch
        a = px[o + 3] if ch == 4 else 255
        if a < 128:
            continue
        i = y * w + x
        body[i] = 1
        cls = nearest(px[o], px[o + 1], px[o + 2])
        if cls in (1, 2):
            face[i] = 1          # the face blob, eye holes included (eyes paint on top)
        if cls == 2:
            eyes[i] = 1

write_pbm('body.pbm', w, h, body)
write_pbm('face.pbm', w, h, face)
write_pbm('eyes.pbm', w, h, eyes)
print('masks written', w, h, 'body', sum(body), 'face', sum(face), 'eyes', sum(eyes))
