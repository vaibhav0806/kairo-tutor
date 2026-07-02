//! Accent-colour selection: derive a vibrant, high-contrast highlight hue from the
//! pixels behind a detected box.

// Vibrant candidate hues (deg): cyan, violet, magenta, lime, orange, yellow.
const ACCENT_HUES: [f64; 6] = [190.0, 275.0, 320.0, 95.0, 30.0, 55.0];

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

fn hue_dist(a: f64, b: f64) -> f64 {
    let d = (a - b).abs().rem_euclid(360.0);
    d.min(360.0 - d)
}

// Pick a vibrant, high-contrast accent: the candidate hue farthest from the
// background hue, saturated, with lightness opposite the background's so it
// always pops and stays readable.
pub(crate) fn vibrant_accent(bg_r: f64, bg_g: f64, bg_b: f64) -> String {
    let (bg_h, _s, bg_l) = rgb_to_hsl(bg_r, bg_g, bg_b);
    let hue = ACCENT_HUES
        .iter()
        .copied()
        .max_by(|a, b| {
            hue_dist(*a, bg_h)
                .partial_cmp(&hue_dist(*b, bg_h))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .unwrap_or(190.0);
    let lightness = if bg_l > 0.5 { 0.44 } else { 0.62 };
    let (r, g, b) = hsl_to_rgb(hue, 0.85, lightness);
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
