# AI Screen Tutor — Product Feature List & MVP PRD

**Version:** 0.1  
**Platform focus:** Mac first, Windows next  
**Primary market:** India-first software-skills education  
**Product type:** Screen-native AI tutor / AI lab assistant for complex software

---

## 1. Product concept

The product is an **AI-powered desktop tutor** for students learning complex creative, technical, and professional software.

The user activates the tutor with a global shortcut, speaks their problem naturally, and the AI:

1. Listens to the user.
2. Sees the current screen.
3. Understands which software is open.
4. Understands visible UI elements, buttons, panels, menus, errors, and current workflow state.
5. Talks back through voice.
6. Points, highlights, underlines, and draws boxes around relevant screen areas.
7. Guides the user step by step until the task is complete or the problem is solved.

The desired experience is:

> The user feels like a personal tutor is sitting beside them, watching their screen, understanding where they are stuck, and showing them exactly what to do next.

Example user query:

> “Help me make my first animation in Blender.”

The AI should respond by guiding the user visually and verbally:

> “I can see Blender is open. First, select the cube in the center. I’m highlighting it now.”

The product should **guide the user**, not simply answer with text.

---

## 2. Core product promise

The product promise is:

> **The AI does not just answer. It shows.**

This is the key difference from normal chatbots, tutorials, LMS videos, and generic help pages.

The product should be optimized around small, progressive learning loops:

```text
User presses shortcut
    ↓
User speaks or draws on screen
    ↓
AI captures current screen
    ↓
AI detects app and loads relevant skill pack
    ↓
AI understands the current screen state
    ↓
AI gives one next step through voice
    ↓
AI highlights or points to the exact screen region
    ↓
User performs the action
    ↓
AI checks the new screen state
    ↓
AI continues or corrects
```

The product should feel like:

> “Look here. Click this. Now do this. I’ll check your screen and guide the next step.”

---

## 3. Target users

### 3.1 Primary early users

The best initial users are students in:

- Design institutes
- Animation institutes
- VFX institutes
- Video-editing institutes
- Gaming/3D training programs
- CAD training centers
- Computer training centers
- Tally/accounting training centers
- Colleges with practical software labs

### 3.2 Secondary users

- K-12 private school students
- Higher-secondary vocational students
- Coding bootcamp students
- Online course learners
- Corporate employees learning software tools
- Individual creators and freelancers

### 3.3 Best first wedge

The strongest first wedge is:

> **AI lab assistant for creative software institutes.**

Recommended first software focus:

1. Blender
2. Photoshop
3. Premiere Pro
4. After Effects

The first MVP should probably focus on **Blender** or **Blender + Photoshop**, because these tools are highly visual, beginner-frustrating, and easy to demonstrate.

---

## 4. Supported software categories

The long-term product can support many software categories, but early development should be narrow.

### 4.1 Creative design

- Photoshop
- Illustrator
- Canva
- Figma

### 4.2 Video and motion

- Premiere Pro
- After Effects
- DaVinci Resolve
- CapCut
- Adobe Animate

### 4.3 3D, animation, and gaming

- Blender
- Maya-like workflows
- Unity
- Unreal Engine

### 4.4 CAD and architecture

- AutoCAD
- Fusion
- Revit-like tools
- SketchUp

### 4.5 Business and accounting

- TallyPrime
- Excel
- Google Sheets
- GST/accounting tools

### 4.6 Coding and technical tools

- VS Code
- PyCharm
- Jupyter
- GitHub
- Terminal
- Web development stacks
- Python, JavaScript, Java, C/C++, SQL

---

## 5. Product modes

The product should have two primary modes.

---

### 5.1 Mode A: “I’m stuck”

This is the highest-frequency use case.

The user asks a specific question about their current screen.

Examples:

- “Why is my Blender object not moving?”
- “Why is my Photoshop layer locked?”
- “Why is my render black?”
- “Where is the timeline?”
- “Why is my Python package not importing?”
- “What is this error?”
- “Why can’t I select this object?”
- “How do I export this video?”

The AI should:

1. Read the screen.
2. Understand the visible problem.
3. Diagnose the likely cause.
4. Highlight the relevant area.
5. Explain one fix at a time.
6. Check whether the fix worked.

---

### 5.2 Mode B: “Teach me a task”

This is best for demos and structured learning.

The user asks for a guided session.

Examples:

- “Help me make my first animation in Blender.”
- “Teach me how to remove a background in Photoshop.”
- “Help me create a simple logo in Illustrator.”
- “Teach me how to edit my first video in Premiere Pro.”
- “Help me make a basic UI screen in Figma.”
- “Teach me how to create a ledger in Tally.”
- “Help me write my first Python program.”

The AI should break the task into steps and guide the user progressively.

---

## 6. P0 feature list

These are the must-have features for the first serious MVP.

---

### 6.1 Global shortcut activation

The user should be able to activate the tutor from anywhere on the computer.

Example flow:

```text
User presses shortcut
    ↓
Screen overlay appears
    ↓
Microphone opens
    ↓
User speaks
    ↓
AI analyzes screen and responds
```

Suggested Mac shortcut options:

- `Command + Shift + Space`
- `Option + Space`
- Customizable shortcut

Avoid using `Control + Option` as the default shortcut on Mac because it may conflict with the default VoiceOver modifier.

---

### 6.2 Permission onboarding

On first launch, the app should request permissions clearly and explain why each one is needed.

| Permission | Why needed |
|---|---|
| Screen Recording | To see the active screen or app window |
| Microphone | To hear the user’s spoken question |
| Accessibility | To detect UI elements and support overlays/control later |
| Optional system audio | Useful for video, media, or software-audio debugging |
| Optional camera | Not needed for MVP |

The app should always show a clear status indicator when screen access is active.

Example:

> “AI tutor is viewing your screen.”

---

### 6.3 Instant voice recognition

After the shortcut is pressed, voice recognition should begin immediately.

The user should be able to speak naturally:

> “Help me make my first animation in Blender.”

> “Why is this layer not working?”

> “I circled the thing I don’t understand.”

Voice input requirements:

| Feature | Priority |
|---|---|
| Push-to-talk after shortcut | P0 |
| Streaming transcription | P0 |
| English support | P0 |
| Hinglish support | P1 |
| Hindi support | P1 |
| Indian-language support | P1/P2 |
| Domain vocabulary | P1 |
| Barge-in / interrupt | P1 |

Candidate providers:

- Sarvam AI for Indian-language speech recognition and speech output
- ElevenLabs for high-quality global speech recognition and text-to-speech
- Native/local models later if cost or latency becomes a problem

---

### 6.4 Screen understanding

The AI must understand what is on the screen.

It should detect:

- Active application
- Window title
- Visible UI panels
- Buttons
- Menus
- Toolbars
- Dropdowns
- Error messages
- Selected objects or layers where possible
- Timeline/current frame where possible
- Current document/project context where safe
- User annotations on the screen

The system should combine:

| Method | Purpose |
|---|---|
| Screenshot vision model | Understand visual UI and layout |
| OCR | Read visible text, errors, labels, menus |
| Accessibility/UI tree | Extract structured UI information when available |
| App-specific skill pack | Interpret software-specific state and workflows |

The product should not rely only on accessibility APIs, because many creative tools use complex custom UI components. Vision + OCR + skill packs are essential.

---

### 6.5 Active app detection

The system should automatically identify the software being used.

Examples:

```yaml
active_app: Blender
window_title: "Blender"
detected_version: "unknown"
loaded_skill: "blender"
```

```yaml
active_app: Photoshop
window_title: "Untitled-1 @ 100%"
loaded_skill: "photoshop"
```

Skill loading should happen through:

1. The active app on screen.
2. The user mentioning a software name.
3. The user asking a task associated with a specific software category.

Example:

> User says: “Help me make my first animation.”

If Blender is open, load the Blender skill pack.

---

### 6.6 Visual overlay layer

This is one of the most important parts of the product.

The AI should be able to draw on top of the user’s screen using an overlay.

Required overlay features:

| Feature | Priority |
|---|---|
| Highlight box | P0 |
| AI ghost cursor / pointer | P0 |
| Arrow | P0 |
| Underline | P0 |
| Spotlight/dim background | P1 |
| Step instruction card | P1 |
| Progress indicator | P1 |

The overlay should not permanently modify the user’s screen or file. It should sit above the app visually.

---

### 6.7 AI ghost cursor

Instead of controlling the user’s actual mouse in the MVP, create an AI pointer or ghost cursor.

The AI can say:

> “Look where my pointer is.”

Then the ghost cursor moves to the relevant button, menu, panel, object, or timeline.

This is safer than autonomous clicking and better for learning.

Recommended MVP principle:

> The AI points. The user clicks.

---

### 6.8 Accurate highlighting and pointing

The AI should be able to highlight UI elements accurately.

Examples:

- Timeline in Blender
- Layers panel in Photoshop
- Export button in Premiere Pro
- Terminal error in VS Code
- Ledger creation button in Tally
- Formula cell in Excel
- Auto-layout panel in Figma
- Object Mode dropdown in Blender

The coordinate system should account for:

- Retina scaling
- Multiple monitors
- Different resolutions
- Window resizing
- Full-screen apps
- Dark/light themes
- Software version differences
- Hidden panels
- Custom UI components

Internal coordinate object example:

```yaml
screen_resolution: 3024x1964
scale_factor: 2.0
active_window_bounds:
  x: 120
  y: 80
  width: 2200
  height: 1400
target_element:
  label: "Object Mode dropdown"
  bounding_box:
    x: 240
    y: 132
    width: 110
    height: 32
confidence: 0.87
```

---

### 6.9 User annotation input

The user should be able to draw, circle, underline, or highlight anything on the screen to show the AI what they mean.

Example user actions:

- Circle a button
- Draw an arrow to a panel
- Highlight a confusing error
- Underline a menu item
- Draw a rectangle around an object

Example user queries:

> “What is this?”

> “Why is this not working?”

> “I circled the thing I don’t understand.”

> “How do I fix the part I highlighted?”

This is important because beginner questions are often vague. Annotation gives the AI spatial context.

Internal annotation object:

```yaml
annotation_type: circle
screen_region:
  x: 850
  y: 420
  width: 300
  height: 180
nearby_text:
  - "Render Engine"
  - "Eevee"
  - "Cycles"
user_question: "What should I select here?"
active_app: Blender
```

Annotation features:

| Feature | Priority |
|---|---|
| Draw circle | P0 |
| Draw rectangle | P0 |
| Highlight area | P0 |
| Underline | P0 |
| Erase annotation | P0 |
| Attach annotation to voice query | P0 |
| AI refers to annotation in response | P0 |
| Multi-annotation | P1 |
| Save annotation to lesson history | P2 |
| Teacher can see annotations | P2 |

---

### 6.10 AI voice output

The AI should talk back to the user in a natural teaching voice.

Example:

> “Great. I can see Blender is open. We’ll animate the cube. First, click the cube in the center. I’m highlighting it now.”

Voice output requirements:

| Feature | Priority |
|---|---|
| Low-latency TTS | P0 |
| Friendly teaching tone | P0 |
| Short step-by-step responses | P0 |
| Adjustable speed | P1 |
| Indian English voice | P1 |
| Hindi/Hinglish voice | P1 |
| Regional language voices | P2 |

The AI should avoid long lectures. It should speak in short, actionable chunks.

Bad:

> “Animation is the process of changing properties over time, and Blender supports many different animation systems...”

Good:

> “First, select the cube. I’m highlighting it now.”

Then wait for the user.

---

### 6.11 Step-by-step tutoring loop

The AI should not give a complete ten-step answer immediately.

It should guide progressively:

1. Give one instruction.
2. Highlight the relevant area.
3. Wait for user action.
4. Capture/check screen.
5. Confirm success or correct mistake.
6. Continue.

Example:

```text
AI: Click the cube in the center. I’m highlighting it.
User clicks.
AI checks screen.
AI: Good. Now go to frame 1 in the timeline. I’m pointing to it.
User clicks wrong area.
AI: Not there. Look at the highlighted timeline at the bottom.
```

---

### 6.12 Guided learning sessions

The AI should support structured guided sessions for selected beginner workflows.

Example guided session:

> “Make your first animation in Blender.”

Possible steps:

1. Open Blender.
2. Understand the viewport.
3. Select the cube.
4. Move to frame 1.
5. Insert first keyframe.
6. Move to frame 40.
7. Move the cube.
8. Insert second keyframe.
9. Press play.
10. Adjust timing.
11. Save/export.

Each step should include:

- Voice instruction
- Visual highlight
- User action
- Screen check
- Correction if wrong
- Continue to next step

Guided session features:

| Feature | Priority |
|---|---|
| Beginner lessons | P0 |
| Step-by-step mode | P0 |
| Check screen after each step | P0 |
| “I’m stuck” inside lesson | P0 |
| Resume session | P1 |
| Progress tracking | P1 |
| Quiz/checkpoint | P1 |
| Teacher-assigned lesson | P2 |

---

## 7. P1 feature list

These features should come after the first product loop works.

---

### 7.1 Hindi, Hinglish, and Indian-language support

For India-first adoption, language support matters.

Priority order:

1. English
2. Hinglish
3. Hindi
4. Tamil / Telugu / Bengali / Marathi / Kannada / Malayalam / Gujarati / Punjabi / Urdu depending market
5. More Indian languages over time

Language support should include:

- STT
- TTS
- UI/tutorial explanations
- Software-specific vocabulary
- Mixed-language queries

Example:

> “Blender mein keyframe kaise add karun?”

The AI should respond naturally:

> “Pehle cube select karo. Main cube ko highlight kar raha hoon. Ab keyboard par `I` press karo, phir `Location` choose karo.”

---

### 7.2 Web research mode

The product should be able to search the web when necessary, but not for every query.

Use web search when:

- The software version is new.
- The local skill pack does not know the answer.
- The user asks about a specific error.
- The app UI has changed.
- The user asks for updated documentation.
- The task depends on a plugin/library/package.
- The user asks for current best practices.

Preferred source priority:

1. Official software documentation
2. Official forums/help centers
3. Trusted tutorials
4. Stack Overflow / GitHub issues for coding
5. Community forums
6. General web only if needed

Research Mode UX:

> “This looks like a version-specific Blender issue. I’ll check the latest documentation.”

Important guardrails:

- Do not browse unnecessarily during fast tutoring.
- Prefer official sources.
- Show when web search is happening.
- Save useful findings into the skill system for future improvement.
- Give a confidence level when relying on community answers.

---

### 7.3 Teacher dashboard

For B2B adoption, the product should help teachers and institutes, not just students.

