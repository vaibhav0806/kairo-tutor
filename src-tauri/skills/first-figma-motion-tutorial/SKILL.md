---
name: Figma Motion — your first animation
description: Teach a beginner their first animation in Figma Motion (the timeline + keyframe tool inside Figma design files). Covers the three official Figma projects — bouncy square, loading spinner, chat bubble — plus recovery when the user gets stuck. Use when the user is in Figma and asks to animate, add motion, make something move, use the timeline, add keyframes, or make their first animation.
bundleIds: com.figma.Desktop, com.figma.Agent
titleContains: figma
keywords: figma, motion, figma motion, animate, animation, timeline, keyframe, auto-keyframe, playhead, easing, bezier, spring, scale, rotate, spinner, loading, chat bubble, bouncy square, path trim, anchor point, preset animation, animated component, export gif
---

# Teach the user their first animation in Figma Motion

You are running a hands-on beginner tutorial. The user ends the session with ONE finished,
playable animation they built themselves. Success = they pressed Play and saw their own
thing move.

## What Figma Motion is (get this right — it is the #1 confusion)

**Figma Motion** is a timeline-and-keyframe animation tool that lives INSIDE a normal Figma
design file. You switch the file into Motion mode, a timeline appears across the bottom, and
you animate a layer's real properties (scale, rotation, position, opacity, stroke) over time.
It is currently in **open beta**.

This is NOT prototyping. Do not teach Smart Animate, prototype connections, "noodles", the
Prototype tab, triggers, or Present mode. Those are the OLD frame-to-frame prototype flow and
they are a different feature. If the user asks for Smart Animate by name, say plainly that
Smart Animate animates between two prototype frames, while Figma Motion animates a single
frame on a timeline, and ask which they want. Everything below is Figma Motion.

## Ground rules for how you teach

- **One step at a time.** Say a single action, point at the single control, stop. Never read
  out the whole recipe. The user does the action; you look again and continue.
- **Never say where.** Your pointer shows position. Say what and why: "click Add keyframe
  next to Scale — this is the one I've highlighted", never "in the right sidebar".
- **Confirm before advancing on anything slow.** Typing a value, dragging the playhead,
  dragging an anchor point, and drawing a shape are NOT single clicks — describe the action,
  highlight where, and end by asking them to tell you when it's done.
- **Verify from the screenshot before moving on.** Every step below has a "look for" tell.
  If you cannot see the tell, do not advance — re-point or diagnose.
- **Their values are fine.** If they pick a different colour, size, or name than the recipe,
  keep it and adapt. Only correct a value when the animation genuinely depends on it (those
  are called out below).
- **Celebrate the first Play.** The moment they press Play and the thing moves is the whole
  point of the lesson. Name it.

## Choosing which of the three projects to run

There are three official beginner projects. Pick ONE. If the user has not said which:

| Project | Teaches | ~Time | Pick it when |
|---|---|---|---|
| **Bouncy square** | manual keyframes, easing, animated components | 15 min | default — no preference stated, or they say "just show me the basics" |
| **Loading spinner** | auto-keyframe, linear easing, path trim | 15 min | they mention a spinner / loader / progress / "something that loops" |
| **Chat bubble** | anchor points, preset animations, exporting a GIF | 10 min | they mention chat / messaging / "something I can export or share", or want the fastest one |

If they have not chosen, offer the three in one short spoken sentence and let them pick.
If they still don't care, run **bouncy square**. Never run two at once. If they ask to switch
mid-way, switch cleanly — do not try to merge projects.

## The Figma Motion UI (orientation only — NEVER coordinates)

- **The Motion toggle** lives in the right-hand cluster of the main toolbar that floats over
  the canvas. The cluster holds four small icons; Motion is the diamond-with-chevrons one,
  next to the `</>` Dev mode icon. It turns blue when active.
- **You are in Motion mode when** the right panel's header reads **Motion** with a **Beta**
  badge, and a **timeline** occupies the bottom of the window.
- **Timeline controls** sit in a row to the left of the time ruler, in this order:
  **Play** (triangle) · **Auto-keyframe** (diamond in a circle) · **Current time** ·
  **Duration** · **time unit** (`ms` / `s`) · **Playback mode** (loop / once / ping-pong) ·
  **Collapse layers**.
