import { z } from 'zod';
import type { TutorPlannerAdapter, TutorTurnInput } from '../../core/orchestrator';
import type { TutorResponse, VisualTarget } from '../../core/types';
import type { OpenRouterMessage } from './openRouter';

export type OpenRouterChatAdapter = {
  chat(messages: OpenRouterMessage[]): Promise<string>;
};

const providerVisualTargetSchema = z.object({
  kind: z.enum(['highlight_box', 'ghost_cursor', 'arrow', 'underline', 'spotlight']),
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
  mode: z.enum(['idle', 'stuck_help', 'guided_lesson']),
  skillSlug: z.string().optional().default(''),
  voiceText: z.string().min(1),
  screenText: z.string().optional().default(''),
  visualTargets: z.array(providerVisualTargetSchema).optional().default([]),
  expectedNextState: z.string().optional().default('user_next_action')
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
  const visibleText =
    providerText && providerText.length > 0
      ? providerText
      : 'I need one more clear prompt.';

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

  return {
    ...parsed,
    skillSlug: parsed.skillSlug.trim() || input.skill.slug,
    screenText: parsed.screenText.trim() || parsed.voiceText,
    visualTargets: safeTargets,
    providerMetadata: {
      confidenceState: confidenceState(safeTargets),
      warnings
    }
  };
}

function buildSystemPrompt(input: TutorTurnInput) {
  return [
    'You are Kairo Tutor, a screen-native software tutor.',
    'Return only JSON that matches this TypeScript shape:',
    '{ mode: "idle" | "stuck_help" | "guided_lesson", skillSlug: string, voiceText: string, screenText: string, visualTargets: VisualTarget[], expectedNextState: string }',
    'VisualTarget kind must be one of highlight_box, ghost_cursor, arrow, underline, spotlight.',
    'Use screenRegion pixel coordinates only for visible UI areas you are confident about.',
    'Give exactly one short next step. Do not invent app state.',
    'Answer general user questions directly. Do not refuse just because the question is outside the selected skill pack.',
    'Use the selected skill pack only when it is relevant to the active app or user question.',
    'When responding to a user question, prefer mode "stuck_help" or "guided_lesson"; reserve mode "idle" for no-op readiness.',
    'If annotations are present, treat them as user-marked screen areas. Mention only listed annotation IDs/types; do not invent image labels or extra annotations.',
    `Selected skill context, when relevant: ${input.skill.displayName} (${input.skill.slug}).`,
    `Constraints: ${input.constraints.join(' ')}`
  ].join('\n');
}

function buildAnnotationSummary(input: TutorTurnInput) {
  if (input.annotations.length === 0) {
    return 'No user annotations.';
  }

  const annotations = input.annotations
    .map((annotation) => {
      const region = annotation.screenRegion;
      return `${annotation.id}: ${annotation.type} at x=${region.x}, y=${region.y}, width=${region.width}, height=${region.height}`;
    })
    .join('; ');

  return `User annotations: exactly ${input.annotations.length}. ${annotations}. Do not invent unlisted annotations.`;
}

function buildUserPrompt(input: TutorTurnInput) {
  return JSON.stringify(
    {
      userQuery: input.userQuery,
      activeApp: input.activeApp,
      annotationSummary: buildAnnotationSummary(input),
      annotations: input.annotations,
      screen: {
        captured: input.screen.captured,
        reason: input.screen.reason,
        imageMimeType: input.screen.imageMimeType,
        byteLength: input.screen.byteLength,
        displayBounds: input.screen.displayBounds
      },
      skillLandmarks: input.skill.landmarks
    },
    null,
    2
  );
}

export function buildTutorPlannerMessages(input: TutorTurnInput): OpenRouterMessage[] {
  const userText = buildUserPrompt(input);

  if (input.screen.captured && input.screen.imageMimeType && input.screen.imageBase64) {
    return [
      { role: 'system', content: buildSystemPrompt(input) },
      {
        role: 'user',
        content: [
          { type: 'text', text: userText },
          {
            type: 'image_url',
            image_url: {
              url: `data:${input.screen.imageMimeType};base64,${input.screen.imageBase64}`
            }
          }
        ]
      }
    ];
  }

  return [
    { role: 'system', content: buildSystemPrompt(input) },
    { role: 'user', content: userText }
  ];
}

export function createOpenRouterTutorPlanner(client: OpenRouterChatAdapter): TutorPlannerAdapter {
  return async (input) => {
    const content = await client.chat(buildTutorPlannerMessages(input));
    return parseTutorPlannerResponse(content, input);
  };
}
