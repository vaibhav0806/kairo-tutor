//! Accent-colour selection: the user's chosen accent is the base tint; we contrast-adjust its
//! lightness against the pixels behind a detected box only when it would be invisible there.

// Parse "#rrggbb" → (r, g, b) as 0..255 floats (matching rgb_to_hsl's input). None if malformed.
fn parse_hex(hex: &str) -> Option<(f64, f64, f64)> {
    let h = hex.strip_prefix('#')?;
    if h.len() != 6 || !h.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let n = u32::from_str_radix(h, 16).ok()?;
    Some((
        ((n >> 16) & 0xff) as f64,
        ((n >> 8) & 0xff) as f64,
        (n & 0xff) as f64,
    ))
}

// How close (in HSL lightness) the accent may sit to the background before we treat it as
// invisible and push its lightness to the opposite end.
const ACCENT_MIN_L_CONTRAST: f64 = 0.22;
// Floor on saturation so the on-screen accent always reads as vibrant, not washed out.
const ACCENT_MIN_S: f64 = 0.6;

fn rgb_to_hsl(r: f64, g: f64, b: f64) -> (f64, f64, f64) {
    let (r, g, b) = (r / 255.0, g / 255.0, b / 255.0);
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) / 2.0;
    let d = max - min;
    if d < 1e-9 {
        return (0.0, 0.0, l);
    }
    let s = if l > 0.5 {
        d / (2.0 - max - min)
    } else {
        d / (max + min)
    };
    let mut h = if (max - r).abs() < 1e-9 {
        ((g - b) / d).rem_euclid(6.0)
    } else if (max - g).abs() < 1e-9 {
        (b - r) / d + 2.0
    } else {
        (r - g) / d + 4.0
    } * 60.0;
    if h < 0.0 {
        h += 360.0;
    }
    (h, s, l)
}

fn hsl_to_rgb(h: f64, s: f64, l: f64) -> (u8, u8, u8) {
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let hp = (h.rem_euclid(360.0)) / 60.0;
    let x = c * (1.0 - ((hp.rem_euclid(2.0)) - 1.0).abs());
    let (r1, g1, b1) = if hp < 1.0 {
        (c, x, 0.0)
    } else if hp < 2.0 {
        (x, c, 0.0)
    } else if hp < 3.0 {
        (0.0, c, x)
    } else if hp < 4.0 {
        (0.0, x, c)
    } else if hp < 5.0 {
        (x, 0.0, c)
    } else {
        (c, 0.0, x)
    };
    let m = l - c / 2.0;
    (
        ((r1 + m) * 255.0).round() as u8,
        ((g1 + m) * 255.0).round() as u8,
        ((b1 + m) * 255.0).round() as u8,
    )
}

/// The highlight/pointer accent for a target. The **user accent** (`accent_hex`) is the base:
/// its HUE is always preserved. We only contrast-adjust its LIGHTNESS when the accent sits within
/// `ACCENT_MIN_L_CONTRAST` of the background behind the box — then we push lightness to the
/// opposite end so it stays visible. Saturation is floored so it stays vibrant. A malformed
/// accent falls back to the brand default.
pub(crate) fn vibrant_accent(accent_hex: &str, bg_r: f64, bg_g: f64, bg_b: f64) -> String {
    let (ar, ag, ab) = parse_hex(accent_hex)
        .or_else(|| parse_hex(crate::constants::DEFAULT_ACCENT))
        .unwrap_or((124.0, 58.0, 237.0));
    let (h_a, s_a, l_a) = rgb_to_hsl(ar, ag, ab);
    let (_h_bg, _s_bg, l_bg) = rgb_to_hsl(bg_r, bg_g, bg_b);
    let s = s_a.max(ACCENT_MIN_S);
    // Keep the user's own lightness unless it's too close to the background to be seen.
    let l = if (l_a - l_bg).abs() < ACCENT_MIN_L_CONTRAST {
        if l_bg > 0.5 { 0.44 } else { 0.62 }
    } else {
        l_a
    };
    let (r, g, b) = hsl_to_rgb(h_a, s, l);
    format!("#{r:02x}{g:02x}{b:02x}")
}

// Average colour of the ring just OUTSIDE the box (its background), stride-sampled
// so it stays cheap regardless of box size. Falls back to a neutral dark grey.
pub(crate) fn sample_background(
    rgb: &image::RgbImage,
    x1: u32,
    y1: u32,
    x2: u32,
    y2: u32,
) -> (f64, f64, f64) {
    let (w, h) = (rgb.width(), rgb.height());
    if w == 0 || h == 0 {
        return (30.0, 30.0, 30.0);
    }
    let margin = ((x2.saturating_sub(x1)).max(y2.saturating_sub(y1)) / 3).clamp(8, 80);
    let ox1 = x1.saturating_sub(margin);
    let oy1 = y1.saturating_sub(margin);
    let ox2 = (x2 + margin).min(w - 1);
    let oy2 = (y2 + margin).min(h - 1);
    let area = (ox2.saturating_sub(ox1) + 1) as u64 * (oy2.saturating_sub(oy1) + 1) as u64;
    let stride = (area / 1500).max(1);
    let (mut sr, mut sg, mut sb, mut n, mut i) = (0u64, 0u64, 0u64, 0u64, 0u64);
    for yy in oy1..=oy2 {
        for xx in ox1..=ox2 {
            if xx >= x1 && xx <= x2 && yy >= y1 && yy <= y2 {
                continue; // skip the element itself; sample only its surroundings
            }
            i += 1;
            if i % stride != 0 {
                continue;
            }
            let p = rgb.get_pixel(xx, yy);
            sr += p[0] as u64;
            sg += p[1] as u64;
            sb += p[2] as u64;
            n += 1;
        }
    }
    if n == 0 {
        return (30.0, 30.0, 30.0);
    }
    (
        sr as f64 / n as f64,
        sg as f64 / n as f64,
        sb as f64 / n as f64,
    )
}

#[cfg(test)]
mod tests {
    use super::{parse_hex, vibrant_accent};

    #[test]
    fn keeps_user_hue_when_it_contrasts() {
        // Violet accent on a near-white background: lightness differs plenty → hue is preserved,
        // so the result stays blue-dominant (blue is violet's max channel).
        let out = vibrant_accent("#7c3aed", 245.0, 245.0, 245.0);
        let (r, g, b) = parse_hex(&out).unwrap();
        assert!(b > r && b > g, "expected a violet-ish hue, got {out}");
    }

    #[test]
    fn shifts_lightness_when_invisible_against_bg() {
        // Background lightness ≈ accent lightness → the safety-adjust fires and the output moves.
        let out = vibrant_accent("#7c3aed", 122.0, 90.0, 175.0);
        assert_ne!(out.to_lowercase(), "#7c3aed");
    }

    #[test]
    fn falls_back_to_default_on_bad_accent() {
        let out = vibrant_accent("not-a-hex", 30.0, 30.0, 30.0);
        assert!(out.starts_with('#') && out.len() == 7);
    }
}
