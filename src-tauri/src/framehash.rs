//! Perceptual frame fingerprint for the follow-along loop.
//!
//! dHash (difference hash): downscale to 17x16 grayscale, then for each row
//! compare each pixel to its right neighbour (16 comparisons x 16 rows = 256
//! bits). Robust to minor pixel noise, sensitive to structural change (scroll,
//! page load, navigation). Comparison is popcount of XOR — nanoseconds.
//! The hash is 8 x u32 so it round-trips to the JS frontend as number[].

pub(crate) const HASH_U32S: usize = 8; // 256 bits

pub(crate) fn dhash_from_bytes(bytes: &[u8]) -> Result<[u32; HASH_U32S], String> {
    let img = image::load_from_memory(bytes).map_err(|e| format!("decode: {e}"))?;
    Ok(dhash(&img))
}

pub(crate) fn dhash(img: &image::DynamicImage) -> [u32; HASH_U32S] {
    let small = img
        .resize_exact(17, 16, image::imageops::FilterType::Triangle)
        .to_luma8();
    let mut bits = [0u32; HASH_U32S];
    let mut idx = 0usize;
    for y in 0..16u32 {
        for x in 0..16u32 {
            let left = small.get_pixel(x, y).0[0];
            let right = small.get_pixel(x + 1, y).0[0];
            if left > right {
                bits[idx / 32] |= 1u32 << (idx % 32);
            }
            idx += 1;
        }
    }
    bits
}

/// Number of differing bits (0..=256). Lower = more similar.
// Only exercised by tests today; the runtime comparison consumer lands in a
// later follow-along unit. Kept as the primitive's public "compare" half.
#[allow(dead_code)]
pub(crate) fn hamming(a: &[u32; HASH_U32S], b: &[u32; HASH_U32S]) -> u32 {
    let mut d = 0u32;
    for i in 0..HASH_U32S {
        d += (a[i] ^ b[i]).count_ones();
    }
    d
}

/// Copy exactly `width * 4` bytes out of each of `height` rows from a possibly
/// stride-padded 32bpp buffer, producing a tightly packed `width*height*4` Vec.
/// `bytes_per_row` (the source stride) may exceed `width*4` due to row alignment,
/// so we index each row by the stride rather than assuming packed rows — getting
/// this wrong shears the image and poisons the hash. Returns None if the geometry
/// is degenerate or the source slice is too short. Pure + unit-tested; byte order
/// is preserved as-is (the caller does the BGRA→RGBA swap — see `swap_rb`).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn pack_stride_rows(
    bytes: &[u8],
    width: usize,
    height: usize,
    bytes_per_row: usize,
) -> Option<Vec<u8>> {
    if width == 0 || height == 0 {
        return None;
    }
    let row_len = width.checked_mul(4)?;
    if bytes_per_row < row_len {
        return None; // stride can't be narrower than the visible row
    }
    // Last row starts at (height-1)*stride and needs row_len bytes present.
    let needed = (height - 1).checked_mul(bytes_per_row)?.checked_add(row_len)?;
    if bytes.len() < needed {
        return None;
    }
    let mut packed = Vec::with_capacity(row_len.checked_mul(height)?);
    for y in 0..height {
        let start = y * bytes_per_row;
        packed.extend_from_slice(&bytes[start..start + row_len]);
    }
    Some(packed)
}

/// In place, swap byte 0 and byte 2 of every 4-byte pixel: `[B,G,R,A] → [R,G,B,A]`.
/// CGDisplay bitmaps are BGRA; the PNG-decode fallback yields RGBA. Swapping here
/// makes the fast path's true-luma dHash identical to the PNG path's, so the two
/// are interchangeable within a session (a transient fast→png fallback can't flip
/// a saturated-color frame's hash and cause a false "changed" verdict). Trailing
/// bytes that don't complete a 4-byte pixel are left untouched. Pure + unit-tested.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn swap_rb(buf: &mut [u8]) {
    for px in buf.chunks_exact_mut(4) {
        px.swap(0, 2);
    }
}

/// In-process capture of the main display → 256-bit dHash. No temp file, no
/// `screencapture` process spawn: grabs the display's CGImage bitmap directly,
/// packs its rows (respecting stride), hashes it, and drops the full-frame buffer
/// here — only the 32-byte hash escapes, so nothing pixel-sized is retained. This
/// is the whole point of the fast path (the settle loop + background poll call it
/// repeatedly). Returns None on any failure so the caller falls back to PNG.
///
/// Needs the same Screen Recording TCC grant `screencapture` already relies on —
/// no new entitlement. CGDisplay bitmaps are BGRA, so we swap R/B (`swap_rb`) into
/// true RGBA before hashing: that makes this path's true-luma dHash identical to
/// the PNG fallback's, so the fast and png paths are interchangeable within one
/// session (a transient fallback can't produce a false "changed" verdict). The
/// extra pass is negligible — the frame is discarded immediately after.
#[cfg(target_os = "macos")]
fn capture_display_dhash_fast() -> Option<[u32; HASH_U32S]> {
    use core_graphics::display::CGDisplay;

    let display = CGDisplay::main();
    let cg_image = display.image()?; // CGImage of the whole main display

    // Only the standard 32bpp / 8bpc packed layout is safe to reinterpret as
    // RGBA(=BGRA) here; anything else (planar, 10-bit HDR, etc.) falls back to PNG.
    let bpp = cg_image.bits_per_pixel();
    let bpc = cg_image.bits_per_component();
    if bpp != 32 || bpc != 8 {
        crate::klog!(follow, warn, bpp = bpp, bpc = bpc, "unexpected display bitmap layout; skipping fast path");
        return None;
    }

    let width = cg_image.width();
    let height = cg_image.height();
    let bytes_per_row = cg_image.bytes_per_row();
    let data = cg_image.data(); // CFData owning a copy of the bitmap
    let mut packed = pack_stride_rows(data.bytes(), width, height, bytes_per_row)?;
    swap_rb(&mut packed); // BGRA → RGBA, so this hash matches the PNG path's

    let buf = image::RgbaImage::from_raw(width as u32, height as u32, packed)?;
    let dynimg = image::DynamicImage::ImageRgba8(buf);
    Some(dhash(&dynimg))
    // `dynimg`, `buf`'s backing Vec, `data`, and `cg_image` all drop here.
}

