use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process, thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State, WebviewWindow, WindowEvent};
use tauri_nspanel::{cocoa::appkit::NSWindowCollectionBehavior, ManagerExt, WebviewWindowExt};

struct Probe {
    root: PathBuf,
    panel_mode: bool,
}

fn resolve_root() -> PathBuf {
    let raw = std::env::var("BAYPER_WINDOW_ROOT").unwrap_or_default();
    let valid = ["/tmp/bayper-window-spike-", "/private/tmp/bayper-window-spike-"]
        .iter()
        .any(|prefix| raw.starts_with(prefix));
    if !valid {
        eprintln!("BAYPER_WINDOW_ROOT 无效: {raw:?}");
        process::exit(1);
    }
    PathBuf::from(raw)
}

fn append_jsonl(root: &Path, record: Value) -> std::io::Result<()> {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let mut entry = record.as_object().cloned().unwrap_or_default();
    entry.insert("ts_ms".into(), json!(ts));
    let line = format!("{}\n", Value::Object(entry));
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("tauri.jsonl"))?
        .write_all(line.as_bytes())
}

fn log(root: &Path, record: Value) {
    if let Err(err) = append_jsonl(root, record) {
        eprintln!("写 tauri.jsonl 失败: {err}");
    }
}

fn window_state(window: &WebviewWindow) -> Value {
    let focused = window
        .is_focused()
        .map_or_else(|err| json!(format!("error: {err}")), |value| json!(value));
    let visible = window
        .is_visible()
        .map_or_else(|err| json!(format!("error: {err}")), |value| json!(value));
    json!({ "is_focused": focused, "is_visible": visible })
}

// 动作执行结果必须落盘，成功和失败都保留。
fn log_outcome(
    root: &Path,
    event: &str,
    seq: i64,
    action: &str,
    value: Value,
    result: tauri::Result<()>,
) -> bool {
    match result {
        Ok(()) => {
            log(root, json!({"event": event, "seq": seq, "action": action, "value": value, "ok": true}));
            true
        }
        Err(err) => {
            log(root, json!({"event": event, "seq": seq, "action": action, "value": value, "ok": false, "error": err.to_string()}));
            false
        }
    }
}

fn apply_on_main(app: &AppHandle, root: &Path, seq: i64, command: Value) {
    let Some(window) = app.get_webview_window("probe") else {
        log(root, json!({"event": "command", "seq": seq, "ok": false, "error": "probe 窗口不存在"}));
        return;
    };
    let mut ok = true;
    let panel_mode = app.state::<Probe>().panel_mode;
    let panel = if panel_mode {
        match app.get_webview_panel("probe") {
            Ok(panel) => Some(panel),
            Err(err) => {
                log(root, json!({"event": "panel-missing", "seq": seq, "error": format!("{err:?}")}));
                None
            }
        }
    } else {
        None
    };

    if let Some(ignore) = command.get("ignore").and_then(Value::as_bool) {
        ok &= log_outcome(root, "command-action", seq, "ignore", json!(ignore), window.set_ignore_cursor_events(ignore));
    }
    if let Some(animate) = command.get("animate").and_then(Value::as_bool) {
        let script = format!("window.setAnimation({animate})");
        ok &= log_outcome(root, "command-action", seq, "animate", json!(animate), window.eval(&script));
    }
    if command.get("x").and_then(Value::as_f64).is_some() || command.get("y").and_then(Value::as_f64).is_some() {
        let scale = match window.scale_factor() {
            Ok(scale) => scale,
            Err(err) => {
                log(root, json!({"event": "command-action", "seq": seq, "action": "position", "ok": false, "error": err.to_string()}));
                return;
            }
        };
        match window.outer_position() {
            Ok(position) => {
                // Electron 位置使用逻辑像素，这里用 LogicalPosition 对齐。
                let x = command.get("x").and_then(Value::as_f64).unwrap_or(position.x as f64 / scale);
                let y = command.get("y").and_then(Value::as_f64).unwrap_or(position.y as f64 / scale);
                ok &= log_outcome(
                    root,
                    "command-action",
                    seq,
                    "position",
                    json!({"x": x, "y": y}),
                    window.set_position(tauri::LogicalPosition::new(x, y)),
                );
            }
            Err(err) => {
                log(root, json!({"event": "command-action", "seq": seq, "action": "position", "ok": false, "error": err.to_string()}));
                ok = false;
            }
        }
    }
    if let Some(visible) = command.get("visible").and_then(Value::as_bool) {
        if panel_mode {
            // 后续 show/hide 也只能走 panel 接口，window.show() 会激活应用。
            match &panel {
                Some(panel) => {
                    if visible {
                        panel.order_front_regardless();
                    } else {
                        panel.order_out(None);
                    }
                    log(root, json!({"event": "command-action", "seq": seq, "action": "visible", "value": visible, "ok": true, "route": "panel"}));
                }
                None => {
                    ok = false;
                    log(root, json!({"event": "command-action", "seq": seq, "action": "visible", "value": visible, "ok": false, "error": "panel 不存在，未回退到 window.show/hide"}));
                }
            }
        } else {
            let result = if visible { window.show() } else { window.hide() };
            ok &= log_outcome(root, "command-action", seq, "visible", json!(visible), result);
        }
    }

    log(root, json!({"event": "command", "seq": seq, "ok": ok, "state": window_state(&window)}));
    if command.get("quit").and_then(Value::as_bool) == Some(true) {
        log(root, json!({"event": "quit-command", "seq": seq}));
        app.exit(0);
    }
}

