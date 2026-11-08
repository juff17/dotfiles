// node --test modules/ghostty/home/.config/ghostty/hub/client.test.mjs
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

// client.mjs reads its runtime folder once, as it loads.
const TMP = mkdtempSync(join(tmpdir(), 'hub-client-'))
process.env.XDG_RUNTIME_DIR = TMP
after(() => rmSync(TMP, { recursive: true, force: true }))
const { RUN, alivePid, follow, markReviewed, markStopped, readState } = await import('./client.mjs')

const writeState = s => writeFileSync(join(RUN, 'state.json'), JSON.stringify(s))
const until = async (ok, ms = 2000) => {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (ok()) return true
    await new Promise(r => setTimeout(r, 20))
  }
  return ok()
}

test('the runtime folder is agent-hub under XDG_RUNTIME_DIR', () => {
  assert.equal(RUN, join(TMP, 'agent-hub'))
})

test('readState is null until agentd has written a state it can read', () => {
  rmSync(RUN, { recursive: true, force: true })
  assert.equal(readState(), null)
  mkdirSync(RUN, { recursive: true })
  writeFileSync(join(RUN, 'state.json'), '{"at": 1, "agents": [')
  assert.equal(readState(), null)
  writeState({ at: 2, agents: [] })
  assert.deepEqual(readState(), { at: 2, agents: [] })
})

test('markReviewed and markStopped leave a file agentd reads, making their folders', () => {
  rmSync(RUN, { recursive: true, force: true })
  markReviewed('s1')
  markStopped('s1', 'b5sky')
  assert.ok(existsSync(join(RUN, 'reviewed', 's1')))
  assert.ok(existsSync(join(RUN, 'stopped', 's1.b5sky')))
  // Again is fine.
  markReviewed('s1')
})

test('alivePid: this process yes, none or a gone pid no, another user\'s yes', () => {
  assert.equal(alivePid(process.pid), true)
  assert.equal(alivePid(0), false)
  assert.equal(alivePid(undefined), false)
  assert.equal(alivePid(2 ** 30), false)
  // init answers EPERM to a signal from us: it runs, it just isn't ours.
  assert.equal(alivePid(1), true)
})

test('follow registers, hands over each new state once, and skips one it has seen', async () => {
  rmSync(RUN, { recursive: true, force: true })
  mkdirSync(RUN, { recursive: true })
  // An agentd that's alive, so follow doesn't start a real one.
  writeFileSync(join(RUN, 'agentd.pid'), String(process.pid))
  writeState({ at: 1, agents: [] })
  const seen = []
  const stop = follow(s => seen.push(s.at))
  try {
    assert.ok(existsSync(join(RUN, 'clients', String(process.pid))))
    assert.deepEqual(seen, [1])
    writeState({ at: 1, agents: ['same at'] })
    writeState({ at: 2, agents: [] })
    assert.ok(await until(() => seen.includes(2)), `saw ${seen}`)
    assert.deepEqual(seen, [1, 2])
  } finally {
    stop()
  }
})
