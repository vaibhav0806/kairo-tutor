# Rust Skill Packs (Figma first-animation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Kairo dynamically-selected, domain-knowledge "skill packs" (starting with one Figma "create your first animation" pack) that the model routes to and that get injected into the tutor turn, so Fable makes fewer errors.

**Architecture:** Skills are Anthropic-style folders (`SKILL.md` = flat frontmatter + body), embedded in the Rust binary at compile time. **L1** metadata (name + description) is injected into the gate prompt so the model picks a `skillSlug`; a deterministic app guardrail repairs bad picks. The chosen slug is cached on the frontend and passed into every `run_tutor_turn` (which follow-along reuses); **L2** = Rust resolves the slug to its body and injects it into the tutor system prompt each turn. Selection lives entirely in Rust (single source of truth); the frontend only carries a slug string. No coordinates ever live in a skill.

**Tech Stack:** Rust (Tauri, serde_json), React 19 + TS (vitest), OpenRouter chat completions.

---

## Background: current wiring (verified)

- `run_gate_turn` (`src-tauri/src/tutor.rs:539`) is text-only, sees `active_app`/`window_title`/`history`, returns `{ needsScreen, voiceText }`. Runs **only** for voice with no annotations (`NotchApp.tsx:1298`).
- `run_tutor_turn` (`src-tauri/src/tutor.rs:279`) is the single vision turn. Follow-along reuses it (no separate Rust follow command; `NotchApp.tsx` has two `askTutorFromNotch` call sites — `:1362` initial, `:1470` follow-continuation).
- Skill is currently **selected on the frontend** (`src/core/orchestrator.ts:43-47`, string matching) and the fat `SkillPack` (slug + displayName + appIdentifiers + landmarks) is shipped into Rust as `TutorTurnInput.skill` (`src-tauri/src/types.rs:194`). Rust injects only a one-liner (`prompts.rs:86`) plus a `skillLandmarks` JSON blob (`tutor.rs:44`). Effectively inert.
- Each model call is **stateless**: a fresh 2-message array (system + user) is built every turn; "history" is a preformatted ~6-triple text blob. Nothing persists server-side → the skill body must ride along every tutor turn.

## File Structure

**Rust (create):**
- `src-tauri/skills/figma-first-animation/SKILL.md` — the pack content.
- `src-tauri/src/skills.rs` — registry: parse embedded packs, L1 metadata block, body lookup, app-match guardrail + fallback, slug resolution.

**Rust (modify):**
- `src-tauri/src/types.rs` — `TutorTurnInput.skill: TutorSkillPack` → `skill_slug: String`; delete `TutorSkillPack`; add `bundle_id` to `GateInput`.
- `src-tauri/src/prompts.rs` — `skill_is_active(&str)`; inject L2 body in `build_tutor_system_prompt`; `gate_system_prompt(skills_block)` with new JSON schema.
- `src-tauri/src/tutor.rs` — drop `skillLandmarks`; resolve+validate slug in `run_tutor_turn`; inject L1 + repair slug in `run_gate_turn`.
- `src-tauri/src/lib.rs` — `mod skills;`; fix test fixture + imports.
- `src-tauri/src/constants.rs` — `SKILLS_ENABLED` A/B flag.

**Frontend (modify):**
- `src/core/orchestrator.ts`, `src/core/runtimePlanner.ts`, `src/core/mockTutor.ts`, `src/core/types.ts`, `src/server/providers/tutorPlanner.ts` — replace `skill: SkillPack` with `skillSlug: string`.
- `src/notch/notchTutor.ts` — pass the cached slug through.
- `src/notch/NotchApp.tsx` — parse `skillSlug` from the gate, cache it, feed both ask sites.

**Frontend (delete):**
- `src/core/skills.ts` — registry retired (Rust owns it now).

**Frontmatter schema (flat, comma-separated lists — no nested YAML, dependency-free to parse):**
```
name: <slug-ish name>
description: <one line: what + when, for the gate>
bundleIds: <comma list of exact bundle ids>        # desktop-app identity
titleContains: <comma list of window-title substrings>  # browser / title identity
keywords: <comma list>                              # gate routing hint only
```
`bundleIds` + `titleContains` = the app guardrail. `keywords` help the model route.

