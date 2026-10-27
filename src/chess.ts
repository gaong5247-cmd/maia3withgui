import { Chess, type Move, type Square } from 'chess.js'
import { defaultSession, START_FEN, type Session } from './types'

export type HistoryEntry = { ply: number; san: string; uci: string; fen: string }
export type Replay = {
  board: Chess
  history: HistoryEntry[]
  validMoves: string[]
  cursor: number
}

export function uciMove(board: Chess, uci: string): Move | null {
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return null
  try {
    return board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' })
  } catch {
    return null
  }
}

export function replay(rootFen: string, moves: string[], cursor: number): Replay {
  let board: Chess
  try { board = new Chess(rootFen) } catch { board = new Chess(START_FEN) }
  const history: HistoryEntry[] = []
  const validMoves: string[] = []
  for (const uci of moves.slice(0, 600)) {
    const move = uciMove(board, uci)
    if (!move) break
    validMoves.push(uci)
    history.push({ ply: history.length + 1, san: move.san, uci, fen: board.fen() })
  }
  const safeCursor = Math.min(Math.max(0, cursor), validMoves.length)
  try { board = new Chess(rootFen) } catch { board = new Chess(START_FEN) }
  for (let i = 0; i < safeCursor; i++) uciMove(board, validMoves[i])
  return { board, history, validMoves, cursor: safeCursor }
}

function num(value: unknown, fallback: number, min: number, max: number) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback
}

export function normalizeSession(raw: unknown): Session {
  if (!raw || typeof raw !== 'object') return { ...defaultSession, settings: { ...defaultSession.settings } }
  const s = raw as Partial<Session>
  const rootFen = typeof s.rootFen === 'string' ? s.rootFen : START_FEN
  let safeFen = rootFen
  try { new Chess(rootFen) } catch { safeFen = START_FEN }
  const result = replay(
    safeFen,
    Array.isArray(s.moves) ? s.moves.filter((m): m is string => typeof m === 'string') : [],
    Number.isFinite(s.cursor) ? Number(s.cursor) : 0
  )
  const settings = s.settings || defaultSession.settings
  return {
    rootFen: safeFen,
    moves: result.validMoves,
    cursor: result.cursor,
    orientation: s.orientation === 'b' ? 'b' : 'w',
    skin: s.skin === 'rhosgfx' ? 'rhosgfx' : 'chessnut',
    autoAnalyze: s.autoAnalyze !== false,
    settings: {
      elo: Math.round(num(settings.elo, 1500, 0, 5000)),
      temperature: num(settings.temperature, 1, 0, 3),
      topP: num(settings.topP, 1, 0.1, 1),
      multipv: Math.round(num(settings.multipv, 5, 1, 20)),
      pythonPath: typeof settings.pythonPath === 'string' ? settings.pythonPath : '',
      checkpointPath: typeof settings.checkpointPath === 'string' ? settings.checkpointPath : ''
    }
  }
}

export function toUci(move: Move): string {
  return move.from + move.to + (move.promotion || '')
}

export function sanForUci(board: Chess, uci: string): string {
  const clone = new Chess(board.fen())
  return uciMove(clone, uci)?.san || uci
}

export function pgnAtCursor(session: Session): string {
  const chess = new Chess(session.rootFen)
  for (const uci of session.moves.slice(0, session.cursor)) {
    if (!uciMove(chess, uci)) break
  }
  return chess.pgn()
}

export function loadPgnToSession(pgn: string, previous: Session): Session {
  const board = new Chess()
  board.loadPgn(pgn)
  const moves = board.history({ verbose: true }).map(toUci)
  return { ...previous, rootFen: board.header().FEN || START_FEN, moves, cursor: moves.length }
}

export function isSquare(s: string): s is Square {
  return /^[a-h][1-8]$/.test(s)
}
