import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import ContextHandoff from '../lib/index.js'

const messages = [
  { role: 'system', content: [{ type: 'text', text: 'You are a coding agent.' }] },
  { role: 'user', content: [{ type: 'text', text: 'Build a token-aware handoff plugin with tests.' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'Implemented and tested.' }] },
]

function makeMeter(promptTokens) {
  return {
    measure: () => ({ totalTokens: promptTokens, surfaceTokens: Math.max(0, promptTokens - 10000), nodes: [] }),
    estimateMessage: (message) => Math.ceil(JSON.stringify(message.content).length / 4) + 4,
  }
}

function makeWorld(root, { promptTokens = 50000, auto = false, recommendAtRatio = 1 } = {}) {
  const registered = []
  const routes = new Map()
  const created = { options: undefined, followups: [] }
  const agent = {
    session: {
      id: 'sess-panel-1234',
      header: { cwd: root },
      seq: 5,
      deriveMessages: () => messages,
      requestHeader: () => ({
        config: { provider: 'test-provider', model: 'test-model', maxTokens: 4096 },
        tools: [],
      }),
      toolHistory: () => [],
    },
    options: { provider: 'test-provider', model: 'test-model' },
    status: 'idle',
    async runMaintenance(fn) {
      return fn(new AbortController().signal)
    },
  }
  const ctx = {
    commands: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
    llm: {
      async resolveModelInfo() {
        return { context: { contextWindow: 128000 }, defaultMaxTokens: 8192 }
      },
      async *stream() {
        yield { type: 'text-delta', text: '# Handoff: Panel test\n\n## Mission\nKeep going.\n\n## Next steps\n- Continue.' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    tokenMeter: makeMeter(promptTokens),
    agents: {
      get(id) {
        return id === agent.session.id ? agent : undefined
      },
      async create(options) {
        created.options = options
        return {
          agent: {
            async followup(message) {
              created.followups.push(message)
            },
          },
          async dispose() {},
        }
      },
    },
    sessions: {
      get(id) {
        return id === agent.session.id ? agent.session : undefined
      },
    },
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) {
      const result = fn()
      if (result !== undefined && typeof result.next === 'function') {
        let step = result.next()
        while (!step.done) step = result.next()
      }
    },
    get() {
      return undefined
    },
    on() {
      return () => {}
    },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => {}
      },
    },
    inject(deps, callback) {
      if (deps.includes('commands')) callback({ commands: ctx.commands, effect: ctx.effect })
      if (deps.includes('webServer')) callback({ webServer: ctx.webServer, effect: ctx.effect })
    },
  }
  const plugin = new ContextHandoff(ctx, {
    outputDir: '.dsh/handoff',
    auto,
    autoCooldownMinutes: 0,
    recommendAtRatio,
    recommendMaxTokens: 1000000,
  })
  return { ctx, plugin, agent, registered, routes, created }
}

function httpRequest(routeHandler, plugin, { method = 'GET', url = '/', headers = {}, body } = {}) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  request.method = method
  request.url = url
  request.headers = headers
  const response = {
    statusCode: 0,
    headers: {},
    chunks: [],
    writeHead(status, nextHeaders) {
      this.statusCode = status
      Object.assign(this.headers, nextHeaders)
    },
    end(chunk) {
      if (chunk !== undefined) this.chunks.push(Buffer.from(chunk))
    },
  }
  return Promise.resolve(routeHandler.call(plugin, request, response)).then(() => ({
    status: response.statusCode,
    body: response.chunks.length > 0 ? JSON.parse(Buffer.concat(response.chunks).toString('utf8')) : undefined,
  }))
}

test('panel bridge: state, guarded toggle, run, and ack', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-handoff-panel-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { plugin, agent, routes, created } = makeWorld(root)

  assert.ok(routes.has('/context-handoff/api/state'))
  assert.ok(routes.has('/context-handoff/api/auto'))
  assert.ok(routes.has('/context-handoff/api/run'))
  assert.ok(routes.has('/context-handoff/api/ack'))

  const state = await httpRequest(plugin.handleStateRoute, plugin, {
    url: `/context-handoff/api/state?session=${agent.session.id}`,
  })
  assert.equal(state.status, 200)
  assert.equal(state.body.ok, true)
  assert.equal(state.body.auto, false)
  assert.equal(state.body.promptTokens, 50000)
  assert.equal(state.body.recommendedAt, 119808)
  assert.equal(state.body.autoNewSession, true)

  const refused = await httpRequest(plugin.handleAutoRoute, plugin, {
    method: 'POST',
    body: { sessionId: agent.session.id, enabled: true },
  })
  assert.equal(refused.status, 403)

  const enabled = await httpRequest(plugin.handleAutoRoute, plugin, {
    method: 'POST',
    headers: { 'x-context-handoff': '1', 'content-type': 'application/json' },
    body: { sessionId: agent.session.id, enabled: true },
  })
  assert.equal(enabled.status, 200)
  assert.equal(enabled.body.auto, true)
  const autoFile = JSON.parse(await readFile(path.join(root, '.dsh/handoff/auto.json'), 'utf8'))
  assert.equal(autoFile.auto, true)

  const run = await httpRequest(plugin.handleRunRoute, plugin, {
    method: 'POST',
    headers: { 'x-context-handoff': '1', 'content-type': 'application/json' },
    body: { sessionId: agent.session.id, newSession: true },
  })
  assert.equal(run.status, 200)
  assert.equal(run.body.ok, true)
  assert.ok(run.body.result.newSessionId)
  assert.equal(created.options.meta.cwd, root)
  assert.equal(created.options.agentOptions.provider, 'test-provider')
  assert.equal(created.followups.length, 1)
  assert.match(created.followups[0].content[0].text, /^Read @\.dsh\/handoff\//)

  plugin.lastAutoBySource.set(agent.session.id, {
    newSessionId: run.body.result.newSessionId,
    file: run.body.result.relativePath,
    at: Date.now(),
  })
  const ack = await httpRequest(plugin.handleAckRoute, plugin, {
    method: 'POST',
    headers: { 'x-context-handoff': '1', 'content-type': 'application/json' },
    body: { sessionId: agent.session.id, newSessionId: run.body.result.newSessionId },
  })
  assert.equal(ack.status, 200)
  assert.equal(plugin.lastAutoBySource.has(agent.session.id), false)
})

