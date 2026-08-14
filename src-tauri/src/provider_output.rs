pub(crate) const MAX_PROVIDER_EVENT_BYTES: usize = 512 * 1024;
// This byte budget also bounds line count because every completed line consumes
// at least its delimiter; a separate line cap rejects valid token-dense SSE.
pub(crate) const MAX_PROVIDER_STREAM_BYTES: usize = 2 * 1024 * 1024;
pub(crate) const MAX_PROVIDER_OUTPUT_BYTES: usize = 120_000;

const OUTPUT_TRUNCATION_MARKER: &str = "... (earlier output trimmed)\n";

#[derive(Default)]
pub(crate) struct ProviderLineBuffer {
    pending: Vec<u8>,
    total_bytes: usize,
}

impl ProviderLineBuffer {
    pub(crate) fn push(&mut self, chunk: &[u8]) -> Result<Vec<String>, String> {
        let mut lines = Vec::new();
        let mut offset = 0;
        while offset < chunk.len() {
            let remaining = &chunk[offset..];
            let piece_len = remaining
                .iter()
                .position(|byte| *byte == b'\n')
                .map(|index| index + 1)
                .unwrap_or(remaining.len());
            if self.pending.len().saturating_add(piece_len) > MAX_PROVIDER_EVENT_BYTES {
                return Err(format!(
                    "Provider event exceeded the {MAX_PROVIDER_EVENT_BYTES}-byte limit."
                ));
            }
            self.pending.extend_from_slice(&remaining[..piece_len]);
            offset += piece_len;
            if self.pending.last() == Some(&b'\n') {
                self.finish_line(&mut lines)?;
            }
        }
        Ok(lines)
    }

    pub(crate) fn finish(&mut self) -> Result<Vec<String>, String> {
        let mut lines = Vec::new();
        if !self.pending.is_empty() {
            self.finish_line(&mut lines)?;
        }
        Ok(lines)
    }

    fn finish_line(&mut self, lines: &mut Vec<String>) -> Result<(), String> {
        if self.total_bytes.saturating_add(self.pending.len()) > MAX_PROVIDER_STREAM_BYTES {
            return Err(format!(
                "Provider stream exceeded the {MAX_PROVIDER_STREAM_BYTES}-byte limit."
            ));
        }
        self.total_bytes += self.pending.len();

        let mut end = self.pending.len();
        if end > 0 && self.pending[end - 1] == b'\n' {
            end -= 1;
        }
        if end > 0 && self.pending[end - 1] == b'\r' {
            end -= 1;
        }
        lines.push(String::from_utf8_lossy(&self.pending[..end]).into_owned());
        self.pending.clear();
        Ok(())
    }
}

pub(crate) fn truncate_provider_output(text: &str) -> String {
    if text.len() <= MAX_PROVIDER_OUTPUT_BYTES {
        return text.to_string();
    }
    let tail_bytes = MAX_PROVIDER_OUTPUT_BYTES.saturating_sub(OUTPUT_TRUNCATION_MARKER.len());
    let tail = utf8_tail(text, tail_bytes);
    format!("{OUTPUT_TRUNCATION_MARKER}{tail}")
}

pub(crate) fn append_provider_response_prefix(buffer: &mut String, text: &str) -> bool {
    let remaining = MAX_PROVIDER_OUTPUT_BYTES.saturating_sub(buffer.len());
    if remaining == 0 {
        return !text.is_empty();
    }
    let mut end = text.len().min(remaining);
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    buffer.push_str(&text[..end]);
    end < text.len()
}

#[derive(Default)]
pub(crate) struct ProviderOutputTail {
    bytes: Vec<u8>,
    truncated: bool,
}

impl ProviderOutputTail {
    pub(crate) fn push(&mut self, chunk: &[u8]) {
        if chunk.len() >= MAX_PROVIDER_OUTPUT_BYTES {
            self.bytes.clear();
            self.bytes
                .extend_from_slice(&chunk[chunk.len() - MAX_PROVIDER_OUTPUT_BYTES..]);
            self.truncated = true;
            return;
        }
        let overflow = self
            .bytes
            .len()
            .saturating_add(chunk.len())
            .saturating_sub(MAX_PROVIDER_OUTPUT_BYTES);
        if overflow > 0 {
            self.bytes.drain(..overflow);
            self.truncated = true;
        }
        self.bytes.extend_from_slice(chunk);
    }

    pub(crate) fn into_string(self) -> String {
        let text = String::from_utf8_lossy(&self.bytes);
        if self.truncated {
            let tail_bytes =
                MAX_PROVIDER_OUTPUT_BYTES.saturating_sub(OUTPUT_TRUNCATION_MARKER.len());
            format!("{OUTPUT_TRUNCATION_MARKER}{}", utf8_tail(&text, tail_bytes))
        } else {
            truncate_provider_output(&text)
        }
    }
}

fn utf8_tail(text: &str, max_bytes: usize) -> &str {
    if text.len() <= max_bytes {
        return text;
    }
    let mut start = text.len() - max_bytes;
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    &text[start..]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_lines_preserve_normal_provider_streaming() {
        let mut buffer = ProviderLineBuffer::default();
        assert!(buffer.push(b"{\"event\":\"in").unwrap().is_empty());
        assert_eq!(
            buffer.push(b"it\"}\r\nsecond\n").unwrap(),
            vec!["{\"event\":\"init\"}", "second"]
        );
    }

    #[test]
    fn provider_events_and_streams_fail_closed_at_byte_bounds() {
        let mut line = ProviderLineBuffer::default();
        assert!(line
            .push(&vec![b'x'; MAX_PROVIDER_EVENT_BYTES + 1])
            .unwrap_err()
            .contains("event exceeded"));

        let mut stream = ProviderLineBuffer::default();
        let chunk = vec![b'x'; MAX_PROVIDER_EVENT_BYTES - 1];
        for _ in 0..4 {
            let mut event = chunk.clone();
            event.push(b'\n');
            assert_eq!(stream.push(&event).unwrap().len(), 1);
        }
        assert!(stream.push(b"x\n").unwrap_err().contains("stream exceeded"));
    }

    #[test]
    fn provider_output_tail_keeps_only_the_bounded_utf8_tail() {
        let mut tail = ProviderOutputTail::default();
        tail.push("HEAD".as_bytes());
        tail.push("x".repeat(MAX_PROVIDER_OUTPUT_BYTES).as_bytes());
        tail.push(b"TAIL");
        let output = tail.into_string();
        assert!(output.len() <= MAX_PROVIDER_OUTPUT_BYTES);
        assert!(output.contains("output trimmed"));
        assert!(output.ends_with("TAIL"));
    }
}
