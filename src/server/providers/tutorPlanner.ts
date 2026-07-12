import { z } from 'zod';
import type { TutorTurnInput } from '../../core/orchestrator';
import type { TutorResponse, VisualTarget } from '../../core/types';

const providerVisualTargetSchema = z.object({
  kind: z.enum(['highlight_box', 'pointer']),
  targetId: z.string().optional(),
  label: z.string().optional(),
  confidence: z.number().optional(),
  screenRegion: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number()
  })
});

const tutorStepSchema = z.object({
  say: z
    .string()
    .nullish()
    .transform((value) => value ?? ''),
  visualTargets: z
    .array(providerVisualTargetSchema)
    .nullish()
    .transform((value) => value ?? [])
});

// Unified turn (RU1): the optional single click-target Kairo keeps up after
// narration. Same visualTargets shape as a step (a highlight_box + a pointer).
const awaitClickSchema = z.object({
  visualTargets: z
    .array(providerVisualTargetSchema)
    .nullish()
    .transform((value) => value ?? []),
  wait: z
    .string()
    .nullish()
    .transform((value) => value ?? 'ui-settle'),
  // Which mouse button the user must use. Default 'left' → every existing flow is
  // unchanged; 'right' is for context-menu / right-click tasks.
  button: z
    .enum(['left', 'right'])
    .nullish()
    .transform((value) => value ?? 'left')
});

const tutorResponseSchema = z.object({
  // The native single-call prompt returns { mode, voiceText, steps:[{say, visualTargets}] }.
  // skillSlug/screenText/expectedNextState are legacy fields still consumed by the
  // main-window preview + mock path, so they default here rather than being required.
  mode: z.enum(['single', 'steps', 'idle', 'stuck_help', 'guided_lesson']).default('single'),
  steps: z
    .array(tutorStepSchema)
    .nullish()
    .transform((value) => value ?? []),
  // Unified turn: a click-target the notch arms the pointer-watch on, plus a done
  // flag. Absent/null ⇒ today's single/steps behavior (the golden rule).
  awaitClick: awaitClickSchema
    .nullish()
    .transform((value) => value ?? null),
  done: z
    .boolean()
    .nullish()
    .transform((value) => value ?? false),
  skillSlug: z
    .string()
    .nullish()
    .transform((value) => value ?? ''),
  voiceText: z.string().min(1),
  screenText: z
    .string()
    .nullish()
    .transform((value) => value ?? ''),
  visualTargets: z
    .array(providerVisualTargetSchema)
    .nullish()
    .transform((value) => value ?? []),
  expectedNextState: z
    .string()
    .nullish()
    .transform((value) => value ?? 'user_next_action')
});

type ProviderVisualTarget = z.infer<typeof providerVisualTargetSchema>;

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const jsonText = fenced?.[1] ?? trimmed;
  return JSON.parse(jsonText);
}

function isSafeTarget(target: VisualTarget) {
  const region = target.screenRegion;
  return (
    Number.isFinite(region.x) &&
    Number.isFinite(region.y) &&
    Number.isFinite(region.width) &&
    Number.isFinite(region.height) &&
    region.width > 0 &&
    region.height > 0
  );
}

function confidenceState(targets: VisualTarget[]): 'high' | 'medium' | 'low' {
  if (targets.length === 0) {
    return 'medium';
  }

  const bestConfidence = Math.max(...targets.map((target) => target.confidence));
  if (bestConfidence >= 0.75) {
    return 'high';
  }

  if (bestConfidence >= 0.45) {
    return 'medium';
  }

  return 'low';
}

function normalizeTarget(target: ProviderVisualTarget, index: number): VisualTarget {
  return {
    kind: target.kind,
    targetId: target.targetId?.trim() || `provider-target-${index + 1}`,
    label: target.label?.trim() || 'Suggested target',
    confidence: target.confidence ?? 0.5,
    screenRegion: target.screenRegion
  };
}