A teacher dashboard should show:

| Metric | Example |
|---|---|
| Students stuck right now | 12 students asked for help in the last 10 minutes |
| Common issue | “Could not find timeline” |
| Students needing human help | 3 escalated questions |
| Assignment progress | 70% completed step 4 |
| AI answer confidence | 82% resolved without escalation |
| Repeated confusion | “Keyframes” concept unclear |

Teacher dashboard benefits:

- Reduces repetitive doubts
- Helps teacher identify confused students
- Shows where the class is struggling
- Creates measurable ROI for institutes
- Makes teachers feel supported, not replaced

---

### 7.4 Escalate to teacher

If the AI is unsure, it should escalate.

Example:

> “I’m not fully confident about this. I’m sending this to your teacher.”

Escalation triggers:

- Low confidence
- Repeated failed step
- Potential file loss
- Dangerous or irreversible action
- Student asks for evaluation or judgment
- AI cannot identify the screen state
- Student is stuck for too long

---

### 7.5 Classroom/admin controls

Institutions should be able to configure:

- Which apps are supported
- Which lessons are unlocked
- Whether web search is allowed
- Whether screenshots are stored
- Whether voice is enabled
- Whether students can use free-form AI help
- Whether AI should give hints only
- Whether the AI can suggest shortcuts
- Whether teacher escalation is required for some actions

---

### 7.6 Assignment-aware tutoring

Teachers should be able to upload or create:

- Assignment instructions
- Course outline
- Lesson plan
- Rubric
- Example project files
- Allowed tools
- Disallowed shortcuts
- Expected output

The AI should then guide within that assignment context.

Example:

> “In this assignment, students must animate the cube manually. Do not generate a finished animation for them. Give hints only.”

---

### 7.7 Session history

The user should be able to review:

- What they asked
- What the AI suggested
- Which steps they completed
- Where they got stuck
- Screenshots or annotations, if saved with consent

For privacy, session history should be configurable and deleteable.

---

## 8. P2/P3 feature list

These are later-stage features.

---

### 8.1 Autonomous clicking and control

The AI could eventually click, type, or perform actions for the user.

However, this should **not** be in the MVP.

Reason:

- It is riskier.
- It may reduce learning.
- It can cause wrong actions.
- It creates privacy and security concerns.
- It increases technical complexity.
- It may feel invasive.

Recommended principle for learning:

> The AI points. The user acts.

Possible future safe use cases:

- Open a menu only after confirmation
- Move a cursor to show where to click
- Fill harmless demo fields
- Set up a practice environment
- Open documentation
- Create a new blank file
- Navigate inside a guided lesson

Actions requiring confirmation:

- Delete
- Overwrite
- Export
- Submit
- Install
- Share
- Send
- Run destructive command
- Purchase
- Upload

---

### 8.2 Skill pack marketplace

Later, the product could support third-party skill packs.

Possible creators:

- Teachers
- Institutes
- Software experts
- Course creators
- Companies
- Open-source contributors

Marketplace categories:

- Blender beginner animation
- Photoshop retouching
- Figma UI design
- AutoCAD basics
- Excel for finance
- Tally GST accounting
- Python beginner coding
- Premiere Pro editing

This is a platform opportunity, but should not be built early.

---

### 8.3 Edtech API/SDK

Later, edtech companies could integrate the AI tutor into their courses.

Possible API features:

- Launch tutor inside course
- Pass lesson context
- Track learner stuck points
- Send completion data back to LMS
- White-label tutor
- Course-specific skill packs

This is promising, but not MVP-first.

---

### 8.4 Corporate training mode

Corporate users may need:

- SSO
- Admin dashboard
- Compliance
- Data retention policy
- App allowlist
- No training on company data
- Audit logs
- Enterprise support
- Software-specific internal workflow packs

This should come after the core product is reliable.

---

## 9. Skill pack system

The `skill.md` idea is central to the product.

However, instead of one file, each software should have a full **skill pack**.

Recommended structure:

```text
skills/
  blender/
    skill.md
    ui_landmarks.json
    workflows.yaml
    troubleshooting.yaml
    glossary.yaml
    version_notes.md
    safety_rules.yaml
    screenshots/
    tests/
  photoshop/
    skill.md
    ui_landmarks.json
    workflows.yaml
    troubleshooting.yaml
    glossary.yaml
    version_notes.md
    safety_rules.yaml
    screenshots/
    tests/
  figma/
  autocad/
  tally/
  vscode/
```

---

### 9.1 `skill.md`

This is the core instruction file for the software.

Example:

```markdown
# Blender Skill

## Supported versions
- Blender 4.0
- Blender 4.1
- Blender 4.2
- Blender 4.3

## App identifiers
- org.blenderfoundation.blender

## Teaching style
- Give one action at a time.
- Prefer visual pointing over long explanation.
- Do not explain advanced concepts unless the user asks.
- For beginners, name the panel before asking them to click.
- Ask the user to perform actions instead of doing it for them.

## Common beginner goals
- Make first animation
- Move/scale/rotate object
- Add material
- Add light
- Render image
- Export video

## Common stuck states
- User is in Object Mode but needs Edit Mode.
- Timeline is hidden.
- Object is not selected.
- Camera is not positioned.
- Render is black.
- Keyframes are not inserted.
- User cannot see object because viewport is zoomed out.

## UI landmarks
- Viewport
- Timeline
- Outliner
- Properties panel
- Object Mode dropdown
- Transform toolbar

## Safe actions
- Highlight
- Point
- Explain
- Ask user to click
- Suggest keyboard shortcuts

## Unsafe actions
- Do not delete objects without confirmation.
- Do not overwrite files.
- Do not install plugins without confirmation.
- Do not submit or upload anything without confirmation.
```

---

### 9.2 `ui_landmarks.json`

This file helps the AI identify common visual regions in the software.

Example:

```json
{
  "timeline": {
    "description": "Horizontal animation timeline usually at the bottom of Blender interface",
    "common_location": "bottom",
    "visual_clues": ["frame numbers", "play button", "timeline scrubber"]
  },
  "outliner": {
    "description": "Scene hierarchy panel",
    "common_location": "top right",
    "visual_clues": ["Scene Collection", "Camera", "Cube", "Light"]
  },
  "properties_panel": {
    "description": "Panel for object, material, render, and scene settings",
    "common_location": "right",
    "visual_clues": ["tabs", "icons", "render properties", "object properties"]
  }
}
```

---

### 9.3 `workflows.yaml`

This file defines guided lessons.

Example:

```yaml
first_blender_animation:
  title: "Make your first animation in Blender"
  difficulty: beginner
  estimated_time_minutes: 15
  steps:
    - id: select_cube
      goal: "Select the cube"
      instruction: "Click the cube in the viewport."
      expected_screen_state: "cube_selected"
      highlight_target: "default_cube"

    - id: go_to_frame_1
      goal: "Move to frame 1"
      instruction: "Click frame 1 in the timeline."
      expected_screen_state: "frame_1_active"
      highlight_target: "timeline_frame_1"

    - id: insert_first_keyframe
      goal: "Insert first keyframe"
      instruction: "Press I and choose Location."
      expected_screen_state: "location_keyframe_inserted"
      highlight_target: "keyframe_menu_location"
```

---

### 9.4 `troubleshooting.yaml`

This file helps answer “I’m stuck” problems.

Example:

```yaml
render_is_black:
  symptoms:
    - "render output is black"
    - "nothing visible after render"
    - "my render is blank"
  check:
    - "Is there a light?"
    - "Is the camera pointing at the object?"
    - "Is the object hidden?"
    - "Is the render engine configured?"
    - "Is the camera clipping range correct?"
  response_style:
    - "Check one cause at a time."
    - "Start with light and camera."
    - "Use visual highlights for the camera and light."
```

---

### 9.5 `glossary.yaml`

This file explains concepts in beginner-friendly language and local languages.

Example:

```yaml
keyframe:
  simple_explanation: "A saved position or setting at a specific point in time."
  hindi_explanation: "Keyframe matlab kisi object ki position ya setting ko ek specific time par save karna."
  example: "If the cube is at the left on frame 1 and at the right on frame 40, Blender animates the movement between those frames."

viewport:
  simple_explanation: "The main area where you see and edit your 3D scene."
  hindi_explanation: "Viewport woh main area hai jahan aap apna 3D scene dekhte aur edit karte ho."
```

---

### 9.6 `version_notes.md`

This file tracks UI differences across software versions.

Example:

```markdown
# Blender Version Notes

## Blender 4.0
- Timeline layout similar to 3.x.
- Some menus moved in animation workspace.

## Blender 4.1
- Minor UI updates.
- Confirm exact location of keyframe menu.

## Blender 4.2
- Check rendering engine defaults.
- Update screenshots for properties panel.
```

---

### 9.7 `safety_rules.yaml`

This file defines what the AI should not do.

Example:

```yaml
requires_confirmation:
  - delete_object
  - overwrite_file
  - install_plugin
  - run_script
  - submit_assignment
  - export_final_file
  - upload_file
  - share_screen_recording

forbidden:
  - bypass_license
  - crack_software
  - cheat_on_exam
  - submit_work_as_student_without_learning
```

---

### 9.8 Skill auto-loading

Skill packs should load automatically.

Load triggers:

| Trigger | Example |
|---|---|
| Active app detection | Blender is the active window |
| User mention | “Help me with Blender” |
| Task inference | “I want to edit a video” |
| Teacher assignment | Current class is a Photoshop assignment |

Example:

```yaml
input:
  active_app: Blender
  user_query: "Help me make my first animation"
  screen_state: default_blender_scene

loaded_skills:
  - blender.core
  - blender.animation_beginner
  - general_tutoring
  - voice_hinglish
```

---

## 10. Product architecture

High-level architecture:

