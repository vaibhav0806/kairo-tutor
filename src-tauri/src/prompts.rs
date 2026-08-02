//! All model-facing system prompts in one place. Kept short and plain-spoken while
//! preserving every load-bearing rule.

use crate::TutorTurnInput;

/// Phase-1 gate ("do I need to look at the screen?"). Text-only, no screenshot.
/// `skills_block` (may be empty) = the L1 list of available skill packs so the model
/// can also route to a `skillSlug`.
pub(crate) fn gate_system_prompt(skills_block: &str) -> String {
    let mut lines: Vec<String> = vec![
        "You are Kairo, a voice tutor that points at things on the user's screen. You have NOT seen their screen yet. Decide whether you need to look, if the user seems to be talking like they're seeing their screen and mentioning something there, then needsScreen=true.".to_string(),
        "needsScreen=false — answer directly. Use this for greetings, small talk, opinions, and general knowledge. Put the full spoken answer in voiceText.".to_string(),
        "needsScreen=true — you must look. Put a warm 6-14 word filler in voiceText that plays instantly while Kairo looks. Which filler depends on what the user is doing:".to_string(),
        "(a) ASKING about something — name it, echoing their words so they feel understood. user \"how do I add a keyframe?\" -> \"Sure, let me find the keyframe controls for you.\"; user \"where's the export button?\" -> \"On it — looking for the export option now.\"".to_string(),
        "(b) REPORTING they finished a step (\"done\", \"I've set it to 400\", \"I renamed it\", \"what's next\") — the thing they name is what they just COMPLETED, so naming it back makes you sound a turn behind. Acknowledge briefly and look FORWARD to the next step, which you have not seen yet. user \"I've dragged it to 400\" -> \"Nice — let me line up what's next.\" NOT \"let me find the current time field.\"; user \"I've grabbed the rectangle tool\" -> \"Great, checking where we go from here.\" NOT \"I'll find the rectangle tool for you.\" recentHistory shows the step they just did — use it to avoid repeating it, never to describe it back.".to_string(),
        "NEVER output a bare generic filler: \"Sure, let me find that.\", \"Let me take a look.\", \"On it, one sec.\"".to_string(),
        "Greetings and chit-chat are NEVER needsScreen=true — only look when there is something on their screen to point at, or if the user seems to be talking about something on their screen.".to_string(),
        "The app and window title are context, not a reason to look.".to_string(),
        "recentHistory (when present) is the recent back-and-forth. Use it to resolve a follow-up that refers to \"that\", \"the one you showed\", or where you left off.".to_string(),
        "IMPORTANT: when \"A guide pointer is currently on screen\" is stated, Kairo is mid-guide and pointing at something for the user to click. A short continuation like \"what next\", \"ok done\", \"now what\", \"how do I…\", or a new step question almost always needs the screen — set needsScreen=true.".to_string(),
    ];
    if !skills_block.trim().is_empty() {
        lines.push(format!(
            "Available skills (domain-knowledge packs):\n{skills_block}\nIf the user's question is about one of these skills, set skillSlug to its slug; otherwise set skillSlug to \"\". Trust what the user says they are working in. The active app may be a web browser (Chrome, Brave, Safari, Arc, Edge) hosting a web app — then judge from the window title and the user's words, not the browser's name."
        ));
    }
    lines.push("Return ONLY JSON: { \"needsScreen\": boolean, \"voiceText\": string, \"skillSlug\": string }.".to_string());
    lines.join("\n")
}

/// Text-only ack spoken immediately after a valid click, while the vision model
/// plans the next step. MUST NOT claim any on-screen result — only acknowledge
/// the action and bridge to the next step.
pub(crate) fn ack_system_prompt() -> String {
    "The user just did the action you asked for in a hands-on guide. Say ONE short, \
warm, forward-looking spoken line (about 4 to 8 words) that acknowledges they did \
it and that you're moving to the next step. You have NOT seen the result — do NOT \
claim anything is now open/done/changed. Good: \"Nice — let me line up the next \
step.\" \"Got it, one moment for what's next.\" Bad: \"Great, the editor is open now.\" \
Return ONLY the sentence, no quotes, no JSON."
        .to_string()
}

/// The tutor system prompt, as authored in `prompts/tutor-system.md`.
///
/// Baked in at compile time, so the text ships inside the binary and there is no runtime path to
/// go wrong. It lives as prose in one file rather than as Rust string literals for two reasons:
/// it can be edited by someone who does not write Rust, and there is exactly ONE place prompt
/// text can live. The second reason is not hypothetical — a `constraints` array built in the
/// frontend used to be appended here, and because it landed last it silently overrode the
/// step-count rules and capped every walkthrough to a single highlight.
const TUTOR_SYSTEM_PROMPT: &str = include_str!("../prompts/tutor-system.md");