fn apply_command(app: &AppHandle, root: &Path, seq: i64, command: Value) {
    let handle = app.clone();
    let main_root = root.to_path_buf();
    let error_root = main_root.clone();
    if let Err(err) = app.run_on_main_thread(move || apply_on_main(&handle, &main_root, seq, command)) {
        log(&error_root, json!({"event": "command", "seq": seq, "ok": false, "error": err.to_string()}));
    }
}

fn start_command_thread(app: AppHandle, root: PathBuf) {
    thread::spawn(move || {
        let command_path = root.join("command.json");
        let mut last_seq = i64::MIN;
        let mut last_bad_raw = String::new();
        loop {
            thread::sleep(Duration::from_millis(250));
            let raw = match fs::read_to_string(&command_path) {
                Ok(raw) => raw,
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
                Err(err) => {
                    log(&root, json!({"event": "command-read-failed", "error": err.to_string()}));
                    continue;
                }
            };
            if raw == last_bad_raw {
                continue;
            }
            let command: Value = match serde_json::from_str(&raw) {
                Ok(command) => command,
                Err(err) => {
                    log(&root, json!({"event": "command-parse-failed", "raw": &raw, "error": err.to_string()}));
                    last_bad_raw = raw;
                    continue;
                }
            };
            last_bad_raw.clear();
            let Some(seq) = command.get("seq").and_then(Value::as_i64) else {
                continue;
            };
            if seq <= last_seq {
                continue;
            }
            last_seq = seq;
            apply_command(&app, &root, seq, command);
        }
    });
}

#[tauri::command]
fn log_event(event: Value, state: State<'_, Probe>) -> Result<(), String> {
    // 返回错误让 renderer 的 invoke 失败，避免点击日志被静默丢弃。
    append_jsonl(&state.root, json!({"event": "renderer-click", "payload": event}))
        .map_err(|err| err.to_string())
}

