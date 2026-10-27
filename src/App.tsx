import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Chess, type Square } from 'chess.js'
import {
  Activity, ArrowDownToLine, BookOpen, BrainCircuit, Check, ChevronLeft,
  ChevronRight, ChevronsLeft, ChevronsRight, CircleHelp, Clipboard,
  Copy, Download, FlipHorizontal2, FolderOpen, Gauge, Layers3, LoaderCircle,
  PanelLeft, Play, RotateCcw, Settings2, ShieldCheck, SlidersHorizontal,
  Sparkles, Target, Upload, X
} from 'lucide-react'
import { defaultSession, START_FEN, STORAGE_KEY, type Analysis, type Candidate, type Session } from './types'
import { isSquare, loadPgnToSession, normalizeSession, pgnAtCursor, replay, sanForUci, toUci, uciMove } from './chess'

type ImportMode = 'pgn' | 'fen'
type PromotionChoice = { from: Square; to: Square }
type BackendDetails = {
  ready: boolean
  runtimePath: string
  legacyExists: boolean
  legacyPath: string
}
const PIECE_NAMES: Record<string, string> = { k: 'King', q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight', p: 'Pawn' }
const PIECE_FALLBACK: Record<string, string> = {
  wK: '♔', wQ: '♕', wR: '♖', wB: '♗', wN: '♘', wP: '♙',
  bK: '♚', bQ: '♛', bR: '♜', bB: '♝', bN: '♞', bP: '♟'
}

function loadLocal(): Session {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    return saved ? normalizeSession(JSON.parse(saved)) : normalizeSession(null)
  } catch { return normalizeSession(null) }
}
function humanWdl(candidate: Candidate) {
  return candidate.wdl.map(v => (v / 10).toFixed(1))
}
function displayError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
function hasInputFocus() {
  const target = document.activeElement
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
}

