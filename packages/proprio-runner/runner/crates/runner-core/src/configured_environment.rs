//! Controller-selected task environment; mirrors configured-environment.ts.
use crate::local_runner::LocalRunnerError;
use std::process::Command;

const MARKER: &str = "PROPRIO_CONFIGURED_ENV_KEYS";
/// Names (never values) of configured entries resolved from secrets.
const SECRET_MARKER: &str = "PROPRIO_SECRET_ENV_KEYS";
const RESERVED: &[&str] = &[
    "PROPRIO_OBSERVABILITY_CODEX_CONFIG",
    "PROPRIO_OBSERVABILITY_OPENCODE",
    "CLAUDE_CODE_ENABLE_TELEMETRY",
    "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA",
    "ENABLE_ENHANCED_TELEMETRY_BETA",
    "OTEL_LOGS_EXPORTER",
    "OTEL_TRACES_EXPORTER",
    "OTEL_METRICS_EXPORTER",
    "OTEL_RESOURCE_ATTRIBUTES",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_PROTOCOL",
    "OTEL_EXPORTER_OTLP_HEADERS",
    "OTEL_EXPORTER_OTLP_TIMEOUT",
    "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
    "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
    "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
    "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
    "OTEL_EXPORTER_OTLP_LOGS_TIMEOUT",
    "OTEL_EXPORTER_OTLP_TRACES_TIMEOUT",
    "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
    "OTEL_EXPORTER_OTLP_METRICS_HEADERS",
    "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
    "OTEL_LOG_USER_PROMPTS",
    "OTEL_LOG_ASSISTANT_RESPONSES",
    "OTEL_LOG_TOOL_DETAILS",
    "OTEL_LOG_TOOL_CONTENT",
    "OTEL_LOG_RAW_API_BODIES",
    "AGENT_HOME",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "AWS_BEARER_TOKEN_BEDROCK",
    "BASH_ENV",
    "ZDOTDIR",
    "GH_CONFIG_DIR",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CODEX_API_KEY",
    "CODEX_HOME",
    "COPILOT_GITHUB_TOKEN",
    "CURSOR_API_KEY",
    "CURSOR_AUTH_TOKEN",
    "ENV",
    "GH_ENTERPRISE_TOKEN",
    "GH_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
    "GITHUB_TOKEN",
    "HOME",
    "KIMI_API_KEY",
    "NODE_OPTIONS",
    "NODE_PATH",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "PROPRIO_ACPX_CREDENTIAL_BINDING",
    "PROPRIO_AGENT_ID",
    "PROPRIO_AGENT_KEY_ID",
    "PROPRIO_AGENT_MESSAGE_KEY",
    "PROPRIO_AGENT_PRIVATE_KEY",
    "PROPRIO_AGENT_PUBLIC_KEY",
    "PROPRIO_AI_PROVIDER_KEY",
    "PROPRIO_API_BRIDGE_MODE",
    "PROPRIO_API_KEY",
    "PROPRIO_API_URL",
    "PROPRIO_APPROVAL_ID",
    "PROPRIO_APPROVAL_STATUS",
    "PROPRIO_COMPANY_ID",
    "PROPRIO_CONFIGURED_ENV_KEYS",
    "PROPRIO_SECRET_ENV_KEYS",
    "PROPRIO_EXECUTION_MODE",
    "PROPRIO_EXTERNAL_CHAT_EXECUTION_BOUND_KEY",
    "PROPRIO_GITHUB_AUTH_MODE",
    "PROPRIO_GITHUB_BRIDGE_TOKEN",
    "PROPRIO_GITHUB_BROKER_TOKEN",
    "PROPRIO_GITHUB_BROKER_URL",
    "PROPRIO_GITHUB_HOST_HOME",
    "PROPRIO_GITHUB_LAUNCHER_DIR",
    "PROPRIO_GIT_METADATA_ROOTS",
    "PROPRIO_GIT_TOKEN",
    "PROPRIO_HARNESS_CHECKOUT_KEY",
    "PROPRIO_INSTANCE_ID",
    "PROPRIO_LINKED_ISSUE_IDS",
    "PROPRIO_NATIVE_MCP_NAME",
    "PROPRIO_NATIVE_MCP_TOKEN",
    "PROPRIO_NATIVE_MCP_URL",
    "PROPRIO_NATIVE_MCP_STDIO",
    "PROPRIO_NATIVE_MCP_PROXY",
    "PROPRIO_NORMALIZED_SESSION_ID",
    "PROPRIO_PROVIDER_TRACE_MAX_BYTES",
    "PROPRIO_PROVIDER_TRACE_PATH",
    "PROPRIO_RUNNER_BOOTSTRAP_TICKET",
    "PROPRIO_RUNNER_EXTERNAL_SANDBOX",
    "PROPRIO_RUNNER_INSTANCE_ID",
    "PROPRIO_RUNNER_NETWORK_ACCESS",
    "PROPRIO_RUNNER_NETWORK_ROOTS",
    "PROPRIO_RUNTIME_PRIMARY_URL",
    "PROPRIO_RUNTIME_SERVICES_JSON",
    "PROPRIO_RUNTIME_SERVICE_INTENTS_JSON",
    "PROPRIO_RUN_ID",
    "PROPRIO_RUNTIME_NOTIFICATION_CONTEXT",
    "PROPRIO_RUNTIME_NOTIFICATION_HELPER",
    "PROPRIO_TASK_ID",
    "PROPRIO_WAKE_COMMENT_ID",
    "PROPRIO_WAKE_PAYLOAD_JSON",
    "PROPRIO_WAKE_REASON",
    "PROPRIO_WORKSPACES_JSON",
    "PROPRIO_WORKSPACE_AUTHORITATIVE_ROOT",
    "PROPRIO_WORKSPACE_BRANCH",
    "PROPRIO_WORKSPACE_CWD",
    "PROPRIO_WORKSPACE_ID",
    "PROPRIO_WORKSPACE_REALIZATION_MODE",
    "PROPRIO_WORKSPACE_REPO_REF",
    "PROPRIO_WORKSPACE_REPO_URL",
    "PROPRIO_WORKSPACE_SOURCE",
    "PROPRIO_WORKSPACE_WORKTREE_PATH",
    "PATH",
    "PERL5LIB",
    "PERL5OPT",
    "PYTHONHOME",
    "PYTHONPATH",
    "RUBYLIB",
    "RUBYOPT",
    "SHELL",
    "USERPROFILE",
    "XAI_API_KEY",
];