```text
Desktop Client
  ├── Global Shortcut Manager
  ├── Screen Capture Service
  ├── Microphone / Audio Service
  ├── Active App Detector
  ├── Accessibility / UI Tree Reader
  ├── User Annotation Layer
  ├── Visual Overlay Renderer
  ├── Local Privacy Controller
  └── Session Manager

AI Orchestrator
  ├── Speech-to-Text
  ├── Screen Understanding Model
  ├── OCR / UI Parser
  ├── Skill Loader
  ├── Tutor Planner
  ├── Step-by-Step Dialogue Manager
  ├── Web Research Mode
  ├── Safety / Confidence Checker
  └── Text-to-Speech

Skill System
  ├── skill.md
  ├── workflows.yaml
  ├── troubleshooting.yaml
  ├── ui_landmarks.json
  ├── glossary.yaml
  ├── version_notes.md
  └── evaluation_tests/

Institution Layer
  ├── Teacher Dashboard
  ├── Student Analytics
  ├── Assignment Context
  ├── Admin Controls
  └── Privacy / Consent Management
```

---

## 11. Mac-first implementation plan

### 11.1 Mac client modules

| Module | Purpose |
|---|---|
| Global hotkey listener | Start the tutor from any app |
| Screen capture | Capture active screen/window |
| App/window detector | Know whether user is in Blender, Photoshop, etc. |
| Accessibility reader | Extract UI element metadata where available |
| Overlay renderer | Draw highlights, cursor, arrows, boxes |
| Annotation layer | Let user draw/circle/highlight |
| Audio recorder | Capture user voice |
| TTS playback | Speak back |
| Session controller | Manage ask mode, guided mode, stop/pause |
| Privacy module | Show indicator, block sensitive apps, delete data |

### 11.2 Mac technology options

| Layer | Possible option |
|---|---|
| Native shell | Swift / SwiftUI / AppKit |
| Faster cross-platform build | Tauri or Electron with native Mac modules |
| Screen capture | ScreenCaptureKit |
| UI metadata | macOS Accessibility API |
| Overlay | Transparent always-on-top window |
| Audio input | AVFoundation / AVAudioEngine |
| Backend | Python/FastAPI or Node |
| AI orchestration | Model router + skill loader + tool planner |

Recommended direction:

> Native Swift/AppKit shell + cloud AI backend

or:

> Tauri frontend + native Swift modules

Electron may be faster for iteration, but native overlay/screen-permission handling may feel cleaner in Swift.

---

## 12. Windows implementation later

Windows matters for India scale because many schools, institutes, and labs use Windows machines.

The same product architecture can carry over, but the OS layer changes.

| Mac layer | Windows equivalent |
|---|---|
| ScreenCaptureKit | Windows Graphics Capture |
| macOS Accessibility API | Microsoft UI Automation |
| AppKit overlay window | WinUI/WPF/Direct2D overlay |
| AVFoundation audio | WASAPI |
| Global hotkey | Win32 global hotkey |
| App detection | Win32 process/window APIs |

Recommended approach:

1. Prove product loop on Mac.
2. Build institute pilots.
3. Start Windows client once usage and willingness to pay are validated.
4. Prioritize Windows before large India deployment.

---

## 13. MVP scope

### 13.1 MVP goal

The MVP should prove:

> Students learning one complex software use the tutor repeatedly, and teachers feel it reduces repetitive support load.

### 13.2 MVP software focus

Pick one of these:

| Option | Pros | Cons |
|---|---|---|
| Blender MVP | Free software, visual, great demo, strong beginner pain | Smaller paid software-training market than Photoshop |
| Photoshop MVP | Large demand, common in institutes | Adobe version differences and licensing issues |
| VS Code MVP | Easier text/error parsing | Very crowded with coding AI tools |
| Figma MVP | Strong UI/design use case | Built-in AI and simpler UI reduce need |
| AutoCAD MVP | High willingness to pay | Harder UI, more professional stakes |

Recommendation:

> Start with **Blender** or **Blender + Photoshop**.

### 13.3 MVP features

| Feature | Include in MVP? |
|---|---|
| Mac app | Yes |
| Global shortcut | Yes |
| Voice input | Yes |
| Screenshot analysis | Yes |
| Active app detection | Yes |
| Screen highlight/box/arrow | Yes |
| AI ghost cursor | Yes |
| AI voice response | Yes |
| User draw/circle annotation | Yes |
| Step-by-step guided lesson | Yes |
| One software skill pack | Yes |
| Limited web research mode | Yes, limited |
| Basic teacher dashboard | Optional P1 |
| Autonomous clicking | No |
| Full LMS | No |
| 10 software tools | No |
| Continuous screen recording | No |
| Full multilingual support | No, but design for it |

---

## 14. Roadmap

### V0 — Prototype

Goal:

> Create an impressive working demo.

Features:

- Mac app
- Shortcut activation
- Capture screenshot
- User asks by voice or text
- AI analyzes screenshot
- AI responds with text and voice
- Draws highlight box on screen
- AI ghost cursor points to target area
- One guided Blender lesson

