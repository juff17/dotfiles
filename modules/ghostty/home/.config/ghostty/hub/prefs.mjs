// What the hub keeps between runs: the folders New agent offers as recent,
// and choices such as questions you said not to ask again. The files are
// passed in, so tests can use their own (prefs.test.mjs).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

// Recents are a cache; prefs are state, not cache or the runtime folder,
// which a reboot clears, since they should outlive the hub and a reboot.
export function storePaths(env = process.env, home = homedir()) {
  return {
    recents: join(env.XDG_CACHE_HOME || join(home, '.cache'), 'agent-hub', 'recents.json'),
    prefs: join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'agent-hub', 'prefs.json'),
  }
}

// The folders New agent offers: the ones you started agents in, newest
// first, then those running agents work in (a worktree counts as its repo),
// never home, at most 8.
export function recents(file, agents, home) {
  let saved = []
  try {
    saved = JSON.parse(readFileSync(file, 'utf8'))
  } catch {}
  const roots = agents.map(a => {
    const m = a.cwd.match(/^(.*)\/\.claude\/worktrees\//)
    return m ? m[1] : a.cwd
  })
  return [...new Set([...saved, ...roots])].filter(p => p && p !== home).slice(0, 8)
}

// Puts dir first in the recents. A failed write only loses the ordering.
export function remember(file, dir, agents, home) {
  const list = [dir, ...recents(file, agents, home).filter(d => d !== dir)].slice(0, 12)
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
