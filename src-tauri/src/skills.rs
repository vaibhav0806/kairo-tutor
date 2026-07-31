//! Rust-side skill registry: domain-knowledge packs embedded at compile time.
//! L1 = name + description (fed to the gate for routing). L2 = body (injected into
//! the tutor turn once a slug is selected). `bundle_ids`/`title_contains` drive a
//! deterministic guardrail + the non-gate fallback. A skill NEVER holds coordinates.

use std::collections::HashSet;
use std::sync::{OnceLock, RwLock};

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
    "first-figma-motion-tutorial",
    include_str!("../skills/first-figma-motion-tutorial/SKILL.md"),
)];

/// Parsed packs, built once. Malformed packs are logged loudly and skipped — a pack that
/// silently fails to parse looks exactly like a pack that was never routed to, so the
/// `skill pack FAILED to parse` line is the first thing to grep for when a skill "doesn't
/// load".
pub(crate) fn registry() -> &'static Vec<Skill> {
    static REG: OnceLock<Vec<Skill>> = OnceLock::new();
    REG.get_or_init(|| {
        let packs: Vec<Skill> = EMBEDDED
            .iter()
            .filter_map(|(slug, raw)| match parse_skill(slug, raw) {
                Some(skill) => Some(skill),
                None => {
                    crate::klog!(
                        skills,
                        error,
                        slug = %slug,
                        raw_chars = raw.len(),
                        "skill pack FAILED to parse (missing frontmatter / description / body)"
                    );
                    None
                }
            })
            .collect();
        for skill in &packs {
            crate::klog!(
                skills,
                info,
                slug = %skill.slug,
                name = %skill.name,
                body_chars = skill.body.len(),
                body_hash = %format!("{:x}", body_hash(&skill.body)),
                bundle_ids = skill.bundle_ids.len(),
                keywords = skill.keywords.len(),
                "skill pack loaded"
            );
        }
        crate::klog!(
            skills,
            info,
            count = packs.len(),
            enabled = crate::constants::SKILLS_ENABLED,
            "skill registry ready"
        );
        packs
    })
}

// ---------------------------------------------------------------- Per-skill enable/disable
// User-disabled skill slugs (toggled off in Settings). A slug NOT here = enabled. Persisted
// one-per-line in the app config dir; loaded once at startup via load_disabled().
static DISABLED: RwLock<Option<HashSet<String>>> = RwLock::new(None);

fn disabled_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("skills_disabled"))
}

/// Load the persisted disabled set into the cache. Call once from setup.
pub(crate) fn load_disabled(app: &tauri::AppHandle) {
    let set: HashSet<String> = disabled_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|raw| {
            raw.lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect()
        })
        .unwrap_or_default();
    if let Ok(mut guard) = DISABLED.write() {
        *guard = Some(set);
    }
}

/// True unless the user disabled this skill (unknown state before load → enabled).
pub(crate) fn is_enabled(slug: &str) -> bool {
    DISABLED
        .read()
        .ok()
        .and_then(|g| g.as_ref().map(|set| !set.contains(slug)))
        .unwrap_or(true)
}

fn persist_disabled(app: &tauri::AppHandle) {
    if let (Some(path), Ok(guard)) = (disabled_path(app), DISABLED.read()) {
        if let Some(set) = guard.as_ref() {
            let _ = std::fs::write(path, set.iter().cloned().collect::<Vec<_>>().join("\n"));
        }
    }
}

#[derive(serde::Serialize)]
pub(crate) struct SkillInfo {
    pub slug: String,
    pub name: String,
    pub description: String,
    pub enabled: bool,
}

/// List every skill pack + whether it's enabled (for the Settings skills list).
#[tauri::command]
pub(crate) fn list_skills() -> Vec<SkillInfo> {
    registry()
        .iter()
        .map(|s| SkillInfo {
            slug: s.slug.clone(),
            name: s.name.clone(),
            description: s.description.clone(),
            enabled: is_enabled(&s.slug),
        })
        .collect()
}