/// The rules in one `=== NAME ===` section: `#` comments dropped, one entry per
/// blank-line-separated paragraph, in file order. A missing section logs and yields nothing.
fn prompt_section(name: &str) -> Vec<String> {
    let heading = format!("=== {name} ===");
    let Some(start) = TUTOR_SYSTEM_PROMPT.find(&heading) else {
        crate::klog!(
            skills,
            error,
            section = name,
            "prompt section missing from tutor-system.md"
        );
        return Vec::new();
    };
    let rest = &TUTOR_SYSTEM_PROMPT[start + heading.len()..];
    // A section runs until the next heading, or to the end of the file.
    let body = match rest.find("\n=== ") {
        Some(end) => &rest[..end],
        None => rest,
    };

    body.split("\n\n")
        .map(|para| {
            para.lines()
                .filter(|line| !line.trim_start().starts_with('#'))
                .collect::<Vec<_>>()
                .join("\n")
                .trim()
                .to_string()
        })
        .filter(|para| !para.is_empty())
        .collect()
}

/// System prompt for the tutor answer turn: the spoken answer + the one box to
/// point at. One vision call returns both.
pub(crate) fn build_tutor_system_prompt(input: &TutorTurnInput) -> String {
    let mut lines = prompt_section("ALWAYS");
    // Continuity: when recentContext is present, the user's question may follow on
    // from an earlier answer or a walkthrough that was interrupted mid-way.
    if input
        .recent_context
        .as_ref()
        .is_some_and(|s| !s.trim().is_empty())
    {
        lines.extend(prompt_section("WHEN_RECENT_CONTEXT"));
    }
    // Hand-off: the gate already spoke `spokenIntro` aloud THIS turn — continue from it.
    if input
        .spoken_intro
        .as_ref()
        .is_some_and(|s| !s.trim().is_empty())
    {
        lines.extend(prompt_section("WHEN_SPOKEN_INTRO"));
    }
    // L2: inject the selected pack's full body. Authoritative app knowledge for this
    // turn. Stateless calls → re-injected every turn.
    match crate::skills::get(&input.skill_slug) {
        Some(skill) => {
            for rule in prompt_section("WHEN_SKILL") {
                lines.push(
                    rule.replace("{skill_name}", &skill.name)
                        .replace("{skill_body}", &skill.body),
                );
            }
            crate::klog!(
                skills,
                info,
                slug = %skill.slug,
                name = %skill.name,
                body_chars = skill.body.len(),
                body_hash = %format!("{:x}", crate::skills::body_hash(&skill.body)),
                approx_tokens = skill.body.len() / 4,
                "L2 skill body INJECTED into the tutor system prompt"
            );
            // Full-text proof that the pack's knowledge reached the model. One dump per
            // pack per process (not per turn) so the log stays readable.
            if crate::constants::LOG_SKILL_BODY {
                log_skill_body_once(skill);
            }
        }
        None if input.skill_slug.trim().is_empty() => {
            crate::klog!(
                skills,
                debug,
                "no skill slug for this turn — tutor prompt has no L2 body"
            );
        }
        None => {
            crate::klog!(
                skills,
                warn,
                slug = %input.skill_slug,
                "skill slug is NOT in the registry — nothing injected"
            );
        }
    }
    lines.extend(prompt_section("ALWAYS_LAST"));
    lines.join("\n")
}

/// Dump a pack's full body to the log the FIRST time it is injected in this process, in
/// numbered chunks (the logger truncates nothing, but chunking keeps `tail -F` readable).
/// This is the ground-truth check that the SKILL.md text we authored is the text the model
/// receives — grep `skill body dump` and read it back.
fn log_skill_body_once(skill: &crate::skills::Skill) {
    use std::collections::HashSet;
    use std::sync::{Mutex, OnceLock};
    static DUMPED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    let dumped = DUMPED.get_or_init(|| Mutex::new(HashSet::new()));
    let Ok(mut seen) = dumped.lock() else { return };
    if !seen.insert(skill.slug.clone()) {
        return;
    }
    let chars: Vec<char> = skill.body.chars().collect();
    let chunks: Vec<String> = chars.chunks(1500).map(|c| c.iter().collect()).collect();
    let total = chunks.len();
    for (i, chunk) in chunks.into_iter().enumerate() {
        crate::klog!(
            skills,
            debug,
            slug = %skill.slug,
            part = i + 1,
            of = total,
            "skill body dump: {}",
            chunk
        );
    }
}

/// The user's-name line for the NON-CACHED (dynamic) section of the gate + tutor prompts. Empty
/// when the name is unknown / signed out. Kept out of the cached system prefix so it never busts
/// prompt caching. See spec §12.
///
/// Carries usage guidance, not just the name: with the bare fact, the gate used the name in 62%
/// of fillers and the tutor in 32% of answers, so on a turn where both fired the user heard it
/// twice in ten seconds — which reads as creepy, not warm.
pub(crate) fn user_name_line(user_name: Option<&str>) -> String {
    match user_name.map(str::trim) {
        Some(name) if !name.is_empty() => format!(
            "The user's name is {name}. Use it SPARINGLY — a greeting, a congratulation, or a \
moment that earns it. Never in routine steps, acknowledgements, or fillers. Most turns should \
not contain their name at all."
        ),
        _ => String::new(),
    }
}