fn eligible_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    !key.is_empty()
        && key.len() <= 128
        && key
            .bytes()
            .enumerate()
            .all(|(i, b)| b == b'_' || b.is_ascii_alphabetic() || (i > 0 && b.is_ascii_digit()))
        && !RESERVED.contains(&upper.as_str())
        && ![
            "LD_",
            "DYLD_",
            "GIT_CONFIG_",
            "PROPRIO_RUNNER_",
            "PROPRIO_NATIVE_",
            "PROPRIO_CURSOR_CLOUD_",
            "PROPRIO_GITHUB_",
            "PROPRIO_ACPX_",
            "PROPRIO_VERIFIED_",
        ]
        .iter()
        .any(|prefix| upper.starts_with(prefix))
}

pub(crate) fn apply_configured_environment(
    command: &mut Command,
    lookup: impl Fn(&str) -> Option<String>,
) -> Result<(), LocalRunnerError> {
    let Some(raw) = lookup(MARKER) else {
        return Ok(());
    };
    let invalid = || LocalRunnerError::invalid("invalid configured environment projection");
    if raw.len() > 20_000 {
        return Err(invalid());
    }
    let mut names: Vec<String> = serde_json::from_str(&raw).map_err(|_| invalid())?;
    if names.len() > 128 || names.iter().any(|name| !eligible_key(name)) {
        return Err(invalid());
    }
    names.sort();
    if names.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(invalid());
    }
    let mut bytes = 0;
    // Validate all values before modifying the child launch specification.
    let mut values = Vec::new();
    for name in &names {
        let value = lookup(name).ok_or_else(invalid)?;
        let size = name.len() + value.len();
        bytes += size;
        if value.contains('\0') || size > 65_536 || bytes > 262_144 {
            return Err(invalid());
        }
        values.push((name, value));
    }
    // The secret-name marker travels with the projection it describes. Only
    // names that this projection carries may cross.
    let secret_names = match lookup(SECRET_MARKER) {
        None => None,
        Some(raw) => {
            if raw.len() > 20_000 {
                return Err(invalid());
            }
            let secret: Vec<String> = serde_json::from_str(&raw).map_err(|_| invalid())?;
            if secret.len() > 128 || secret.iter().any(|name| !eligible_key(name)) {
                return Err(invalid());
            }
            Some(
                secret
                    .into_iter()
                    .filter(|name| names.contains(name))
                    .collect::<Vec<_>>(),
            )
        }
    };
    command.envs(values);
    command.env(
        MARKER,
        serde_json::to_string(&names).map_err(|_| invalid())?,
    );
    if let Some(secret) = secret_names {
        command.env(
            SECRET_MARKER,
            serde_json::to_string(&secret).map_err(|_| invalid())?,
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn rejects_reserved_malformed_missing_and_oversized_environment() {
        for raw in [
            "not-json",
            "[1]",
            "[\"NODE_OPTIONS\"]",
            "[\"BASH_ENV\"]",
            "[\"ZDOTDIR\"]",
            "[\"GH_CONFIG_DIR\"]",
            "[\"PROPRIO_API_KEY\"]",
            "[\"PROPRIO_RUNNER_BOOTSTRAP_TICKET\"]",
            "[\"PROPRIO_RUNTIME_NOTIFICATION_CONTEXT\"]",
            "[\"PROPRIO_RUNTIME_NOTIFICATION_HELPER\"]",
            "[\"OPENAI_API_KEY\"]",
            "[\"KIMI_API_KEY\"]",
            "[\"PROPRIO_NATIVE_MCP_NAME\"]",
            "[\"PROPRIO_NATIVE_MCP_URL\"]",
            "[\"PROPRIO_NATIVE_MCP_TOKEN\"]",
            "[\"LD_PRELOAD\"]",
            "[\"bad=name\"]",
            "[\"CUSTOM\",\"CUSTOM\"]",
            "[\"MISSING\"]",
        ] {
            let mut command = Command::new("unused");
            assert!(
                apply_configured_environment(&mut command, |key| if key == MARKER {
                    Some(raw.into())
                } else {
                    None
                })
                .is_err()
            );
            assert_eq!(command.get_envs().count(), 0);
        }
        let mut command = Command::new("unused");
        assert!(apply_configured_environment(&mut command, |key| match key {
            MARKER => Some("[\"KIMI_API_KEY\"]".into()),
            "KIMI_API_KEY" => Some("selected-code-key".into()),
            _ => None,
        })
        .is_err());
        assert_eq!(command.get_envs().count(), 0);
        let mut command = Command::new("unused");
        assert!(
            apply_configured_environment(&mut command, |key| Some(if key == MARKER {
                "[\"CUSTOM\"]".into()
            } else {
                "x".repeat(65_536)
            }))
            .is_err()
        );
    }

    #[test]
    fn secret_name_marker_crosses_only_with_its_projection() {
        let source = BTreeMap::from([
            (MARKER, "[\"CUSTOM\",\"PLAIN\"]".to_string()),
            ("CUSTOM", "custom-secret-value".to_string()),
            ("PLAIN", "plain".to_string()),
            (SECRET_MARKER, "[\"CUSTOM\",\"NOT_CONFIGURED\"]".to_string()),
        ]);
        let mut command = Command::new("unused");
        apply_configured_environment(&mut command, |key| source.get(key).cloned()).unwrap();
        let envs: BTreeMap<_, _> = command
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().into_owned(),
                    value.map(|v| v.to_string_lossy().into_owned()),
                )
            })
            .collect();
        assert_eq!(
            envs.get(SECRET_MARKER),
            Some(&Some("[\"CUSTOM\"]".to_string()))
        );
        for raw in ["not-json", "[\"bad=name\"]", "[\"PROPRIO_API_KEY\"]"] {
            let mut source = source.clone();
            source.insert(SECRET_MARKER, raw.into());
            let mut command = Command::new("unused");
            assert!(
                apply_configured_environment(&mut command, |key| source.get(key).cloned()).is_err()
            );
            assert_eq!(command.get_envs().count(), 0);
        }
        let mut legacy = source.clone();
        legacy.remove(SECRET_MARKER);
        let mut command = Command::new("unused");
        apply_configured_environment(&mut command, |key| legacy.get(key).cloned()).unwrap();
        assert!(command.get_envs().all(|(key, _)| key != SECRET_MARKER));
    }

    #[test]
    #[cfg(unix)]
    fn child_receives_only_selected_task_values_across_configuration_changes() {
        for secret in [None, Some("first-secret"), Some("rotated-secret"), None] {
            let mut source = BTreeMap::from([
                ("HOST_SECRET", "unbound-secret".to_string()),
                ("NODE_OPTIONS", "unbound-loader".to_string()),
            ]);
            let names = if let Some(value) = secret {
                source.insert("PROPRIO_PAGE_AWS_SECRET_ACCESS_KEY", value.into());
                vec!["PROPRIO_PAGE_AWS_SECRET_ACCESS_KEY"]
            } else {
                vec![]
            };
            source.insert(MARKER, serde_json::to_string(&names).unwrap());
            let mut command = Command::new("/bin/sh");
            command.env_clear().args(["-c", "printf '%s|%s|%s' \"$PROPRIO_PAGE_AWS_SECRET_ACCESS_KEY\" \"$HOST_SECRET\" \"$NODE_OPTIONS\""]);
            apply_configured_environment(&mut command, |key| source.get(key).cloned()).unwrap();
            let output = command.output().unwrap();
            assert!(output.status.success());
            assert_eq!(
                String::from_utf8(output.stdout).unwrap(),
                format!("{}||", secret.unwrap_or_default())
            );
        }
    }
}
