export interface EngineSettings {
  elo: number
  temperature: number
  topP: number
  multipv: number
  pythonPath: string
  checkpointPath: string
}
export interface Session {
  rootFen: string
  moves: string[]
  cursor: number
  orientation: 'w' | 'b'
  skin: 'chessnut' | 'rhosgfx'
  autoAnalyze: boolean
  settings: EngineSettings
}
export interface Candidate {
  rank: number
  uci: string
  cp: number
  wdl: [number, number, number]
}
export interface Analysis {
  candidates: Candidate[]
  bestmove: string | null
  model: string
}
export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
export const STORAGE_KEY = 'maia-studio-session-v1'
export const defaultSettings: EngineSettings = {
  elo: 1500,
  temperature: 1.0,
  topP: 1.0,
  multipv: 5,
  pythonPath: '',
  checkpointPath: ''
}
export const defaultSession: Session = {
  rootFen: START_FEN,
  moves: [],
  cursor: 0,
  orientation: 'w',
  skin: 'chessnut',
  autoAnalyze: true,
  settings: { ...defaultSettings }
}
