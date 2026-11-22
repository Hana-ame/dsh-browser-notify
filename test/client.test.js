/**
 * Offline tests for dsh-browser-notify's client half.
 *
 * The client.js is an ESM that calls `window.__ModuleLoader__.load` with a
 * `factory(require)`. We install a fake loader + fake `require('react')` /
 * `require('react-dom')` BEFORE importing it, then drive the plugin's
 * `apply(ctx)` against a fake sessions face whose projections we control —
 * no browser, no real notifications, no money.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

// ── fake react / react-dom ──────────────────────────────────────────────────
const ReactMock = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useCallback: (fn) => fn,
  Fragment: 'Fragment',
}
const ReactDOMMock = {
  createPortal: (node) => ({ portal: node }),
  render: () => {},
  unmountComponentAtNode: () => {},
}

// ── fake window / document / Notification ───────────────────────────────────
class FakeNotification {
  static permission = 'granted'
  constructor(title, options) {
    this.title = title
    this.options = options
    this.onclick = null
    FakeNotification.instances.push(this)
  }
  close() { this.closed = true }
}
FakeNotification.instances = []

globalThis.window = {
  Notification: FakeNotification,
  localStorage: (() => {
    const m = new Map()
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }
  })(),
  focus: () => { globalThis.window._focused = true },
  location: { href: 'http://old/' },
}
globalThis.document = {
  hidden: true,
  body: { appendChild() {} },
  createElement: () => ({ dataset: {}, appendChild() {}, remove() {}, setAttribute() {} }),
  addEventListener() {},
  removeEventListener() {},
}

// ── install the fake module loader, then import the client ──────────────────
const captured = {}
globalThis.window.__ModuleLoader__ = {
  load({ id, factory }) {
    const exports = factory((name) => {
      if (name === 'react') return ReactMock
      if (name === 'react-dom') return ReactDOMMock
      throw new Error(`unexpected require ${name}`)
    })
    captured[id] = exports
  },
}

await import('../client.js?t=' + Date.now())
const plugin = captured['dsh-browser-notify']
if (!plugin) throw new Error('plugin did not register')

/**
 * A fake sessions face. Each session exposes two controllable projections.
 * Call `session.setTurns([...])` / `session.setQuestions([...])` to update a
 * projection and fire its subscribers (exactly what a real projection update
 * does). `sessions.list.subscribe` fires when a session is first bound.
 */
function makeSessionsFace() {
  const sessions = new Map()
  const listListeners = new Set()
  const face = {
    list: {
      getSnapshot: () => ({ byId: Object.fromEntries([...sessions.keys()].map((id) => [id, { id }])) }),
      subscribe(fn) { listListeners.add(fn); return () => listListeners.delete(fn) },
    },
    binding(id) { return sessions.get(id)?.binding ?? undefined },
    /** Register a session with controllable projections. */
    addSession(id, initialTurns = []) {
      const listeners = { turnOutline: new Set(), userQuestions: new Set() }
      const session = {
        id,
        turns: initialTurns,
        questions: [],
        listeners,
        // Real shape: binding.session.projections.faceOf(...) — projections live
        // under a `.session` wrapper on the binding, matching the real binding.
        binding: {
          session: {
            projections: {
              faceOf(key) {
                return {
                  getSnapshot: () => (key === 'turnOutline' ? { turns: session.turns } : { active: session.questions }),
                  subscribe(fn) { listeners[key].add(fn); return () => listeners[key].delete(fn) },
                }
              },
            },
          },
        },
        /** Update the open turns and notify subscribers. */
        setTurns(turns) { session.turns = turns; for (const fn of session.listeners.turnOutline) fn() },
        /** Update active questions and notify subscribers. */
        setQuestions(questions) { session.questions = questions; for (const fn of session.listeners.userQuestions) fn() },
      }
      sessions.set(id, session)
      // Adding a session notifies list subscribers (the plugin rebinds) — set
      // must happen BEFORE notifying so the plugin's reconcile finds the binding.
      for (const fn of listListeners) fn()
      return session
    },
  }
  return face
}

function applyPlugin(sessionsFace) {
  plugin.apply({ sessions: sessionsFace, effect(fn) { fn() } })
}

const tick = () => new Promise((r) => setTimeout(r, 0))

