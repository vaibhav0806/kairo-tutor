//! Rust-side skill registry: domain-knowledge packs embedded at compile time.
//! L1 = name + description (fed to the gate for routing). L2 = body (injected into
//! the tutor turn once a slug is selected). `bundle_ids`/`title_contains` drive a
//! deterministic guardrail + the non-gate fallback. A skill NEVER holds coordinates.

use std::sync::OnceLock;

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Skill {
    pub(crate) slug: String,
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) bundle_ids: Vec<String>,
    pub(crate) title_contains: Vec<String>,
    pub(crate) keywords: Vec<String>,
    pub(crate) body: String,
}

// Each embedded pack = (slug, raw SKILL.md). Add a pack: drop its folder + one line.
const EMBEDDED: &[(&str, &str)] = &[(
    "figma-first-animation",
    include_str!("../skills/figma-first-animation/SKILL.md"),
)];

/// Parsed packs, built once. Malformed packs are silently skipped.
pub(crate) fn registry() -> &'static Vec<Skill> {
    static REG: OnceLock<Vec<Skill>> = OnceLock::new();
    REG.get_or_init(|| {
        EMBEDDED
            .iter()
            .filter_map(|(slug, raw)| parse_skill(slug, raw))
            .collect()
    })
}

/// Split `---`-fenced frontmatter from the markdown body. Returns (frontmatter, body).
fn split_frontmatter(raw: &str) -> Option<(String, String)> {
    let mut lines = raw.lines();
    // First non-empty line must be the opening fence.
    let mut opened = false;
    for line in lines.by_ref() {
        if line.trim().is_empty() {
            continue;
        }
        opened = line.trim() == "---";
        break;
    }
    if !opened {
        return None;
    }
    let mut front = Vec::new();
    let mut closed = false;
    for line in lines.by_ref() {
        if line.trim() == "---" {
            closed = true;
            break;
        }
        front.push(line);
    }
    if !closed {
        return None;
    }
    let body: Vec<&str> = lines.collect();
    Some((front.join("\n"), body.join("\n").trim().to_string()))
}

/// Split a comma-separated frontmatter value into trimmed, non-empty items.
fn csv(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn parse_skill(slug: &str, raw: &str) -> Option<Skill> {
    let (front, body) = split_frontmatter(raw)?;
    let mut name = String::new();
    let mut description = String::new();
    let mut bundle_ids = Vec::new();
    let mut title_contains = Vec::new();
    let mut keywords = Vec::new();
    for line in front.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        match key.trim() {
            "name" => name = value.to_string(),
            "description" => description = value.to_string(),
            "bundleIds" => bundle_ids = csv(value),
            "titleContains" => title_contains = csv(value),
            "keywords" => keywords = csv(value),
            _ => {}
        }
    }
    if description.is_empty() || body.is_empty() {
        return None;
    }
    Some(Skill {
        slug: slug.to_string(),
        name,
        description,
        bundle_ids,
        title_contains,
        keywords,
        body,
    })
}

/// L1: the block fed to the gate so the model can choose a slug.
pub(crate) fn metadata_block() -> String {
    registry()
        .iter()
        .map(|s| format!("- {}: {}", s.slug, s.description))
        .collect::<Vec<_>>()
        .join("\n")
}

pub(crate) fn get(slug: &str) -> Option<&'static Skill> {
    registry().iter().find(|s| s.slug == slug)
}

/// Deterministic guardrail: does this pack belong to the frontmost app?
pub(crate) fn matches_app(
    skill: &Skill,
    active_app: &str,
    bundle_id: &str,
    window_title: &str,
) -> bool {
    let app = active_app.to_lowercase();
    let bundle = bundle_id.to_lowercase();
    let title = window_title.to_lowercase();
    skill.bundle_ids.iter().any(|b| b.to_lowercase() == bundle)
        || skill.title_contains.iter().any(|t| {
            let t = t.to_lowercase();
            !t.is_empty() && (title.contains(&t) || app.contains(&t))
        })
}

