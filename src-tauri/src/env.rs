//! Environment/config resolution: process env + local `.env` files, plus small
//! parsing helpers used to select providers and timeouts.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

pub(crate) fn parse_local_env(text: &str) -> HashMap<String, String> {
    let mut values = HashMap::new();

    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((raw_key, raw_value)) = line.split_once('=') else {
            continue;
        };
        let key = raw_key.trim();
        if key.is_empty() {
            continue;
        }

        let value = raw_value.trim();
        let value = if value.len() >= 2 {
            let first = value.as_bytes()[0] as char;
            let last = value.as_bytes()[value.len() - 1] as char;
            if (first == '"' && last == '"') || (first == '\'' && last == '\'') {
                &value[1..value.len() - 1]
            } else {
                value
            }
        } else {
            value
        };

        values.insert(key.to_string(), value.to_string());
    }

    values
}

pub(crate) fn push_env_file_candidates_from(start: &Path, candidates: &mut Vec<PathBuf>) {
    let mut current = if start.is_file() {
        start.parent()
    } else {
        Some(start)
    };

    while let Some(dir) = current {
        candidates.push(dir.join(".env.local"));
        candidates.push(dir.join(".env"));
        current = dir.parent();
    }
}

pub(crate) fn local_env_file_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(current_dir) = std::env::current_dir() {
        push_env_file_candidates_from(&current_dir, &mut candidates);
    }

    if let Ok(current_exe) = std::env::current_exe() {
        push_env_file_candidates_from(&current_exe, &mut candidates);
    }

    candidates.dedup();
    candidates
}

pub(crate) fn read_local_env_value(name: &str) -> Option<String> {
    for candidate in local_env_file_candidates() {
        let Ok(text) = fs::read_to_string(candidate) else {
            continue;
        };
        if let Some(value) = parse_local_env(&text).remove(name) {
            return Some(value);
        }
    }

    None
}

pub(crate) fn provider_env_optional(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .or_else(|| read_local_env_value(name))
}

pub(crate) fn provider_env(name: &str, fallback: &str) -> String {
    provider_env_optional(name).unwrap_or_else(|| fallback.to_string())
}

pub(crate) fn provider_timeout_ms(raw_value: Option<String>) -> u64 {
    raw_value
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(crate::constants::OPENROUTER_REQUEST_TIMEOUT_MS)
}