Demo:

> “Help me make my first animation in Blender.”

---

### V1 — Pilot-ready product

Goal:

> Use inside one real training institute.

Features:

- Reliable overlay cursor
- Draw/circle user annotation
- Step-by-step tutoring loop
- Blender or Photoshop skill pack
- Basic Hindi/Hinglish support
- Session history
- Privacy controls
- Teacher view of common stuck points
- Paid pilot readiness

---

### V2 — Institution product

Goal:

> Sell to institutes and colleges.

Features:

- Multi-student dashboard
- Class/batch management
- Assignment-aware tutoring
- Admin controls
- Multiple software skill packs
- Web research mode
- Escalation to teacher
- Analytics and ROI reporting
- Windows beta

---

### V3 — Platform

Goal:

> Become a software-learning layer.

Features:

- Skill pack marketplace
- Teacher-authored skill packs
- Edtech API/SDK
- Corporate training mode
- Windows full release
- Local-language tutor
- Offline/lightweight mode
- Advanced progress tracking
- Assessment and certification

---

## 15. Prioritized feature table

| Feature | Priority | Why |
|---|---|---|
| Shortcut activation | P0 | Core entry point |
| Voice input | P0 | Natural interaction |
| Screen capture | P0 | Core product |
| Active app detection | P0 | Needed for correct skill |
| Screen understanding | P0 | Core intelligence |
| Visual highlight boxes | P0 | Main differentiation |
| AI ghost cursor | P0 | Makes guidance feel real |
| Voice response | P0 | Tutor-like experience |
| User annotation | P0 | Solves vague “this thing” questions |
| Guided lessons | P0 | Great demo and structured learning |
| Skill pack system | P0 | Core moat |
| Privacy indicator | P0 | Trust requirement |
| Stop/pause/delete session | P0 | Trust requirement |
| Teacher dashboard | P1 | Needed for B2B |
| Hindi/Hinglish | P1 | India advantage |
| Web research mode | P1 | Keeps knowledge updated |
| Windows app | P1/P2 | India scale requirement |
| Autonomous clicking | P2 | Useful but risky |
| LMS/course library | P3 | Avoid early |
| Marketplace | P3 | Later platform play |

---

## 16. UX examples

### 16.1 Blender guided lesson

User opens Blender and presses shortcut.

User says:

> “Help me make my first animation.”

AI says:

> “I can see Blender is open. We’ll animate the cube. First, click the cube in the center. I’m highlighting it.”

AI highlights the cube.

User clicks it.

AI says:

> “Good. Now look at the timeline at the bottom. I’m pointing to frame 1. Click frame 1.”

AI ghost cursor points to the timeline.

User clicks.

AI says:

> “Now press `I` on your keyboard and choose `Location`. This saves the cube’s starting position.”

User does something wrong.

AI says:

> “Looks like the keyframe was not added. Try again: press `I`, then click `Location`. I’m highlighting the menu item.”

---

### 16.2 Photoshop stuck state

User presses shortcut.

User says:

> “Why can’t I edit this image?”

AI analyzes screen.

AI says:

> “I can see the layer is locked. Look at the Layers panel on the right. I’m highlighting the lock icon. Click the lock once to unlock the layer.”

User clicks.

AI checks screen.

AI says:

> “Great. The layer is unlocked now. You can edit it.”

---

### 16.3 User annotation

User draws a circle around a confusing panel in Blender.

User says:

> “What is this?”

AI says:

> “You circled the Properties panel. This is where Blender shows settings for the selected object, material, render, and scene. Right now, you’re looking at object settings.”

---

### 16.4 VS Code error

User presses shortcut.

User says:

> “What is this error?”

AI reads terminal.

AI says:

> “The error says Python cannot find the `numpy` package. I’m highlighting the exact line. Open the terminal and run `pip install numpy`. If you are using a virtual environment, make sure it is activated first.”

---

## 17. Privacy and trust requirements

Because the product uses screen and audio permissions, privacy must be a core product feature.

### 17.1 Core privacy principles

- Screen is captured only when the user activates the tutor.
- No continuous screen recording by default.
- Always show when the AI is viewing the screen.
- Allow the user to pause or stop at any time.
- Allow session deletion.
- Give institutions clear admin controls.
- Avoid storing screenshots unless needed and consented.
- Blur or block sensitive apps where possible.
- Do not capture passwords, banking, personal chats, or private documents.
- For minors, require strict consent and school/parent controls.

### 17.2 Sensitive app handling

The app should detect or allow users to block:

- Banking apps/websites
- Password managers
- Personal messaging apps
- Email
- Government ID portals
- Payment apps
- Health records
- Private photo libraries

If a sensitive app is active, the tutor should say:

> “Screen tutoring is paused because this may contain sensitive information.”

---

## 18. Accuracy and safety principles

The AI should not overclaim confidence.

### 18.1 Confidence levels

Possible internal confidence states:

