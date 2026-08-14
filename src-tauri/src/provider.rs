//! Model provider routing shared by the chat and subagent loops.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelProvider {
    Grok,
    OpenAi,
    Antigravity,
    OpenCode,
}

/// Dynamic OpenCode models use a private prefix so upstream ids cannot shadow
/// the native Grok/OpenAI catalogs.
pub fn provider_of_model(model: &str) -> ModelProvider {
    let model = model.trim().to_ascii_lowercase();
    if model.starts_with("antigravity::") {
        ModelProvider::Antigravity
    } else if model.starts_with("opencode::") {
        ModelProvider::OpenCode
    } else if model.starts_with("gpt-") {
        ModelProvider::OpenAi
    } else {
        ModelProvider::Grok
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_catalog_prefixes() {
        assert_eq!(provider_of_model("grok-4.5"), ModelProvider::Grok);
        assert_eq!(provider_of_model("gpt-5.6-sol"), ModelProvider::OpenAi);
        assert_eq!(
            provider_of_model("gpt-daybreak-blue-latest"),
            ModelProvider::OpenAi
        );
        assert_eq!(provider_of_model("  GPT-5.6-luna "), ModelProvider::OpenAi);
        assert_eq!(
            provider_of_model("antigravity::gemini-3.6-flash-low"),
            ModelProvider::Antigravity
        );
        assert_eq!(
            provider_of_model("opencode::anthropic/claude-sonnet-4-5"),
            ModelProvider::OpenCode
        );
        assert_eq!(provider_of_model("unknown"), ModelProvider::Grok);
    }
}