test('auto mode: reads the workspace switch, writes a file, starts a session once', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-handoff-auto-session-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { plugin, agent, created } = makeWorld(root, { promptTokens: 120000, auto: false, recommendAtRatio: 0.55 })
  await plugin.autoState.write(root, true)

  await plugin.maybeAuto(agent)
  assert.equal(created.followups.length, 1)
  const files = (await readdir(path.join(root, '.dsh/handoff'))).filter((name) => name.endsWith('.md'))
  assert.equal(files.length, 1)
  assert.ok(plugin.lastAutoBySource.has(agent.session.id))
  assert.equal(plugin.lastAuto.get(agent.session.id).completed, true)

  // A completed auto handoff does not write a second file for the same session.
  await plugin.maybeAuto(agent)
  assert.equal(created.followups.length, 1)
  assert.equal((await readdir(path.join(root, '.dsh/handoff'))).filter((name) => name.endsWith('.md')).length, 1)
})

test('a handoff session is created through the session controller', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-handoff-controller-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { ctx, plugin, agent, created } = makeWorld(root, { promptTokens: 120000, recommendAtRatio: 0.55 })
  const requests = []
  const selections = []
  const followups = []
  const newAgent = {
    session: { id: 'session-created-by-controller' },
    async followup(message) {
      followups.push(message)
    },
  }
  ctx.get = (name) => {
    if (name === 'sessionController') {
      return {
        async create(request) {
          requests.push(request)
          return { sessionId: newAgent.session.id }
        },
        async selectModel(request) {
          selections.push(request)
          return { selected: { provider: request.provider, model: request.model } }
        },
      }
    }
    if (name === 'workspaceRegistry') return { resolveByPath: async () => ({ id: 'workspace-1' }) }
    return undefined
  }
  const agents = ctx.agents
  ctx.agents = {
    ...agents,
    get(id) {
      return id === newAgent.session.id ? newAgent : agents.get(id)
    },
  }

  const result = await plugin.generate(agent, { trigger: 'panel', newSession: true })
  assert.equal(result.newSessionId, 'session-created-by-controller')
  // The controller attaches the session to its workspace, which keeps it out of Ungrouped.
  assert.equal(requests.length, 1)
  assert.deepEqual(requests[0], { workspaceId: 'workspace-1' })
  // The controller mounts the preset itself, so no bare agent is created.
  assert.equal(created.options, undefined)
  // The new session runs the finished conversation's model, not the deployment default.
  assert.equal(selections.length, 1)
  assert.equal(selections[0].sessionId, 'session-created-by-controller')
  assert.equal(selections[0].provider, 'test-provider')
  assert.equal(selections[0].model, 'test-model')
  assert.equal(followups.length, 1)
  assert.match(followups[0].content[0].text, /^Read @\.dsh\/handoff\//)
})

test('the bare fallback mounts the default preset, the source route, and the workspace', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-handoff-bare-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { ctx, plugin, agent, created } = makeWorld(root, { promptTokens: 120000, recommendAtRatio: 0.55 })
  const mounted = []
  const attached = []
  ctx.get = (name) => {
    if (name === 'agentPresets') {
      return {
        async resolve(requested) {
          assert.equal(requested, undefined)
          return { id: 'standard' }
        },
        async mount(agentCtx, presetId) {
          mounted.push({ agentCtx, presetId })
        },
      }
    }
    if (name === 'workspaceRegistry') {
      return {
        resolveByPath: async () => ({ id: 'workspace-1' }),
        get: () => ({
          async attachSession(sessionId) {
            attached.push(sessionId)
          },
        }),
      }
    }
    return undefined
  }

  const result = await plugin.generate(agent, { trigger: 'panel', newSession: true })
  assert.equal(created.options.meta.agentPreset, 'standard')
  assert.equal(created.options.agentOptions.provider, 'test-provider')
  assert.equal(created.options.agentOptions.model, 'test-model')
  assert.equal(typeof created.options.setup, 'function')
  await created.options.setup({})
  assert.deepEqual(mounted.map((entry) => entry.presetId), ['standard'])
  assert.deepEqual(attached, [result.newSessionId])
  assert.equal(created.followups.length, 1)
})