---

## Task 1: Author the Figma skill pack

**Files:**
- Create: `src-tauri/skills/figma-first-animation/SKILL.md`

- [ ] **Step 1: Write the pack** (body ≤ ~450 words; no coordinates)

Create `src-tauri/skills/figma-first-animation/SKILL.md`:

```markdown
---
name: Figma — create your first animation
description: Create a first animation in Figma using Smart Animate between two frames. Use when the user is in Figma and asks to animate, add motion, make something move, or make their first animation.
bundleIds: com.figma.Desktop, com.figma.Agent
titleContains: figma
keywords: figma, animate, animation, smart animate, prototype, motion, transition, easing, move
---

# Create your first animation in Figma (Smart Animate)

Core idea: Figma animates by tweening between two frames that share layers with the
SAME NAME. Make a "before" frame and an "after" frame, connect them in the Prototype
tab, choose Smart Animate, and Figma morphs the matching layers. This is the standard
beginner path — teach exactly this unless the user asks for something else.

## Vocabulary
- Frame: a screen/artboard. Animation goes from one frame to another.
- Smart Animate: the animation type that tweens matching layers between two frames.
- Prototype tab: the right-panel tab where frame-to-frame interactions are wired.
- Connection ("noodle"): the wire dragged from one frame to the next.
- Trigger: what starts it — On Click, or After Delay for auto-play.
- Present mode: the play control that previews the prototype.

## Recipe (guide ONE step at a time; never dump the whole list)
1. Make a frame with one simple shape inside it.
2. Duplicate that frame so there are two (Frame 1 and Frame 2).
3. In Frame 2, change the shape — move it, resize it, or recolor it. Keep its layer
   name identical to Frame 1 (Smart Animate matches layers by name).
4. Open the Prototype tab in the right panel.
5. Select Frame 1, then drag the connection from its edge onto Frame 2.
6. In the interaction: Trigger = On Click (or After Delay to auto-play),
   Action = Navigate to, Animation = Smart Animate. Set a duration and easing.
7. Use Present to preview the animation.

## Gotchas
- No tween if the layer names differ between frames — Smart Animate matches by name.
- The element must exist in BOTH frames; if it's only in one it fades, not moves.
- After Delay auto-plays; On Click needs a click in Present mode.
- Easing + duration set the whole feel; the defaults are fine for a first try.

## Orientation (soft hints — NEVER coordinates)
- Prototype controls live in the right panel, alongside Design.
- The Present / play control is usually a triangle icon near the top-right.
```

- [ ] **Step 2: Commit**

```bash
git add src-tauri/skills/figma-first-animation/SKILL.md
git commit -m "feat(skills): add Figma first-animation skill pack"
```

---

## Task 2: Rust skill registry + frontmatter parser (TDD)

**Files:**
- Create: `src-tauri/src/skills.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod skills;`)
- Modify: `src-tauri/src/constants.rs` (add `SKILLS_ENABLED`)

- [ ] **Step 1: Add the module + toggle**

In `src-tauri/src/constants.rs`, add near the other toggles:

```rust
/// Master switch for skill packs (L1 routing + L2 body injection). Flip to `false`
/// to run the A/B baseline (identical flow, no skill knowledge injected).
pub const SKILLS_ENABLED: bool = true;
```

In `src-tauri/src/lib.rs`, add to the module list near the other `mod` lines (e.g. beside `mod prompts;`):

```rust
mod skills;
```

- [ ] **Step 2: Write `skills.rs` with the failing tests**

Create `src-tauri/src/skills.rs`:

```rust
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

/// Parsed packs, built once. Malformed packs are skipped (logged by the caller path).
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
}
```

- [ ] **Step 3: Run the tests — expect FAIL (`get` not defined yet)**

Run: `cargo test --manifest-path src-tauri/Cargo.toml skills:: 2>&1 | tail -20`
Expected: FAIL — `cannot find function 'get' in this scope`.

