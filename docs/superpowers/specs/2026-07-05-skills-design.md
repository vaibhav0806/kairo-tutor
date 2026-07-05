# Kairo Skills — design (deferred, do NOT build yet)

> Status: **research + design only.** No implementation this cycle. This captures
> how the industry does "skills" so we copy the proven pattern instead of
> reinventing it, and how it maps onto Kairo. Revisit after Tour v1 ships.

## 0. Why this doc exists

A skill = a reusable body of app-specific expertise ("how to guide someone in
Blender / Photoshop / GitHub"). We want the tutor to load that expertise **only
when it's relevant**, without bloating every prompt (we just spent a cycle
*removing* prompt bloat — a naive "paste the whole Blender manual every turn"
would undo it). Every major AI system converged on the same answer:
**progressive disclosure**. This doc records that pattern and the Kairo mapping.

## 1. How the industry does it (the wheel we won't reinvent)

### Anthropic Agent Skills / Claude Code — the reference design

A skill is a **directory** with a `SKILL.md` file: YAML frontmatter + markdown body.
Loading is **three levels of progressive disclosure**:

1. **Discovery (startup):** only each skill's `name` + `description` is preloaded
   into the system prompt (~100 tokens/skill). Just enough for the model to know
   *when* a skill applies, without its content in context.
2. **Activation (on match):** when the task matches a skill's description, the
   **full `SKILL.md` body** is loaded (target < ~5k tokens).
3. **Execution (on demand):** `SKILL.md` can *reference* extra files
   (`reference.md`, `forms.md`, scripts). Those load **only** when that specific
   sub-scenario arises. So total bundled context is effectively unbounded while
   per-turn context stays lean.

`SKILL.md` frontmatter fields worth stealing:

| Field | Meaning |
|---|---|
| `name` | identifier / display label |
| `description` | **the most important field** — what it does + *when to use it*. The model routes on this. Key use-case first; Claude Code caps `description`+`when_to_use` at 1,536 chars in the listing. |
| `when_to_use` | extra trigger phrases / example requests, appended to description |
| `disable-model-invocation` | if true, only the user can invoke (side-effect workflows) |
| `allowed-tools` | tools usable without asking while the skill is active |

Claude Code extras: **dynamic context injection** (a `` !`cmd` `` line in the body
is run and its output inlined *before* the model sees the skill — e.g. inline the
current `git diff`), and **subagent execution** (run a skill in a forked context).
Authoring guidance: start from real failing tasks; keep `SKILL.md` lean and push
rarely-needed detail into referenced files; iterate from actual usage.

### MCP (Model Context Protocol) — the injection plumbing, if we ever go remote

Three primitives with different control models:
- **Tools** — *model-controlled* (the model decides to call them).
- **Resources** — *app-controlled* (docs/data the app attaches).
- **Prompts** — *user-controlled* (structured, user-selected prompt templates;
  can embed resources).

The client lists a server's tools/resources with **natural-language descriptions**;
the model reads those descriptions to decide what to call. Same discovery→load
idea, over a wire protocol. Security caveat: MCP has known **prompt-injection /
tool-poisoning** risks — anything loaded from an untrusted server can attack the
model. Relevant only if Kairo ever loads *third-party* skills.

### OpenAI GPTs / Assistants — the "config bundle" version

A custom GPT = **instructions** (behavior) + **knowledge files** (up to 20 files,
reference material retrieved when relevant) + **tools/actions** (function calling
to external APIs). Knowledge files are RAG-style retrieval, not prescriptive
workflows. Less structured than Agent Skills, same spirit: static instructions +
on-demand knowledge + callable tools.

### Progressive disclosure vs RAG (important distinction)

- **RAG** = retrieve semantically-similar *passive* chunks for the current query.
  Chunks can't prescribe a multi-step workflow or bundle runnable code.
- **Progressive disclosure** = a *workflow* decision about *when in the task* to
  load which materials and how to trigger the load. RAG can be the *fetch
  mechanism inside* progressive disclosure (for large knowledge bases), but the
  architecture is the disclosure, not the retrieval.

**Takeaway for Kairo:** adopt **progressive disclosure**. Add RAG only later, and
only for skills too big to inject whole.

## 2. Kairo skills — the design

Kairo is **native (Rust) + local + real-time voice**. No MCP server needed: skills
are **local markdown files bundled with the app** (user-addable later). "Loading"
= read a file and inject a slice into the tutor prompt. Keep the three levels.

### 2.1 Shape

```
skills/
  github/
    SKILL.md            # frontmatter + body (what GitHub is, key landmarks, tone)
    tours/
      first-visit.md    # a canned orientation tour recipe (level 3)
    tasks/
      open-a-pr.md       # a task recipe (level 3), loaded only for that intent
  blender/
    SKILL.md
    tours/orientation.md
    tasks/first-keyframe.md
```

Example `skills/github/SKILL.md`:

```markdown
---
name: GitHub
description: Guide a user around a GitHub repository page — orient a newcomer,
  point at the file list / README / Clone / Issues / PRs, and walk common tasks.
when_to_use: active app is a browser on github.com, or the user asks about a repo,
  cloning, pull requests, issues, commits, or "what is this page".
app_identifiers: ["com.github.*", "github.com"]
---

## What GitHub is
A place developers host and share code. A "repository" (repo) is one project.

## Key landmarks (what to look for on a repo page)
- File list — the table of files/folders; the actual code lives here.
- README — the long formatted doc under the file list; explains the project.
- Green "Code" button (top-right of the file list) — clone/download.
- Tabs (Code / Issues / Pull requests / Actions) — near the top.

## Tone
Assume the user is new. Explain jargon in one clause. Never say positions
("top-right") — Kairo's pointer shows where; you say what and why.

## Tours
For "what is this / guide me", use tours/first-visit.md.
```