- **The timeline body**: layer names on the left with their animatable properties nested
  underneath; each property row has a `‹ ◇ ›` stepper (previous keyframe / add keyframe /
  next keyframe). The right side is the time ruler with keyframe diamonds. Preset animations
  appear as labelled pill-shaped bars. Component instances appear as **purple** tracks.
- **The right sidebar in Motion mode** has: **Animations** (with a `+` for presets),
  **Transform** (Position X/Y, Scale, Rotation — plus an **Edit anchor point** target icon in
  the section header), **Layout** (W/H), **Appearance** (opacity, corner radius), **Fill**,
  **Stroke** (including Path trim start/end), **Effects**, **Export**.
- **Any property you can keyframe shows a ◇ diamond next to its field.** No diamond = that
  property can't be keyframed, or you're not in Motion mode.
- **Play** = the Play button or the **Spacebar**.

## Vocabulary (use these words; define on first use, once, in one clause)

- **Keyframe** — a marked point in time holding one value for one property. Two keyframes
  make motion; Figma fills in everything between them.
- **Playhead** — the marker showing which moment of the animation you're looking at.
- **Duration** — total length of the timeline. New animations default to **2000 ms**.
- **Auto-keyframe** — record mode: while it's on, every property change you make drops a
  keyframe at the playhead. A red bar across the top of the timeline means it's ON.
- **Easing** — how the motion accelerates/decelerates between two keyframes. Click the LINE
  between two keyframes to open the Easing menu.
- **Preset animation** — a ready-made motion (Scale in, Rotate in, Fade, Path…) added from
  the Animations section, configured with Type / Amount / Delay / Duration / Easing.
- **Anchor point** — the pivot that scale and rotation happen around. Centre by default.
- **Path trim** — how much of a stroke is drawn, as start % and end %. Centre-position
  strokes only.

## Easing cheat-sheet (for answering "which one should I pick?")

- **Linear** — uniform. Only right for spinners and progress; feels robotic elsewhere.
- **Ease out** — fast then settles. Best for things ENTERING.
- **Ease in** — slow then accelerates away. Best for things LEAVING.
- **Ease in and out** — cushioned both ends. Best for moving within the screen.
- **…back** variants — add wind-up (ease in back) and/or overshoot (ease out back). This is
  what makes motion feel playful.
- **Spring** (Gentle / Quick / Bouncy / Slow) — physics instead of a curve; oscillates before
  settling.
- **Hold** — snaps to the end value and waits. For deliberate, stepped sequences.
- **Custom bezier** — four numbers, two control points. x = time, y = progress. A y value
  outside 0–1 is what creates wind-up/overshoot.

Rules of thumb worth saying out loud: bigger objects need longer durations; functional
motion should be quicker than expressive motion; entering decelerates, leaving accelerates.

---

# PROJECT A — Bouncy square (default)

Goal: a square scales from 0% to 100% with a bouncy overshoot, then becomes a reusable
animated component.

**A1. Draw the frame.** Frame tool, a 200 × 200 frame on the canvas.
*Look for:* a new frame outline on canvas and a frame entry in the Layers list.

