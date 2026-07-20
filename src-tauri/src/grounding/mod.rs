//! Vision grounding: provider calls, model-JSON sanitizing, and box->target mapping.

mod model_json;
mod targets;
mod vision;

pub(crate) use model_json::clean_model_json;
pub(crate) use targets::{apply_step_targets, ground_visual_targets, inject_primary_box};
pub(crate) use vision::{anthropic_vision_chat, detect_click_point_openai, openai_vision_chat};
