/**
 * What a client is allowed to ask a provider for.
 *
 * The desktop builds the full provider payload itself and the proxy forwards it. Authentication
 * alone does not make that safe, because the expensive dimension of an LLM request is not how many
 * you send — it is how much each one costs. A caller who stays comfortably inside every rate limit
 * can still name the priciest model and ask for a hundred thousand tokens, and a Pro subscriber is
 * unmetered by design, so nothing downstream would stop them.
 *
 * So the ceilings are clamped rather than trusted, and a payload cannot carry an unbounded number
 * of images. This is the control for cost-per-request; the quota is the control for request count.
 * They are different attacks and need different answers.
 */
import { BadRequestError } from '../plugins/error-handler';

/**
 * Chat models the desktop is built to request (`constants.rs`: GATE_MODEL, ACK_MODEL,
 * OPENROUTER_MODEL, OPENROUTER_VISION_MODEL). Kept as a literal list rather than derived from a
 * constant, so a model change is a deliberate edit here rather than a silent widening.
 */
const KNOWN_CHAT_MODELS = new Set([
  'openai/gpt-5.6-luna',
  'google/gemini-2.5-flash-lite',
  'google/gemini-2.5-flash',
]);

/** Single-call answer+box models (`TUTOR_VISION_MODEL`, `OPENAI_TUTOR_MODEL`). */
const KNOWN_VISION_MODELS = new Set(['claude-opus-4-8', 'gpt-5.6-sol']);

/**
 * Token ceilings. The product's own vision turn asks for `ANTHROPIC_VISION_MAX_TOKENS` (3000), and
 * onboarding's gate replies are a sentence or two, so these sit just above real usage. Clamping
 * beats rejecting: a legitimate build that drifts slightly still works, it just cannot bill us for
 * a novel.
 */
const MAX_CHAT_TOKENS = 1_000;
const MAX_VISION_TOKENS = 4_000;

/** One screenshot per turn is the product's shape; the allowance is for a retry, not a batch. */
const MAX_IMAGES = 3;

type Body = Record<string, unknown>;

function asObject(body: unknown): Body {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestError('request body must be a JSON object');
  }
  return { ...(body as Body) };
}

/** Clamp a numeric token field in place, leaving it absent if the caller never set it. */
function clampTokens(body: Body, field: string, ceiling: number): void {
  if (!(field in body)) return;
  const requested = Number(body[field]);
  // A non-numeric or non-positive value is not a negotiation; pin it to the ceiling.
  body[field] = Number.isFinite(requested) && requested > 0 ? Math.min(requested, ceiling) : ceiling;
}

/** Count image blocks anywhere in the payload, whatever shape the provider uses to carry them. */
function countImages(value: unknown, depth = 0): number {
  if (depth > 8 || !value || typeof value !== 'object') return 0;
  if (Array.isArray(value)) return value.reduce((n, v) => n + countImages(v, depth + 1), 0);
  const record = value as Body;
  const type = typeof record.type === 'string' ? record.type : '';
  const isImage = type === 'image' || type === 'image_url' || type === 'input_image';
  return (
    (isImage ? 1 : 0) +
    Object.values(record).reduce((n: number, v) => n + countImages(v, depth + 1), 0)
  );
}

function requireAllowedModel(body: Body, allowed: Set<string>): void {
  const model = typeof body.model === 'string' ? body.model : '';
  if (!allowed.has(model)) {
    // The rejected value is our own allowlist decision, not user content, but it is still attacker
    // input — it never reaches the log, only the fact that something was refused.
    throw new BadRequestError('unsupported model');
  }
}

/**
 * Clamp a chat payload. Clamped, not allowlisted: an installed build sends whatever model constant
 * it was compiled with, and refusing an unrecognised one would strand users on a version they
 * cannot update past. The unknown model is reported so we learn what is actually in the wild.
 * Returns the sanitised body and whether the model was one we recognise, for the caller to log.
 */
export function clampAuthedChat(body: unknown): { body: Body; knownModel: boolean } {
  const guarded = asObject(body);
  clampTokens(guarded, 'max_tokens', MAX_CHAT_TOKENS);
  clampTokens(guarded, 'max_completion_tokens', MAX_CHAT_TOKENS);
  if (countImages(guarded) > MAX_IMAGES) throw new BadRequestError('too many images');
  const model = typeof guarded.model === 'string' ? guarded.model : '';
  return { body: guarded, knownModel: KNOWN_CHAT_MODELS.has(model) };
}

/**
 * Clamp a vision payload — the expensive one, and the reason this file exists.
 *
 * A single vision turn carries a full screenshot and can be asked for thousands of output tokens.
 * The quota bounds how many turns a free user gets; nothing bounds what one turn costs, and Pro
 * has no quota at all. So the ceiling and the image count are enforced here regardless of who is
 * asking.
 */
export function clampAuthedVision(body: unknown): { body: Body; knownModel: boolean } {
  const guarded = asObject(body);
  clampTokens(guarded, 'max_tokens', MAX_VISION_TOKENS);
  clampTokens(guarded, 'max_output_tokens', MAX_VISION_TOKENS);
  if (countImages(guarded) > MAX_IMAGES) throw new BadRequestError('too many images');
  const model = typeof guarded.model === 'string' ? guarded.model : '';
  return { body: guarded, knownModel: KNOWN_VISION_MODELS.has(model) };
}

export const MODEL_GUARD_LIMITS = {
  MAX_CHAT_TOKENS,
  MAX_VISION_TOKENS,
  MAX_IMAGES,
} as const;
