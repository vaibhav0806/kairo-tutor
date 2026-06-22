# Clicky Borrowing Notes

Source repo: https://github.com/farzaa/clicky

License: MIT

Clicky inspired the original Kairo idea and is technically close to our early Mac product loop: screen capture, push-to-talk, AI response, TTS, and a cursor-style overlay. We should use it as a reference implementation, not as the full product architecture.

## What We Should Borrow

### Mac Native App Shape

Clicky is a macOS menu-bar app with no dock icon and no normal main window. This is a good fit for Kairo because the tutor should feel available from anywhere, not like a separate app the student has to manage.

Borrow:

- Menu-bar app pattern
- Floating panel for status/settings
- No dock icon
- AppKit bridging where SwiftUI alone is not enough

### Secure Provider Proxy

Clicky uses a Cloudflare Worker so API keys are never shipped in the app binary.

Borrow:

- Worker proxy pattern
- Server-side secrets
- Local worker dev flow
- Simple upstream routes

Adapt for Kairo:

- `/chat` should call OpenRouter
- `/tts` should call Sarvam Text to Speech
- `/stt-token` or `/stt` should support Sarvam Speech to Text

### ScreenCaptureKit Capture

Clicky has useful ScreenCaptureKit handling for multi-monitor capture.

Borrow:

- Capture all screens
- Label the screen containing the cursor as primary focus
- Exclude the app's own windows from screenshots
- Downscale screenshots before sending to the model
- Track both screenshot pixel size and display point size
- Preserve display frame metadata for coordinate mapping

### Transparent Overlay Window

Clicky creates a click-through transparent `NSWindow` per screen.

Borrow:

- Always-on-top transparent overlay
- `ignoresMouseEvents = true`
- Join all Spaces
- One overlay per screen
- Coordinate mapping between screenshot pixels and AppKit screen points

Adapt for Kairo:

- Add highlight boxes
- Add arrows
- Add underlines
- Add spotlight/dim layer
- Keep the ghost cursor, but do not control the user's real mouse

### Global Push-To-Talk

Clicky uses a listen-only `CGEvent` tap to detect global shortcut press/release.

Borrow:

- Press/release shortcut lifecycle
- Listen-only event tap
- Shortcut state publisher

Adapt for Kairo:

- Default shortcut should avoid macOS VoiceOver conflicts.
- Preferred default: `Command + Shift + Space`.
- User-configurable shortcut later.

### Pointing Protocol

Clicky asks the model to append tags like:

```text
[POINT:x,y:label:screenN]
```

Borrow the idea:

- Model response includes explicit visual target data.
- Overlay parses target data.
- Cursor/highlight moves to the target.

Improve for Kairo:

Use structured output instead of text tags:

```json
{
  "spokenText": "Click the cube in the viewport.",
  "visualTargets": [
    {
      "type": "highlight_box",
      "label": "Default cube",
      "screen": 1,
      "x": 612,
      "y": 388,
      "width": 80,
      "height": 80,
      "confidence": 0.86
    }
  ],
  "expectedNextState": "cube_selected"
}
```

### Interaction State Machine

Clicky's loop is roughly:

```text
idle -> listening -> processing -> responding
```

Borrow this as the base UI state machine.

Adapt for Kairo:

```text
idle
  -> listening
  -> capturing_screen
  -> planning_step
  -> speaking_and_pointing
  -> waiting_for_user_action
  -> checking_screen_state
  -> correcting_or_continuing
```

## What We Should Not Copy Blindly

### Do Not Copy The Mega Manager Shape

Clicky's `CompanionManager` owns too much: dictation, shortcut monitoring, screen capture, AI calls, TTS, overlay state, onboarding, analytics, and conversation state.

Kairo should split responsibilities:

- `ShortcutService`
- `PermissionService`
- `ScreenCaptureService`
- `OverlayService`
- `AnnotationService`
- `VoiceInputService`
- `VoiceOutputService`
- `TutorOrchestrator`
- `SkillPackLoader`
- `SessionStateMachine`

### Do Not Keep General Buddy Prompting As The Core

Clicky is a general screen buddy. Kairo is a software-skills tutor.

Kairo must prioritize:

- Software-specific skill packs
- Guided workflows
- Troubleshooting states
- Beginner-safe explanations
- One instruction at a time
- Screen-state verification

### Do Not Use The Same Providers

Clicky uses:

- Anthropic
- AssemblyAI
- ElevenLabs

Kairo currently uses:

- OpenRouter for model routing
- Sarvam for speech-to-text and text-to-speech

### Do Not Add Autonomous Control Early

Clicky points. Kairo should preserve this principle:

```text
The AI points. The user acts.
```

Do not add autonomous clicking in the MVP.

## Milestone Mapping

### Milestone 2: Mac Native Capture And Permissions

Reference Clicky files:

- `leanring-buddy/CompanionScreenCaptureUtility.swift`
- `leanring-buddy/WindowPositionManager.swift`
- `leanring-buddy/GlobalPushToTalkShortcutMonitor.swift`
- `leanring-buddy/MenuBarPanelManager.swift`

Kairo work:

- Add native Mac shell
- Add permission onboarding
- Add global shortcut
- Add active app/window metadata
- Add screenshot capture

### Milestone 3: Overlay And Annotation Layer

Reference Clicky files:

- `leanring-buddy/OverlayWindow.swift`
- `leanring-buddy/CompanionResponseOverlay.swift`

Kairo work:

- Add ghost cursor
- Add highlight boxes
- Add arrows
- Add underlines
- Add annotation drawing layer
- Add coordinate normalization

### Milestone 4: Real AI Orchestrator

Reference Clicky files:

- `leanring-buddy/ClaudeAPI.swift`
- `worker/src/index.ts`

Kairo work:

- Replace Anthropic-specific logic with OpenRouter
- Replace ElevenLabs/AssemblyAI with Sarvam
- Keep responses structured
- Enforce one-step tutoring output
- Feed skill-pack context into the model

## Attribution Note

If we port code directly from Clicky, preserve the MIT license and add attribution in the relevant source file or docs.

Recommended attribution:

```text
This implementation was adapted from farzaa/clicky, licensed under MIT:
https://github.com/farzaa/clicky
```

## Decision

Use Clicky as a reference for native Mac implementation patterns, especially screen capture, global shortcut, overlay windows, and provider proxying.

Do not clone Clicky's architecture wholesale. Kairo's durable product value should come from skill packs, tutoring workflows, screen-state verification, Indian-language voice, and institute-facing learning analytics.