### 2.2 The three levels, Kairo-mapped

1. **Discovery (startup):** load each skill's `name` + `description` +
   `app_identifiers` into a small in-memory **catalog**. Cheap, always resident.
2. **Activation (per turn):** pick at most one skill and inject its `SKILL.md`
   **body** into the tutor prompt. This is the `skill_is_active` slot we already
   left in `build_tutor_system_prompt` — today it prints one line; then it prints
   the body.
3. **Execution (on demand):** if the turn is a tour or a known task, also inject
   the matching `tours/*.md` or `tasks/*.md` recipe — nothing else. Keeps the
   prompt lean even for a big skill.

### 2.3 Routing (which skill, if any)

We already have the routing layer: `skills.ts` `matchActiveApp` / `matchUserQuery`
+ the native `general` fallback. Order of preference:

1. **Deterministic app-id match** (bundle id / host) — free, no model call. Best
   signal (you're literally in Blender).
2. **Keyword / `when_to_use` match** on the query — cheap.
3. **(Later, only if needed)** a model pick over the catalog descriptions, exactly
   like Claude's skill selection. Avoid until 1+2 prove insufficient — a real-time
   voice tutor shouldn't pay an extra routing round-trip.

`general` (no app-specific skill) → inject **nothing** (current behavior). Never
force a skill that doesn't match — that was the old "Blender everywhere" bug.

### 2.4 Kairo's twist: skills carry **tour recipes**

This is where skills and Tour v1 meet. A skill's `tours/*.md` is a *canned step
sequence* ("orientation: file list → README → Code button → tabs") that the tutor
**adapts to the actual screenshot** (grounding each step's box live). The skill
makes tours reliable because it tells the model *what to look for*; the screenshot
tells it *where*. Tours work without skills (model improvises), but skills make
them consistent and expert.

### 2.5 What Kairo skills are NOT

- **No side effects / no tools that act.** Kairo skills are read-only guidance
  ("the AI points, the user acts"). So `disable-model-invocation`, `allowed-tools`,
  executable scripts — not needed in v1. (Revisit only if Kairo ever automates.)
- **No third-party remote skills in v1** → no MCP, no prompt-injection surface.
  Bundled-with-app only. If we later allow user/community skills, treat their
  bodies as untrusted input (they ride into the prompt) and sandbox accordingly.

## 3. Anti-patterns (things we must not do)

- **Don't inject the whole skill every turn.** That re-bloats the prompt we just
  slimmed. Level 2 body only on match; level 3 recipe only for the matched task.
- **Don't add an LLM routing call** before deterministic matching is proven
  insufficient. Latency + cost for a voice loop.
- **Don't let `description` drift.** It's the routing signal; keep it "what + when",
  key use-case first, under the char cap.
- **Don't couple skills to Blender specifically.** Templateable folder + frontmatter
  from day one, even if we ship one skill first.

## 4. When to build (trigger conditions)

Build skills **after** Tour v1 ships and we've confirmed:
- tours are good but **inconsistent per app** (the model improvises the wrong
  landmarks) → a skill body fixes that; and/or
- users repeatedly ask about one app (Blender/Photoshop/GitHub) where canned
  landmarks + recipes would clearly help.

First build = **one** skill (GitHub or Blender) end-to-end: catalog entry →
app-id routing → body injection at the `skill_is_active` slot → one tour recipe.
Template from there.

## 5. Open questions to resolve at build time

- **Where skills live:** bundled in the `.app` resources (read-only) vs a
  user-writable dir (so users can add skills). Probably both (bundled defaults +
  user overrides), mirroring `.claude/skills`.
- **Body size budget:** target < ~1–2k tokens for a `SKILL.md` body so injection
  stays cheap; push detail into `tasks/*` / `tours/*`.
- **Slice selection for level 3:** how the tutor call signals which task recipe to
  load (a cheap pre-classify, or the same call that picks tour vs act emits a
  `task` hint we resolve to a recipe file).
- **Windows portability:** skills are plain files → portable. The *routing* signal
  (`app_identifiers`) needs a Windows equivalent (process/exe name) — keep the
  match layer abstract.

## Sources
- Anthropic — [Equipping agents for the real world with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- Claude Code — [Extend Claude with skills](https://code.claude.com/docs/en/skills)
- [Agent Skills open standard](https://agentskills.io/home)
- MCP — [Prompts spec](https://modelcontextprotocol.io/specification/2025-06-18/server/prompts) · control models (tools=model, resources=app, prompts=user)
- Simon Willison — [MCP has prompt injection security problems](https://simonwillison.net/2025/Apr/9/mcp-prompt-injection/)
- OpenAI — [Custom GPTs](https://openai.com/academy/custom-gpts/) · [GPT Actions](https://developers.openai.com/api/docs/actions/introduction)
- MindStudio — [Progressive disclosure vs RAG](https://www.mindstudio.ai/blog/progressive-disclosure-ai-agent-skill-design)
