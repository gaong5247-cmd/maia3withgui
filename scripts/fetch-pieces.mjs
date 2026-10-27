import { mkdir, writeFile } from 'node:fs/promises'

const sets = ['chessnut', 'rhosgfx']
const pieces = ['K', 'Q', 'R', 'B', 'N', 'P']
const origin = 'https://raw.githubusercontent.com/lichess-org/lila/master/public/piece'

for (const set of sets) {
  await mkdir('public/pieces/' + set, { recursive: true })
  for (const color of ['w', 'b']) {
    for (const piece of pieces) {
      const name = color + piece + '.svg'
      const url = origin + '/' + set + '/' + name
      const response = await fetch(url)
      if (!response.ok) throw new Error('Could not download ' + url + ': ' + response.status)
      const svg = await response.text()
      if (!svg.includes('<svg')) throw new Error('Not an SVG: ' + url)
      await writeFile('public/pieces/' + set + '/' + name, svg)
    }
  }
}
console.log('Installed two legally reusable Lichess piece sets (24 SVGs).')
