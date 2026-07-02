//! On-screen text detection (Apple Vision OCR) and the text-hint context blocks
//! used to ground the model's targets on real screen elements.

use crate::types::{OcrElement, OverlayDisplayBounds, TutorTurnInput};
#[cfg(target_os = "macos")]
use crate::types::ScreenRegion;

// Run Apple's Vision OCR on the screenshot bytes and return on-screen text
// elements with accurate regions. Synchronous (Vision's performRequests blocks).
#[cfg(target_os = "macos")]
pub(crate) fn ocr_screenshot(image_bytes: &[u8], bounds: &OverlayDisplayBounds) -> Vec<OcrElement> {
    use objc2::runtime::AnyObject;
    use objc2::AllocAnyThread;
    use objc2_foundation::{NSArray, NSData, NSDictionary, NSString};
    use objc2_vision::{
        VNImageRequestHandler, VNRecognizeTextRequest, VNRequest, VNRequestTextRecognitionLevel,
    };

    let data = NSData::with_bytes(image_bytes);
    let request = VNRecognizeTextRequest::new();
    request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
    request.setUsesLanguageCorrection(true);

    let options: objc2::rc::Retained<NSDictionary<NSString, AnyObject>> = NSDictionary::new();
    let handler = VNImageRequestHandler::initWithData_options(
        VNImageRequestHandler::alloc(),
        &data,
        &options,
    );

    let request_ref: &VNRequest = &request;
    let requests = NSArray::from_slice(&[request_ref]);
    if handler.performRequests_error(&requests).is_err() {
        return Vec::new();
    }

    let Some(results) = request.results() else {
        return Vec::new();
    };

    let scale_factor = if bounds.scale_factor > 0.0 {
        bounds.scale_factor
    } else {
        1.0
    };
    let mut elements: Vec<OcrElement> = Vec::new();
    for observation in results.iter() {
        if (unsafe { observation.confidence() } as f64) < 0.3 {
            continue;
        }
        let candidates = observation.topCandidates(1);
        let Some(top) = candidates.firstObject() else {
            continue;
        };
        let text = top.string().to_string();
        let text = text.trim().to_string();
        if text.is_empty() {
            continue;
        }

        // Vision boundingBox: normalized [0,1], origin BOTTOM-left of the image.
        let bbox = unsafe { observation.boundingBox() };
        let (min_x, min_y) = (bbox.origin.x, bbox.origin.y);
        let (bw, bh) = (bbox.size.width, bbox.size.height);
        if bw <= 0.0 || bh <= 0.0 {
            continue;
        }
        let left_logical = bounds.x + min_x * bounds.width;
        // Flip Y: bottom-left normalized -> top-left logical.
        let top_logical = bounds.y + (1.0 - (min_y + bh)) * bounds.height;
        elements.push(OcrElement {
            id: elements.len() as u32 + 1,
            text,
            region: ScreenRegion {
                x: left_logical * scale_factor,
                y: top_logical * scale_factor,
                width: bw * bounds.width * scale_factor,
                height: bh * bounds.height * scale_factor,
            },
            center_x_pct: (min_x + bw / 2.0) * 100.0,
            center_y_pct: (1.0 - (min_y + bh / 2.0)) * 100.0,
        });
        if elements.len() >= 200 {
            break;
        }
    }
    elements
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn ocr_screenshot(_image_bytes: &[u8], _bounds: &OverlayDisplayBounds) -> Vec<OcrElement> {
    Vec::new()
}

// OCR the tutor turn's screenshot (the same image the model sees). Empty when no
// screenshot is available — pointing is then disabled rather than hallucinated.
pub(crate) fn ocr_tutor_screenshot(input: &TutorTurnInput) -> Vec<OcrElement> {
    if !input.screen.captured {
        return Vec::new();
    }
    let (Some(image_base64), Some(bounds)) =
        (&input.screen.image_base64, &input.screen.display_bounds)
    else {
        return Vec::new();
    };
    use base64::Engine;
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(image_base64) else {
        return Vec::new();
    };
    ocr_screenshot(&bytes, bounds)
}

pub(crate) fn build_box_locator_context(elements: &[OcrElement]) -> String {
    if elements.is_empty() {
        return "OCR/TEXT HINTS: none available.".to_string();
    }

    let mut lines = Vec::with_capacity(elements.len().min(80) + 1);
    lines.push(
        "OCR/TEXT HINTS: visible text boxes from the same screenshot. Use these as anchors, but still return the final tight pixel box from the image."
            .to_string(),
    );
    for element in elements.iter().take(80) {
        lines.push(format!(
            "{}: \"{}\" @ {:.0}%,{:.0}% size {:.0}x{:.0}px",
            element.id,
            element.text.replace('"', "'").replace('\n', " "),
            element.center_x_pct,
            element.center_y_pct,
            element.region.width,
            element.region.height
        ));
    }
    lines.join("\n")
}

// The on-screen text elements, listed for the model with ids + center positions.
pub(crate) fn build_screen_elements_block(elements: &[OcrElement]) -> String {
    if elements.is_empty() {
        return String::new();
    }
    let mut lines = Vec::with_capacity(elements.len() + 1);
    lines.push(
        "SCREEN ELEMENTS — text currently visible on the user's screen. Each line is `id: \"text\" @ x%,y%`, where x%,y% is the element's center (x from the left edge, y from the top). You may set visualTargets.elementId to one of these ids for text elements. For icon-only controls or visual objects, use the screenshot and return a tight screenRegion instead."
            .to_string(),
    );
    for element in elements {
        lines.push(format!(
            "{}: \"{}\" @ {:.0}%,{:.0}%",
            element.id,
            element.text.replace('"', "'").replace('\n', " "),
            element.center_x_pct,
            element.center_y_pct
        ));
    }
    lines.join("\n")
}
