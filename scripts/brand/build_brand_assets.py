#!/usr/bin/env python3
"""Generate the Modaafa identity v1.0 SVG set into public/brand.

Symbol construction (approved sheet, section 02): a small square s touches a
square 2s at the corner, and a yellow lamp s/2 sits at the top-right of the big
square. In a 12-unit box: big 8x8 at (4,0), small 4x4 at (0,8), lamp 2x2 at (10,0).
The wordmark paths were traced from the approved master artwork
(scripts/brand/wordmark-paths.json, source pixel coordinates).
"""
import json, os, pathlib
NAVY, PAPER, YELLOW = '#0E1426', '#F4F2EC', '#FBBC04'
root = pathlib.Path(__file__).resolve().parents[2]
out = root / 'public' / 'brand'
out.mkdir(parents=True, exist_ok=True)
wm = json.load(open(pathlib.Path(__file__).with_name('wordmark-paths.json')))
AR, EN = wm['ar'], wm['en']

def svg(vb, body, title):
    x, y, w, h = vb
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{x} {y} {w} {h}" role="img" aria-label="{title}">'
            f'<title>{title}</title>{body}</svg>\n')

def symbol(ink, lamp, tx=0, ty=0, k=1.0):
    t = f' transform="translate({tx} {ty}) scale({k})"' if (tx or ty or k != 1.0) else ''
    lamp_el = f'<rect x="10" y="0" width="2" height="2" fill="{lamp}"/>' if lamp else ''
    return (f'<g{t}><rect x="4" y="0" width="8" height="8" fill="{ink}"/>'
            f'<rect x="0" y="8" width="4" height="4" fill="{ink}"/>{lamp_el}</g>')

def write(name, content):
    (out / name).write_text(content, encoding='utf-8')

# symbol only
write('modaafa-symbol-primary.svg', svg((0,0,12,12), symbol(NAVY, YELLOW), 'مُضاعِف'))
write('modaafa-symbol-reversed.svg', svg((0,0,12,12), symbol(PAPER, YELLOW), 'مُضاعِف'))
write('modaafa-symbol-mono-navy.svg', svg((0,0,12,12), symbol(NAVY, NAVY), 'مُضاعِف'))
write('modaafa-symbol-mono-paper.svg', svg((0,0,12,12), symbol(PAPER, PAPER), 'مُضاعِف'))
# tiles (app icons): reversed on navy, accent on yellow (lamp merges into the field by design)
def tile_svg(bg, ink, lamp, inner, title='مُضاعِف'):
    k = inner / 12.0
    off = (64 - inner) / 2
    return svg((0,0,64,64), f'<rect width="64" height="64" fill="{bg}"/>' + symbol(ink, lamp, off, off, k), title)
write('modaafa-symbol-tile-reversed.svg', tile_svg(NAVY, PAPER, YELLOW, 36))
write('modaafa-symbol-tile-accent.svg', tile_svg(YELLOW, NAVY, None, 36))
write('modaafa-symbol-maskable.svg', tile_svg(NAVY, PAPER, YELLOW, 30))   # inside the 80% safe zone

# horizontal lockup, source-pixel space of the approved master
SYM_X, SYM_Y, U = 1010.0, 213.0, 202.0 / 12.0
def lockup(word, sym_ink, lamp):
    body = (f'<path d="{AR}" fill="{word}" fill-rule="evenodd"/>'
            f'<path d="{EN}" fill="{word}" fill-rule="evenodd"/>'
            + symbol(sym_ink, lamp, SYM_X, SYM_Y, U))
    return svg((238, 213, 974, 229), body, 'مُضاعِف MODAAFA')
write('modaafa-lockup-primary.svg', lockup(NAVY, NAVY, YELLOW))
write('modaafa-lockup-reversed.svg', lockup(PAPER, PAPER, YELLOW))
write('modaafa-lockup-mono-navy.svg', lockup(NAVY, NAVY, NAVY))
write('modaafa-lockup-mono-paper.svg', lockup(PAPER, PAPER, PAPER))

# stacked: symbol centred above the wordmark
cx = (238.25 + 961.5) / 2
def stacked(word, sym_ink, lamp):
    sx = cx - 101.0
    sy = 217 - 202 - 48
    body = (f'<path d="{AR}" fill="{word}" fill-rule="evenodd"/>'
            f'<path d="{EN}" fill="{word}" fill-rule="evenodd"/>'
            + symbol(sym_ink, lamp, sx, sy, U))
    return svg((238, sy, 724, 442 - sy), body, 'مُضاعِف MODAAFA')
write('modaafa-stacked-primary.svg', stacked(NAVY, NAVY, YELLOW))
write('modaafa-stacked-reversed.svg', stacked(PAPER, PAPER, YELLOW))
print('ok', sorted(p.name for p in out.glob('*.svg')))
