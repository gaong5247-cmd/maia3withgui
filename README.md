# Maia Studio

**A premium, analysis-first Windows chess GUI for the official [Maia3-79M](https://huggingface.co/UofTCSSLab/Maia3-79M) human move prediction model.** Built with Rust + Tauri 2 and React/TypeScript.

> This GUI drives CSSLab's real Maia3 UCI engine. No fabricated engine evaluations or simulated model output. Maia3 produces **human move candidates and predicted WDL**, not Stockfish-like deep-search evaluations.

## Download

**[Windows releases](https://github.com/gaong5247-cmd/maia3withgui/releases)** — download the latest **NSIS setup .exe** (or plain .exe if included). A first-run Maia backend installation is required.

**Requirements:** Windows 10/11 x64, Microsoft WebView2, Python **3.10+**, working internet on first setup, and several GB of free disk space for PyTorch and the 316MB Maia3-79M checkpoint. After setup, locally cached checkpoints can be reused without redownloading. The lightweight Tauri EXE does *not* contain PyTorch/Python/the checkpoint.

### First-time setup

1. Download and run the Windows installer from Releases.
2. Open **Engine Controls → Python & checkpoint configuration**.
3. If Python is not on PATH, specify its executable in **Python executable** (such as `C:\\Python311\\python.exe`).
4. Click **Install Maia3-79M environment**. Maia Studio creates its own virtual environment inside the application data folder, installs [CSSLab/maia3](https://github.com/CSSLab/maia3) and its dependencies, and caches the official 79M weights via Hugging Face.
5. Click **Analyze position** (or leave Auto enabled). The first engine launch initializes the model; subsequent analyses reuse the same process.

If you have a trusted **local** 79M checkpoint, enter its path in the checkpoint field. The app still uses the **79M architecture preset**.

**Environment note:** The app uses the installed venv when present, otherwise the configured system Python. Installation relies on the official GitHub source ZIP and the Python packaging index. For machines without Python, install Python 3.10+ first.

## Features

- Real Maia3-79M model analysis via **UCI**, including **up to 20 MultiPV candidates** and per-candidate WDL bars.
- Elo (0–5000 in the UCI engine; slider targets 0–3500), Temperature (0–3), MultiPV, TopP (backend), and advanced Python/checkpoint settings.
- Elo/Temperature changes are applied through UCI `setoption` and automatically reanalyzed **without model restart**.
- Beautiful interactive chessboard: click / drag to play, promotion choice, move arrows, white/black rotation, and full legal move validation using chess.js.
- Navigable move history, keyboard navigation (←, →, Home, End), branch from an earlier move, PGN import/export and FEN import/copy.
- **Session persistence:** every move, cursor position, analysis settings and visual preferences are saved synchronously to the local WebView store with a second app-data JSON copy; closing and reopening the EXE restores the session.
- Two licensed Lichess piece skins: Chessnut (Apache-2.0) and RhosGFX (CC0). Official Chess.com artwork is *not* bundled without verified redistribution permission.

## Development

Requires Node.js 20+, Rust stable, and [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

```powershell
git clone https://github.com/gaong5247-cmd/maia3withgui
cd maia3withgui
npm install
npm run assets
npx tauri icon assets/app-icon.svg
npm run tauri dev
```

Release build locally:

```powershell
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri build
```

The GitHub Actions workflow runs the same checks and publishes a **prerelease** with a Windows NSIS installer and plain executable when it succeeds. The plain executable still requires the Python backend and WebView2.

## How Maia analysis differs from Stockfish

The **candidate ranking** comes from the human-move policy head at the configured rating; the **WDL bars** are the model's predicted human-game outcomes after a move. The original UCI compatibility `score cp` is calculated from WDL and is **not** a searched centipawn evaluation. Lower temperatures tend toward deterministic/argmax selection; higher temperatures increase sampling diversity. **Elo is a conditioning input, not a guaranteed calibrated playing strength.** For tactical engine search, add a dedicated search engine separately.

## Security and licensing

The Tauri/Rust process starts Python directly with explicit arguments (no shell command interpolation), validates FEN and UCI move text, and stores user sessions in the platform's application-data directory. Model downloads and Python installs are initiated by the user.

The GUI source is MIT licensed. The separate Maia3 code and model are AGPL-3.0 licensed. See [THIRD_PARTY.md](THIRD_PARTY.md) for piece assets and acknowledgements. Maia Studio is an independent project, unaffiliated with CSSLab, Lichess or Chess.com.