test('exports the plugin face with sessions inject', () => {
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(plugin.inject, ['sessions'])
})

test('a NEWLY completed turn fires a browser notification', async () => {
  FakeNotification.instances.length = 0
  const face = makeSessionsFace()
  applyPlugin(face)
  // Page load: the session ALREADY has one finished turn. Because addSession
  // seeds the plugin synchronously (count=1), this history must NOT toast.
  const session = face.addSession('sess-1', [{ turn: 1, seq: 1, prompt: 'first', response: 'done' }])
  await tick()
  assert.equal(FakeNotification.instances.length, 0, 'history seed does not toast')

  // A NEW turn lands → toast.
  session.setTurns([
    { turn: 1, seq: 1, prompt: 'first', response: 'done' },
    { turn: 2, seq: 2, prompt: 'again', response: 'ok' },
  ])
  await tick()
  assert.equal(FakeNotification.instances.length, 1, 'new turn toasts once')
  assert.match(FakeNotification.instances[0].title, /回应完成/)
})

test('notification click focuses window and jumps to launchUrl', async () => {
  FakeNotification.instances.length = 0
  globalThis.window._focused = false
  globalThis.window.location.href = 'http://old/'
  const face = makeSessionsFace()
  applyPlugin(face)
  const session = face.addSession('sess-2')
  session.setTurns([])
  await tick()
  session.setTurns([{ turn: 1, seq: 1, prompt: 'p', response: 'r' }])
  await tick()
  const n = FakeNotification.instances.at(-1)
  assert.ok(n, 'notification created')
  n.onclick()
  assert.equal(globalThis.window._focused, true, 'window focused on click')
  assert.equal(globalThis.window.location.href, 'http://127.0.0.1:3080', 'jumps to DSH page')
})

test('ask_user_question (userQuestions active) fires a notification', async () => {
  FakeNotification.instances.length = 0
  const face = makeSessionsFace()
  applyPlugin(face)
  const session = face.addSession('sess-3')
  session.setTurns([])
  session.setQuestions([])
  await tick()
  session.setQuestions([{ callId: 'call-1' }])
  await tick()
  const q = FakeNotification.instances.filter((n) => n.title.includes('需要你回答'))
  assert.ok(q.length > 0, 'a question notification fired')
})

test('no notification when permission is not granted', async () => {
  FakeNotification.instances.length = 0
  const originalPermission = FakeNotification.permission
  FakeNotification.permission = 'denied'
  try {
    const face = makeSessionsFace()
    applyPlugin(face)
    const session = face.addSession('sess-4')
    session.setTurns([])
    await tick()
    session.setTurns([{ turn: 1, seq: 1, prompt: 'p', response: 'r' }])
    await tick()
    assert.equal(FakeNotification.instances.length, 0, 'no notification without permission')
  } finally {
    FakeNotification.permission = originalPermission
  }
})

test('kill switch (enabled=false) suppresses notifications', async () => {
  FakeNotification.instances.length = 0
  globalThis.window.localStorage.setItem('dsh.browser-notify.enabled', '0')
  try {
    const face = makeSessionsFace()
    applyPlugin(face)
    const session = face.addSession('sess-5')
    session.setTurns([])
    await tick()
    session.setTurns([{ turn: 1, seq: 1, prompt: 'p', response: 'r' }])
    await tick()
    assert.equal(FakeNotification.instances.length, 0, 'no notification when disabled')
  } finally {
    globalThis.window.localStorage.setItem('dsh.browser-notify.enabled', '1')
  }
})

test('re-render with the SAME turn count does not re-toast (dedupe)', async () => {
  FakeNotification.instances.length = 0
  const face = makeSessionsFace()
  applyPlugin(face)
  const session = face.addSession('sess-6')
  session.setTurns([])
  await tick()
  session.setTurns([{ turn: 1, seq: 1, prompt: 'p', response: 'r' }])
  await tick()
  const afterFirst = FakeNotification.instances.length
  // Same single turn re-emitted (e.g. an unrelated projection re-render) → no new toast.
  session.setTurns([{ turn: 1, seq: 1, prompt: 'p', response: 'r' }])
  await tick()
  assert.equal(FakeNotification.instances.length, afterFirst, 'no duplicate toast')
})