/// Enable/disable a skill pack (persisted). A disabled pack is never listed to the gate,
/// never returned by `get()`, and never used as a fallback — so the model can't activate it.
#[tauri::command]
pub(crate) fn set_skill_enabled(app: tauri::AppHandle, slug: String, enabled: bool) {
    if let Ok(mut guard) = DISABLED.write() {
        let set = guard.get_or_insert_with(HashSet::new);
        if enabled {
            set.remove(&slug);
        } else {
            set.insert(slug.clone());
        }
    }
    persist_disabled(&app);
    crate::klog!(skills, info, slug = %slug, enabled = enabled, "skill toggled");
}

/// Cheap non-cryptographic fingerprint of a pack body. Logged at load and again at
/// injection so both lines can be eyeballed for a match — same hash = the exact text we
/// parsed is the text that went into the prompt.
pub(crate) fn body_hash(body: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    body.hash(&mut hasher);
    hasher.finish()
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
    let block = registry()
        .iter()
        .filter(|s| is_enabled(&s.slug))
        .map(|s| format!("- {}: {}", s.slug, s.description))
        .collect::<Vec<_>>()
        .join("\n");
    crate::klog!(
        skills,
        debug,
        packs = registry().len(),
        chars = block.len(),
        "L1 metadata block built for the gate"
    );
    block
}

pub(crate) fn get(slug: &str) -> Option<&'static Skill> {
    registry()
        .iter()
        .find(|s| s.slug == slug && is_enabled(&s.slug))
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
        .find(|s| is_enabled(&s.slug) && matches_app(s, active_app, bundle_id, window_title))
        .map(|s| s.slug.as_str())
}

// Known browsers: their bundle id is never the web app, so the app-identity guardrail
// can't confirm a browser-hosted pack via bundle. We treat browsers as wildcard hosts.
const BROWSER_BUNDLE_IDS: &[&str] = &[
    "com.google.chrome",
    "com.google.chrome.canary",
    "com.brave.browser",
    "com.brave.browser.beta",
    "com.apple.safari",
    "com.apple.safaritechnologypreview",
    "company.thebrowser.browser", // Arc
    "com.microsoft.edgemac",
    "org.mozilla.firefox",
    "com.vivaldi.vivaldi",
    "com.operasoftware.opera",
];

/// Is the frontmost app a web browser? Checks the bundle id, then falls back to the
/// app name (so it still works when System Events can't read the bundle).
pub(crate) fn is_browser(bundle_id: &str, active_app: &str) -> bool {
    let bundle = bundle_id.to_lowercase();
    if BROWSER_BUNDLE_IDS.iter().any(|id| *id == bundle) {
        return true;
    }
    let app = active_app.to_lowercase();
    [
        "chrome", "brave", "safari", "firefox", "edge", "arc", "vivaldi", "opera", "browser",
    ]
    .iter()
    .any(|term| app.contains(term))
}

