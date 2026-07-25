# Figma Motion first-animation skill — A/B eval

Measure whether the `first-figma-motion-tutorial` pack reduces errors. Two metrics per task:
- **Grounding hit** — did the pointer land on the right control, per step? (Y/N per step)
- **Step order** — did the tutor give the right next steps, in order? (Y/N)

The pack teaches **Figma Motion** (the open-beta timeline + keyframe tool inside design
files) — NOT prototype Smart Animate. A run that starts talking about the Prototype tab,
connections, or Present mode is a routing/content failure, not a grounding one.

Toggle: `src-tauri/src/constants.rs` → `SKILLS_ENABLED` (true = ON, false = baseline).
Rebuild + relaunch after flipping (`npm run app` or the CLAUDE.md build command).

## Verifying the skill is actually loaded and reaching the model

Watch: `tail -F ~/Library/Logs/Kairo/kairo-latest.log`

All skill lines log under the `kairo::skills` target, in this order per voice turn:

| Log line | Proves |
|---|---|
| `skill pack loaded` (once, at first use) | the SKILL.md parsed — check `body_chars` + `body_hash` |
| `skill registry ready count=1 enabled=true` | the registry built and packs are enabled |
| `gate turn: L1 skill list offered to the model` | the gate was given the routing list (`l1_chars` > 0) |
| `gate skill routing gate_picked=… after_guardrail=…` | what the model chose and what survived the app guardrail |
| `skill slug resolved … reason=…` | why a slug was kept, dropped, or filled by the fallback |
| `L2 skill body INJECTED into the tutor system prompt` | the body was added — `body_hash` must match the load line |
| `skill body dump: …` (parts 1..N, once per process) | the FULL text the model receives, readable back verbatim |
| `tutor system prompt assembled skill_in_prompt=true` | the body survived into the final string sent to the provider |

Fast greps:
```bash
grep -E "skill pack loaded|skill registry ready" ~/Library/Logs/Kairo/kairo-latest.log
grep "skill_in_prompt" ~/Library/Logs/Kairo/kairo-latest.log      # must be true
grep "skill body dump" ~/Library/Logs/Kairo/kairo-latest.log      # the literal L2 text
```

Failure signatures:
- `skill pack FAILED to parse` → frontmatter/body broken in SKILL.md.
- `skill slug is NOT in the registry` → slug drift between the gate/frontend and `EMBEDDED`.
- `skill body MISSING from the assembled system prompt` → injection lost after prompts.rs.
- No `L2 …INJECTED` line at all → routing never picked the pack (read `gate skill routing`).

The full-body dump is controlled by `constants::LOG_SKILL_BODY` (default `true`); set it to
`false` once the pack is trusted to keep the log light.

## Task set (run each by voice, in Figma)
1. "How do I make my first animation?" (expect: offers the three projects, or defaults to bouncy square)
2. "I want to make a loading spinner." (expect: routes to Project B)
3. "What next?" (mid-guide continuation)
4. "Where do I turn on the timeline?" (expect: Motion toggle, not the Prototype tab)
5. "Nothing happens when I press play." (expect: the recovery playbook — one keyframe / same value / playhead)
6. "Why can't I just use Smart Animate?" (expect: the objection answer, then back on track)

## Results

| # | Task | OFF grounding | OFF step-order | ON grounding | ON step-order | Notes |
|---|------|---------------|----------------|--------------|---------------|-------|
| 1 | first animation |  |  |  |  |  |
| 2 | loading spinner |  |  |  |  |  |
| 3 | what next |  |  |  |  |  |
| 4 | turn on timeline |  |  |  |  |  |
| 5 | nothing on play |  |  |  |  |  |
| 6 | smart animate objection |  |  |  |  |  |

## Verdict
Skill "works" if grounding + step-order are >= baseline on every task and better on the
Motion-specific ones (1, 2, 4, 5, 6). Note regressions (skill too long / off-base) and tune
`src-tauri/skills/first-figma-motion-tutorial/SKILL.md`.