| Confidence | Behavior |
|---|---|
| High | Guide normally |
| Medium | Guide with careful language and ask user to confirm |
| Low | Ask clarifying question or escalate to teacher |
| Dangerous action | Require confirmation |
| Unknown | Say it cannot reliably identify the step |

### 18.2 Actions requiring confirmation

The AI should require confirmation before:

- Deleting anything
- Overwriting files
- Installing plugins
- Running scripts
- Submitting assignments
- Uploading files
- Sending messages
- Making purchases
- Changing account settings
- Exporting final files
- Sharing data

### 18.3 Learning-first principle

For education, the AI should avoid doing the work for the student.

Preferred:

> “Click here, then tell me what happens.”

Avoid:

> “I completed the assignment for you.”

---

## 19. Success metrics

For a pilot, measure:

| Metric | Target |
|---|---|
| Weekly active usage | At least 50% of assigned students |
| Tutor sessions per active student | At least 3 per week during lab periods |
| Answer acceptance | At least 80% |
| Repeated trainer interruptions | Reduce by at least 30% |
| Assignment completion time | Improve by at least 20-25% or materially improve completion rate |
| Student satisfaction | Positive qualitative feedback |
| Teacher satisfaction | Teacher says it reduces repetitive support |
| Paid conversion | Institute agrees to paid renewal/expansion |
| AI/cloud cost | Below 15-20% of revenue in realistic usage |

---

## 20. Red flags

Do not continue building if:

- Students use it once and stop.
- Students prefer YouTube or ChatGPT after trying it.
- Teachers block adoption.
- Institutes refuse paid pilots.
- The product cannot point/highlight accurately.
- The AI gives too many wrong instructions.
- Latency makes the experience feel slow.
- AI costs exceed 30% of revenue.
- Privacy concerns dominate every sales conversation.
- The only demand is for a generic LMS/course library.
- Generic AI screen-sharing tools solve most of the use case for free.

---

## 21. Suggested MVP build sequence

### Phase 1: Basic prototype

Build:

1. Mac desktop app shell
2. Shortcut activation
3. Screenshot capture
4. Voice input
5. AI response
6. Text + voice output

Goal:

> AI can answer questions about the current screen.

---

### Phase 2: Overlay magic

Build:

1. Highlight boxes
2. AI ghost cursor
3. Arrows
4. Underlines
5. Spotlight mode

Goal:

> AI can show where to look and where to click.

---

### Phase 3: User annotation

Build:

1. User drawing layer
2. Circle/rectangle/highlight tools
3. Attach annotation to query
4. AI understands circled region

Goal:

> User can visually point the AI to the problem.

---

### Phase 4: Skill pack MVP

Build:

1. Blender skill pack
2. `skill.md`
3. Basic UI landmarks
4. One guided workflow
5. Common stuck-state troubleshooting

Goal:

> AI can guide a beginner through one real Blender task.

---

### Phase 5: Pilot product

Build:

1. Better reliability
2. Privacy controls
3. Basic teacher dashboard
4. Session analytics
5. Paid pilot deployment

Goal:

> Use in a real software-training institute.

---

## 22. What not to build first

Avoid building these too early:

- Full LMS
- Course marketplace
- 10-software support
- Autonomous computer control
- Full school administration system
- Parent portal
- Certificates
- Social/community features
- Complex gamification
- Full offline AI
- Enterprise compliance stack
- Native Windows app before Mac product loop is validated

---

## 23. Final product direction

The strongest product direction is:

> **A screen-native AI teaching assistant for practical software labs.**

It should start as:

> **Mac app + voice + screen analysis + visual overlay + user annotation + one strong software skill pack.**

The first magical demo should show:

> A student asks, “Help me make my first animation in Blender,” and the AI guides them step by step using voice, highlights, and a ghost cursor.

The business should not depend on generic screen awareness alone. The defensibility should come from:

1. Software-specific skill packs
2. Student stuck-state data
3. Teacher/institute analytics
4. Indian-language support
5. Curriculum-aware guidance
6. Privacy-first classroom deployment
7. Repeated usage inside practical labs

In one sentence:

> **Build the AI that sits beside the student in a software lab, sees what they see, and shows them what to do next.**

---

## 24. Implementation references

These are useful references for later technical planning:

- Apple ScreenCaptureKit: https://developer.apple.com/documentation/screencapturekit/
- Apple Accessibility API: https://developer.apple.com/documentation/accessibility/accessibility-api
- Apple VoiceOver modifier reference: https://support.apple.com/en-in/guide/voiceover/vo2681/mac
- Sarvam AI Speech-to-Text: https://www.sarvam.ai/apis/speech-to-text
- Sarvam AI Text-to-Speech: https://www.sarvam.ai/apis/text-to-speech
- ElevenLabs Speech-to-Text: https://elevenlabs.io/docs/overview/capabilities/speech-to-text
- ElevenLabs Text-to-Speech: https://elevenlabs.io/docs/overview/capabilities/text-to-speech
