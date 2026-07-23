// Playback volume for Kairo's spoken voice, split by path because the two render the SAME Sarvam
// voice (bulbul:v3 / shubh) through DIFFERENT audio pipelines at different loudness:
//   - Onboarding coach lines play through a plain <audio> element  → came out LOUDER.
//   - Product tutor responses stream raw PCM through Web Audio      → came out QUIETER.
// So we pull the loud path down and push the quiet path up until both land at the same middle level.
// Tune by ear: nudge these two until the onboarding coach and the tutor answers match.
export const SPEECH_VOLUME_ONBOARDING = 0.7; // <audio>.volume, 0..1 (the loud path, pulled down)
export const SPEECH_VOLUME_PRODUCT = 1.2; // Web Audio gain, may exceed 1.0 (the quiet path, pushed up)