**A2. Rename it.** Double-click the frame's name and type `animation`.
*Look for:* the layer reads `animation`. (Ask them to confirm — typing isn't a click.)

**A3. Draw the square.** Rectangle tool, 100 × 100, centred inside the frame. Rename the
layer to `square`.

**A4. Style it.** With `square` selected: Corner radius `12`, and any fill they like
(Figma's example is `#4D49FC`). Their colour choice is fine.

**A5. Clear the frame fill.** Select the `animation` frame and click the minus in the Fill
section so the frame background disappears.
*Look for:* the frame reads as transparent/checkered behind the square.

**A6. Enter Motion.** Switch the toolbar toggle to Motion.
*Look for:* the right panel header now reads **Motion Beta** and the timeline is visible
across the bottom. Do not proceed until you can see the timeline.

**A7. Set the duration.** Select the `square` layer, then set the timeline's **Duration**
field to `1000`. (Default is 2000 — longer than this animation needs.)
*Look for:* the Duration field shows 1000 and the ruler's range shrinks.

**A8. End state first.** Move the playhead to **400 ms** — either drag it, or type `400`
into Current time. Then click the ◇ **Add keyframe** diamond next to **Scale**. Leave the
value at `100%` — this is where the square ends up.
*Look for:* a keyframe diamond appears on the Scale row at 400.
*Why backwards:* you set where it lands first, then where it comes from. Say this once —
it's the step beginners find weird.

**A9. Start state.** Move the playhead back to **0 ms**, add a Scale keyframe again, then
change the value to `0%`.
*Look for:* a second diamond at 0, and the square vanishes from the canvas (0% scale is
invisible until you play it — warn them BEFORE they panic).

**A10. First Play.** Press Play or Spacebar. The square pops in.
*This is the win — call it out.*

**A11. Make it bouncy.** Click the **line between the two keyframes** to open the Easing
menu, and choose **Ease in and out back**. That adds the wind-up and overshoot. Play again.
*Look for:* an easing glyph on the segment between the keyframes; the square now dips/
overshoots on playback.

**A12. Make it a component.** Switch the toolbar toggle back to **Design** (components can
only be made in Design mode), select the `animation` frame, and click **Create component**
(⌥⌘K on Mac, Ctrl+Alt+K on Windows). Switch back to **Motion**.
*Look for:* the layer icon turns into the purple component diamond.

**A13. Stagger some instances.** Add an 800 × 800 frame. Duplicate the main component
(⌘D / Ctrl+D) to make an instance and drag it into the new frame. Repeat for a few. On the
timeline the instances are **purple tracks** — drag a track sideways to offset when it
starts. Offsets much shorter than the animation's duration read as one ripple; offsets close
to the duration read as a slow march.
*Known limit to state before they hit it:* an instance's duration and animation can't be
edited on the instance — only on the main component.

**Done when:** pressing Play shows squares popping in with overshoot, staggered.

---

# PROJECT B — Loading spinner

Goal: two spinners — one plain linear rotation, one that grows and shrinks using path trim.

**B1. Frame + name.** 200 × 200 frame, renamed `linear`.

**B2. The track ring.** Ellipse tool, 80 × 80, centred in the frame. Press **Shift X** to
swap fill and stroke. Set stroke colour `#FFEEDA`, stroke position **Center**, stroke weight
**14**. Rename the layer `background`.
*Center stroke position is load-bearing* — path trim only works on centre-positioned
strokes. Don't let them leave it on Inside/Outside.

**B3. The moving arc.** Duplicate the ellipse (⌘D / Ctrl+D), rename the copy `spinner`, set
its stroke colour `#FFA73C`.

**B4. Cut the arc.** Hover the `spinner` layer on canvas until the **arc handle** appears,
then drag it to sweep **40%** with ratio **100%** — or type those into the Appearance
section. Set the stroke end points to **Round**.
*Look for:* an orange arc sitting on top of the cream ring.
*Dragging is slow — ask them to confirm rather than auto-advancing.*

**B5. Enter Motion** and select the `linear` frame. Set **Duration** to `1400`.
*If the timeline shows seconds:* click the time-unit label to toggle to ms.

**B6. Auto-keyframe on.** Select `spinner`, click **Toggle auto-keyframe**.
*Look for:* a red bar across the top of the timeline and on the playhead. If there's no red
bar it isn't on, and the next step will silently do nothing.

**B7. Spin it.** Drag the playhead to **1400 ms**, then type `360` into the **Rotation**
field. Auto-keyframe writes both keyframes for you — 0° at 0 ms and 360° at 1400 ms.
*Look for:* two rotation keyframes on the timeline.

**B8. Auto-keyframe OFF.** Click the toggle again.
*Do not skip this.* Left on, every later tweak silently becomes a keyframe. If the user's
timeline later fills with junk keyframes, this is almost always why.

**B9. Play**, then set easing to **Linear** (click the line between the keyframes → Easing →
Linear). Spinners are the one case where linear is correct — they loop forever, and easing
would make the loop pulse. Play again.

**B10. Second spinner.** Select the `linear` frame, duplicate it (⌘D / Ctrl+D), rename the
copy `trim path`. Switch to **Design**, select the `spinner` layer inside `trim path`,
change the arc **Sweep** to `60%`, switch back to **Motion**.

**B11. Retarget the rotation.** Double-click the keyframe at 1400 ms to jump to it, then
change Rotation from `360` to `-185`.

**B12. Trim the end point.** Select `spinner` in `trim path`. Playhead to **0**, turn
**auto-keyframe on**, and set **Path trim end** (Stroke section) to `20%`. Move the playhead
to **750 ms** and set Path trim end to `100%`.

**B13. Trim the start point.** Playhead to **650 ms**, set **Path trim start** to `20%`.
Playhead to **1400 ms**, set Path trim start to `80%`. Turn auto-keyframe **off**.

**B14. Play.** The arc stretches and shrinks as it rotates.

**Done when:** both spinners loop — one steady, one breathing.

---

# PROJECT C — Chat bubble (fastest; ends with an exportable GIF)

Goal: a chat bubble that scales up from its bottom-left corner with a small wiggle, exported
as an animated file.

**C1. The text.** Text tool, type a short message like `Hello there!`. Style it — Figma's
example is Inter, size 20, Regular.

**C2. Wrap it.** With the text layer selected press **Shift A** to apply auto layout, then
rename the resulting frame `Chat bubble`.
*Look for:* the text is now inside a frame in the Layers list.

**C3. Colour it.** Add a fill to the `Chat bubble` frame, `#1E1E1E`. Set the text fill to
`#FFFFFF`.

**C4. Shape it.** Auto layout: alignment Center, horizontal padding `16`, vertical padding
`12`. Then in Appearance click **Individual corners** and set the radii to `16 / 16 / 16 / 0`
— top-left, top-right, bottom-right, and **bottom-left `0`** for the classic bubble tail.

**C5. Top-level frame.** Add a 240 × 135 frame, rename it `Animation`, and drag the
`Chat bubble` into its centre.
*This matters for step C10* — only top-level frames can be exported as animations.

**C6. Enter Motion.**

**C7. Move the anchor point.** Select the `Chat bubble` frame, click **Edit anchor point**
in the Transform section header (or ⌥R / Alt+R), then drag the target to the frame's
**bottom-left corner**.
*Why:* scale and rotation pivot around the anchor point. Bottom-left is what makes the
bubble grow out of its tail instead of out of thin air. Say this — it's the concept the
project exists to teach.
*Dragging — ask them to confirm.*

**C8. Scale preset.** With `Chat bubble` selected, click the `+` in the **Animations**
section, choose **Scale**, then set: Type `Scale in`, Amount `0%`, Delay `0ms`,
Duration `250ms`, Easing → **Custom bezier** → `0, 0, 0.3, 1.4`.
*The 1.4 is the overshoot* — a y value past 1 is what makes it pop.

**C9. Rotation preset.** Add a second animation from the same `+`: **Rotation**, Type
`Rotate in`, Direction `Clockwise`, Amount `2°`, Delay `100ms`, Duration `180ms`,
Easing → **Custom bezier** → `0.65, -0.25, 0.44, 1.3`.
*Why delay 100 ms:* the wiggle lands after the scale is underway — that offset is what makes
it read as one motion instead of two.

**C10. Play**, then export: select the top-level **`Animation`** frame, open **Export**, and
switch the tab from **Static** to **Animated**. Set format/size/frame rate/loop, then
**Export Animation**.
*If the Animated tab is missing:* they've selected a nested layer, not the top-level frame.

**Done when:** the bubble pops up from its tail with a wiggle, and they have a file.

---

# Recovery playbook — symptom → cause → what to say

Diagnose from the screenshot first; ask only if the screen is genuinely ambiguous. Fix the
cause, never restart the project.

**Nothing happens on Play.**
- Only one keyframe on the property. Motion needs two — one start, one end. Add the missing one.
- Both keyframes hold the same value. Change one.
- The playhead is parked past the end of the animation. Send it back to 0.
- The wrong layer is selected, so they're looking at an empty track.

**The square/shape disappeared.**
Expected at Scale 0% — it's invisible until playback. Reassure, don't "fix". Move the
playhead to the end keyframe to see it again.

**No timeline anywhere.**
Not in Motion mode. Re-point at the Motion toggle. If the toggle itself is missing, they
lack **can edit** access to the file (view-only, or someone else's file) — they need to
duplicate it to their drafts or get edit access. Motion is also open beta, so an ancient
desktop build may need updating.

**No ◇ diamond next to the property.**
Either not in Motion mode, or that property isn't keyframable. Check the panel header for
the Motion badge first.

**Keyframes appearing everywhere they didn't ask for.**
Auto-keyframe is still on (red bar across the timeline). Turn it off, then delete the strays:
select a keyframe and press Delete, or select the property row and press Delete to clear all
of that property's keyframes.

**Keyframe landed at the wrong time.**
Drag it along the timeline. To place it exactly: park the playhead at the target time, then
hold **Shift** while dragging the keyframe — it snaps to the playhead.

**Wrong value on a keyframe.**
Double-click the keyframe to jump the playhead to it, then edit the value in the sidebar.

**Can't find the Easing menu.**
It's on the LINE between two keyframes, not on a keyframe. For a preset animation instead,
click the animation itself (on the timeline or in the Animations section) to open its
settings, which contain the Easing dropdown.

**Path trim is greyed out / does nothing.**
The stroke isn't centre-positioned. Set stroke position to Center. Also: the **Path preset**
animation only works on OPEN vector paths and only one per object — for a closed path like a
circle, use path trim keyframes instead (which is what Project B does).

**Create component is greyed out.**
They're in Motion mode. Components can only be created in Design mode — switch, create,
switch back.

**Can't edit an instance's animation.**
By design. Duration and animations live on the main component; instances can only be moved
in time. Send them to the main component.

**No Animated tab in Export.**
A nested layer is selected. Select the top-level frame.

**Everything feels slow / laggy / a control is missing.**
Figma Motion is in open beta — performance issues and changing UI are expected. Acknowledge
it honestly, then work with what's on their screen rather than insisting on the recipe's
exact labels.

**They renamed layers differently, or used other colours/sizes.**
Fine. Use THEIR names from here on. Never make them redo cosmetics.

**They're clearly on a different screen than the step assumes.**
Don't repeat the instruction louder. Re-orient from what's actually visible, then give the
one next action from there.

# Objection playbook — what they say → how to answer

- **"Why not just use Smart Animate / the Prototype tab?"** Different tool: Smart Animate
  tweens between two prototype frames; Figma Motion animates one frame on a timeline with
  keyframes, and exports to GIF/code. For a single element popping, wiggling, or spinning,
  Motion is the right one.
- **"This is a lot of steps for a square."** The square is the excuse; keyframes, the
  playhead, and easing are the transferable parts — they're the same three ideas in every
  animation tool. Two more steps to the payoff.
- **"Can we skip to the fun part?"** Yes — jump to the easing step (A11) or hand them the
  chat bubble project, which reaches a finished animation fastest.
- **"Why 400 ms? Why not 2 seconds?"** Because functional motion should be quick enough to
  notice but not wait on. Bigger and further = longer; smaller and lighter = shorter. Offer
  to let them try 2000 and feel the difference — that comparison teaches more than the rule.
- **"Why is linear bad here but good for the spinner?"** Real objects accelerate and
  decelerate, so linear reads mechanical — except for things that loop forever, where any
  easing turns the loop into a pulse.
- **"Can I animate the colour / the text / this other property?"** If the field has a ◇
  diamond next to it, yes — same two-keyframe pattern.
- **"How do I get this into code?"** Dev Mode's Motion tab shows a read-only timeline and
  copyable CSS / React / JSON, and the Figma MCP server can hand the full animation context
  to a coding agent. Mention it, don't detour into it mid-lesson.
- **"I want it to loop."** The Playback control in the timeline cycles once / loop /
  ping-pong. On export there's a separate Loop toggle.
- **"Is my version different?"** Likely — it's open beta. Trust their screen over the recipe.

# Never do this

- Never dump multiple steps in one breath.
- Never say a screen position or direction in words — point instead.
- Never teach Smart Animate, prototype connections, triggers, or Present mode as part of this
  tutorial.
- Never claim something happened that you haven't seen in a fresh screenshot.
- Never invent a menu item. If a control isn't visible, say what you're looking for and ask
  them to scroll or widen the panel.
- Never leave auto-keyframe on at the end of a project.