- [ ] **Step 4: Add the lookup / metadata / matching functions**

Append to `src-tauri/src/skills.rs` (above the `#[cfg(test)]` block):

```rust
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
```

Add these tests inside the `tests` module:

```rust
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
```

- [ ] **Step 5: Run the tests — expect PASS**

Run: `cargo test --manifest-path src-tauri/Cargo.toml skills:: 2>&1 | tail -20`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/skills.rs src-tauri/src/lib.rs src-tauri/src/constants.rs
git commit -m "feat(skills): rust registry, frontmatter parse, app guardrail + fallback"
```

---

## Task 3: Slim the types (skill_slug) + inject L2 body in the tutor prompt

**Files:**
- Modify: `src-tauri/src/types.rs:194-218` (drop `TutorSkillPack`, add `skill_slug`; add `bundle_id` to `GateInput`)
- Modify: `src-tauri/src/prompts.rs:10-12,44-48,86-97`
- Modify: `src-tauri/src/tutor.rs:42-48` (drop `skillLandmarks`)
- Modify: `src-tauri/src/lib.rs` (fixture + imports)

- [ ] **Step 1: Update the types**

In `src-tauri/src/types.rs`, delete the `TutorSkillPack` struct (lines ~192-199) and change `TutorTurnInput`:

```rust
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TutorTurnInput {
    pub(crate) user_query: String,
    pub(crate) active_app: TutorActiveAppContext,
    pub(crate) annotations: Vec<TutorAnnotation>,
    pub(crate) screen: TutorScreenInput,
    /// Slug of the selected skill pack ("" = none). Resolved/validated in
    /// `run_tutor_turn` against the frontmost app before injection.
    #[serde(default)]
    pub(crate) skill_slug: String,
    pub(crate) constraints: Vec<String>,
    #[serde(default)]
    pub(crate) recent_context: Option<String>,
    #[serde(default)]
    pub(crate) spoken_intro: Option<String>,
}
```

In the same file, add `bundle_id` to `GateInput` (so the gate guardrail can use it):

```rust
pub(crate) struct GateInput {
    pub(crate) user_query: String,
    #[serde(default)]
    pub(crate) active_app: Option<String>,
    #[serde(default)]
    pub(crate) bundle_id: Option<String>,
    #[serde(default)]
    pub(crate) window_title: Option<String>,
    #[serde(default)]
    pub(crate) history: Option<String>,
    #[serde(default)]
    pub(crate) pointer_pending: bool,
}
```

- [ ] **Step 2: Update `prompts.rs` — active check + L2 body injection**

Replace `skill_is_active` (prompts.rs:10-12) and the skill line in `build_tutor_system_prompt` (prompts.rs:86-91):

```rust
/// A skill is "active" when the slug names a real, loaded pack.
pub(crate) fn skill_is_active(skill_slug: &str) -> bool {
    !skill_slug.trim().is_empty() && crate::skills::get(skill_slug).is_some()
}
```

In `build_tutor_system_prompt`, replace the old `if skill_is_active(&input.skill) { ... "Selected skill..." }` block with the L2 body inject:

```rust
    // L2: inject the selected pack's full body. Authoritative app knowledge for this
    // turn. Stateless calls → re-injected every turn (cheap; ~400-700 tokens).
    if let Some(skill) = crate::skills::get(&input.skill_slug) {
        lines.push(format!(
            "ACTIVE SKILL — {}. This is authoritative domain knowledge for the app on \
screen; follow it when relevant. It contains NO screen coordinates — always find the \
actual control in the screenshot.\n{}",
            skill.name, skill.body
        ));
    }
```

- [ ] **Step 3: Drop the landmarks blob in `tutor.rs`**

In `src-tauri/src/tutor.rs`, delete the `skillLandmarks` block (lines 42-48) inside `build_tutor_user_prompt`, and remove `skill_is_active` from the `use crate::prompts::{...}` import if it is now unused there (it is — the user prompt no longer references skills). Keep `build_tutor_system_prompt` and `gate_system_prompt` in the import.

- [ ] **Step 4: Fix the Rust test fixture + imports in `lib.rs`**

In `src-tauri/src/lib.rs`, `sample_tutor_turn_input` (lines ~1041-1046): replace the `skill: TutorSkillPack { ... }` block with:

```rust
            skill_slug: "figma-first-animation".to_string(),
