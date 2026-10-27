use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;
use tokio::time::{timeout, Instant};

const START_FEN: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const CHECKPOINT_MODEL: &str = "maia3-79m";

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EngineSettings {
    elo: i32,
    temperature: f64,
    top_p: f64,
    multipv: u8,
    #[serde(default)]
    python_path: String,
    #[serde(default)]
    checkpoint_path: String,
}

impl EngineSettings {
    fn validate(&self) -> Result<(), String> {
        if !(0..=5000).contains(&self.elo) {
            return Err("Elo는 0~5000 범위여야 합니다.".into());
        }
        if !self.temperature.is_finite() || !(0.0..=3.0).contains(&self.temperature) {
            return Err("Temperature는 0~3 범위여야 합니다.".into());
        }
        if !self.top_p.is_finite() || !(0.1..=1.0).contains(&self.top_p) {
            return Err("TopP는 0.1~1.0 범위여야 합니다.".into());
        }
        if !(1..=20).contains(&self.multipv) {
            return Err("MultiPV는 1~20 범위여야 합니다.".into());
        }
        Ok(())
    }

    fn signature(&self, python: &Path) -> String {
        format!("{}::{}", python.display(), self.checkpoint_path.trim())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    rank: u8,
    uci: String,
    cp: i32,
    wdl: [i32; 3],
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Analysis {
    candidates: Vec<Candidate>,
    bestmove: Option<String>,
    model: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SetupProgress {
    stage: String,
    message: String,
}

struct UciEngine {
    child: Child,
    stdin: ChildStdin,
    stdout: Lines<BufReader<ChildStdout>>,
    signature: String,
    diagnostics: Arc<Mutex<String>>,
}

#[derive(Default)]
pub struct AppState {
    engine: Mutex<Option<UciEngine>>,
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let path = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(path)
}

fn venv_python(app: &AppHandle) -> Result<PathBuf, String> {
    let root = data_dir(app)?.join("maia-python");
    #[cfg(windows)]
    return Ok(root.join("Scripts").join("python.exe"));
    #[cfg(not(windows))]
    return Ok(root.join("bin").join("python"));
}

fn requested_python(path: &str) -> PathBuf {
    let path = path.trim();
    if path.is_empty() {
        PathBuf::from("python")
    } else {
        PathBuf::from(path)
    }
}

fn python_cmd(python: &Path) -> Command {
    let mut cmd = Command::new(python);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.as_std_mut().creation_flags(0x0800_0000);
    }
    cmd
}

fn engine_python(app: &AppHandle, settings: &EngineSettings) -> Result<PathBuf, String> {
    let venv = venv_python(app)?;
    if venv.exists() {
        Ok(venv)
    } else {
        Ok(requested_python(&settings.python_path))
    }
}

async fn read_until(engine: &mut UciEngine, expected: &str, seconds: u64) -> Result<Vec<String>, String> {
    let deadline = Instant::now() + Duration::from_secs(seconds);
    let mut lines = Vec::new();
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            let log = engine.diagnostics.lock().await.clone();
            return Err(format!("Maia 응답 시간 초과 ({}). {}", expected, log));
        }
        match timeout(remaining, engine.stdout.next_line()).await {
            Ok(Ok(Some(line))) => {
                let done = line.trim() == expected
                    || (expected == "bestmove" && line.starts_with("bestmove "));
                lines.push(line);
                if done {
                    return Ok(lines);
                }
            }
            Ok(Ok(None)) => {
                let log = engine.diagnostics.lock().await.clone();
                return Err(format!("Maia 엔진이 종료되었습니다. {}", log));
            }
            Ok(Err(e)) => return Err(format!("엔진 출력 읽기 실패: {}", e)),
            Err(_) => {
                let log = engine.diagnostics.lock().await.clone();
                return Err(format!("Maia 응답 시간 초과 ({}). {}", expected, log));
            }
        }
    }
}

async fn send(engine: &mut UciEngine, line: &str) -> Result<(), String> {
    engine.stdin.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;
    engine.stdin.write_all(b"\n").await.map_err(|e| e.to_string())?;
    engine.stdin.flush().await.map_err(|e| e.to_string())
}

