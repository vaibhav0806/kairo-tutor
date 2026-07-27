"""Assemble the three potrace outputs into the shipped SVG kit."""
import re

TRANSFORM = 'translate(0,1024) scale(0.1,-0.1)'
VIOLET = '#5c26f1'
FACE = '#fefefe'
EYE = '#0f0e1a'


def path_of(name):
    svg = open(f'{name}.svg').read()
    xf = re.search(r'transform="([^"]+)"', svg).group(1)
    assert 'scale(0.100000,-0.100000)' in xf, xf
    ds = re.findall(r'<path d="([^"]+)"', svg)
    assert len(ds) == 1, f'{name}: expected one flat path, got {len(ds)}'
    return re.sub(r'\s+', ' ', ds[0]).strip()


body, face, eyes = path_of('body'), path_of('face'), path_of('eyes')

full = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-label="Kairo">
  <title>Kairo</title>
  <g transform="{TRANSFORM}">
    <path fill="{VIOLET}" d="{body}"/>
    <path fill="{FACE}" d="{face}"/>
    <path fill="{EYE}" d="{eyes}"/>
  </g>
</svg>
'''

# Template variant for the macOS menu bar: one colour + real transparency, so AppKit can
# tint it for the light/dark menu bar. evenodd turns the face into a hole in the body ring.
mono = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-label="Kairo">
  <title>Kairo</title>
  <g transform="{TRANSFORM}" fill="#000000">
    <path fill-rule="evenodd" d="{body} {face}"/>
    <path d="{eyes}"/>
  </g>
</svg>
'''

open('kairo-mark.svg', 'w').write(full)
open('kairo-mark-mono.svg', 'w').write(mono)
print('kairo-mark.svg', len(full), 'bytes')
print('kairo-mark-mono.svg', len(mono), 'bytes')