```

Remove `TutorSkillPack` from the `use ... types::{...}` import at `lib.rs:693`.

- [ ] **Step 5: Add a prompt-injection test**

In `src-tauri/src/prompts.rs`, add a test module (or extend an existing one):

```rust
#[cfg(test)]
mod skill_injection_tests {
    use super::*;
    use crate::lib_test_support::sample_input; // if unavailable, build a minimal TutorTurnInput inline

    #[test]
    fn active_pack_injects_body_inactive_does_not() {
        assert!(skill_is_active("figma-first-animation"));
        assert!(!skill_is_active(""));
        assert!(!skill_is_active("nope-not-a-pack"));
    }
}
```

If `sample_input` support does not exist, drop the import line and keep only the `skill_is_active` assertions (they need no `TutorTurnInput`).

- [ ] **Step 6: Compile + run**

Run: `cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | tail -25`
Expected: PASS. If `build_tutor_system_prompt` still references `input.skill`, fix to `input.skill_slug`.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/types.rs src-tauri/src/prompts.rs src-tauri/src/tutor.rs src-tauri/src/lib.rs
git commit -m "feat(skills): carry skill_slug, inject L2 body into tutor prompt, drop landmarks"
```

---

## Task 4: Gate emits + validates skillSlug (L1 routing)

**Files:**
- Modify: `src-tauri/src/prompts.rs` (`gate_system_prompt` signature + JSON schema)
- Modify: `src-tauri/src/tutor.rs:539-600` (`run_gate_turn`)

- [ ] **Step 1: Extend the gate system prompt**

In `src-tauri/src/prompts.rs`, change `gate_system_prompt()` to take the skills block and add routing lines + the new JSON shape:

```rust
pub(crate) fn gate_system_prompt(skills_block: &str) -> String {
    let mut lines: Vec<String> = vec![
        "You are Kairo, a voice tutor that points at things on the user's screen. You have NOT seen their screen yet. Decide whether you need to look; if the user talks as if seeing their screen and mentions something there, needsScreen=true.".to_string(),
        "needsScreen=false — answer directly (greetings, small talk, opinions, general knowledge). Put the full spoken answer in voiceText.".to_string(),
        "needsScreen=true — you must look. Put a SHORT spoken filler (3-6 words) in voiceText that references what they asked, e.g. \"Sure, let me find that.\"".to_string(),
        "Greetings and chit-chat are NEVER needsScreen=true.".to_string(),
        "The app and window title are context, not a reason to look.".to_string(),
        "recentHistory (when present) is the recent back-and-forth; use it to resolve follow-ups.".to_string(),
        "IMPORTANT: when \"A guide pointer is currently on screen\" is stated, Kairo is mid-guide; a short continuation almost always needs the screen — needsScreen=true.".to_string(),
    ];
    if !skills_block.trim().is_empty() {
        lines.push(format!(
            "Available skills (domain-knowledge packs):\n{skills_block}\nIf the user's question is about one of these AND the active app/window matches that skill, set skillSlug to its slug. Otherwise set skillSlug to \"\". Never guess a skill that does not fit the active app."
        ));
    }
    lines.push("Return ONLY JSON: { \"needsScreen\": boolean, \"voiceText\": string, \"skillSlug\": string }.".to_string());
    lines.join("\n")
}
```

- [ ] **Step 2: Wire + repair in `run_gate_turn`**

In `src-tauri/src/tutor.rs`:

- Update `look()` to include the field: `json!({ "needsScreen": true, "voiceText": "", "skillSlug": "" })`.
- Read the bundle id: after `let title = input.window_title.unwrap_or_default();` add
  `let bundle = input.bundle_id.unwrap_or_default();`.
- Build the system prompt with the skills block (gated by the toggle):

