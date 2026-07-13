# Figma first-animation skill — A/B eval

Measure whether the `figma-first-animation` pack reduces errors. Two metrics per task:
- **Grounding hit** — did the pointer land on the right control, per step? (Y/N per step)
- **Step order** — did the tutor give the right next steps, in order? (Y/N)

Toggle: `src-tauri/src/constants.rs` → `SKILLS_ENABLED` (true = ON, false = baseline).
Rebuild + relaunch after flipping (`npm run app` or the CLAUDE.md build command).

Watch: `tail -F ~/Library/Logs/Kairo/kairo-latest.log`
Look for: `gate result: {... "skillSlug":"figma-first-animation"}` and
`tutor turn skill resolved skill=figma-first-animation app=Figma`.

## Task set (run each by voice, in Figma)
1. "How do I make my first animation?"
2. "Help me animate this shape moving."
3. "What next?" (mid-guide continuation)
4. "Where do I set the animation type?"
5. "Make it move on click."

## Results

| # | Task | OFF grounding | OFF step-order | ON grounding | ON step-order | Notes |
|---|------|---------------|----------------|--------------|---------------|-------|
| 1 | first animation |  |  |  |  |  |
| 2 | animate moving |  |  |  |  |  |
| 3 | what next |  |  |  |  |  |
| 4 | set animation type |  |  |  |  |  |
| 5 | move on click |  |  |  |  |  |

## Verdict
Skill "works" if grounding + step-order are >= baseline on every task and better on
the animation-specific ones (1, 2, 4, 5). Note regressions (skill too long / off-base)
and tune `src-tauri/skills/figma-first-animation/SKILL.md`.