async fn start_engine(app: &AppHandle, settings: &EngineSettings, python: &Path) -> Result<UciEngine, String> {
    let mut cmd = python_cmd(python);
    cmd.arg("-u")
        .args(["-m", "maia3.uci", "--model", CHECKPOINT_MODEL, "--use-uci-history"]);
    if !settings.checkpoint_path.trim().is_empty() {
        cmd.arg("--checkpoint-path").arg(settings.checkpoint_path.trim());
    }
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| format!(
        "Python 실행 실패 ({}): {}. 환경 설치 버튼을 누르거나 Python 경로를 확인하세요.",
        python.display(), e
    ))?;
    let stdin = child.stdin.take().ok_or("UCI stdin을 열지 못했습니다.")?;
    let stdout = child.stdout.take().ok_or("UCI stdout을 열지 못했습니다.")?;
    let stderr = child.stderr.take().ok_or("UCI stderr를 열지 못했습니다.")?;
    let diagnostics = Arc::new(Mutex::new(String::new()));
    let diag_copy = Arc::clone(&diagnostics);
    let app_copy = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            {
                let mut diag = diag_copy.lock().await;
                diag.push_str(&line);
                diag.push('\n');
                if diag.len() > 2500 {
                    let start = diag.len() - 2000;
                    let boundary = diag.ceil_char_boundary(start);
                    *diag = diag[boundary..].to_string();
                }
            }
            let _ = app_copy.emit("engine-log", line);
        }
    });
    let mut engine = UciEngine {
        child, stdin, stdout: BufReader::new(stdout).lines(),
        signature: settings.signature(python),
        diagnostics,
    };
    send(&mut engine, "uci").await?;
    read_until(&mut engine, "uciok", 30).await?;
    let _ = app.emit("engine-status", "Maia3-79M 체크포인트를 확인하고 모델을 로딩하는 중…");
    send(&mut engine, "isready").await?;
    read_until(&mut engine, "readyok", 900).await?;
    let _ = app.emit("engine-status", "Maia3-79M 모델 준비 완료");
    Ok(engine)
}

fn allowed_fen(fen: &str) -> bool {
    fen.split_whitespace().count() == 6
        && fen.len() < 160
        && fen.chars().all(|c| c.is_ascii_alphanumeric() || c == '/' || c == '-' || c == ' ')
}

fn allowed_move(mv: &str) -> bool {
    let b = mv.as_bytes();
    (b.len() == 4 || b.len() == 5)
        && (b'a'..=b'h').contains(&b[0]) && (b'1'..=b'8').contains(&b[1])
        && (b'a'..=b'h').contains(&b[2]) && (b'1'..=b'8').contains(&b[3])
        && (b.len() == 4 || b"qrbn".contains(&b[4]))
}

fn after_token<'a>(tokens: &'a [&str], name: &str) -> Option<&'a str> {
    tokens.windows(2).find(|pair| pair[0] == name).map(|pair| pair[1])
}

fn parse_candidate(line: &str) -> Option<Candidate> {
    if !line.starts_with("info ") {
        return None;
    }
    let parts: Vec<&str> = line.split_whitespace().collect();
    let rank = after_token(&parts, "multipv")?.parse().ok()?;
    let uci = after_token(&parts, "pv")?.to_string();
    if !allowed_move(&uci) {
        return None;
    }
    let cp = after_token(&parts, "cp")?.parse().ok()?;
    let i = parts.iter().position(|p| *p == "wdl")?;
    let wdl = [
        parts.get(i + 1)?.parse().ok()?,
        parts.get(i + 2)?.parse().ok()?,
        parts.get(i + 3)?.parse().ok()?,
    ];
    Some(Candidate { rank, uci, cp, wdl })
}

#[tauri::command]
async fn analyze_position(
    app: AppHandle,
    state: State<'_, AppState>,
    root_fen: String,
    moves: Vec<String>,
    settings: EngineSettings,
) -> Result<Analysis, String> {
    settings.validate()?;
    if !allowed_fen(&root_fen) || moves.len() > 600 || !moves.iter().all(|m| allowed_move(m)) {
        return Err("잘못된 FEN 또는 UCI 수순입니다.".into());
    }
    let python = engine_python(&app, &settings)?;
    let signature = settings.signature(&python);
    let mut engine_guard = state.engine.lock().await;
    let needs_start = engine_guard.as_ref().map_or(true, |e| e.signature != signature);
    if needs_start {
        if let Some(mut old) = engine_guard.take() {
            let _ = old.child.kill().await;
        }
        *engine_guard = Some(start_engine(&app, &settings, &python).await?);
    }
    let engine = engine_guard.as_mut().ok_or("엔진 초기화 실패")?;
    let result = async {
        send(engine, &format!("setoption name Elo value {}", settings.elo)).await?;
        send(engine, &format!("setoption name Temperature value {:.3}", settings.temperature)).await?;
        send(engine, &format!("setoption name TopP value {:.3}", settings.top_p)).await?;
        send(engine, &format!("setoption name MultiPV value {}", settings.multipv)).await?;

        let mut position = if root_fen == START_FEN {
            "position startpos".to_string()
        } else {
            format!("position fen {}", root_fen)
        };
        if !moves.is_empty() {
            position.push_str(" moves ");
            position.push_str(&moves.join(" "));
        }
        send(engine, &position).await?;
        send(engine, "go").await?;
        let output = read_until(engine, "bestmove", 180).await?;
        let mut candidates: Vec<Candidate> = output.iter().filter_map(|l| parse_candidate(l)).collect();
        candidates.sort_by_key(|c| c.rank);
        let bestmove = output.iter().rev().find_map(|l| {
            l.strip_prefix("bestmove ").and_then(|rest| {
                let mv = rest.split_whitespace().next()?.to_string();
                if allowed_move(&mv) { Some(mv) } else { None }
            })
        });
        Ok(Analysis {
            candidates,
            bestmove,
            model: "Maia3-79M".to_string(),
        })
    }.await;
    if result.is_err() {
        // A broken UCI session must not be reused on the next request.
        if let Some(mut old) = engine_guard.take() {
            let _ = old.child.kill().await;
        }
    }
    result
}