function fallbackResponse(input: TutorTurnInput, warning: string, rawContent?: string): TutorResponse {
  const providerText = rawContent?.trim();
  // Never surface raw JSON: a parse failure must not be read aloud or shown
  // verbatim. Only pass through genuine plain-text answers.
  const looksLikeJson = !!providerText && /^[`{[]/.test(providerText);
  const visibleText =
    providerText && providerText.length > 0 && !looksLikeJson
      ? providerText
      : "Sorry, I couldn't read that clearly — could you ask again?";

  return {
    mode: 'single',
    skillSlug: input.skillSlug,
    voiceText: visibleText,
    screenText: visibleText,
    visualTargets: [],
    steps: [{ say: visibleText, visualTargets: [] }],
    expectedNextState: 'user_clarifies_goal',
    providerMetadata: {
      confidenceState: 'low',
      warnings: [warning]
    }
  };
}

// Normalize + drop unsafe targets, clamping confidence to [0,1].
function safeTargetsOf(raw: ProviderVisualTarget[]): { targets: VisualTarget[]; dropped: number } {
  const normalized = raw.map(normalizeTarget);
  const targets = normalized
    .filter(isSafeTarget)
    .map((target) => ({ ...target, confidence: Math.min(Math.max(target.confidence, 0), 1) }));
  return { targets, dropped: normalized.length - targets.length };
}

function ordinalLabel(index: number) {
  const labels = ['first', 'second', 'third', 'fourth', 'fifth'];
  return labels[index] ?? `marked area ${index + 1}`;
}

function sanitizeInternalAnnotationIds(text: string, input: TutorTurnInput) {
  return input.annotations.reduce((currentText, annotation, index) => {
    const replacement = `${ordinalLabel(index)} marked area`;
    return currentText.split(annotation.id).join(replacement);
  }, text);
}

export function parseTutorPlannerResponse(rawContent: string, input: TutorTurnInput): TutorResponse {
  let parsed: z.infer<typeof tutorResponseSchema>;

  try {
    parsed = tutorResponseSchema.parse(extractJson(rawContent));
  } catch {
    return fallbackResponse(input, 'Provider response was not valid tutor JSON.', rawContent);
  }

  // Normalize each step's targets; sanitize its spoken line.
  let dropped = 0;
  const steps = parsed.steps.map((step) => {
    const { targets, dropped: d } = safeTargetsOf(step.visualTargets);
    dropped += d;
    return { say: sanitizeInternalAnnotationIds(step.say, input), visualTargets: targets };
  });

  // Legacy/first-step targets (main-window preview). Fall back to any top-level
  // visualTargets for older/mock responses that don't use steps.
  const top = safeTargetsOf(parsed.visualTargets);
  dropped += steps.length > 0 ? 0 : top.dropped;
  const primaryTargets = steps[0]?.visualTargets ?? top.targets;
  const warnings = dropped > 0 ? [`Dropped ${dropped} unsafe visual target.`] : [];

  const voiceText = sanitizeInternalAnnotationIds(parsed.voiceText, input);
  const screenText = sanitizeInternalAnnotationIds(parsed.screenText.trim() || voiceText, input);

  // Unified turn: normalize the await_click target's boxes the same way steps are
  // (drop unsafe regions, clamp confidence). null passes straight through.
  const awaitClick = parsed.awaitClick
    ? {
        visualTargets: safeTargetsOf(parsed.awaitClick.visualTargets).targets,
        wait: parsed.awaitClick.wait,
        button: parsed.awaitClick.button
      }
    : null;

  return {
    ...parsed,
    skillSlug: parsed.skillSlug.trim() || input.skillSlug,
    voiceText,
    screenText,
    visualTargets: primaryTargets,
    steps,
    awaitClick,
    done: parsed.done,
    providerMetadata: {
      confidenceState: confidenceState(primaryTargets),
      warnings
    }
  };
}
