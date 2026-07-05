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

const tutorResponseSchema = z.object({
  // The native single-call prompt returns { voiceText, box } only; mode/skillSlug/
  // screenText/expectedNextState are legacy fields still consumed by the main-window
  // preview + mock path, so they default here rather than being required.
  mode: z.enum(['idle', 'stuck_help', 'guided_lesson']).default('stuck_help'),
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
    mode: 'stuck_help',
    skillSlug: input.skill.slug,
    voiceText: visibleText,
    screenText: visibleText,
    visualTargets: [],
    expectedNextState: 'user_clarifies_goal',
    providerMetadata: {
      confidenceState: 'low',
      warnings: [warning]
    }
  };
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

  const normalizedTargets = parsed.visualTargets.map(normalizeTarget);
  const safeTargets = normalizedTargets
    .filter(isSafeTarget)
    .map((target) => ({
      ...target,
      confidence: Math.min(Math.max(target.confidence, 0), 1)
    }));
  const droppedTargets = normalizedTargets.length - safeTargets.length;
  const warnings = droppedTargets > 0 ? [`Dropped ${droppedTargets} unsafe visual target.`] : [];
  const voiceText = sanitizeInternalAnnotationIds(parsed.voiceText, input);
  const screenText = sanitizeInternalAnnotationIds(parsed.screenText.trim() || voiceText, input);

  return {
    ...parsed,
    skillSlug: parsed.skillSlug.trim() || input.skill.slug,
    voiceText,
    screenText,
    visualTargets: safeTargets,
    providerMetadata: {
      confidenceState: confidenceState(safeTargets),
      warnings
    }
  };
}
