mod agent_tools;
mod antigravity;
mod auth;
mod chat;
mod child_process;
mod codex_import;
mod db;
mod git;
mod open_in;
mod openai;
mod openai_auth;
mod opencode;
mod paths;
mod permission;
mod preview;
mod project;
mod prompts;
mod provider;
mod provider_output;
mod secure_store;
mod snapshot;
mod subagent;
mod terminal;
mod tools;
mod usage;

use tauri::Manager;

#[tauri::command]
fn agent_notify(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;

    let title: String = title.chars().take(120).collect();
    let body: String = body.chars().take(180).collect();
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .silent()
        .show()
        .map_err(|e| format!("notification: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let conn = db::open_db(app.handle()).map_err(|e| e.to_string())?;
            app.manage(db::DbState(std::sync::Mutex::new(conn)));
            let agent_tools = agent_tools::start_mcp_server(app.handle().clone())?;
            app.manage(agent_tools);
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(3));
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.show();
                }
            });
            Ok(())
        })
        .manage(auth::AuthState::new())
        .manage(openai_auth::OpenAIAuthState::new())
        .manage(antigravity::AntigravityState::default())
        .manage(opencode::OpenCodeState::default())
        .manage(std::sync::Arc::new(chat::StreamControl::new()))
        .manage(std::sync::Arc::new(snapshot::SnapshotState::new()))
        .manage(terminal::TerminalManager::default())
        .manage(preview::PreviewManager::default())
        .invoke_handler(tauri::generate_handler![
            auth::auth_status,
            auth::auth_login,
            auth::auth_cancel_login,
            auth::auth_logout,
            openai_auth::openai_auth_status,
            openai_auth::openai_codex_usage,
            openai_auth::openai_auth_login,
            openai_auth::openai_auth_cancel_login,
            openai_auth::openai_auth_logout,
            codex_import::codex_import_chats,
            antigravity::antigravity_status,
            opencode::opencode_status,
            opencode::opencode_update,
            chat::chat_stream,
            chat::chat_cancel,
            chat::chat_user_input_reply,
            chat::chat_user_input_reject,
            chat::chat_tool_approve,
            chat::chat_tool_deny,
            agent_notify,
            project::project_context,
            project::project_entries,
            project::project_read_file,
            project::project_search_entries,
            project::project_favicon,
            paths::project_register,
            paths::project_unregister,
            open_in::project_open_in_options,
            open_in::project_open_in,
            git::git_status,
            git::git_diff,
            git::git_commit,
            git::git_push,
            git::git_list_refs,
            git::git_worktree_create,
            git::git_worktree_remove,
            git::git_pr_open,
            snapshot::snapshot_list,
            snapshot::snapshot_restore,
            db::profile_get,
            db::profile_create,
            db::profile_update,
            db::profile_stats,
            db::profile_record_activity,
            db::profile_record_openai_tokens,
            db::kv_get,
            db::kv_set,
            db::kv_remove,
            terminal::terminal_start,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_stop,
            preview::preview_open,
            preview::preview_close,
            preview::preview_state,
            preview::preview_navigate,
            preview::preview_sync_state,
            preview::preview_action,
            preview::preview_set_bounds,
            preview::preview_set_visible,
            preview::preview_open_external,
            preview::preview_capture,
            preview::preview_discover_servers,
            usage::usage_summary,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
