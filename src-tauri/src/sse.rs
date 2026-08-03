//! Server-sent-event reader for the streamed tutor turn.
//!
//! Both providers stream the same JSON answer, but announce it differently:
//!   - OpenAI Responses: `{"type":"response.output_text.delta","delta":"…"}`
//!   - Anthropic Messages: `{"type":"content_block_delta","delta":{"type":"text_delta","text":"…"}}`
//!
//! Only the text deltas matter here — reasoning events, usage totals and lifecycle events carry no
//! answer text. Anything unrecognised is skipped rather than treated as an error, so a provider
//! adding a new event type cannot break a turn.

/// Accumulates raw bytes and yields the answer-text fragments found so far.
#[derive(Default)]
pub(crate) struct SseTextReader {
    buffer: String,
}

impl SseTextReader {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Feed a chunk; returns any text deltas completed by it.
    ///
    /// A chunk can split a line anywhere, including mid-UTF-8 or mid-JSON, so only whole lines are
    /// consumed and the remainder is held for the next call.
    pub(crate) fn push(&mut self, chunk: &str) -> Vec<String> {
        self.buffer.push_str(chunk);
        let mut deltas = Vec::new();

        while let Some(newline) = self.buffer.find('\n') {
            let line: String = self.buffer.drain(..=newline).collect();
            if let Some(text) = text_delta_from_line(line.trim_end_matches(['\r', '\n'])) {
                deltas.push(text);
            }
        }

        deltas
    }
}

/// The answer text carried by one SSE line, if it carries any.
fn text_delta_from_line(line: &str) -> Option<String> {
    let payload = line.strip_prefix("data:")?.trim();
    // OpenAI closes the stream with a literal sentinel rather than JSON.
    if payload.is_empty() || payload == "[DONE]" {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(payload).ok()?;

    match value.get("type").and_then(serde_json::Value::as_str) {
        // OpenAI Responses: the delta is the string itself.
        Some("response.output_text.delta") => value
            .get("delta")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        // Anthropic Messages: the delta is an object, and only text_delta carries answer text
        // (thinking_delta and input_json_delta must not be spliced into the answer).
        Some("content_block_delta") => {
            let delta = value.get("delta")?;
            match delta.get("type").and_then(serde_json::Value::as_str) {
                Some("text_delta") => delta
                    .get("text")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string),
                _ => None,
            }
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::SseTextReader;

    #[test]
    fn reads_openai_response_deltas() {
        let mut reader = SseTextReader::new();

        let out = reader.push(
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"{\\\"steps\\\"\"}\n\
             data: {\"type\":\"response.output_text.delta\",\"delta\":\":[\"}\n",
        );

        assert_eq!(out, vec!["{\"steps\"".to_string(), ":[".to_string()]);
    }

    #[test]
    fn reads_anthropic_text_deltas_only() {
        let mut reader = SseTextReader::new();

        let out = reader.push(
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Open\"}}\n\
             data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"hmm\"}}\n",
        );

        // Thinking must never be spliced into the answer.
        assert_eq!(out, vec!["Open".to_string()]);
    }

    #[test]
    fn holds_a_line_split_across_chunks() {
        let mut reader = SseTextReader::new();

        assert!(reader
            .push("data: {\"type\":\"response.output_text.delta\",\"del")
            .is_empty());
        let out = reader.push("ta\":\"half\"}\n");

        assert_eq!(out, vec!["half".to_string()]);
    }

    #[test]
    fn ignores_lifecycle_events_and_the_done_sentinel() {
        let mut reader = SseTextReader::new();

        let out = reader.push(
            "event: response.created\n\
             data: {\"type\":\"response.created\"}\n\
             data: {\"type\":\"response.completed\"}\n\
             data: [DONE]\n\
             \n",
        );

        assert!(out.is_empty());
    }

    #[test]
    fn skips_malformed_json_without_failing_the_turn() {
        let mut reader = SseTextReader::new();

        let out = reader.push(
            "data: not json at all\n\
             data: {\"type\":\"response.output_text.delta\",\"delta\":\"still fine\"}\n",
        );

        assert_eq!(out, vec!["still fine".to_string()]);
    }

    #[test]
    fn handles_crlf_and_absent_space_after_data() {
        let mut reader = SseTextReader::new();

        let out = reader.push(
            "data:{\"type\":\"response.output_text.delta\",\"delta\":\"a\"}\r\n\
             data: {\"type\":\"response.output_text.delta\",\"delta\":\"b\"}\r\n",
        );

        assert_eq!(out, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn keeps_an_incomplete_trailing_line_for_the_next_chunk() {
        let mut reader = SseTextReader::new();

        let first = reader.push(
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"one\"}\n\
             data: {\"type\":\"response.output_te",
        );
        assert_eq!(first, vec!["one".to_string()]);

        let second = reader.push("xt.delta\",\"delta\":\"two\"}\n");
        assert_eq!(second, vec!["two".to_string()]);
    }

    #[test]
    fn preserves_text_that_looks_like_sse_framing() {
        let mut reader = SseTextReader::new();

        // A spoken line could legitimately contain "data:".
        let out = reader
            .push("data: {\"type\":\"response.output_text.delta\",\"delta\":\"send data: now\"}\n");

        assert_eq!(out, vec!["send data: now".to_string()]);
    }
}