/// Resolve the slug to inject. `incoming` = the gate's pick or the cached slug (may be
/// "" or unknown). An explicit pick is kept when it fits the app OR the app is a browser
/// (a browser can host any web app; we can't confirm via bundle, so we trust the pick).
/// With no explicit pick we fall back to a deterministic app match only — we must NOT
/// blindly fire a pack in a browser. Pure (no `SKILLS_ENABLED` gate — callers do that).
pub(crate) fn resolve_slug(
    incoming: &str,
    active_app: &str,
    bundle_id: &str,
    window_title: &str,
) -> String {
    let (resolved, reason) = if let Some(skill) = get(incoming) {
        if matches_app(skill, active_app, bundle_id, window_title) {
            (skill.slug.clone(), "pick matches app identity")
        } else if is_browser(bundle_id, active_app) {
            (
                skill.slug.clone(),
                "pick trusted (browser can host any web app)",
            )
        } else {
            // picked a pack that clearly doesn't fit a native app → drop
            (String::new(), "pick DROPPED (native app mismatch)")
        }
    } else if incoming.trim().is_empty() {
        match fallback_for_app(active_app, bundle_id, window_title) {
            Some(slug) => (slug.to_string(), "no pick; app-identity fallback matched"),
            None => (String::new(), "no pick; no app-identity match"),
        }
    } else {
        match fallback_for_app(active_app, bundle_id, window_title) {
            Some(slug) => (
                slug.to_string(),
                "unknown slug; app-identity fallback matched",
            ),
            None => (String::new(), "unknown slug; no app-identity match"),
        }
    };
    crate::klog!(
        skills,
        debug,
        incoming = %incoming,
        resolved = %resolved,
        app = %active_app,
        bundle = %bundle_id,
        title_chars = window_title.chars().count(),
        reason = reason,
        "skill slug resolved"
    );
    resolved
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
        let skill = get("first-figma-motion-tutorial").expect("figma motion pack present");
        assert!(skill.description.to_lowercase().contains("figma"));
        let body = skill.body.to_lowercase();
        // Figma Motion = the timeline/keyframe tool. All three official projects must be
        // present so the model can route between them.
        assert!(body.contains("figma motion"));
        assert!(body.contains("keyframe"));
        assert!(body.contains("timeline"));
        assert!(body.contains("bouncy square"));
        assert!(body.contains("loading spinner"));
        assert!(body.contains("chat bubble"));
        assert!(skill.bundle_ids.iter().any(|b| b == "com.figma.Desktop"));
    }

    #[test]
    fn metadata_block_lists_the_pack() {
        assert!(metadata_block().contains("first-figma-motion-tutorial:"));
    }

    #[test]
    fn body_hash_is_stable_and_distinguishes_bodies() {
        assert_eq!(body_hash("abc"), body_hash("abc"));
        assert_ne!(body_hash("abc"), body_hash("abd"));
    }

    #[test]
    fn matches_app_by_bundle_and_title() {
        let s = get("first-figma-motion-tutorial").unwrap();
        assert!(matches_app(
            s,
            "Figma",
            "com.figma.Desktop",
            "Untitled – Figma"
        ));
        // Figma in a browser: bundle is the browser, title carries "Figma".
        assert!(matches_app(
            s,
            "Google Chrome",
            "com.google.Chrome",
            "Cover – Figma"
        ));
        assert!(!matches_app(
            s,
            "Blender",
            "org.blenderfoundation.blender",
            "Blender"
        ));
    }

    #[test]
    fn resolve_slug_keeps_valid_drops_mismatch_and_falls_back() {
        // Valid gate pick on the matching app → kept.
        assert_eq!(
            resolve_slug(
                "first-figma-motion-tutorial",
                "Figma",
                "com.figma.Desktop",
                "x – Figma"
            ),
            "first-figma-motion-tutorial"
        );
        // Gate pick on a non-matching NATIVE app → dropped.
        assert_eq!(
            resolve_slug(
                "first-figma-motion-tutorial",
                "Blender",
                "org.blender",
                "Blender"
            ),
            ""
        );
        // Empty pick but app matches → fallback fills it.
        assert_eq!(
            resolve_slug("", "Figma", "com.figma.Desktop", "x – Figma"),
            "first-figma-motion-tutorial"
        );
        // Empty pick, no matching app → stays empty.
        assert_eq!(resolve_slug("", "Notes", "com.apple.Notes", "Notes"), "");
    }

    #[test]
    fn resolve_slug_trusts_gate_pick_in_a_browser() {
        // Figma in Brave: bundle can't confirm and the title lacks "figma", but the gate
        // (or cached slug) picked it → trust it. This is the browser-hosted bug fix.
        assert_eq!(
            resolve_slug(
                "first-figma-motion-tutorial",
                "Brave Browser",
                "com.brave.Browser",
                "Recents"
            ),
            "first-figma-motion-tutorial"
        );
        // No explicit pick in a browser → must NOT blindly fire without a title/URL signal.
        assert_eq!(
            resolve_slug("", "Brave Browser", "com.brave.Browser", "YouTube"),
            ""
        );
        // No explicit pick but the browser title carries "Figma" → fallback fills it.
        assert_eq!(
            resolve_slug("", "Brave Browser", "com.brave.Browser", "Untitled – Figma"),
            "first-figma-motion-tutorial"
        );
    }
}