/// Capture the current screen and return its 256-bit dHash fingerprint. Prefers
/// the in-process fast path (direct display bitmap, no disk / no process spawn);
/// falls back to the `screencapture` PNG path if that fails. Either way the frame
/// is decoded + downscaled locally for hashing; no pixels leave the machine.
#[tauri::command]
pub(crate) fn capture_frame_hash() -> Result<crate::types::FrameHash, String> {
    let _t = crate::klog::timer("follow", "capture_frame_hash");
    #[cfg(target_os = "macos")]
    {
        if let Some(hash) = capture_display_dhash_fast() {
            crate::klog!(follow, debug, path = "fast", "captured frame hash");
            return Ok(crate::types::FrameHash {
                hash: hash.to_vec(),
            });
        }
        crate::klog!(follow, warn, "fast capture failed; falling back to screencapture");
    }
    let png = crate::capture::capture_screen_png_bytes()?;
    let hash = dhash_from_bytes(&png)?;
    crate::klog!(follow, debug, path = "png", bytes = png.len(), "captured frame hash");
    Ok(crate::types::FrameHash {
        hash: hash.to_vec(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, RgbImage};

    fn solid(w: u32, h: u32, v: u8) -> DynamicImage {
        DynamicImage::ImageRgb8(RgbImage::from_pixel(w, h, image::Rgb([v, v, v])))
    }

    #[test]
    fn identical_images_have_zero_distance() {
        let a = dhash(&solid(200, 200, 128));
        let b = dhash(&solid(200, 200, 128));
        assert_eq!(hamming(&a, &b), 0);
    }

    #[test]
    fn a_horizontal_gradient_differs_from_flat() {
        // dHash sets a bit only where a pixel is BRIGHTER than its right neighbour
        // (`left > right`). A flat image gives all-zero bits; so does a *rising*
        // left-to-right gradient (`left < right` everywhere). To be distinguishable
        // from flat, the gradient must brighten toward the LEFT (fall to the right)
        // so every horizontal comparison sets its bit.
        let flat = dhash(&solid(64, 64, 128));
        let mut grad = RgbImage::new(64, 64);
        for (x, _y, px) in grad.enumerate_pixels_mut() {
            let v = ((63 - x) * 4) as u8;
            *px = image::Rgb([v, v, v]);
        }
        let grad = dhash(&DynamicImage::ImageRgb8(grad));
        assert!(hamming(&flat, &grad) > 20, "gradient should be clearly different");
    }

    #[test]
    fn pack_stride_rows_drops_row_padding() {
        // 2x2 image, 32bpp, with 4 bytes of padding after each 8-byte visible row
        // (stride = 12). Distinct byte values per pixel so a stride mistake shows.
        let width = 2usize;
        let height = 2usize;
        let stride = 12usize; // width*4 (=8) + 4 pad
        let mut src = vec![0u8; stride * height];
        // row 0 pixels
        src[0..8].copy_from_slice(&[1, 2, 3, 4, 5, 6, 7, 8]);
        // src[8..12] = padding (stays 0)
        // row 1 pixels
        src[12..20].copy_from_slice(&[9, 10, 11, 12, 13, 14, 15, 16]);
        // src[20..24] = padding
        let packed = pack_stride_rows(&src, width, height, stride).expect("should pack");
        assert_eq!(
            packed,
            vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]
        );
    }

    #[test]
    fn pack_stride_rows_handles_zero_padding() {
        // stride == width*4 (packed rows) must pass through unchanged.
        let src: Vec<u8> = (0..24u8).collect(); // 2x3 @ 4bpp, stride 8
        let packed = pack_stride_rows(&src, 2, 3, 8).expect("should pack");
        assert_eq!(packed, src);
    }

    #[test]
    fn swap_rb_turns_bgra_into_rgba() {
        // Two pixels: [B,G,R,A]. Swapping bytes 0 and 2 yields [R,G,B,A].
        let mut buf = vec![10, 20, 30, 40, 50, 60, 70, 80];
        swap_rb(&mut buf);
        assert_eq!(buf, vec![30, 20, 10, 40, 70, 60, 50, 80]);
    }

    #[test]
    fn swap_rb_leaves_trailing_partial_pixel_untouched() {
        // 4 whole bytes + 2 stragglers: only the complete pixel is swapped.
        let mut buf = vec![1, 2, 3, 4, 5, 6];
        swap_rb(&mut buf);
        assert_eq!(buf, vec![3, 2, 1, 4, 5, 6]);
    }

    #[test]
    fn pack_stride_rows_rejects_bad_geometry() {
        // stride narrower than a visible row
        assert!(pack_stride_rows(&[0u8; 16], 2, 2, 4).is_none());
        // source too short for the claimed height
        assert!(pack_stride_rows(&[0u8; 8], 2, 2, 8).is_none());
        // degenerate dimensions
        assert!(pack_stride_rows(&[0u8; 8], 0, 2, 8).is_none());
        assert!(pack_stride_rows(&[0u8; 8], 2, 0, 8).is_none());
    }
}