export default function App() {
  const [session, setSession] = useState<Session>(loadLocal)
  const [hydrated, setHydrated] = useState(false)
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [busy, setBusy] = useState(false)
  const [installed, setInstalled] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [cleaning, setCleaning] = useState(false)
  const [backendDetails, setBackendDetails] = useState<BackendDetails | null>(null)
  const [engineStatus, setEngineStatus] = useState('MODEL NOT LOADED')
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')
  const [selected, setSelected] = useState<Square | null>(null)
  const [promotion, setPromotion] = useState<PromotionChoice | null>(null)
  const [importMode, setImportMode] = useState<ImportMode | null>(null)
  const [importValue, setImportValue] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(true)
  const [setupOpen, setSetupOpen] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [activeCandidate, setActiveCandidate] = useState<string | null>(null)
  const reqRef = useRef(0)
  const { board, history, validMoves } = useMemo(
    () => replay(session.rootFen, session.moves, session.cursor),
    [session.rootFen, session.moves, session.cursor]
  )
  const cursor = Math.min(session.cursor, validMoves.length)
  const visibleMoves = validMoves.slice(0, cursor)
  const sideToMove = board.turn() === 'w' ? 'WHITE' : 'BLACK'
  const currentFen = board.fen()
  const moveNumber = Math.floor(cursor / 2) + 1
  const gameOver = board.isGameOver()

  const setValue = useCallback((transform: (s: Session) => Session) => {
    setSession(previous => {
      const next = transform(previous)
      // Synchronous fallback means the last move survives even if the user closes
      // the WebView before an asynchronous Rust disk write has completed.
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)) } catch { /* disk may be full */ }
      return next
    })
  }, [])

  useEffect(() => {
    let alive = true
    void Promise.all([
      invoke<Session | null>('load_session').catch(() => null),
      invoke<BackendDetails>('backend_details').catch(() => null)
    ]).then(([disk, details]) => {
      if (!alive) return
      if (!localStorage.getItem(STORAGE_KEY) && disk) setSession(normalizeSession(disk))
      setInstalled(Boolean(details?.ready))
      setBackendDetails(details)
      if (!details?.ready) {
        setSetupOpen(true)
        setEngineStatus('INSTALL REQUIRED')
      } else {
        setEngineStatus('READY TO ANALYZE')
      }
      setHydrated(true)
    })
    const unsubs: Array<() => void> = []
    void listen<string>('engine-status', e => { if (alive) setEngineStatus(e.payload) }).then(unlisten => unsubs.push(unlisten))
    void listen<{ stage: string; message: string }>('setup-progress', e => {
      if (alive) setEngineStatus(e.payload.message)
    }).then(unlisten => unsubs.push(unlisten))
    return () => { alive = false; unsubs.forEach(fn => fn()) }
  }, [])

  useEffect(() => {
    if (!hydrated) return
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(session)) } catch { /* no quota */ }
    void invoke('save_session', { session }).catch(() => { /* local synchronous copy remains */ })
  }, [session, hydrated])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 2400)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => { setSelected(null); setActiveCandidate(null) }, [currentFen])

  const performAnalysis = useCallback(async () => {
    const currentReq = ++reqRef.current
    setBusy(true)
    setError('')
    setEngineStatus('ANALYZING POSITION')
    try {
      const result = await invoke<Analysis>('analyze_position', {
        rootFen: session.rootFen,
        moves: session.moves.slice(0, session.cursor),
        settings: session.settings
      })
      if (currentReq !== reqRef.current) return
      setAnalysis(result)
      setEngineStatus('ENGINE READY · 79M')
    } catch (e) {
      if (currentReq !== reqRef.current) return
      setAnalysis(null)
      setError(displayError(e))
      setEngineStatus('ENGINE OFFLINE')
    } finally {
      if (currentReq === reqRef.current) setBusy(false)
    }
  }, [session.rootFen, session.moves, session.cursor, session.settings])

  useEffect(() => {
    reqRef.current += 1
    setAnalysis(null)
    setBusy(false)
    if (!hydrated || !installed || !session.autoAnalyze || installing || gameOver) return
    const timer = window.setTimeout(() => { void performAnalysis() }, 360)
    return () => {
      window.clearTimeout(timer)
      reqRef.current += 1
    }
  }, [hydrated, installed, session.autoAnalyze, performAnalysis, installing, gameOver])

  function applyUci(uci: string) {
    const clone = new Chess(board.fen())
    const move = uciMove(clone, uci)
    if (!move) { setToast('현재 포지션에서는 둘 수 없는 수입니다'); return }
    setValue(s => ({
      ...s,
      moves: [...s.moves.slice(0, s.cursor), toUci(move)],
      cursor: s.cursor + 1
    }))
    setPromotion(null)
    setSelected(null)
  }

  function attemptMove(from: Square, to: Square) {
    if (from === to) { setSelected(null); return }
    const piece = board.get(from)
    if (!piece || piece.color !== board.turn()) return
    const possible = board.moves({ square: from, verbose: true }).filter(move => move.to === to)
    if (!possible.length) return
    if (possible.some(move => !!move.promotion)) {
      setPromotion({ from, to })
      return
    }
    applyUci(from + to)
  }

  function clickSquare(square: Square) {
    if (promotion) return
    const piece = board.get(square)
    if (selected) {
      const targets = board.moves({ square: selected, verbose: true })
      if (targets.some(move => move.to === square)) {
        attemptMove(selected, square)
        return
      }
    }
    setSelected(piece && piece.color === board.turn() ? square : null)
  }

  function dropSquare(e: DragEvent<HTMLButtonElement>, square: Square) {
    e.preventDefault()
    const from = e.dataTransfer.getData('text/plain')
    if (isSquare(from)) attemptMove(from, square)
  }

  function jumpTo(next: number) {
    setValue(s => ({ ...s, cursor: Math.max(0, Math.min(s.moves.length, next)) }))
    setSelected(null)
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (hasInputFocus() || importMode || promotion || showHelp || event.ctrlKey || event.metaKey || event.altKey) return
      if (event.key === 'ArrowLeft') {
        event.preventDefault(); jumpTo(cursor - 1)
      } else if (event.key === 'ArrowRight') {
        event.preventDefault(); jumpTo(cursor + 1)
      } else if (event.key === 'Home') {
        event.preventDefault(); jumpTo(0)
      } else if (event.key === 'End') {
        event.preventDefault(); jumpTo(session.moves.length)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cursor, session.moves.length, importMode, promotion, showHelp])

  const legalTargets = useMemo(() => {
    if (!selected) return new Set<string>()
    return new Set(board.moves({ square: selected, verbose: true }).map(move => move.to))
  }, [board, selected])

  const lastUci = cursor > 0 ? session.moves[cursor - 1] : ''
  const lastFrom = lastUci.slice(0, 2)
  const lastTo = lastUci.slice(2, 4)
  const arrowUci = activeCandidate || analysis?.candidates[0]?.uci || null

  function squareCoordinates(square: string) {
    const file = square.charCodeAt(0) - 97
    const rank = Number(square[1]) - 1
    return {
      x: (session.orientation === 'w' ? file : 7 - file) * 100 + 50,
      y: (session.orientation === 'w' ? 7 - rank : rank) * 100 + 50
    }
  }

  function doImport() {
    try {
      if (importMode === 'pgn') {
        const result = loadPgnToSession(importValue.trim(), session)
        setValue(() => normalizeSession(result))
      } else {
        const fen = importValue.trim()
        new Chess(fen)
        setValue(s => ({ ...s, rootFen: fen, moves: [], cursor: 0 }))
      }
      setImportMode(null)
      setImportValue('')
      setToast('포지션을 불러왔습니다')
    } catch (e) {
      setError('포지션을 불러올 수 없습니다: ' + displayError(e))
    }
  }

  async function copyText(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value)
      setToast(label + ' 복사 완료')
    } catch {
      window.prompt('복사할 텍스트', value)
    }
  }

  function exportPgn() {
    const blob = new Blob([pgnAtCursor(session)], { type: 'application/x-chess-pgn;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'maia-studio-analysis.pgn'
    link.click()
    URL.revokeObjectURL(url)
    setToast('PGN을 내보냈습니다')
  }

  async function refreshBackend() {
    const details = await invoke<BackendDetails>('backend_details')
    setBackendDetails(details)
    setInstalled(details.ready)
    return details
  }

  async function installMaia() {
    if (installing || cleaning) return
    setInstalling(true)
    setError('')
    setSetupOpen(true)
    setEngineStatus('SETTING UP MAIA')
    try {
      await invoke<string>('install_backend', {
        pythonPath: session.settings.pythonPath,
        checkpointPath: session.settings.checkpointPath
      })
      await refreshBackend()
      setEngineStatus('MODEL INSTALLED')
      setToast('Maia3-79M 환경 검사 및 설치 완료')
      void performAnalysis()
    } catch (e) {
      setError(displayError(e))
      setEngineStatus('INSTALL FAILED')
      await refreshBackend().catch(() => {})
    } finally {
      setInstalling(false)
    }
  }

  async function cleanupLegacy() {
    if (cleaning || installing) return
    const consent = window.confirm(
      'v0.1.0에서 사용했던 Roaming\\com.gaong.maia.studio\\maia-python 폴더만 삭제합니다. 현재 실행 중인 이전 Maia/Python을 모두 종료했나요? 수순과 새 모델 환경은 삭제하지 않습니다.'
    )
    if (!consent) return
    setCleaning(true)
    setError('')
    try {
      await invoke<boolean>('cleanup_legacy_backend')
      await refreshBackend()
      setToast('v0.1.0의 이전 Python 폴더를 정리했습니다')
    } catch (e) {
      setError('이전 설치 폴더를 정리하지 못했습니다: ' + displayError(e))
    } finally {
      setCleaning(false)
    }
  }

  function setSetting<K extends keyof Session['settings']>(key: K, value: Session['settings'][K]) {
    setValue(s => ({ ...s, settings: { ...s.settings, [key]: value } }))
  }

  const statusName = gameOver
    ? board.isCheckmate() ? 'CHECKMATE' : 'GAME FINISHED'
    : board.isCheck() ? 'CHECK' : sideToMove + ' TO MOVE'

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-icon"><span>♞</span></div>
          <div className="brand-copy"><strong>MAIA<span>STUDIO</span></strong><small>HUMAN CHESS INTELLIGENCE</small></div>
        </div>
        <div className="header-center"><span className="header-separator" /><span className="header-label">ANALYSIS WORKSPACE</span><span className="header-version">V 0.1</span></div>
        <div className="header-right">
          <span className={'status-dot ' + (busy ? 'pulsing' : analysis ? 'online' : 'muted')} />
          <span className="header-engine-state">{engineStatus}</span>
          <span className="header-divider" />
          <button className="icon-button help-button" title="도움말" onClick={() => setShowHelp(true)}><CircleHelp size={18} /></button>
          <div className="profile-badge">M3</div>
        </div>
      </header>

      <div className="workspace">
        <aside className="sidebar">
          <div className="nav-group-label">WORKSPACE</div>
          <button className="nav-item active"><Activity size={19} /><span>Analysis</span><div className="nav-indicator" /></button>
          <button className="nav-item" onClick={() => { setImportMode('pgn'); setImportValue('') }}><BookOpen size={19} /><span>Import game</span></button>
          <button className="nav-item" onClick={() => { setSetupOpen(v => !v); setSettingsOpen(true) }}><Settings2 size={19} /><span>Engine setup</span></button>
          <div className="sidebar-divider" />
          <div className="nav-group-label">INTELLIGENCE</div>
          <div className="model-card">
            <div className="model-card-top"><div className="model-emblem"><BrainCircuit size={24} /></div><span className="model-tag">ACTIVE MODEL</span></div>
            <h3>Maia3 <span>79M</span></h3>
            <p>Human-like chess reasoning</p>
            <div className="model-spec"><span>PARAMETERS</span><b>79 million</b></div>
            <div className="model-spec"><span>ARCHITECTURE</span><b>Chessformer</b></div>
            <div className="model-spec"><span>SKILL TARGET</span><b>{session.settings.elo} Elo</b></div>
          </div>
          <div className="sidebar-bottom">
            <div className="save-info"><ShieldCheck size={16} /><span>SESSION AUTO-SAVED</span></div>
            <p>Every move. Every preference.<br />Ready when you return.</p>
          </div>
        </aside>

        <main className="board-column">
          <div className="section-head">
            <div><div className="eyebrow"><span className="mini-dash" /> THE BOARD</div><h1>Position Analysis<span className="small-star">✦</span></h1><p>Study the position through the eyes of human players.</p></div>
            <div className="board-head-actions">
              <button className="soft-button" onClick={() => setValue(s => ({ ...s, orientation: s.orientation === 'w' ? 'b' : 'w' }))}><FlipHorizontal2 size={17} /> Flip</button>
              <button className="soft-button" onClick={() => { setValue(s => ({ ...s, rootFen: START_FEN, moves: [], cursor: 0 })); setSelected(null) }}><RotateCcw size={16} /> New</button>
            </div>
          </div>

          <section className="board-surface">
            <div className="player-strip top-player">
              <div className="player-left"><div className="player-avatar dark-avatar">♚</div><div><strong>{session.orientation === 'w' ? 'Black' : 'White'}</strong><small>HUMAN PLAYER</small></div></div>
              <div className="player-elo"><Gauge size={15} /> {session.settings.elo}</div>
            </div>
            <div className="board-container">
              <div className="chessboard" role="grid" aria-label="Interactive chess analysis board">
                {Array.from({ length: 64 }, (_, index) => {
                  const row = Math.floor(index / 8)
                  const col = index % 8
                  const file = session.orientation === 'w' ? 'abcdefgh'[col] : 'hgfedcba'[col]
                  const rank = session.orientation === 'w' ? 8 - row : row + 1
                  const sq = (file + rank) as Square
                  const piece = board.get(sq)
                  const black = (row + col) % 2 === 1
                  const code = piece ? piece.color + piece.type.toUpperCase() : ''
                  return (
                    <button
                      key={sq}
                      role="gridcell"
                      aria-label={sq + (piece ? ' ' + (piece.color === 'w' ? 'White ' : 'Black ') + PIECE_NAMES[piece.type] : ' empty')}
                      className={'square ' + (black ? 'square-dark ' : 'square-light ') + (selected === sq ? 'selected ' : '') + (lastFrom === sq || lastTo === sq ? 'last-move ' : '')}
                      onClick={() => clickSquare(sq)}
                      onDragOver={e => e.preventDefault()}
                      onDrop={e => dropSquare(e, sq)}
                    >
                      {col === 0 && <span className="coord rank-coord">{rank}</span>}
                      {row === 7 && <span className="coord file-coord">{file}</span>}
                      {legalTargets.has(sq) && <span className={piece ? 'legal-capture' : 'legal-dot'} />}
                      {piece && <img className="piece" src={'/pieces/' + session.skin + '/' + code + '.svg'} draggable={piece.color === board.turn()} alt={code} onDragStart={e => { e.dataTransfer.setData('text/plain', sq); setSelected(sq) }} onError={e => { e.currentTarget.style.display = 'none'; const next = e.currentTarget.nextElementSibling; if (next instanceof HTMLElement) next.style.display = 'block' }} />}
                      {piece && <span className={'fallback-piece ' + (piece.color === 'w' ? 'white-piece' : 'black-piece')}>{PIECE_FALLBACK[code]}</span>}
                    </button>
                  )
                })}
                {arrowUci && isSquare(arrowUci.slice(0, 2)) && isSquare(arrowUci.slice(2, 4)) && !gameOver && (
                  <svg className="board-arrows" viewBox="0 0 800 800" aria-hidden="true">
                    <defs><marker id="move-arrow" markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto" markerUnits="strokeWidth"><path d="M0 0 L5 2.5 L0 5 z" fill="#d4ad61" /></marker></defs>
                    <line x1={squareCoordinates(arrowUci.slice(0, 2)).x} y1={squareCoordinates(arrowUci.slice(0, 2)).y} x2={squareCoordinates(arrowUci.slice(2, 4)).x} y2={squareCoordinates(arrowUci.slice(2, 4)).y} stroke="#d4ad61" strokeWidth="10" strokeOpacity=".72" strokeLinecap="round" markerEnd="url(#move-arrow)" />
                  </svg>
                )}
              </div>
            </div>
            <div className="player-strip bottom-player">
              <div className="player-left"><div className="player-avatar light-avatar">♔</div><div><strong>{session.orientation === 'w' ? 'White' : 'Black'}</strong><small>HUMAN PLAYER</small></div></div>
              <div className="turn-indicator"><span className="turn-dot" />{statusName}</div>
            </div>
          </section>

          <div className="board-toolbar">
            <div className="transport">
              <button title="Start" onClick={() => jumpTo(0)}><ChevronsLeft size={20} /></button>
              <button title="Previous move" onClick={() => jumpTo(cursor - 1)}><ChevronLeft size={20} /></button>
              <span className="ply-counter">{cursor} <i>/</i> {session.moves.length}</span>
              <button title="Next move" onClick={() => jumpTo(cursor + 1)}><ChevronRight size={20} /></button>
              <button title="Last move" onClick={() => jumpTo(session.moves.length)}><ChevronsRight size={20} /></button>
            </div>
            <div className="tool-actions">
              <button title="Copy FEN" onClick={() => void copyText(currentFen, 'FEN')}><Copy size={17} /></button>
              <button title="Import FEN / PGN" onClick={() => { setImportMode('fen'); setImportValue(currentFen) }}><Upload size={18} /></button>
              <button title="Export PGN" onClick={exportPgn}><Download size={18} /></button>
            </div>
          </div>

          <div className="fen-panel"><span>FEN</span><code title={currentFen}>{currentFen}</code><button title="Copy FEN" onClick={() => void copyText(currentFen, 'FEN')}><Clipboard size={15} /></button></div>
          <div className="board-footer"><span><span className="footer-led" /> All changes saved locally</span><span>MOVE {moveNumber} · {sideToMove}</span></div>
        </main>

        <aside className="inspector">
          <section className="inspector-section analysis-section">
            <div className="inspector-title"><div><span className="eyebrow">LIVE INTELLIGENCE</span><h2><BrainCircuit size={19} /> Maia Analysis</h2></div><div className="engine-chip"><span /> 79M</div></div>
            <div className="analysis-meta">
              <div className="metric"><span>SKILL LEVEL</span><strong>{session.settings.elo} <small>ELO</small></strong></div>
              <div className="metric"><span>TEMPERATURE</span><strong>{session.settings.temperature.toFixed(2)} <small>TEMP</small></strong></div>
            </div>
            <div className="analysis-heading"><span>HUMAN MOVE CANDIDATES</span><span>W / D / L</span></div>
            <div className="candidate-list">
              {busy && !analysis && <div className="analysis-empty"><LoaderCircle className="spin" size={26} /><strong>Analyzing position</strong><span>Human move predictions incoming…</span></div>}
              {!busy && !analysis && <div className="analysis-empty"><Sparkles size={27} /><strong>Explore this position</strong><span>{!installed ? 'Install Maia3-79M from Engine Controls first.' : error ? 'Engine setup may be needed.' : 'Maia predictions appear here.'}</span><button disabled={!installed} onClick={() => void performAnalysis()}><Play size={13} /> Analyze now</button></div>}
              {analysis && analysis.candidates.length === 0 && <div className="analysis-empty"><Target size={26} /><strong>End of position</strong><span>No legal move candidates.</span></div>}
              {analysis?.candidates.map((candidate, index) => {
                const [w, d, l] = humanWdl(candidate)
                return (
                  <button key={candidate.uci + candidate.rank} className={'candidate ' + (activeCandidate === candidate.uci ? 'candidate-active' : '')} onMouseEnter={() => setActiveCandidate(candidate.uci)} onMouseLeave={() => setActiveCandidate(null)} onClick={() => applyUci(candidate.uci)}>
                    <div className="candidate-top"><span className={'candidate-order ' + (index === 0 ? 'best-rank' : '')}>{String(candidate.rank).padStart(2, '0')}</span><strong>{sanForUci(board, candidate.uci)}</strong><span className="candidate-uci">{candidate.uci}</span>{index === 0 && <span className="top-choice">TOP</span>}</div>
                    <div className="wdl-bar"><i className="win-bar" style={{ width: w + '%' }} /><i className="draw-bar" style={{ width: d + '%' }} /><i className="loss-bar" style={{ width: l + '%' }} /></div>
                    <div className="wdl-labels"><span>{w}%</span><span>{d}%</span><span>{l}%</span></div>
                  </button>
                )
              })}
            </div>
            {analysis?.bestmove && <div className="sampled-move"><span>SAMPLED MOVE</span><strong>{sanForUci(board, analysis.bestmove)}</strong><button title="Play sampled move" onClick={() => applyUci(analysis.bestmove!)}><ArrowDownToLine size={15} /></button></div>}
            <div className="analysis-buttons">
              <button className="primary-button" disabled={!installed || busy || installing || gameOver} onClick={() => void performAnalysis()}>{busy ? <LoaderCircle size={16} className="spin" /> : <Activity size={16} />}{busy ? 'Analyzing…' : 'Analyze position'}</button>
              <button className={'toggle-button ' + (session.autoAnalyze ? 'toggle-active' : '')} title="Auto analyze" onClick={() => setValue(s => ({ ...s, autoAnalyze: !s.autoAnalyze }))}><span className="toggle-track"><i /></span><small>AUTO</small></button>
            </div>
            <p className="analysis-disclaimer"><CircleHelp size={13} /> WDL estimates human game outcomes, not search evaluations. Elo conditions predictions, not engine strength.</p>
          </section>

          <section className="inspector-section moves-section">
            <div className="inspector-title compact"><div><span className="eyebrow">GAME JOURNAL</span><h2><BookOpen size={18} /> Move History</h2></div><span className="move-count">{history.length} PLY</span></div>
            <div className="move-ledger">
              {history.length === 0 && <div className="no-moves">Your game begins here.<br />Play a move on the board.</div>}
              {Array.from({ length: Math.ceil(history.length / 2) }, (_, i) => (
                <div className="move-row" key={i}><span className="move-index">{i + 1}.</span>
                  {history.slice(i * 2, i * 2 + 2).map(entry => (
                    <button key={entry.ply} onClick={() => jumpTo(entry.ply)} className={'move-cell ' + (cursor === entry.ply ? 'move-current' : '')}>{entry.san}</button>
                  ))}
                </div>
              ))}
            </div>
          </section>

          <section className="inspector-section controls-section">
            <button className="settings-header" onClick={() => setSettingsOpen(v => !v)}><span><SlidersHorizontal size={18} /> Engine Controls</span><span>{settingsOpen ? '−' : '+'}</span></button>
            {settingsOpen && <div className="settings-body">
              <label className="slider-label" htmlFor="elo"><span>Playing style / Elo</span><strong>{session.settings.elo}</strong></label>
              <input id="elo" aria-label="Elo" type="range" min="0" max="3500" step="50" value={session.settings.elo} onChange={e => setSetting('elo', Number(e.target.value))} />
              <div className="range-hints"><span>BEGINNER</span><span>MASTER</span></div>
              <label className="slider-label" htmlFor="temperature"><span>Temperature</span><strong>{session.settings.temperature.toFixed(2)}</strong></label>
              <input id="temperature" aria-label="Temperature" type="range" min="0" max="3" step=".05" value={session.settings.temperature} onChange={e => setSetting('temperature', Number(e.target.value))} />
              <div className="range-hints"><span>DETERMINISTIC</span><span>EXPLORATORY</span></div>
              <div className="input-row"><label htmlFor="multipv">Candidate lines</label><select id="multipv" value={session.settings.multipv} onChange={e => setSetting('multipv', Number(e.target.value))}>{[1, 3, 5, 8, 10, 15, 20].map(n => <option key={n} value={n}>{n} moves</option>)}</select></div>
              <div className="input-row"><label htmlFor="skin">Piece set</label><select id="skin" value={session.skin} onChange={e => setValue(s => ({ ...s, skin: e.target.value === 'rhosgfx' ? 'rhosgfx' : 'chessnut' }))}><option value="chessnut">Lichess · Chessnut</option><option value="rhosgfx">Lichess · RhosGFX</option></select></div>
              <button className="advanced-link" onClick={() => setSetupOpen(v => !v)}><FolderOpen size={14} /> Python & checkpoint configuration <span>{setupOpen ? '−' : '+'}</span></button>
              {setupOpen && <div className="setup-box">
                <label>Python executable (optional)</label>
                <input value={session.settings.pythonPath} placeholder="python or C:\\Python311\\python.exe" onChange={e => setSetting('pythonPath', e.target.value)} />
                <label>Local Maia3-79M checkpoint (optional)</label>
                <input value={session.settings.checkpointPath} placeholder="C:\\models\\maia3-79m.pt" onChange={e => setSetting('checkpointPath', e.target.value)} />
                <button className="setup-button" onClick={() => void installMaia()} disabled={installing || cleaning}>{installing ? <LoaderCircle size={15} className="spin" /> : <Download size={15} />}{installing ? 'Installing / verifying…' : installed ? 'Verify / repair Maia3-79M' : 'Install Maia3-79M environment'}</button>
                <p>Needs Python 3.10+ for the first setup. Maia3 and PyTorch are installed separately from the app. Reinstalling the EXE preserves the runtime and downloaded checkpoint.</p>
                {backendDetails && <div className="runtime-location"><strong>INDEPENDENT RUNTIME LOCATION</strong><code title={backendDetails.runtimePath}>{backendDetails.runtimePath}</code><span>{backendDetails.ready ? '● Verified environment' : '○ Not installed or incomplete'}</span></div>}
                {backendDetails?.legacyExists && <div className="legacy-warning">
                  <strong>Old v0.1.0 Python environment detected</strong>
                  <p>The old runtime was stored inside Roaming app data. This could prevent uninstall. New Maia installs use an independent directory. Finish setting up the new runtime before cleaning the old one.</p>
                  <button className="legacy-cleanup" disabled={!installed || cleaning || installing} onClick={() => void cleanupLegacy()}>{cleaning ? <LoaderCircle className="spin" size={14} /> : <RotateCcw size={14} />} {cleaning ? 'Removing old files…' : 'Clean old v0.1.0 Python files'}</button>
                  <code title={backendDetails.legacyPath}>{backendDetails.legacyPath}</code>
                </div>}
              </div>}
            </div>}
          </section>
        </aside>
      </div>

      {error && <div className="error-banner"><div><strong>Maia needs attention</strong><span>{error}</span></div><button onClick={() => { setSetupOpen(true); setSettingsOpen(true); setError('') }}>Setup</button><button onClick={() => setError('')} title="Dismiss"><X size={17} /></button></div>}
      {toast && <div className="toast"><Check size={15} />{toast}</div>}

      {promotion && <div className="modal-backdrop" onClick={() => setPromotion(null)}><div className="promotion-dialog" onClick={e => e.stopPropagation()}><div className="modal-kicker">PROMOTION</div><h2>Choose your piece</h2><div className="promotion-grid">{(['q', 'r', 'b', 'n'] as const).map(p => {
        const code = board.turn() + p.toUpperCase()
        return <button key={p} onClick={() => applyUci(promotion.from + promotion.to + p)}><span>{PIECE_FALLBACK[code]}</span>{PIECE_NAMES[p]}</button>
      })}</div><button className="modal-cancel" onClick={() => setPromotion(null)}>Cancel</button></div></div>}

      {importMode && <div className="modal-backdrop" onClick={() => setImportMode(null)}><div className="import-dialog" onClick={e => e.stopPropagation()}><div className="modal-head"><div><span className="modal-kicker">LOAD A POSITION</span><h2>Import to workspace</h2></div><button className="icon-button" onClick={() => setImportMode(null)}><X size={19} /></button></div><div className="import-tabs"><button className={importMode === 'fen' ? 'tab-active' : ''} onClick={() => { setImportMode('fen'); setImportValue(currentFen) }}>FEN</button><button className={importMode === 'pgn' ? 'tab-active' : ''} onClick={() => { setImportMode('pgn'); setImportValue('') }}>PGN</button></div><textarea rows={6} value={importValue} onChange={e => setImportValue(e.target.value)} placeholder={importMode === 'fen' ? START_FEN : '1. e4 e5 2. Nf3 Nc6 3. Bb5'} /><p>This replaces the current board position. Your changes are automatically saved.</p><button className="primary-button import-submit" onClick={doImport}><Upload size={17} /> Import {importMode.toUpperCase()}</button></div></div>}

      {showHelp && <div className="modal-backdrop" onClick={() => setShowHelp(false)}><div className="import-dialog help-dialog" onClick={e => e.stopPropagation()}><div className="modal-head"><div><span className="modal-kicker">ABOUT THE LAB</span><h2>Maia Studio</h2></div><button className="icon-button" onClick={() => setShowHelp(false)}><X size={19} /></button></div><p>Maia3-79M models which moves real human players may choose. Candidate lines are ranked by Maia's move policy; WDL bars are predicted outcomes after each move, from the moving player's perspective.</p><p>Change Elo, Temperature or MultiPV and the analysis refreshes without restarting the model. Temperature changes move sampling, not a Stockfish-like depth or strength setting.</p><p>Click or drag pieces to move. Use the ← / → arrow keys to review the line. Click a candidate to play it. Import FEN/PGN or export the current PGN. All moves and preferences are saved across restarts.</p><p>Maia3 code and weights: CSSLab · AGPL-3.0. Lichess Chessnut and RhosGFX piece sets are used with their respective licenses. This GUI is not affiliated with Chess.com.</p><button className="primary-button import-submit" onClick={() => setShowHelp(false)}>Got it</button></div></div>}
    </div>
  )
}