```rust
    let skills_block = if constants::SKILLS_ENABLED {
        crate::skills::metadata_block()
    } else {
        String::new()
    };
    let system = gate_system_prompt(&skills_block);
```

- Change the model call to use `&system` instead of `&gate_system_prompt()`.
- On success, validate/repair the slug before returning:

```rust
        Ok(content) => {
            let repaired = repair_gate_skill(&content, &app, &bundle, &title);
            crate::klog!(gate, debug, "gate result: {}", repaired.chars().take(200).collect::<String>());
            Ok(repaired)
        }
```

Add this helper near `run_gate_turn`:

```rust
/// Keep the gate's JSON but force `skillSlug` through the registry guardrail: an
/// unknown slug or one that doesn't match the frontmost app becomes "".
fn repair_gate_skill(content: &str, app: &str, bundle: &str, title: &str) -> String {
    let Ok(mut parsed) = serde_json::from_str::<Value>(content) else {
        return content.to_string();
    };
    if !constants::SKILLS_ENABLED {
        parsed["skillSlug"] = json!("");
        return parsed.to_string();
    }
    let picked = parsed.get("skillSlug").and_then(Value::as_str).unwrap_or("");
    let clean = crate::skills::resolve_slug(picked, app, bundle, title);
    parsed["skillSlug"] = json!(clean);
    parsed.to_string()
}
```

Note: `resolve_slug` here also fills the slug via app-match when the model returned "" but the app clearly matches — good (voice-path gets fallback too).

- [ ] **Step 3: Test the repair helper**

Add to the `tests` module in `tutor.rs`:

```rust
    #[test]
    fn repair_gate_skill_drops_wrong_app_and_fills_match() {
        // Model picked Figma pack but frontmost app is Blender → dropped.
        let out = super::repair_gate_skill(
            "{\"needsScreen\":true,\"voiceText\":\"\",\"skillSlug\":\"figma-first-animation\"}",
            "Blender", "org.blender", "Blender",
        );
        assert!(out.contains("\"skillSlug\":\"\""));
        // Model returned no slug but app is Figma → fallback fills it.
        let out2 = super::repair_gate_skill(
            "{\"needsScreen\":true,\"voiceText\":\"\",\"skillSlug\":\"\"}",
            "Figma", "com.figma.Desktop", "Untitled – Figma",
        );
        assert!(out2.contains("figma-first-animation"));
    }
```

- [ ] **Step 4: Run**

Run: `cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | tail -25`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/prompts.rs src-tauri/src/tutor.rs
git commit -m "feat(skills): gate emits skillSlug (L1) with app guardrail repair"
```

---

## Task 5: Resolve the slug inside `run_tutor_turn`

**Files:**
- Modify: `src-tauri/src/tutor.rs:279` (`run_tutor_turn`)

- [ ] **Step 1: Resolve + validate before building the prompt**

In `run_tutor_turn`, change the signature to `mut input: TutorTurnInput` and, at the top of the body (after the timer), add:

```rust
    // Resolve/validate the incoming slug against the LIVE frontmost app (it may have
    // changed since the gate ran; non-gate paths send ""). Keeps skill logic in Rust.
    input.skill_slug = if constants::SKILLS_ENABLED {
        crate::skills::resolve_slug(
            &input.skill_slug,
            &input.active_app.active_app,
            input.active_app.bundle_id.as_deref().unwrap_or(""),
            input.active_app.window_title.as_deref().unwrap_or(""),
        )
    } else {
        String::new()
    };
    crate::klog!(
        tutor,
        info,
        skill = %input.skill_slug,
        app = %input.active_app.active_app,
        "tutor turn skill resolved"
    );
