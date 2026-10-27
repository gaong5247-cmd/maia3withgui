# Third-party components and licensing

- Maia3 code: https://github.com/CSSLab/maia3 — AGPL-3.0, installed into a separate user-controlled Python environment; NOT copied into this repository.
- Maia3-79M checkpoint: https://huggingface.co/UofTCSSLab/Maia3-79M — AGPL-3.0. Downloaded to the Hugging Face cache on setup; not bundled in the installer.
- Lichess Chessnut pieces: https://github.com/lichess-org/lila/tree/master/public/piece/chessnut — Alexis Luengas, Apache-2.0.
- Lichess RhosGFX pieces: https://github.com/lichess-org/lila/tree/master/public/piece/rhosgfx — RhosGFX, CC0-1.0.
- Lichess asset credit/license index: https://github.com/lichess-org/lila/blob/master/COPYING.md
- chess.js: https://github.com/jhlywa/chess.js — BSD-2-Clause.
- React, Vite, Tauri and Lucide maintain their upstream licenses.

Chess.com official graphics are *not* redistributed because no redistributable license for those files has been established. The second locally bundled skin is Lichess RhosGFX, not Chess.com artwork.

The GUI is independent, not affiliated with Lichess, Chess.com or Maia's authors. Maia's Elo setting conditions human-move predictions; it is not a certified playing strength. Maia WDL is a model-predicted human result, not search-based centipawns.