/// The user's-platform line for the same NON-CACHED section. Resolved from the build target, so
/// it is right today (macOS-only shipping) and right automatically when the Windows build lands
/// — no constant to remember to flip. Per-user like the name, so it stays out of the cached
/// prefix rather than fragmenting the shared prompt cache across users.
///
/// Exists because the model told a Mac user to "press Ctrl+D" and cost them two turns: without
/// this it has to guess the platform, and skills that spell shortcuts both ways invite the wrong
/// half.
pub(crate) fn platform_line() -> String {
    let (os, modifiers) = match std::env::consts::OS {
        "macos" => ("macOS", "Command (⌘), Option (⌥), Control (⌃)"),
        "windows" => ("Windows", "Ctrl, Alt, Shift"),
        other => (other, "the platform's standard modifiers"),
    };
    format!(
        "The user is on {os}. Give {os} keyboard shortcuts only, using {modifiers} — never quote \
another platform's shortcut, and never offer both and let them pick."
    )
}

#[cfg(test)]
mod tests {
    /// The prompt file is the only copy of this text, so a typo in a section heading would
    /// silently ship a prompt with a whole block missing. Assert every section the builder asks
    /// for actually resolves, and that no rule leaks a comment or an unfilled placeholder.
    #[test]
    fn every_prompt_section_resolves() {
        for name in [
            "ALWAYS",
            "WHEN_RECENT_CONTEXT",
            "WHEN_SPOKEN_INTRO",
            "WHEN_SKILL",
            "ALWAYS_LAST",
        ] {
            let rules = super::prompt_section(name);
            assert!(!rules.is_empty(), "section {name} is missing or empty");
            for rule in &rules {
                assert!(
                    !rule.starts_with('#'),
                    "section {name} leaked a comment: {rule}"
                );
            }
        }
        assert!(super::prompt_section("NOT_A_SECTION").is_empty());
    }

    #[test]
    fn the_prompt_never_caps_the_step_count() {
        // The regression that motivated moving the prompt into one file: a stray instruction to
        // return a single step overrode every rule above it and flattened walkthroughs.
        let all = super::prompt_section("ALWAYS")
            .into_iter()
            .chain(super::prompt_section("ALWAYS_LAST"))
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase();
        assert!(!all.contains("return one short tutor step"));
        assert!(!all.contains("return one step"));
    }

    #[test]
    fn the_skill_block_keeps_both_placeholders() {
        let block = super::prompt_section("WHEN_SKILL").join("\n");
        assert!(block.contains("{skill_name}"));
        assert!(block.contains("{skill_body}"));
    }

    use super::user_name_line;

    /// The end-to-end contract of the skill system: a resolved slug puts the pack's
    /// FULL body into the tutor system prompt. If this breaks, the model is flying blind
    /// no matter how good SKILL.md is.
    #[test]
    fn resolved_slug_injects_the_full_pack_body() {
        let mut input = crate::tests::sample_tutor_turn_input();
        input.skill_slug = "first-figma-motion-tutorial".to_string();
        let prompt = super::build_tutor_system_prompt(&input);
        let skill = crate::skills::get("first-figma-motion-tutorial").unwrap();
        assert!(prompt.contains("ACTIVE SKILL"));
        assert!(prompt.contains(skill.body.as_str()));
        assert!(prompt.contains("Figma Motion"));
    }

    #[test]
    fn empty_slug_injects_nothing() {
        let mut input = crate::tests::sample_tutor_turn_input();
        input.skill_slug = String::new();
        assert!(!super::build_tutor_system_prompt(&input).contains("ACTIVE SKILL"));
    }

    #[test]
    fn appends_for_a_name() {
        // The line now carries usage guidance after the fact, so assert the prefix rather
        // than the whole string (the guidance itself is covered below).
        assert!(user_name_line(Some("Prasad")).starts_with("The user's name is Prasad."));
    }

    #[test]
    fn name_line_carries_sparing_use_guidance() {
        // The bare fact drove the name into 62% of fillers; the guidance is the fix, so it
        // must ship with the name rather than living in a prompt line that can drift away.
        let line = user_name_line(Some("Prasad"));
        assert!(line.contains("Prasad"));
        assert!(line.to_uppercase().contains("SPARINGLY"));
    }

    #[test]
    fn platform_line_names_this_build_target_and_its_modifiers() {
        let line = super::platform_line();
        #[cfg(target_os = "macos")]
        {
            assert!(line.contains("macOS"));
            assert!(line.contains('⌘'));
            assert!(!line.contains("Ctrl"));
        }
        #[cfg(target_os = "windows")]
        {
            assert!(line.contains("Windows"));
            assert!(line.contains("Ctrl"));
        }
    }

    #[test]
    fn empty_when_absent_or_blank() {
        assert_eq!(user_name_line(None), "");
        assert_eq!(user_name_line(Some("  ")), "");
    }
}