```

- [ ] **Step 2: Verify existing tutor tests still pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | tail -25`
Expected: PASS. (`sample_tutor_turn_input` now sets `skill_slug`; the fixture's Blender app won't match Figma, so `resolve_slug` yields "" — fine for the model-selection tests, which don't assert on skill.)

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/tutor.rs
git commit -m "feat(skills): resolve + guardrail skill_slug in run_tutor_turn"
```

---

## Task 6: Frontend — replace `skill: SkillPack` with `skillSlug: string`

**Files:**
- Modify: `src/core/orchestrator.ts:15-79`
- Modify: `src/core/runtimePlanner.ts:65`
- Modify: `src/server/providers/tutorPlanner.ts:145,218`
- Modify: `src/core/mockTutor.ts`
- Modify: `src/core/types.ts:91-102`
- Delete: `src/core/skills.ts`

- [ ] **Step 1: `orchestrator.ts` — carry a slug, stop selecting**

Change `TutorTurnInput` and `buildTutorTurnInput`:

```ts
export type TutorTurnInput = {
  userQuery: string;
  activeApp: ActiveAppContext;
  annotations: UserAnnotation[];
  screen: TutorScreenInput;
  skillSlug: string;
  constraints: string[];
  recentContext?: string;
  spokenIntro?: string;
};
```

In `buildTutorTurnInput`, remove the `createSkillPackRegistry` import + the `registry.match...` block and set the slug directly:

```ts
export function buildTutorTurnInput({
  request,
  screenCapture,
  skillSlug,
  recentContext,
  spokenIntro
}: {
  request: TutorRequest;
  screenCapture: NativeScreenCapture | null;
  skillSlug: string;
  recentContext?: string;
  spokenIntro?: string;
}): TutorTurnInput {
  return {
    userQuery: request.userQuery,
    activeApp: {
      activeApp: request.activeApp,
      bundleId: request.bundleId,
      windowTitle: request.windowTitle
    },
    annotations: request.annotations,
    screen: screenCapture
      ? { /* unchanged screen mapping */ }
      : { captured: false, reason: 'No screen capture is available for this turn.' },
    skillSlug: skillSlug ?? '',
    constraints: [
      'Return one short tutor step.',
      'Do not invent app state that is not visible in the provided context.'
    ],
    ...(recentContext && recentContext.trim() ? { recentContext } : {}),
    ...(spokenIntro && spokenIntro.trim() ? { spokenIntro } : {})
  };
}
```

(Keep the existing `screen` mapping object verbatim; only the skill line and the registry import change. Remove `SkillPack` from the type imports.)

- [ ] **Step 2: `runtimePlanner.ts` — error fallback slug**

Line 65: `skillSlug: input.skill.slug` → `skillSlug: input.skillSlug`.

- [ ] **Step 3: `tutorPlanner.ts` — response parse**

Lines 145 and 218: `input.skill.slug` → `input.skillSlug`.

- [ ] **Step 4: `mockTutor.ts` — drop the registry**

Remove `createSkillPackRegistry` usage. Where it read `skill.slug`, read the request/echo a constant. Minimal change: replace the registry lookup with `const skillSlug = 'general';` (mock output is not skill-aware) and update the `skillSlug: skill.slug` fields to `skillSlug`.

- [ ] **Step 5: `types.ts` — remove `SkillPack`/`UiLandmark`**

Delete the `UiLandmark` and `SkillPack` type exports (lines 91-102). Grep confirms no remaining importers after Steps 1-4.

- [ ] **Step 6: Delete the registry**

```bash
git rm src/core/skills.ts
```

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: PASS. Fix any lingering `skill`/`SkillPack` references it flags (search: `grep -rn "\.skill\b\|SkillPack\|UiLandmark\|createSkillPackRegistry" src`).

- [ ] **Step 8: Unit tests**

Run: `npm run test`
Expected: PASS. Update any test that constructed `skill: {...}` to `skillSlug: '...'`.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor(skills): frontend carries skillSlug string; retire TS skill registry"
```

---

## Task 7: NotchApp — parse gate skillSlug, cache it, feed both ask sites

**Files:**
- Modify: `src/notch/notchTutor.ts:21,62,100,166` (param name)
- Modify: `src/notch/NotchApp.tsx` (gate parse ~1295-1360, ask sites :1362 + :1470, gate input builder)
- Modify: `src/native/nativeBridge.ts` (gate call passes bundleId; gate result type)

- [ ] **Step 1: Rename the ask param for clarity**

In `src/notch/notchTutor.ts`, rename `defaultSkill` → `skillSlug` in `AskTutorFromNotchOptions` (line 21), the destructure (line 62), and the two `skillSlug: defaultSkill` usages (lines 100, 166) → `skillSlug`. Also update `createTutorRuntimeErrorResponse({ skillSlug: defaultSkill ...})` at line 166 → `skillSlug`.

- [ ] **Step 2: Gate result carries skillSlug**

The gate returns a raw JSON string parsed in `NotchApp.tsx` (`runGate`). Extend the parse to read `skillSlug`. Find the `runGate` helper (~`NotchApp.tsx:1149`) and where it returns `{ needsScreen, voiceText }`; add `skillSlug: typeof parsed.skillSlug === 'string' ? parsed.skillSlug : ''` to the returned object, and add `skillSlug: string` to its return type.

Ensure the gate **input** includes `bundleId`. In `nativeBridge.ts` `runGateTurn` the caller builds `input`; confirm the NotchApp gate call passes `bundleId` alongside `activeApp`/`windowTitle`. If not, add it (the active app is already fetched for the turn).

- [ ] **Step 3: Cache the slug + feed both ask sites**

In `NotchApp.tsx`, add a ref near the other session refs:

```ts
// The skill pack chosen for the current task. Set by the gate (voice path); reused
// across follow-along turns; "" lets Rust resolve via the app-match fallback.
const activeSkillRef = useRef<string>('');
```

Where the gate decision is consumed (after `const gate = gateRan ? await runGate(...) : {...}`), set the cache when the gate ran:

```ts
if (gateRan) {
  activeSkillRef.current = gate.skillSlug ?? '';
}
```

For the non-gate branch (`{ needsScreen: true, voiceText: '' }`), leave the ref as-is (reuse the task's cached slug; if none, it stays "" → Rust app-fallback).

Change **both** `askTutorFromNotch({ ... defaultSkill: env.defaultSkill ... })` sites (`:1362` and the follow-continuation `:1470`) to:

```ts
          skillSlug: activeSkillRef.current,
```

Also update the two `useCallback` dependency arrays (`:1389`, `:1492`) — remove `env.defaultSkill`, add `activeSkillRef` is a ref (no dep needed).

Reset `activeSkillRef.current = ''` where a task/turn resets and the frontmost app may have changed (alongside the existing `resetPreviousTurn`/pending-clear logic) so a new question re-routes cleanly.

- [ ] **Step 4: Typecheck + test**

Run: `npm run typecheck && npm run test`
Expected: PASS. `env.defaultSkill`/`KAIRO_DEFAULT_SKILL` may now be unused — keep the config field (harmless default) or remove it and its `env.ts` references; if removed, drop the `defaultSkill` line in `src/config/env.ts:60,128`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(skills): notch caches gate skillSlug and feeds tutor + follow turns"
```

---

## Task 8: Build the real app + smoke the plumbing

**Files:** none (verification task)

- [ ] **Step 1: Full checks**

Run:
```bash
npm run typecheck && npm run test && cargo check --manifest-path src-tauri/Cargo.toml
```
Expected: all PASS.

- [ ] **Step 2: Build + launch the packaged app**

Run:
```bash
osascript -e 'tell application "Kairo Tutor" to quit'; npm run tauri:build -- --bundles app && open "src-tauri/target/release/bundle/macos/Kairo Tutor.app"
```
Expected: builds, signs, launches.

- [ ] **Step 3: Confirm routing in the logs**

Run: `tail -F ~/Library/Logs/Kairo/kairo-latest.log`
In Figma, ask by voice: "help me make my first animation." Expect log lines:
- `gate turn` then a `gate result` containing `"skillSlug":"figma-first-animation"`.
- `tutor turn skill resolved skill=figma-first-animation app=Figma`.

Ask the same in a non-Figma app (e.g. Notes). Expect `skillSlug` empty in `gate result` and `tutor turn skill resolved skill=` (empty). This proves the guardrail.

- [ ] **Step 4: Commit any log/tuning fixes**

```bash
git add -A && git commit -m "chore(skills): logging + plumbing fixes from first packaged run"
```

---

## Task 9: A/B eval — does the skill reduce errors?

**Files:**
- Create: `docs/superpowers/plans/figma-skill-eval.md` (results log)

- [ ] **Step 1: Define the task set**

Write 5 concrete Figma requests to run identically with the skill ON and OFF, e.g.:
1. "How do I make my first animation?"
2. "Help me animate this shape moving."
3. "What next?" (mid-guide continuation)
4. "Where do I set the animation type?"
5. "Make it move on click."

- [ ] **Step 2: Baseline (skill OFF)**

Set `SKILLS_ENABLED = false` in `src-tauri/src/constants.rs`, rebuild + launch (Task 8 Step 2). Run all 5 tasks. For each, record: (a) did grounding point at the right control per step (Y/N per step), (b) did the tutor give the right next steps in order (Y/N). Log to `figma-skill-eval.md`.

- [ ] **Step 3: Treatment (skill ON)**

Set `SKILLS_ENABLED = true`, rebuild + launch. Run the same 5 tasks, record the same two metrics.

- [ ] **Step 4: Compare + decide**

In `figma-skill-eval.md`, tabulate ON vs OFF for both metrics. The skill "works" if grounding hit-rate and step-order correctness are >= baseline on every task and better on the animation-specific ones. Note any regressions (skill too long / misleading) and adjust the SKILL.md body.

- [ ] **Step 5: Commit the eval**

```bash
git add docs/superpowers/plans/figma-skill-eval.md src-tauri/src/constants.rs
git commit -m "test(skills): A/B eval of Figma first-animation pack (with vs without)"
```

---

## Self-Review

**Spec coverage:**
- Borrow Anthropic pattern (L1 metadata + L2 body, progressive) → Tasks 1, 2, 3, 4. ✅
- Model-driven selection via gate `skillSlug` → Task 4. ✅
- App as evidence + post-guardrail (not a hard pre-filter) → `resolve_slug`/`repair_gate_skill`/`matches_app`, Tasks 2, 4, 5. ✅
- No L3, no coordinates/landmarks → landmarks dropped (Task 3 Step 3); soft hints only in SKILL.md (Task 1). ✅
- App-scoped only, `appIdentifiers` optional → `bundle_ids`/`title_contains` default empty; a pack with none = global (query-only) — schema door open, not used. ✅
- Registry in Rust, retire frontend selection → Tasks 2, 6. ✅
- Route once + inject every turn from cache → `activeSkillRef` (Task 7) + per-turn `build_tutor_system_prompt` inject (Task 3). ✅
- Embedded at compile → `include_str!` (Task 2). ✅
- Follow-along covered → it reuses `run_tutor_turn`; both ask sites fed the cached slug (Task 7). ✅
- Eval A/B with/without skill → `SKILLS_ENABLED` + Task 9. ✅
- One Figma pack → Task 1. ✅

**Placeholder scan:** No TBD/"handle edge cases"/"similar to". Each code step shows real code. ✅

**Type consistency:** `skill_slug` (Rust, snake) ↔ `skillSlug` (TS/JSON, camel) via `#[serde(rename_all = "camelCase")]`. `Skill`, `resolve_slug`, `matches_app`, `metadata_block`, `get`, `fallback_for_app`, `repair_gate_skill`, `skill_is_active`, `SKILLS_ENABLED` used consistently across Tasks 2-5. `activeSkillRef` / `skillSlug` consistent across Tasks 6-7. ✅

## Open risk notes
- **Figma surface:** the pack targets desktop-app + browser Figma Smart-Animate prototyping. If "Figma Motion" is a different surface, only `SKILL.md` (Task 1) changes.
- **`bundle_id` on `GateInput`:** requires the frontend gate call to pass `bundleId` (Task 7 Step 2). If omitted, the gate guardrail still works via `titleContains: figma`; `run_tutor_turn` re-validates with the real bundle regardless.
- **Prompt size:** body ≤ ~450 words keeps the vision prompt lean; re-check the tutor prompt token count after Task 3.