/// Non-gate fallback: first pack whose identity matches the frontmost app.
pub(crate) fn fallback_for_app(
    active_app: &str,
    bundle_id: &str,
    window_title: &str,
) -> Option<&'static str> {
    registry()
        .iter()
        .find(|s| matches_app(s, active_app, bundle_id, window_title))
        .map(|s| s.slug.as_str())
}

/// Resolve the slug to inject. `incoming` = the gate's pick (may be "" or unknown).
/// A gate pick is kept only if it exists AND matches the frontmost app; otherwise we
/// fall back to the app match. Pure (no `SKILLS_ENABLED` gate — callers do that).
pub(crate) fn resolve_slug(
    incoming: &str,
    active_app: &str,
    bundle_id: &str,
    window_title: &str,
) -> String {
    if let Some(skill) = get(incoming) {
        if matches_app(skill, active_app, bundle_id, window_title) {
            return skill.slug.clone();
        }
        return String::new(); // gate picked a pack that doesn't fit this app → drop
    }
    fallback_for_app(active_app, bundle_id, window_title)
        .map(str::to_string)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "---\nname: Test Pack\ndescription: Do a thing when relevant.\nbundleIds: com.acme.App, com.acme.Beta\ntitleContains: acme\nkeywords: foo, bar\n---\n# Body Heading\n\nThe real knowledge.\n";

    #[test]
    fn parse_skill_extracts_metadata_and_body() {
        let skill = parse_skill("test-pack", SAMPLE).expect("should parse");
        assert_eq!(skill.slug, "test-pack");
        assert_eq!(skill.name, "Test Pack");
        assert_eq!(skill.description, "Do a thing when relevant.");
        assert_eq!(skill.bundle_ids, vec!["com.acme.App", "com.acme.Beta"]);
        assert_eq!(skill.title_contains, vec!["acme"]);
        assert_eq!(skill.keywords, vec!["foo", "bar"]);
        // Body excludes the frontmatter fence.
        assert!(skill.body.starts_with("# Body Heading"));
        assert!(!skill.body.contains("description:"));
    }

    #[test]
    fn parse_skill_rejects_missing_frontmatter() {
        assert!(parse_skill("x", "# no frontmatter here").is_none());
    }

    #[test]
    fn embedded_figma_pack_loads() {
        let skill = get("figma-first-animation").expect("figma pack present");
        assert!(skill.description.to_lowercase().contains("figma"));
        assert!(skill.body.to_lowercase().contains("smart animate"));
        assert!(skill.bundle_ids.iter().any(|b| b == "com.figma.Desktop"));
    }

    #[test]
    fn metadata_block_lists_the_pack() {
        assert!(metadata_block().contains("figma-first-animation:"));
    }

    #[test]
    fn matches_app_by_bundle_and_title() {
        let s = get("figma-first-animation").unwrap();
        assert!(matches_app(s, "Figma", "com.figma.Desktop", "Untitled – Figma"));
        // Figma in a browser: bundle is the browser, title carries "Figma".
        assert!(matches_app(s, "Google Chrome", "com.google.Chrome", "Cover – Figma"));
        assert!(!matches_app(s, "Blender", "org.blenderfoundation.blender", "Blender"));
    }

    #[test]
    fn resolve_slug_keeps_valid_drops_mismatch_and_falls_back() {
        // Valid gate pick on the matching app → kept.
        assert_eq!(
            resolve_slug("figma-first-animation", "Figma", "com.figma.Desktop", "x – Figma"),
            "figma-first-animation"
        );
        // Gate pick on a non-matching app → dropped.
        assert_eq!(
            resolve_slug("figma-first-animation", "Blender", "org.blender", "Blender"),
            ""
        );
        // Empty pick but app matches → fallback fills it.
        assert_eq!(
            resolve_slug("", "Figma", "com.figma.Desktop", "x – Figma"),
            "figma-first-animation"
        );
        // Empty pick, no matching app → stays empty.
        assert_eq!(resolve_slug("", "Notes", "com.apple.Notes", "Notes"), "");
    }
}