async fn setup_command(app: &AppHandle, stage: &str, message: &str, mut cmd: Command) -> Result<(), String> {
    let _ = app.emit("setup-progress", SetupProgress { stage: stage.into(), message: message.into() });
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let result = timeout(Duration::from_secs(1800), cmd.output()).await
        .map_err(|_| format!("{} 단계가 시간 초과되었습니다.", stage))?
        .map_err(|e| format!("{} 실행 실패: {}", stage, e))?;
    if !result.status.success() {
        let err = String::from_utf8_lossy(&result.stderr);
        let out = String::from_utf8_lossy(&result.stdout);
        return Err(format!("{} 실패 ({}): {} {}", stage, result.status,
            err.chars().rev().take(1300).collect::<String>().chars().rev().collect::<String>(),
            out.chars().rev().take(500).collect::<String>().chars().rev().collect::<String>()));
    }
    Ok(())
}

#[tauri::command]
async fn install_backend(app: AppHandle, state: State<'_, AppState>, python_path: String) -> Result<String, String> {
    {
        let mut guard = state.engine.lock().await;
        if let Some(mut engine) = guard.take() {
            let _ = engine.child.kill().await;
        }
    }
    let venv = data_dir(&app)?.join("maia-python");
    let vpy = venv_python(&app)?;
    if !vpy.exists() {
        let python = requested_python(&python_path);
        let mut cmd = python_cmd(&python);
        cmd.arg("-m").arg("venv").arg(&venv);
        setup_command(&app, "venv", "독립된 Python 환경을 생성하는 중…", cmd).await?;
    }
    let mut cmd = python_cmd(&vpy);
    cmd.args([
        "-m", "pip", "install", "--disable-pip-version-check",
        "https://github.com/CSSLab/maia3/archive/refs/heads/main.zip"
    ]);
    setup_command(&app, "dependencies", "공식 Maia3 및 PyTorch 의존성을 설치하는 중…", cmd).await?;

    let mut cmd = python_cmd(&vpy);
    cmd.args(["-m", "maia3.cache", "--model", CHECKPOINT_MODEL]);
    setup_command(&app, "checkpoint", "Hugging Face에서 Maia3-79M 체크포인트를 캐시하는 중… (약 316MB)", cmd).await?;
    let _ = app.emit("setup-progress", SetupProgress {
        stage: "done".into(), message: "Maia3-79M 준비 완료".into()
    });
    Ok(vpy.to_string_lossy().to_string())
}

#[tauri::command]
fn backend_status(app: AppHandle) -> Result<bool, String> {
    Ok(venv_python(&app)?.exists())
}

#[tauri::command]
fn load_session(app: AppHandle) -> Result<Option<Value>, String> {
    let path = data_dir(&app)?.join("session.json");
    if !path.exists() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let parsed = serde_json::from_str::<Value>(&content).map_err(|e| e.to_string())?;
    Ok(Some(parsed))
}

#[tauri::command]
fn save_session(app: AppHandle, session: Value) -> Result<(), String> {
    let data = serde_json::to_vec(&session).map_err(|e| e.to_string())?;
    if data.len() > 2_000_000 {
        return Err("세션이 너무 큽니다.".into());
    }
    let path = data_dir(&app)?.join("session.json");
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, data).map_err(|e| e.to_string())?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    std::fs::rename(tmp, path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parse_maia_multipv() {
        let item = parse_candidate("info depth 1 multipv 2 score cp -54 wdl 210 350 440 pv e2e4").unwrap();
        assert_eq!(item.rank, 2);
        assert_eq!(item.uci, "e2e4");
        assert_eq!(item.wdl, [210, 350, 440]);
    }
    #[test]
    fn reject_injected_commands() {
        assert!(!allowed_move("e2e4\nquit"));
        assert!(!allowed_fen("startpos\nquit"));
        assert!(allowed_fen(START_FEN));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            analyze_position, install_backend, backend_status, load_session, save_session
        ])
        .run(tauri::generate_context!())
        .expect("Maia Studio startup failed");
}
