// What the hub keeps between runs: the folders New agent offers as recent,
// and choices such as questions you said not to ask again. The files are
// passed in, so tests can use their own (prefs.test.mjs).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { load as settings } from './settings.mjs'

// Recents are a cache; prefs are state, not cache or the runtime folder,
// which a reboot clears, since they should outlive the hub and a reboot.
export function storePaths(env = process.env, home = homedir()) {
  return {
    recents: join(env.XDG_CACHE_HOME || join(home, '.cache'), 'agent-hub', 'recents.json'),
    prefs: join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'agent-hub', 'prefs.json'),
  }
}

// The folders you started agents in, newest first, then those running
// agents work in (a worktree counts as its repo), never home.
function lastUsed(file, agents, home) {
  let saved = []
  try {
    saved = JSON.parse(readFileSync(file, 'utf8'))
  } catch {}
  const roots = agents.map(a => {
    const m = a.cwd.match(/^(.*)\/\.claude\/worktrees\//)
    return m ? m[1] : a.cwd
  })
  return [...new Set([...saved, ...roots])].filter(p => p && p !== home)
}

// z.sh's ranks from ~/.z (path|rank|time a line), aged the way z.sh ages
// them, so a folder you cd into often and lately scores highest.
export function frecency(home, now = Date.now() / 1000, file = process.env._Z_DATA || join(home, '.z')) {
  const scores = new Map()
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return scores
  }
  for (const line of text.split('\n')) {
    const [path, rank, time] = line.split('|')
    if (!path || !rank || !time || !Number.isFinite(+rank) || !Number.isFinite(+time)) continue
    const age = now - +time
    const weight = age < 3600 ? 4 : age < 86400 ? 2 : age < 604800 ? 0.5 : 0.25
    scores.set(path, +rank * weight)
  }
  return scores
}

// The repo a folder is in (a worktree's being its main repo), or null
// outside git.
export function repoRoot(dir) {
  for (let d = dir; d && d !== '/'; d = dirname(d)) if (existsSync(join(d, '.git'))) return d.replace(/\/\.claude\/worktrees\/[^/]+$/, '')
  return null
}

// The folders New agent offers, as many as Settings says. Ranked by
// frecency, the folder you last started an agent in staying first, or by
// last use; with Only git repos, each as its repo and none outside git.
export function recents(file, agents, home) {
  const s = settings()
  let list = lastUsed(file, agents, home)
  const scores = s['newAgent.rankBy'] === 'frecency' ? frecency(home) : new Map()
  if (scores.size) {
    const top = [...scores].sort((a, b) => b[1] - a[1]).slice(0, 50).map(([p]) => p)
    const [first, ...rest] = [...new Set([...list, ...top])].filter(p => p !== home)
    const score = p => scores.get(p) ?? 0
    // Stable for ties, so folders z doesn't know keep their last-used order.
    rest.sort((a, b) => score(b) - score(a))
    list = first ? [first, ...rest] : []
  }
  if (s['newAgent.gitOnly']) list = [...new Set(list.map(repoRoot).filter(Boolean))].filter(p => p !== home)
  return list.slice(0, s['newAgent.recent'])
}

// Puts dir first in the recents. A failed write only loses the ordering.
export function remember(file, dir, agents, home) {
  const list = [dir, ...lastUsed(file, agents, home).filter(d => d !== dir)].slice(0, 12)
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(list))
  } catch {}
}

const isObject = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x)

// Prefs that aren't an object (null, a list, a number) read as none, so a
// hand-edited file can't crash x on a monitor.
export function readPrefs(file) {
  try {
    const p = JSON.parse(readFileSync(file, 'utf8'))
    return isObject(p) ? p : {}
  } catch {
    return {}
  }
}

export const skips = (prefs, name) => Boolean(isObject(prefs?.skip) && prefs.skip[name])

// Records that question `name` isn't to be asked again, keeping the other
// prefs. Throws when it can't write, so the hub can say so.
export function dontAsk(file, name) {
  const p = readPrefs(file)
  p.skip = { ...(isObject(p.skip) ? p.skip : {}), [name]: true }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(p, null, 2)}\n`)
}
