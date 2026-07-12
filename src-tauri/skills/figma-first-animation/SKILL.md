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
