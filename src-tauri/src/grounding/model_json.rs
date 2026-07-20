//! Sanitize model JSON: strip a markdown code fence, then recover the first
//! balanced JSON object, so callers hand serde/the frontend a clean object even
//! when the model wraps its output in prose or trailing text.

// Strip a leading/trailing ```json ... ``` markdown fence if the model wrapped
// its JSON in one (it sometimes does despite response_format json_object). Without
// this the native parse bails and ungrounded targets leak to the frontend.
pub(crate) fn json_body(content: &str) -> &str {
    let trimmed = content.trim();
    if !trimmed.starts_with("```") {
        return trimmed;
    }
    let inner = trimmed.trim_start_matches('`');
    let inner = inner.strip_prefix("json").unwrap_or(inner);
    inner.trim_matches(|c: char| c == '`' || c.is_whitespace())
}

// Return the first balanced JSON object substring (from the first `{` to its
// matching `}`), ignoring braces inside strings. Anthropic has no json_object
// mode, so Opus/Fable can prepend prose ("Here's the guidance:\n{...}") or add trailing
// text; this recovers the object so serde parses and the frontend never receives
// non-JSON. Returns the input unchanged when no balanced object is found (callers
// still attempt to parse). Brace/quote/backslash are all ASCII, so byte scanning
// is safe on UTF-8 (multibyte continuation bytes are >= 0x80 and never collide).
pub(crate) fn extract_json_object(content: &str) -> &str {
    let bytes = content.as_bytes();
    let Some(start) = content.find('{') else {
        return content;
    };
    let mut depth: i32 = 0;
    let mut in_string = false;
    let mut escaped = false;
    let mut i = start;
    while i < bytes.len() {
        let c = bytes[i];
        if in_string {
            if escaped {
                escaped = false;
            } else if c == b'\\' {
                escaped = true;
            } else if c == b'"' {
                in_string = false;
            }
        } else {
            match c {
                b'"' => in_string = true,
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        return &content[start..=i];
                    }
                }
                _ => {}
            }
        }
        i += 1;
    }
    content
}

// Strip a code fence then extract the first balanced JSON object, so callers hand
// a clean object to serde/the frontend even when the model wraps its JSON in prose
// or trailing text. Idempotent on already-clean JSON.
pub(crate) fn clean_model_json(content: &str) -> String {
    extract_json_object(json_body(content)).to_string()
}

#[cfg(test)]
mod tests {
    use super::extract_json_object;

    #[test]
    fn strips_prose_preamble() {
        assert_eq!(
            extract_json_object("Here's the guidance:\n{\"voiceText\":\"hi\"}"),
            "{\"voiceText\":\"hi\"}"
        );
    }

    #[test]
    fn strips_trailing_text() {
        assert_eq!(extract_json_object("{\"a\":1}\nThanks!"), "{\"a\":1}");
    }

    #[test]
    fn ignores_braces_and_quotes_inside_strings() {
        let s = "{\"t\":\"a } b { c \\\" d\"}";
        assert_eq!(extract_json_object(s), s);
    }

    #[test]
    fn returns_input_when_no_object_present() {
        assert_eq!(extract_json_object("no json here"), "no json here");
    }
}
