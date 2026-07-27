# Brand asset pipeline

Everything here regenerates Kairo's logo assets from one source bitmap. Pure Python — no
third-party packages. The only external tool is [potrace](http://potrace.sourceforge.net/)
(`brew install potrace`), used to turn the bitmap masks into vector curves.

## Source of truth

`assets/brand/kairo-mark-source-1024.png` — the mark as shipped by the brand/landing repo
(`prasad-178/kairo` → `public/brand/kairo-mark-transparent-1024.png`). If the brand mark
ever changes, replace that file and re-run the steps below.

Sampled colours (flat; the source's violet gradient spans only #5822f0 → #602df3, which is
visually flat, so the SVG uses the mean):

| part | hex |
| --- | --- |
| body | `#5c26f1` |
| face | `#fefefe` |
| eyes | `#0f0e1a` |

Note this is the *logo's* violet. The UI accent is the website's `--kairo: #665cff` — a
different, lighter value on purpose. Don't unify them.

## Regenerate

```bash
cd scripts/brand
python3 masks.py                       # source PNG -> body/face/eyes PBM masks
for m in body face eyes; do            # masks -> vector
  potrace -s --flat -o $m.svg --turdsize 8 --alphamax 1.0 --opttolerance 0.2 $m.pbm
done
python3 assemble.py                    # -> kairo-mark.svg + kairo-mark-mono.svg
python3 compose_icon.py                # -> kairo-icon-1024.png (macOS squircle plate)
python3 tray_template.py               # -> kairo-tray-template.png (menu-bar template)
```

Then copy the outputs to where the app reads them:

| output | destination | used by |
| --- | --- | --- |
| `kairo-mark.svg` | `public/brand/kairo-mark.svg` | every WebView surface (`<img src="/brand/kairo-mark.svg">`) |
| `kairo-mark-mono.svg` | `assets/brand/` | source for the tray raster |
| `kairo-icon-1024.png` | `assets/brand/` | `npm run tauri icon assets/brand/kairo-icon-1024.png` → Dock/Finder/About/notifications |
| `kairo-tray-template.png` | `src-tauri/icons/tray-template.png` | the menu-bar status item (`lib.rs`) |

The intermediate `*.pbm` / `body|face|eyes.svg` files are throwaway — don't commit them.

## Why each output looks the way it does

- **`kairo-mark.svg`** — three flat paths (body, face, eyes) sharing potrace's
  `translate(0,1024) scale(0.1,-0.1)` transform, in a `0 0 1024 1024` viewBox.
- **`kairo-mark-mono.svg`** — one colour plus real transparency so AppKit can tint it. The
  face is punched out of the body with `fill-rule="evenodd"`; the eyes paint on top.
- **`kairo-icon-1024.png`** — Apple's Big Sur grid: 824×824 body centred in a 1024 canvas,
  continuous (superellipse) corners, `--surface-deep`-family plate, mark at 496px wide.
- **`kairo-tray-template.png`** — 28×36 (18pt @2x). `tray-icon` normalises the status item
  to 18pt tall via `NSImage.setSize`, so shipping 2x pixels keeps it crisp on Retina.