fn main() {
    let root = resolve_root();
    let panel_mode = std::env::var("BAYPER_PANEL").map(|value| value == "1").unwrap_or(false);
    let setup_root = root.clone();
    let builder = tauri::Builder::default()
        .manage(Probe { root, panel_mode })
        .invoke_handler(tauri::generate_handler![log_event]);
    // 只有 panel 模式注册 nspanel 插件，普通窗口基线保持原路径。
    let builder = if panel_mode { builder.plugin(tauri_nspanel::init()) } else { builder };
    builder
        .setup(move |app| {
            // App 不进入 Dock，也不主动抢焦点，点击写日志由窗口自身完成。
            // set_activation_policy 返回 () 而非 Result，无法观测成功或错误，只记录已发出调用。
            #[cfg(target_os = "macos")]
            {
                // 可选对照：prohibited 仅用于观察是否仍抢激活；不自动把焦点抢回来。
                let prohibited = panel_mode
                    && std::env::var("BAYPER_ACTIVATION_POLICY").map(|value| value == "prohibited").unwrap_or(false);
                let policy = if prohibited {
                    tauri::ActivationPolicy::Prohibited
                } else {
                    tauri::ActivationPolicy::Accessory
                };
                app.set_activation_policy(policy);
                log(&setup_root, json!({"event": "startup-action", "seq": 0, "action": "activation-policy", "value": if prohibited { "Prohibited" } else { "Accessory" }, "result": "called"}));
            }

            let window = match app.get_webview_window("probe") {
                Some(window) => window,
                None => {
                    log(&setup_root, json!({"event": "startup-failed", "error": "probe 窗口不存在"}));
                    process::exit(1);
                }
            };

            log(&setup_root, json!({
                "event": "startup",
                "pid": process::id(),
                "panel_mode": panel_mode,
                "window_kind": if panel_mode { "nspanel" } else { "normal" },
                "versions": {
                    "probe": env!("CARGO_PKG_VERSION"),
                    "package": app.package_info().version.to_string(),
                },
                "state": window_state(&window),
            }));

            let event_window = window.clone();
            let event_root = setup_root.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::Focused(focused) = event {
                    log(&event_root, json!({
                        "event": "focused",
                        "focused": focused,
                        "state": window_state(&event_window),
                    }));
                }
            });

            let mut ok = log_outcome(&setup_root, "startup-action", 0, "ignore", json!(false), window.set_ignore_cursor_events(false));
            if panel_mode {
                // tauri-nspanel 在 objc runtime 中把 NSWindow 的 class swizzle 为 NSPanel 子类，
                // 属额外社区原生适配；只在此处调用一次 to_panel()。
                match window.to_panel() {
                    Ok(panel) => {
                        panel.set_style_mask(1 << 7); // NSNonactivatingPanelMask
                        panel.set_collection_behaviour(
                            NSWindowCollectionBehavior::NSWindowCollectionBehaviorCanJoinAllSpaces
                                | NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenAuxiliary,
                        );
                        panel.set_hides_on_deactivate(false);
                        panel.set_becomes_key_only_if_needed(true);
                        // 初始显示用 order_front_regardless，避免 makeKeyAndOrderFront 抢焦点。
                        panel.order_front_regardless();
                        log(&setup_root, json!({
                            "event": "startup-action", "seq": 0, "action": "panel-show",
                            "value": {
                                "route": "tauri-nspanel",
                                "rev": "18ffb9a201fbf6fedfaa382fd4b92315ea30ab1a",
                                "note": "NSWindow 经 tauri-nspanel 在 runtime swizzle 为 NSPanel，属额外社区原生适配",
                                "style_mask": 1 << 7,
                                "collection_behavior": ["canJoinAllSpaces", "fullScreenAuxiliary"],
                                "hides_on_deactivate": false,
                                "becomes_key_only_if_needed": true,
                            },
                            "ok": true,
                        }));
                    }
                    Err(err) => {
                        log(&setup_root, json!({"event": "startup-failed", "action": "to-panel", "error": err.to_string()}));
                        process::exit(1);
                    }
                }
            } else {
                ok &= log_outcome(&setup_root, "startup-action", 0, "show", json!(true), window.show());
            }
            log(&setup_root, json!({"event": "shown", "ok": ok, "state": window_state(&window)}));

            start_command_thread(app.handle().clone(), setup_root.clone());
            let timeout_app = app.handle().clone();
            let timeout_root = setup_root.clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_secs(20 * 60));
                log(&timeout_root, json!({"event": "timeout-quit"}));
                timeout_app.exit(0);
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Tauri 启动失败");
}
