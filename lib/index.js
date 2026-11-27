/**
 * dsh-context-handoff — a token-aware session handoff plugin for DSH.
 *
 * Registers `/handoff` and, when enabled, watches idle sessions for the point
 * where writing a compact handoff becomes cheaper than carrying the full
 * conversation forward.
 *
 * @module dsh-context-handoff
 */
import { randomUUID } from 'node:crypto'
import { channel as diagnosticsChannel } from 'node:diagnostics_channel'
import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { AutoStateStore } from './auto-state.js'
import { Config, resolveConfig } from './config.js'
import {
  buildFallbackBody,
  enforceFileBudget,
  extractTitle,
  priceHandoff,
  priceMessage,
  redactSecrets,
  renderHandoffFile,
  resolveLanguage,
  sanitizeModelMarkdown,
} from './digest.js'
import { chooseDigestBudget, computePlan, formatTokens } from './economics.js'
import {
  appendLedger,
  displayPath,
  handoffFileName,
  latestHandoff,
  listHandoffs,
  pruneHandoffs,
  readLedger,
  resolveOutputDir,
  writeHandoff,
} from './files.js'
import {
  formatGeneratedReport,
  formatListReport,
  formatPlanReport,
  formatStatsReport,
  formatStatusReport,
  HELP_TEXT,
} from './format.js'
import { sendError, sendJson, mutationAllowed, readJsonBody } from './http.js'
import { buildInstruction, buildSummaryRequest, resolveSummaryTarget, streamSummary } from './summarize.js'

/** Thrown when a handoff cannot start because the agent is already working. */
export class HandoffBusyError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'HandoffBusyError'
    this.code = 'HANDOFF_BUSY'
  }
}

/**
 * Token-aware handoff plugin.
 */
export default class ContextHandoff {
  static inject = ['agents', 'llm', 'sessions', 'tokenMeter']

  static Config = Config

  /**
   * @param {object} ctx - Cordis context.
   * @param {object} [config] - validated entry config.
   */
  constructor(ctx, config = {}) {
    this.ctx = ctx
    this.config = resolveConfig(config)
    /** @type {Map<string, Promise<object>>} */
    this.active = new Map()
    /** @type {Map<string, {tokens: number, at: number, completed?: boolean}>} */
    this.lastAuto = new Map()
    /** @type {Map<string, {newSessionId: string, file: string, at: number}>} */
    this.lastAutoBySource = new Map()
    /** @type {Map<string, object>} */
    this.createdAgents = new Map()
    /** @type {Map<string, number | undefined>} */
    this.windowCache = new Map()
    this.autoState = new AutoStateStore(this.config)
    this.autoTimer = undefined
    /** @type {Map<string, {count: number, lastAt: number, before: number, after: number, saved: number, failedAt?: number}>} */
    this.compactions = new Map()
    /** @type {object | undefined} */
    this.compaction = undefined
    /** How the compaction service was found; surfaced in the panel for diagnosis. */
    this.compactionSource = 'none'
    /** @type {Set<string>} */
    this.compacting = new Set()
    /**
     * Raw Node `undici` transport records for the last few seconds. The LLM layer
     * converts every adapter throw into a `{message, code}` failure chunk, so the
     * cause of a `TRANSPORT` failure never reaches the session log; these records
     * are the only place the underlying fetch error survives.
     * @type {string[]}
     */
    this.transportRecords = []

    const plugin = this
    const registerCommand = (commandCtx) => {
      commandCtx.effect(function* registerHandoffCommand() {
        yield commandCtx.commands.register({
          definitionId: 'dsh-context-handoff',
          name: 'handoff',
          description: 'Summarize this session into a handoff file and compare its token cost',
          input: { hint: '[plan|status|list|stats|help] [turns|tokens]' },
          handler: (invocation) => plugin.handleCommand(invocation),
        })
      }, 'context-handoff command')
      plugin.commands = commandCtx.commands
      plugin.ctx.logger?.info?.('context-handoff: registered /handoff command')
    }
    if (typeof ctx.inject === 'function') {
      // Optional: headless/ACP profiles may not mount the command registry, but
      // auto mode still works there because it is a host-side listener.
      ctx.inject(['commands'], (commandCtx) => registerCommand(commandCtx))
      // Condensation is provided by the composition (dsh-compaction-basic).
      // Without it the plugin still handoffs, it just cannot condense first.
      ctx.inject(['compaction'], (compactionCtx) => {
        if (compactionCtx.compaction !== undefined && plugin.compaction === undefined) {
          plugin.compaction = compactionCtx.compaction
          plugin.compactionSource = 'inject'
          plugin.ctx.logger?.info?.('context-handoff: compaction service injected')
        }
      })
    } else if (ctx.commands !== undefined) {
      registerCommand(ctx)
    }

    this.installAuto()
    this.installDiagnostics()
    this.installTransportDiagnostics()
    this.installHttpRoutes()
  }

  /**
   * Dispatch `/handoff` input.
   * @param {object} invocation - command invocation from dsh-commands.
   * @returns {Promise<{kind: 'success'|'error', text: string}>}
   */
  async handleCommand(invocation) {
    const raw = String(invocation.rawInput ?? '').trim()
    const [subcommand = 'now', ...rest] = raw.length === 0 ? [] : raw.split(/\s+/u)
    try {
      switch (subcommand) {
        case 'now':
          return await this.commandNow(invocation, rest)
        case 'plan':
          return await this.commandPlan(invocation, rest)
        case 'status':
          return await this.commandStatus(invocation, rest)
        case 'list':
          return await this.commandList(invocation, rest)
        case 'stats':
          return await this.commandStats(invocation, rest)
        case 'auto':
          return await this.commandAuto(invocation, rest)
        case 'help':
          return { kind: 'success', text: HELP_TEXT }
        default:
          return { kind: 'error', text: `Unknown /handoff subcommand: ${subcommand}\n\n${HELP_TEXT}` }
      }
    } catch (error) {
      if (invocation.signal?.aborted || error?.code === 'ABORTED') {
        return { kind: 'error', text: 'Handoff cancelled.' }
      }
      if (error instanceof HandoffBusyError) return { kind: 'error', text: error.message }
      const message = error instanceof Error ? error.message : String(error)
      return { kind: 'error', text: `Handoff failed: ${message}` }
    }
  }

  async commandNow(invocation, rest) {
    let budgetOverride
    if (rest.length > 1) return { kind: 'error', text: 'Usage: /handoff now [digest-tokens]' }
    if (rest.length === 1) {
      budgetOverride = Number(rest[0])
      if (!Number.isInteger(budgetOverride) || budgetOverride < 600) {
        return { kind: 'error', text: 'The digest budget must be an integer of at least 600 tokens.' }
      }
      budgetOverride = Math.min(budgetOverride, this.config.maxDigestTokens)
    }
    const result = await this.generate(invocation.agent, {
      trigger: 'command',
      signal: invocation.signal,
      budgetOverride,
    })
    return { kind: 'success', text: result.text }
  }

  async commandPlan(invocation, rest) {
    if (rest.length > 1) return { kind: 'error', text: 'Usage: /handoff plan [turns]' }
    let horizon = this.config.horizonTurns
    if (rest.length === 1) {
      horizon = Number(rest[0])
      if (!Number.isInteger(horizon) || horizon < 2 || horizon > 1000) {
        return { kind: 'error', text: 'The horizon must be an integer between 2 and 1000 turns.' }
      }
    }
    const snapshot = await this.inspect(invocation.agent, { signal: invocation.signal, horizon })
    const text = formatPlanReport({
      plan: snapshot.plan,
      config: this.config,
      digestBudget: snapshot.digestBudget,
      extra: { sessionTokens: snapshot.cumulativeTokens, turns: snapshot.turns, perTurn: snapshot.perTurnTokens },
    })
    return { kind: 'success', text }
  }

  async commandStatus(invocation, rest) {
    if (rest.length > 0) return { kind: 'error', text: 'Usage: /handoff status' }
    const snapshot = await this.inspect(invocation.agent, { signal: invocation.signal, horizon: this.config.horizonTurns })
    const latest = await latestHandoff(snapshot.outputDir)
    const text = formatStatusReport({
      cwd: snapshot.cwd,
      latest,
      plan: snapshot.plan,
      digestBudget: snapshot.digestBudget,
      config: this.config,
    })
    return { kind: 'success', text }
  }

  async commandList(invocation, rest) {
    if (rest.length > 0) return { kind: 'error', text: 'Usage: /handoff list' }
    const snapshot = await this.inspect(invocation.agent, { signal: invocation.signal, horizon: this.config.horizonTurns })
    const files = await listHandoffs(snapshot.outputDir)
    return { kind: 'success', text: formatListReport(files, snapshot.cwd) }
  }

  async commandStats(invocation, rest) {
    if (rest.length > 0) return { kind: 'error', text: 'Usage: /handoff stats' }
    const snapshot = await this.inspect(invocation.agent, { signal: invocation.signal, horizon: this.config.horizonTurns })
    const records = this.config.ledger ? await readLedger(snapshot.outputDir) : []
    const files = await listHandoffs(snapshot.outputDir)
    const text = formatStatsReport({
      records,
      fileCount: files.length,
      usage: snapshot.sessionUsage,
    })
    return { kind: 'success', text }
  }

  async commandAuto(invocation, rest) {
    if (rest.length > 1) return { kind: 'error', text: 'Usage: /handoff auto [on|off]' }
    const snapshot = await this.inspect(invocation.agent, { signal: invocation.signal, horizon: this.config.horizonTurns })
    if (rest.length === 1) {
      const action = rest[0].toLowerCase()
      if (action !== 'on' && action !== 'off') return { kind: 'error', text: 'Usage: /handoff auto [on|off]' }
      await this.autoState.write(snapshot.cwd, action === 'on')
      if (action === 'on') setTimeout(() => void this.maybeAuto(invocation.agent), 100)
    }
    const setting = await this.autoState.read(snapshot.cwd)
    const threshold = Number.isFinite(snapshot.plan.recommendedAt)
      ? `${formatTokens(snapshot.plan.recommendedAt)} tokens`
      : 'unknown (no model window)'
    return {
      kind: 'success',
      text: [
        `Auto handoff for ${snapshot.cwd}: ${setting.auto ? 'ON' : 'OFF'}${setting.explicit ? '' : ' (config default)'}`,
        `Trigger: ${threshold} · current ${formatTokens(snapshot.promptTokens)} · ${this.config.autoNewSession ? 'creates a new session' : 'writes a file only'}`,
        'The sidebar switch writes the same per-workspace setting.',
      ].join('\n'),
    }
  }

  /**
   * Snapshot the session and compute the comparison without writing anything.
   * @param {object} agent
   * @param {{signal?: AbortSignal, horizon?: number}} [options]
   * @returns {Promise<object>}
   */
  async inspect(agent, options = {}) {
    const session = agent?.session
    if (session === undefined) throw new Error('this command needs a live agent session')
    const cwd = typeof session.header?.cwd === 'string' && session.header.cwd.length > 0 ? session.header.cwd : process.cwd()
    const messages = typeof session.deriveMessages === 'function' ? session.deriveMessages() : []
    const meter = this.ctx.tokenMeter
    let measure
    try {
      measure = meter.measure(session)
    } catch (error) {
      const fallback = messages.reduce((total, message) => total + priceMessage(meter, message), 0)
      measure = { totalTokens: fallback, surfaceTokens: fallback, nodes: [] }
    }
    const promptTokens = Math.max(0, Number(measure.totalTokens) || 0)
    const surfaceTokens = Math.max(0, Number(measure.surfaceTokens) || 0)
    const systemTokens = messages
      .filter((message) => message?.role === 'system')
      .reduce((total, message) => total + priceMessage(meter, message), 0)
    const toolsTokens = Math.max(0, promptTokens - surfaceTokens)
    const breakdown = this.readProjection(session, 'contextBreakdown')
    const breakdownFixed =
      breakdown !== undefined && Number.isFinite(breakdown.systemTokens) && Number.isFinite(breakdown.toolsTokens)
        ? Number(breakdown.systemTokens) + Number(breakdown.toolsTokens)
        : undefined
    const fixedPrefixTokens = Math.min(
      promptTokens,
      Math.max(0, breakdownFixed ?? systemTokens + toolsTokens),
    )
    const outputDir = resolveOutputDir(cwd, this.config.outputDir)

    let target
    let targetError
    try {
      target = await resolveSummaryTarget({
        ctx: this.ctx,
        agent,
        config: this.config,
        signal: options.signal,
        cache: this.windowCache,
      })
    } catch (error) {
      targetError = error instanceof Error ? error.message : String(error)
    }
    const windowTokens = target?.windowTokens
    const digestBudget = chooseDigestBudget({
      promptTokens,
      fixedPrefixTokens,
      windowTokens,
      config: this.config,
    })
    const plan = computePlan({
      promptTokens,
      fixedPrefixTokens,
      digestTokens: digestBudget,
      windowTokens,
      horizonTurns: options.horizon ?? this.config.horizonTurns,
      cacheHitRatio: this.config.cacheHitRatio,
      cacheReadWeight: this.config.cacheReadWeight,
      switchOverheadTokens: this.config.switchOverheadTokens,
      recommendAtRatio: this.config.recommendAtRatio,
      recommendMaxTokens: this.config.recommendMaxTokens,
      reserveTokens: this.config.maxOutputTokens > 0 ? this.config.maxOutputTokens + 4096 : 8192,
    })
    const sessionUsage = this.readProjection(session, 'tokenUsage')
    const autoSetting = await this.autoState.read(cwd)
    const turns = messages.filter((message) => message?.role === 'user').length
    const cumulativeTokens =
      sessionUsage === undefined
        ? undefined
        : (Number(sessionUsage.uncachedInputTokens) || 0) +
          (Number(sessionUsage.cacheReadTokens) || 0) +
          (Number(sessionUsage.cacheWriteTokens) || 0) +
          (Number(sessionUsage.outputTokens) || 0)
    const perTurnTokens = cumulativeTokens !== undefined && turns > 0 ? cumulativeTokens / turns : undefined
    options.signal?.throwIfAborted()

    return {
      session,
      cwd,
      messages,
      meter,
      measure,
      promptTokens,
      surfaceTokens,
      fixedPrefixTokens,
      messagesTokens: Math.max(0, promptTokens - fixedPrefixTokens),
      digestBudget,
      plan,
      windowTokens,
      target,
      targetError,
      outputDir,
      auto: autoSetting.auto,
      autoExplicit: autoSetting.explicit,
      sessionUsage,
      cumulativeTokens,
      turns,
      perTurnTokens,
      title: extractTitle(messages, session.id),
      language: resolveLanguage(this.config.language, messages),
    }
  }

  /** Read one host projection without making sessionProjections a hard dependency. */
  readProjection(session, key) {
    try {
      const projections = this.ctx.get?.('sessionProjections') ?? this.ctx.sessionProjections
      const state = projections?.stateOf?.(session, key)
      return state !== null && typeof state === 'object' ? state : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Write a handoff for one agent. Serializes per session and runs as agent
   * maintenance when the loop exposes it, so a queued prompt cannot interleave.
   * @param {object} agent
   * @param {{trigger?: string, signal?: AbortSignal, budgetOverride?: number, newSession?: boolean}} [options]
   * @returns {Promise<object>}
   */
  async generate(agent, options = {}) {
    const sessionId = agent?.session?.id
    if (typeof sessionId !== 'string') throw new Error('this command needs a live agent session')
    if (this.active.has(sessionId)) {
      throw new HandoffBusyError('A handoff is already being generated for this session; wait for it to finish.')
    }
    const jobs = this.runningJobs(sessionId)
    if (jobs.length > 0) {
      // A background job belongs to its own session's agent: it is not carried
      // into the new session, its output stays in the old chat, and disposing
      // that agent cancels it. Handing off now would abandon the job silently.
      throw new HandoffBusyError(
        `The handoff cannot start while ${jobs.length === 1 ? 'a background job is' : `${jobs.length} background jobs are`} still running (${jobs
          .map((job) => `${job.id}${typeof job.label === 'string' && job.label.length > 0 ? ` "${job.label}"` : ''}`)
          .join(', ')}). Wait for it to finish, or stop it with job_kill, then retry.`,
      )
    }
    const operation = this.runWithMaintenance(agent, options.signal, (signal) => this.generateInner(agent, { ...options, signal }))
    this.active.set(sessionId, operation)
    try {
      return await operation
    } finally {
      this.active.delete(sessionId)
    }
  }

  async runWithMaintenance(agent, signal, fn) {
    if (typeof agent.runMaintenance !== 'function') return fn(signal)
    let started = false
    try {
      return await agent.runMaintenance(async (maintenanceSignal) => {
        started = true
        return fn(combineSignals(maintenanceSignal, signal))
      })
    } catch (error) {
      if (!started) {
        throw new HandoffBusyError('The handoff could not start because the agent is not idle. Wait for the current turn to finish and retry.', {
          cause: error,
        })
      }
      throw error
    }
  }

  async generateInner(agent, options) {
    const { signal, trigger = 'command' } = options
    signal?.throwIfAborted()
    const snapshot = await this.inspect(agent, { signal, horizon: this.config.horizonTurns })
    signal?.throwIfAborted()
    const budget = clamp(
      options.budgetOverride ?? snapshot.digestBudget,
      600,
      Math.max(600, this.config.maxDigestTokens),
    )
    if (!hasSummarizableContent(snapshot.messages)) {
      throw new Error('nothing to hand off yet; start a conversation first')
    }
    const language = snapshot.language
    const title = snapshot.title
    const createdAt = new Date()
    const goal = this.sessionGoal(agent)
    // The transfer needs both a new session and the goal service; the file must
    // not promise a re-creation that cannot happen.
    const goalMode = options.newSession === true && this.goalService() !== undefined ? this.config.handoffGoal : 'file'
    const dir = snapshot.outputDir
    const filename = handoffFileName(snapshot.session.id, createdAt)
    const absolutePath = path.join(dir, filename)
    const relativePath = displayPath(snapshot.cwd, absolutePath)
    const maxOutputTokens =
      this.config.maxOutputTokens > 0
        ? this.config.maxOutputTokens
        : clamp(Math.ceil(Math.max(300, budget - 220) * 1.6), 512, 8192)

    let body
    let generator = 'llm'
    let fallbackReason
    let summary
    let summaryMode
    let omittedMessages = 0
    if (snapshot.target === undefined) {
      if (!this.config.fallbackDigest) throw new Error(snapshot.targetError ?? 'no summarization model is available')
      generator = 'fallback'
      fallbackReason = snapshot.targetError ?? 'no summarization model is available'
    } else {
      const instruction = buildInstruction({
        budgetTokens: Math.max(300, budget - 220),
        language,
        title,
        promptTokens: snapshot.promptTokens,
      })
      const toolHistory = typeof snapshot.session.toolHistory === 'function' ? snapshot.session.toolHistory() : undefined
      const tools = snapshot.session.requestHeader?.()?.tools
      const request = buildSummaryRequest({
        messages: snapshot.messages,
        target: snapshot.target,
        config: this.config,
        meter: snapshot.meter,
        instruction,
        maxOutputTokens,
        toolHistory,
        tools,
      })
      summaryMode = request.mode
      omittedMessages = request.omittedMessages
      const transportFrom = this.transportRecords.length
      // A summary never needs chain-of-thought, and thinking tokens are billed
      // against `maxTokens`: on a route whose default effort is high the model
      // can spend the whole output budget reasoning and complete with no text
      // at all. Ask for reasoning off, and retry once without that control when
      // the route does not offer it.
      let failure
      for (const variant of [{ reasoningEffort: 'off' }, {}]) {
        try {
          summary = await streamSummary({
            ctx: this.ctx,
            agent,
            config: this.config,
            target: snapshot.target,
            request: { ...request, ...variant },
            signal,
          })
          body = sanitizeModelMarkdown(summary.text)
          if (body.trim().length === 0) {
            // A route with reasoning enabled spends its output budget on
            // reasoning first; when the cap is small the stream completes
            // without ever emitting text. Naming the finish reason and the
            // token usage makes the fallback reason say which of the two
            // happened instead of the uninformative "no text".
            const finishKind = summary.finish?.kind ?? 'unknown'
            const outputTokens = Number(summary.usage?.outputTokens) || 0
            const reasoningChars = Number(summary.reasoningChars) || 0
            throw new Error(
              `the summarization model returned no text (finish ${finishKind}, ${outputTokens} output tokens, ${reasoningChars} reasoning characters)`,
            )
          }
          failure = undefined
          break
        } catch (error) {
          failure = error
          signal?.throwIfAborted()
          if (error?.code === 'ABORTED') throw error
          if (error?.code === 'UNSUPPORTED_REASONING_EFFORT' && variant.reasoningEffort !== undefined) continue
          break
        }
      }
      if (failure !== undefined) {
        if (!this.config.fallbackDigest) throw failure
        generator = 'fallback'
        summary = undefined
        // An empty model answer throws after `body` was already assigned the
        // empty string, and `body === undefined` below is what selects the
        // deterministic digest. Leaving that empty string in place skipped the
        // fallback and wrote a handoff with a heading and nothing under it.
        body = undefined
        const reason = (failure instanceof Error ? failure.message : String(failure)).replace(/\s+/g, ' ').trim()
        fallbackReason = reason.length > 300 ? `${reason.slice(0, 299)}…` : reason
        // Keep the raw transport of the failed summary, not only the phrase the
        // adapter reduced it to: a stream that dies after its headers looks
        // exactly like a model that answered nothing.
        try {
          await this.flushTransport(
            snapshot.cwd,
            `summarization request (${summaryMode ?? 'unknown'} mode) after the digest fell back: ${fallbackReason}`,
            transportFrom,
          )
        } catch {
          // Diagnostics must never fail a handoff.
        }
      }
    }

    if (body === undefined) {
      body = buildFallbackBody({
        title,
        messages: snapshot.messages,
        language,
        stats: { promptTokens: snapshot.promptTokens, created: createdAt.toISOString() },
        includeToolDetails: this.config.includeToolDetails,
      })
    }
    if (this.config.redactSecrets) body = redactSecrets(body)
    if (goal !== undefined) {
      // A goal is durable per session and its continuation authority is
      // process-local, so a new session starts with neither. Recording it costs
      // a few lines and keeps the objective from disappearing with the old
      // chat; re-creating it here would arm automatic rounds in a session whose
      // first turn is the resume prompt, so the new session decides that itself.
      body = `${body.trimEnd()}\n\n${renderGoalSection(goal, language, goalMode)}\n`
    }

    const baseMeta = {
      dsh_handoff: 1,
      session: snapshot.session.id,
      created: createdAt.toISOString(),
      cwd: snapshot.cwd,
      provider: snapshot.target?.provider ?? '',
      model: snapshot.target?.model ?? '',
      source_tokens: snapshot.promptTokens,
      ...(snapshot.windowTokens === undefined ? {} : { window_tokens: snapshot.windowTokens }),
      fixed_tokens: snapshot.fixedPrefixTokens,
      budget_tokens: budget,
      horizon_turns: this.config.horizonTurns,
      generator,
      summary_mode: generator === 'llm' ? summaryMode ?? 'unknown' : 'fallback',
      language,
      truncated: false,
      ...(goal === undefined
        ? {}
        : {
            goal_objective: goal.objective,
            goal_phase: goal.phase,
            goal_rounds: goal.roundsStarted,
            goal_max_rounds: goal.maxGoalRounds,
          }),
    }

    let meta = baseMeta
    let finalBody = body
    let content = ''
    let digestTokens = 0
    let truncated = false
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const enforced = enforceFileBudget({
        meta,
        body: finalBody,
        cwd: snapshot.cwd,
        relativePath,
        title,
        budgetTokens: budget,
        meter: snapshot.meter,
        language,
      })
      content = enforced.text
      finalBody = enforced.body
      digestTokens = enforced.tokens
      truncated = truncated || enforced.truncated
      const actualPlan = this.planFor(snapshot, enforced.tokens)
      const nextMeta = {
        ...baseMeta,
        digest_tokens: Math.round(enforced.tokens),
        saving_per_turn: Math.round(actualPlan.savingPerTurn),
        ...(Number.isFinite(actualPlan.breakEvenTurns)
          ? { break_even_turns: Math.round(actualPlan.breakEvenTurns * 100) / 100 }
          : {}),
        projected_saved_tokens: Math.round(actualPlan.projectedSavings),
        truncated,
      }
      const settled = meta.digest_tokens === nextMeta.digest_tokens && meta.truncated === nextMeta.truncated
      meta = nextMeta
      if (settled) break
    }
    content = renderHandoffFile({
      meta,
      body: finalBody,
      cwd: snapshot.cwd,
      relativePath,
      title,
      language,
    })
    digestTokens = priceHandoff(snapshot.meter, content)
    // Converge the reported digest size with the final frontmatter digits.
    for (let attempt = 0; attempt < 2 && meta.digest_tokens !== Math.round(digestTokens); attempt += 1) {
      const settledPlan = this.planFor(snapshot, digestTokens)
      meta = {
        ...meta,
        digest_tokens: Math.round(digestTokens),
        saving_per_turn: Math.round(settledPlan.savingPerTurn),
        ...(Number.isFinite(settledPlan.breakEvenTurns)
          ? { break_even_turns: Math.round(settledPlan.breakEvenTurns * 100) / 100 }
          : {}),
        projected_saved_tokens: Math.round(settledPlan.projectedSavings),
      }
      content = renderHandoffFile({
        meta,
        body: finalBody,
        cwd: snapshot.cwd,
        relativePath,
        title,
        language,
      })
      digestTokens = priceHandoff(snapshot.meter, content)
    }

    const actualPlan = this.planFor(snapshot, digestTokens)
    await writeHandoff(dir, filename, content)
    const pruned = await pruneHandoffs(dir, this.config.keepFiles)

    let newSession
    let sessionError
    let goalTransfer
    let sourceGoalClose
    if (options.newSession) {
      try {
        newSession = await this.startNewSession(agent, snapshot, { relativePath, language })
      } catch (error) {
        sessionError = error instanceof Error ? error.message : String(error)
        this.ctx.logger?.warn?.(`context-handoff: could not create a new session: ${sessionError}`)
      }
      if (newSession !== undefined) {
        goalTransfer = this.transferGoal(newSession.sessionId, goal)
        if (goalTransfer !== undefined) sourceGoalClose = this.closeSourceGoal(agent, goal)
      }
    }

    const effectiveSummaryTokens =
      summary?.effectiveTokens !== undefined ? summary.effectiveTokens : generator === 'llm' ? Math.round(actualPlan.oneTimeCost) : 0
    if (this.config.ledger) {
      await appendLedger(dir, {
        v: 1,
        at: createdAt.toISOString(),
        session: snapshot.session.id,
        file: relativePath,
        trigger,
        generator,
        summary_mode: generator === 'llm' ? summaryMode ?? 'unknown' : 'fallback',
        omitted_messages: omittedMessages,
        ...(fallbackReason === undefined ? {} : { fallback_reason: fallbackReason }),
        language,
        provider: snapshot.target?.provider ?? '',
        model: snapshot.target?.model ?? '',
        source_tokens: snapshot.promptTokens,
        fixed_tokens: snapshot.fixedPrefixTokens,
        digest_tokens: Math.round(digestTokens),
        budget_tokens: budget,
        window_tokens: snapshot.windowTokens ?? 0,
        summary_tokens: Math.round(effectiveSummaryTokens),
        summary_input_tokens: summary?.usage === undefined
          ? 0
          : (Number(summary.usage.inputTokens) || 0) +
            (Number(summary.usage.cacheReadTokens) || 0) +
            (Number(summary.usage.cacheWriteTokens) || 0),
        summary_output_tokens: summary?.usage === undefined ? 0 : Number(summary.usage.outputTokens) || 0,
        saving_per_turn: Math.round(actualPlan.savingPerTurn),
        break_even_turns: Number.isFinite(actualPlan.breakEvenTurns)
          ? Math.round(actualPlan.breakEvenTurns * 100) / 100
          : 0,
        horizon_turns: actualPlan.horizonTurns,
        projected_saved_tokens: Math.round(actualPlan.projectedSavings),
        truncated,
        ...(newSession === undefined ? {} : { new_session: newSession.sessionId }),
        ...(newSession?.via === undefined ? {} : { new_session_via: newSession.via }),
        ...(sessionError === undefined ? {} : { new_session_error: sessionError }),
        ...(goalTransfer === undefined ? {} : { goal_transferred: goalTransfer.phase, goal_activation: goalTransfer.activation ?? '' }),
        ...(sourceGoalClose === undefined ? {} : { goal_source_closed: sourceGoalClose }),
      })
    }

    this.ctx.logger?.info?.(
      `context-handoff: wrote ${relativePath} (${formatTokens(digestTokens)} tokens, generator ${generator}${truncated ? ', trimmed' : ''}${pruned.length > 0 ? `, pruned ${pruned.length}` : ''})`,
    )

    const text = formatGeneratedReport({
      relativePath,
      cwd: snapshot.cwd,
      plan: actualPlan,
      digestTokens,
      budgetTokens: budget,
      generator,
      truncated,
      fallbackReason,
      language,
      summaryMode,
      omittedMessages,
      newSessionId: newSession?.sessionId,
      newSessionIdle: newSession?.idle === true,
      sessionVia: newSession?.via,
      sessionError,
      goalTransfer,
      sourceGoalClose,
    })
    return {
      text,
      path: absolutePath,
      relativePath,
      digestTokens,
      plan: actualPlan,
      generator,
      truncated,
      pruned,
      ...(newSession === undefined ? {} : { newSessionId: newSession.sessionId }),
      ...(newSession?.via === undefined ? {} : { newSessionVia: newSession.via }),
      ...(sessionError === undefined ? {} : { sessionError }),
      ...(goalTransfer === undefined ? {} : { goalTransfer }),
      ...(sourceGoalClose === undefined ? {} : { sourceGoalClose }),
    }
  }

  /**
   * Create a fresh root session in the same workspace and queue the resume
   * prompt. The handoff file is already on disk, so the new session reads it on
   * its first turn. Failures are reported to the caller; the file remains valid.
   *
   * The session is created through the session controller, the path the Web
   * client itself uses, so it inherits the agent preset and joins its workspace
   * group. A bare `agents.create` leaves the agent without a preset: it runs
   * with the base tool set only and without the preset's model wiring, so its
   * first request fails at the transport before the resume prompt ever reaches
   * the model.
   *
   * @param {object} sourceAgent
   * @param {object} snapshot
   * @param {{relativePath: string, language: 'en'|'zh'}} input
   * @returns {Promise<{sessionId: string}>}
   */
  async startNewSession(sourceAgent, snapshot, { relativePath, language }) {
    const created = await this.createRootAgent(snapshot, sourceAgent)
    const agent = created.agent
    const sessionId = created.sessionId ?? agent?.session?.id
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('the new session did not expose an id')
    }
    const heading = language === 'zh' ? '下一步' : 'Next steps'
    // The first message is injected by the host, not typed into the composer,
    // so it names the file as a plain workspace-relative path. An `@` reference
    // is a composer feature: the client resolves it into a staged attachment,
    // and a raw `@path` produced on the host side reaches the model as literal
    // text pointing at a file nothing has attached.
    const prompt = language === 'zh'
      ? `Handoff file: ${relativePath}. Read it and continue from the "${heading}" section. 先读文件，不要复述摘要，直接从第一个下一步动作开始。`
      : `Handoff file: ${relativePath}. Read it and continue from the "${heading}" section. Do not restate the handoff; start with the first next action.`
    // Any admitted prompt starts a turn, and `queue`/`steer` differ only in how
    // they wait for a running one. So "leave the turn to the person" means not
    // admitting anything: `manual` creates the session and stops there.
    if (this.config.resumeMode === 'manual') {
      this.createdAgents.set(sessionId, agent)
      void this.diagnose(snapshot?.cwd, `created ${sessionId} and left it idle (resumeMode=manual; no prompt sent)`)
      return {
        sessionId,
        ...(created.via === undefined ? {} : { via: created.via }),
        idle: true,
      }
    }
    const message = this.config.resumeMode === 'brief'
      ? language === 'zh'
        ? `Handoff file: ${relativePath}. 先读这个文件，然后用一句话说出第一个下一步动作就停下，等我的指示，不要开始工作。`
        : `Handoff file: ${relativePath}. Read it now, then reply with the one next step you would take and stop there — do not start working until I say so.`
      : prompt
    try {
      this.installFetchObserver()
      // Two throwaway model calls are only worth their tokens while a first-turn
      // transport failure is still unexplained; opt in with
      // DSH_HANDOFF_PROBE=1 when gathering that evidence.
      if (process.env.DSH_HANDOFF_PROBE === '1') await this.probeRoute(snapshot, sessionId)
      await this.sendFirstPrompt(created.controller, agent, sessionId, message, snapshot)
    } catch (error) {
      this.restoreFetch()
      await this.disposeSession(sessionId)
      throw error
    }
    this.createdAgents.set(sessionId, agent)
    return {
      sessionId,
      ...(created.via === undefined ? {} : { via: created.via }),
    }
  }

  /**
   * Deliver the resume prompt through the same RPC the composer uses.
   *
   * `agent.followup` skips prompt admission: the message then reaches the agent
   * as a bare `{kind: 'user'}` source, so the host injects the runtime context,
   * the skill catalog, and the time note as loose text. `sessionController.prompt`
   * admits the prompt the way a typed one is admitted — the message records a
   * user-rpc source with the client's time zone, and the host attaches its
   * context as structured `runtime-context` / `skill-catalog` / `time-context`
   * parts, which is exactly the shape a hand-written first turn has.
   *
   * @param {object} controller
   * @param {object} agent
   * @param {string} sessionId
   * @param {string} text
   * @param {object} snapshot
   * @returns {Promise<void>}
   */
  async sendFirstPrompt(controller, agent, sessionId, text, snapshot) {
    const prompt = this.controllerCall(controller, 'prompt')
    const cwd = typeof snapshot?.cwd === 'string' ? snapshot.cwd : undefined
    if (prompt !== undefined) {
      const zone = this.clientTimeZoneOf(snapshot)
      try {
        // `SessionController.prompt(request, signal)` opens with
        // `signal.throwIfAborted()`, so an omitted signal is a TypeError rather
        // than a default: the call rejected, the catch below fell back to
        // `agent.followup`, and the fallback looked like success. Every handoff
        // therefore delivered its first prompt without prompt admission — no
        // rpcId on the recorded source, no client time zone, and the host's
        // context attached as loose text instead of structured parts.
        await prompt({
          sessionId,
          requestId: randomUUID(),
          mode: 'queue',
          content: [{ type: 'text', text }],
          ...(zone === undefined ? {} : { clientTimeZone: zone }),
        }, AbortSignal.timeout(30000))
        this.transportRecord?.('marker', `first prompt admitted through sessionController.prompt for ${sessionId} (zone ${zone ?? 'unknown'})`)
        if (cwd !== undefined) void this.diagnose(cwd, `first prompt admitted through sessionController.prompt (zone ${zone ?? 'unknown'})`)
        return
      } catch (error) {
        this.warn(`context-handoff: the controller could not admit the first prompt, sending it directly: ${String(error)}`)
        this.transportRecord?.('probe-error', `sessionController.prompt failed, falling back to agent.followup\n${this.describeError(error)}`)
        if (cwd !== undefined) void this.diagnose(cwd, `sessionController.prompt failed, falling back to agent.followup:\n${this.describeError(error)}`)
      }
    } else {
      this.transportRecord?.('marker', 'no sessionController.prompt in this composition; using agent.followup')
      if (cwd !== undefined) void this.diagnose(cwd, 'no sessionController.prompt in this composition; using agent.followup')
    }
    await agent.followup({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
  }

  /**
   * Read the client time zone the finished conversation was recorded with, so
   * the new session's context names the same zone instead of "unavailable".
   *
   * @param {object} snapshot
   * @returns {string|undefined}
   */
  clientTimeZoneOf(snapshot) {
    const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : []
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const zone = messages[index]?.source?.clientTimeZone
      if (typeof zone === 'string' && zone.length > 0) return zone
    }
    return undefined
  }

  /**
   * Create the root agent for a handoff through the host's session controller —
   * the same path the Web client takes for "+ new chat". That path resolves and
   * mounts the default agent preset (toolset and system prompt) and attaches
   * the session to its workspace, so the conversation starts with a full agent
   * in its own workspace group instead of a bare agent in Ungrouped.
   *
   * The model is deliberately left alone: the controller applies the deployment
   * default, which is the same model a hand-written "+ new chat" gets. Choosing
   * a model here would spend the user's balance on a route they did not pick.
   *
   * The bare agent remains as a fallback for compositions without a controller.
   *
   * @param {object} snapshot
   * @param {object} sourceAgent
   * @returns {Promise<{agent: object, sessionId: string, controller?: object}>}
   */
  async createRootAgent(snapshot, sourceAgent) {
    const cwd = snapshot.cwd
    const controller = this.sessionController()
    const create = this.controllerCall(controller, 'create') ?? this.controllerCall(controller, 'createSession')
    if (create !== undefined) {
      const workspaceId = await this.workspaceIdFor(cwd)
      let created
      try {
        created = await create(workspaceId === undefined ? { cwd } : { workspaceId })
      } catch (error) {
        this.warn(`context-handoff: the session controller could not create a session: ${String(error)}`)
      }
      const sessionId = created?.sessionId ?? created?.session?.id
      const agent = created?.agent ?? (await this.awaitAgent(sessionId))
      if (typeof sessionId === 'string' && agent !== undefined) {
        this.transportRecord?.('marker', `handoff session ${sessionId} created; first prompt follows`)
        void this.diagnose(cwd, `created ${sessionId} via session controller (workspace ${workspaceId ?? '(none)'}, source ${sourceAgent?.session?.id ?? '(unknown)'})`)
        return { agent, sessionId, controller, via: 'session controller' }
      }
      if (created !== undefined) this.warn(`context-handoff: the session controller returned no live session for ${cwd}`)
    }
    const presetId = await this.defaultPresetId()
    const bare = await this.createBareAgent(cwd, presetId)
    void this.diagnose(cwd, `created ${bare.sessionId} via bare agent (preset ${presetId ?? '(none)'}, source ${sourceAgent?.session?.id ?? '(unknown)'})`)
    return { ...bare, via: 'bare agent' }
  }

  /**
   * Resolve one command on the controller, or on the business controller it
   * delegates to. The remote service exposes the commands directly; older
   * compositions keep them on `commands`.
   *
   * @param {object} controller
   * @param {string} name
   * @returns {((request: object) => Promise<object>)|undefined}
   */
  controllerCall(controller, name) {
    if (controller === undefined || controller === null) return undefined
    const direct = controller[name]
    if (typeof direct === 'function') return (...args) => direct.call(controller, ...args)
    const nested = controller.commands?.[name]
    if (typeof nested === 'function') return (...args) => nested.call(controller.commands, ...args)
    return undefined
  }

  /** Read a live agent by id without throwing. */
  liveAgent(sessionId) {
    if (typeof sessionId !== 'string') return undefined
    try {
      return this.ctx.agents?.get?.(sessionId)
    } catch {
      return undefined
    }
  }

  /**
   * Wait for the controller to publish the agent it just created. Publication
   * is synchronous in the current host; the short retry only guards a
   * composition that publishes on a later tick.
   *
   * @param {string} sessionId
   * @param {number} [attempts]
   * @returns {Promise<object|undefined>}
   */
  async awaitAgent(sessionId, attempts = 4) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const agent = this.liveAgent(sessionId)
      if (agent !== undefined) return agent
      await new Promise((resolve) => { setTimeout(resolve, 25) })
    }
    return undefined
  }

  /**
   * Find the workspace that owns a directory, so a created session joins its
   * group. Without an identity the controller creates the session ungroupped.
   *
   * @param {string} cwd
   * @returns {Promise<string|undefined>}
   */
  async workspaceIdFor(cwd) {
    try {
      const registry = this.ctx.get?.('workspaceRegistry')
      const workspace = await registry?.resolveByPath?.(cwd)
      return typeof workspace?.id === 'string' ? workspace.id : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Read the default agent preset id, when the deployment has a roster.
   *
   * @returns {Promise<string|undefined>}
   */
  async defaultPresetId() {
    try {
      const presets = this.ctx.get?.('agentPresets')
      if (presets === undefined) return undefined
      const resolved = await presets.resolve(undefined)
      return typeof resolved?.id === 'string' ? resolved.id : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Create a bare agent with the preset mounted. This mirrors what the
   * controller does, for compositions that mount no session controller. The
   * model is left at the deployment default, exactly like the controller path.
   *
   * @param {string} cwd
   * @param {string|undefined} presetId
   * @returns {Promise<{agent: object, sessionId: string}>}
   */
  async createBareAgent(cwd, presetId) {
    const sessionId = `session-${randomUUID()}`
    const presets = presetId === undefined ? undefined : this.ctx.get?.('agentPresets')
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: { cwd, ...(presetId === undefined ? {} : { agentPreset: presetId }) },
      ...(presets === undefined
        ? {}
        : { setup: async (agentCtx) => { await presets.mount(agentCtx, presetId) } }),
    })
    await this.attachToWorkspace(cwd, sessionId)
    return { agent: handle.agent, sessionId }
  }

  /**
   * Attach a session created outside the controller to its workspace group.
   *
   * @param {string} cwd
   * @param {string} sessionId
   * @returns {Promise<void>}
   */
  async attachToWorkspace(cwd, sessionId) {
    const workspaceId = await this.workspaceIdFor(cwd)
    if (workspaceId === undefined) return
    try {
      await this.ctx.get?.('workspaceRegistry')?.get?.(workspaceId)?.attachSession?.(sessionId)
    } catch (error) {
      this.warn(`context-handoff: the new session could not join its workspace: ${String(error)}`)
    }
  }

  /** Log a non-fatal problem through the host logger. */
  warn(message) {
    try {
      this.ctx.logger?.warn?.(message)
    } catch {
      // A composition without a logger still completes the handoff.
    }
  }

  /**
   * Append one diagnostic record to `<workspace>/.dsh/handoff/diagnostics.log`.
   * A handoff session that fails its first turn leaves nothing behind in the
   * panel and the host records only the model-facing message, so this file is
   * the one place the error chain survives.
   *
   * @param {string} cwd
   * @param {string} message
   * @returns {Promise<void>}
   */
  async diagnose(cwd, message) {
    try {
      const dir = resolveOutputDir(cwd, this.config.outputDir)
      await mkdir(dir, { recursive: true })
      await appendFile(path.join(dir, 'diagnostics.log'), `${new Date().toISOString()} ${message}\n`)
    } catch {
      // Diagnostics must never fail a handoff.
    }
  }

  /**
   * Render an error and its cause chain as one indented block.
   *
   * @param {unknown} error
   * @returns {string}
   */
  describeError(error) {
    const lines = []
    let current = error
    let depth = 0
    while (current !== undefined && current !== null && depth < 6) {
      if (typeof current !== 'object') {
        lines.push(`${'  '.repeat(depth)}${String(current)}`)
        break
      }
      const name = typeof current.name === 'string' ? current.name : 'Error'
      const code = typeof current.code === 'string' ? ` [${current.code}]` : ''
      const message = typeof current.message === 'string' ? current.message : String(current)
      lines.push(`${'  '.repeat(depth)}${name}${code}: ${message}`)
      if (typeof current.stack === 'string' && depth === 0) {
        lines.push(`${'  '.repeat(depth + 1)}${current.stack.split('\n').slice(1, 5).join('\n' + '  '.repeat(depth + 1))}`)
      }
      current = current.cause
      depth += 1
    }
    return lines.join('\n')
  }

  /** Watch the sessions this plugin created and record why a turn failed. */
  installDiagnostics() {
    const plugin = this
    this.ctx.on('agent/error', ({ agent, error }) => {
      const sessionId = typeof agent?.id === 'string' ? agent.id : agent?.session?.id
      if (typeof sessionId !== 'string' || !plugin.createdAgents.has(sessionId)) return
      const cwd = plugin.sessionCwd(agent.session)
      void plugin.diagnose(cwd, `agent error in handoff session ${sessionId}:\n${plugin.describeError(error)}`)
      void plugin.flushTransport(cwd, `transport around agent error in ${sessionId}`)
    })
    this.ctx.on('session/event', (session, event) => {
      if (event?.type !== 'turn/end') return
      const sessionId = session?.id
      if (typeof sessionId !== 'string' || !plugin.createdAgents.has(sessionId)) return
      const cwd = plugin.sessionCwd(session)
      const turn = event.data?.turn
      const reason = event.data?.reason
      plugin.restoreFetch()
      if (reason?.kind === 'error') {
        void plugin.diagnose(cwd, `turn ${turn} failed in handoff session ${sessionId}: ${reason.error?.code ?? ''} ${reason.error?.message ?? ''}`)
        void plugin.flushTransport(cwd, `transport around failing turn ${turn} in ${sessionId}`)
      } else {
        void plugin.flushTransport(cwd, `transport around completed turn ${turn} in ${sessionId}`)
      }
    })
  }

  /**
   * Subscribe to the raw Node transport channels of the global `fetch`.
   *
   * The model service turns every adapter throw into a terminal `{message, code}`
   * failure chunk, so `TRANSPORT` reaches the session log without its cause. These
   * channels sit below that conversion: they show whether a request left the
   * process at all and, when it did, the exact fetch error and status.
   *
   * Subscription is read-only and never wraps a host service.
   */
  installTransportDiagnostics() {
    const plugin = this
    const disposers = []
    const relevant = (origin) => typeof origin === 'string' && /deepseek/iu.test(origin)
    const record = (kind, text) => {
      plugin.transportRecords.push(`${new Date().toISOString()} ${kind} ${text}`)
      if (plugin.transportRecords.length > 600) plugin.transportRecords.splice(0, 300)
    }
    plugin.transportRecord = record
    const subscribe = (name, handler) => {
      try {
        diagnosticsChannel(name).subscribe(handler)
        disposers.push(() => {
          try {
            diagnosticsChannel(name).unsubscribe(handler)
          } catch {
            // The channel outlives this plugin; an unsubscribe race is harmless.
          }
        })
      } catch {
        // A Node build without this channel simply records nothing.
      }
    }
    const urlOf = (request) => {
      try {
        return `${request?.origin ?? ''}${request?.path ?? ''}`
      } catch {
        return '(unreadable request)'
      }
    }
    subscribe('undici:request:create', (message) => {
      try {
        const request = message?.request
        if (!relevant(request?.origin)) return
        const body = request?.body
        const size = typeof body === 'string' ? body.length : body === undefined || body === null ? 0 : 'stream'
        record('request-created', `${request?.method ?? ''} ${urlOf(request)} body=${size}`)
      } catch {
        // Diagnostics never interfere with the request it observes.
      }
    })
    subscribe('undici:request:headers', (message) => {
      try {
        const request = message?.request
        if (!relevant(request?.origin)) return
        const status = message?.response?.statusCode
        record('response-headers', `${urlOf(request)} status=${status ?? '?'}`)
      } catch {
        // Ignore.
      }
    })
    subscribe('undici:request:error', (message) => {
      try {
        const request = message?.request
        if (!relevant(request?.origin)) return
        record('request-error', `${urlOf(request)}\n${plugin.describeError(message?.error)}`)
      } catch {
        // Ignore.
      }
    })
    subscribe('undici:client:connectError', (message) => {
      try {
        const params = message?.connectParams
        const origin = params?.origin === undefined ? '' : String(params.origin)
        if (!relevant(origin)) return
        record('connect-error', `${origin}\n${plugin.describeError(message?.error)}`)
      } catch {
        // Ignore.
      }
    })
    try {
      this.ctx.effect(() => () => {
        for (const dispose of disposers) dispose()
      }, 'context-handoff: transport diagnostics')
    } catch {
      // Without an effect scope the subscriptions live with the process, which is
      // still read-only; the ring buffer stays bounded.
    }
  }

  /**
   * Append the recent raw transport records to the diagnostics log.
   * @param {string} cwd
   * @param {string} label
   * @param {number} [from] - first ring index to include; defaults to the last 120.
   * @returns {Promise<void>}
   */
  async flushTransport(cwd, label, from) {
    const records = from === undefined
      ? this.transportRecords.slice(-120)
      : this.transportRecords.slice(Math.max(0, from))
    if (records.length === 0) {
      await this.diagnose(cwd, `${label}: no undici request was observed at all`)
      return
    }
    await this.diagnose(cwd, `${label}: ${records.length} raw transport record(s)\n${records.join('\n')}`)
  }

  /** Read the session controller without an inject requirement. */
  sessionController() {
    try {
      const service = this.ctx.get?.('sessionController')
      if (service !== undefined) return service
    } catch {
      // The controller may live in a scope this context cannot read directly.
    }
    try {
      return this.ctx.sessionController
    } catch {
      return undefined
    }
  }

  /** Drop a session whose first prompt could not be queued. */
  async disposeSession(sessionId) {
    try {
      await this.ctx.agents.get?.(sessionId)?.dispose?.()
    } catch {
      // A session that never started has nothing else to release.
    }
  }

  /**
   * Watch the global `fetch` while the new session's first turn runs.
   *
   * The undici channels in {@link installTransportDiagnostics} see a request that
   * reached the dispatcher. A `fetch` that rejects before dispatch — an invalid
   * argument, an unusable socket, a refused pre-flight — leaves no channel event
   * at all. This observer closes that gap: it calls the original `fetch` with the
   * same arguments, records the rejection together with its cause chain, and
   * rethrows the very same error object, so no caller can observe a difference.
   *
   * The patch lives only while one handoff is starting: {@link restoreFetch} runs
   * on the first `turn/end` of the new session and on a 3-minute timer.
   */
  installFetchObserver() {
    if (this.fetchObserver !== undefined) return
    const plugin = this
    const original = globalThis.fetch
    if (typeof original !== 'function') return
    const observed = function observedFetch(input, init) {
      const pending = original.call(this, input, init)
      try {
        return pending.catch((error) => {
          try {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url
            if (typeof url === 'string' && /deepseek/u.test(url)) {
              plugin.transportRecord?.('fetch-rejected', `${url}\n${plugin.describeError(error)}`)
            }
          } catch {
            // Observation must never change the rejection it reports.
          }
          throw error
        })
      } catch {
        return pending
      }
    }
    try {
      globalThis.fetch = observed
    } catch {
      return
    }
    const timer = setTimeout(() => {
      plugin.restoreFetch()
    }, 180000)
    if (typeof timer.unref === 'function') timer.unref()
    this.fetchObserver = { original, observed, timer }
    this.transportRecord?.('marker', 'fetch observer armed for the first handoff turn')
  }

  /** Put the process-wide `fetch` back exactly as it was found. */
  restoreFetch() {
    const state = this.fetchObserver
    if (state === undefined) return
    this.fetchObserver = undefined
    try {
      clearTimeout(state.timer)
    } catch {
      // Ignore.
    }
    try {
      if (globalThis.fetch === state.observed) globalThis.fetch = state.original
    } catch {
      // Ignore.
    }
    this.transportRecord?.('marker', 'fetch observer restored')
  }

  /**
   * Ask the route one throwaway question over both call paths before the real turn.
   *
   * The failing first turn dies in single-digit milliseconds, which is far too
   * fast for a network round trip, while a title request on the same route in the
   * same process succeeds in about a second. Two things differ: the path
   * (`prepareCall` + a fresh catalog connection versus `stream` and the cached
   * connection) and the request itself. These probes use one trivial message
   * with no tools, so a failure proves the path is at fault and a success proves
   * the request content is — the one distinction a single run can settle.
   *
   * @param {object} snapshot
   * @param {string} sessionId
   * @returns {Promise<void>}
   */
  async probeRoute(snapshot, sessionId) {
    const llm = this.ctx.llm
    if (llm === undefined || llm === null) return
    const provider = snapshot?.target?.provider
    const model = snapshot?.target?.model
    if (typeof provider !== 'string' || typeof model !== 'string' || provider.length === 0 || model.length === 0) return
    const from = this.transportRecords.length
    this.transportRecord?.('marker', `route probes for ${provider}/${model} (session ${sessionId})`)
    const messages = [{
      role: 'user',
      id: randomUUID(),
      content: [{ type: 'text', text: 'Handoff route probe. Reply with the single word: ok' }],
      source: { kind: 'user' },
    }]
    const drain = async (label, stream) => {
      let finish
      try {
        for await (const chunk of stream) if (chunk?.type === 'finish') finish = chunk.reason
        this.transportRecord?.('marker', `${label}: finish=${JSON.stringify(finish ?? { kind: 'stop' })}`)
      } catch (error) {
        this.transportRecord?.('probe-error', `${label}\n${this.describeError(error)}`)
      }
    }
    if (typeof llm.prepareCall === 'function') {
      try {
        const signal = AbortSignal.timeout(15000)
        const call = await llm.prepareCall({ provider, model }, signal)
        this.transportRecord?.('marker', `prepared-call config=${JSON.stringify(call?.config)} adapterDefaults=${JSON.stringify(call?.adapterDefaults)}`)
        await drain('prepared-call', call.stream({ ...call.config, messages, sessionId, signal }))
      } catch (error) {
        this.transportRecord?.('probe-error', `prepared-call (preparation)\n${this.describeError(error)}`)
      }
    }
    if (typeof llm.stream === 'function') {
      try {
        await drain('plain-stream', llm.stream({ provider, model, messages, maxTokens: 32, sessionId, signal: AbortSignal.timeout(15000) }))
      } catch (error) {
        this.transportRecord?.('probe-error', `plain-stream (dispatch)\n${this.describeError(error)}`)
      }
    }
    await this.flushTransport(snapshot?.cwd ?? process.cwd(), 'route probes before the first prompt', from)
  }

  planFor(snapshot, digestTokens) {
    return computePlan({
      promptTokens: snapshot.promptTokens,
      fixedPrefixTokens: snapshot.fixedPrefixTokens,
      digestTokens,
      windowTokens: snapshot.windowTokens,
      horizonTurns: this.config.horizonTurns,
      cacheHitRatio: this.config.cacheHitRatio,
      cacheReadWeight: this.config.cacheReadWeight,
      switchOverheadTokens: this.config.switchOverheadTokens,
      recommendAtRatio: this.config.recommendAtRatio,
      recommendMaxTokens: this.config.recommendMaxTokens,
      reserveTokens: this.config.maxOutputTokens > 0 ? this.config.maxOutputTokens + 4096 : 8192,
    })
  }

  /** Register the sidebar bridge routes when the Web host provides webServer. */
  installHttpRoutes() {
    if (typeof this.ctx.inject !== 'function') return
    const plugin = this
    this.ctx.inject(['webServer'], (hostCtx) => {
      const disposers = []
      const register = (route) => {
        disposers.push(hostCtx.webServer.register(route))
      }
      register({
        kind: 'exact',
        path: '/context-handoff/api/state',
        handler: (request, response) => {
          void plugin.handleStateRoute(request, response)
        },
      })
      register({
        kind: 'exact',
        path: '/context-handoff/api/auto',
        handler: (request, response) => {
          void plugin.handleAutoRoute(request, response)
        },
      })
      register({
        kind: 'exact',
        path: '/context-handoff/api/run',
        handler: (request, response) => {
          void plugin.handleRunRoute(request, response)
        },
      })
      register({
        kind: 'exact',
        path: '/context-handoff/api/ack',
        handler: (request, response) => {
          void plugin.handleAckRoute(request, response)
        },
      })
      hostCtx.effect(function* removeHandoffRoutes() {
        yield () => {
          for (const dispose of disposers.reverse()) dispose()
        }
      }, 'context-handoff routes')
    })
  }

  /** GET /context-handoff/api/state?session=<id> */
  async handleStateRoute(request, response) {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        sendJson(response, 405, { ok: false, error: 'GET only' })
        return
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const state = await this.stateForSession(url.searchParams.get('session'))
      sendJson(response, 200, state)
    } catch (error) {
      sendError(response, error)
    }
  }

  /** POST /context-handoff/api/auto { sessionId, enabled } */
  async handleAutoRoute(request, response) {
    try {
      if (!mutationAllowed(request)) {
        sendJson(response, 403, { ok: false, error: 'request refused' })
        return
      }
      if (request.method !== 'POST') {
        sendJson(response, 405, { ok: false, error: 'POST only' })
        return
      }
      const body = await readJsonBody(request)
      if (typeof body?.sessionId !== 'string' || typeof body?.enabled !== 'boolean') {
        sendJson(response, 400, { ok: false, error: 'sessionId and enabled are required' })
        return
      }
      const session = this.ctx.sessions.get(body.sessionId)
      if (session === undefined) {
        sendJson(response, 404, { ok: false, error: 'session not found' })
        return
      }
      const cwd = this.sessionCwd(session)
      await this.autoState.write(cwd, body.enabled)
      const state = await this.stateForSession(body.sessionId)
      sendJson(response, 200, state)
      if (body.enabled) {
        const agent = this.ctx.agents.get(body.sessionId)
        if (agent !== undefined) setTimeout(() => void this.maybeAuto(agent), 150)
      }
    } catch (error) {
      sendError(response, error)
    }
  }

  /** POST /context-handoff/api/run { sessionId, newSession } */
  async handleRunRoute(request, response) {
    try {
      if (!mutationAllowed(request)) {
        sendJson(response, 403, { ok: false, error: 'request refused' })
        return
      }
      if (request.method !== 'POST') {
        sendJson(response, 405, { ok: false, error: 'POST only' })
        return
      }
      const body = await readJsonBody(request)
      if (typeof body?.sessionId !== 'string') {
        sendJson(response, 400, { ok: false, error: 'sessionId is required' })
        return
      }
      const agent = this.ctx.agents.get(body.sessionId)
      if (agent === undefined) {
        sendJson(response, 409, { ok: false, error: 'session is not live' })
        return
      }
      const result = await this.generate(agent, {
        trigger: 'panel',
        newSession: body.newSession === true,
      })
      sendJson(response, 200, { ok: true, result })
    } catch (error) {
      if (error instanceof HandoffBusyError) {
        sendJson(response, 409, { ok: false, error: error.message })
        return
      }
      sendError(response, error)
    }
  }

  /** POST /context-handoff/api/ack { sessionId, newSessionId } */
  async handleAckRoute(request, response) {
    try {
      if (!mutationAllowed(request)) {
        sendJson(response, 403, { ok: false, error: 'request refused' })
        return
      }
      if (request.method !== 'POST') {
        sendJson(response, 405, { ok: false, error: 'POST only' })
        return
      }
      const body = await readJsonBody(request)
      const entry = typeof body?.sessionId === 'string' ? this.lastAutoBySource.get(body.sessionId) : undefined
      if (entry !== undefined && (body.newSessionId === undefined || entry.newSessionId === body.newSessionId)) {
        this.lastAutoBySource.delete(body.sessionId)
      }
      sendJson(response, 200, { ok: true })
    } catch (error) {
      sendError(response, error)
    }
  }

  /** Build the sidebar payload for one live session. */
  async stateForSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return { ok: false, error: 'sessionId is required' }
    const session = this.ctx.sessions.get(sessionId)
    if (session === undefined) return { ok: false, error: 'session not found' }
    const cwd = this.sessionCwd(session)
    const agent = this.ctx.agents.get(sessionId)
    const setting = await this.autoState.read(cwd)
    if (agent === undefined) {
      return {
        ok: false,
        error: 'session is not live',
        sessionId,
        cwd,
        auto: setting.auto,
        autoExplicit: setting.explicit,
        resumeMode: this.config.resumeMode,
      }
    }
    const snapshot = await this.inspect(agent, { horizon: this.config.horizonTurns })
    const latest = await latestHandoff(snapshot.outputDir)
    const lastAuto = this.lastAutoBySource.get(sessionId)
    return {
      ok: true,
      sessionId,
      cwd,
      auto: setting.auto,
      autoExplicit: setting.explicit,
      autoNewSession: this.config.autoNewSession,
      resumeMode: this.config.resumeMode,
      model: snapshot.target === undefined ? '' : `${snapshot.target.provider}/${snapshot.target.model}`,
      promptTokens: snapshot.promptTokens,
      windowTokens: snapshot.windowTokens ?? 0,
      recommendedAt: Number.isFinite(snapshot.plan.recommendedAt) ? Math.round(snapshot.plan.recommendedAt) : 0,
      economicAt: Number.isFinite(snapshot.plan.economicAt) ? Math.round(snapshot.plan.economicAt) : 0,
      digestBudget: snapshot.digestBudget,
      savingPerTurn: Math.round(snapshot.plan.savingPerTurn),
      breakEvenTurns: Number.isFinite(snapshot.plan.breakEvenTurns)
        ? Math.round(snapshot.plan.breakEvenTurns * 100) / 100
        : 0,
      running: this.active.has(sessionId),
      backgroundJobs: this.runningJobs(sessionId),
      compaction: (() => {
        const record = this.compactions.get(sessionId)
        return {
          available: this.compactionAvailable(agent),
          source:
            this.compactionService(agent) !== undefined
              ? this.compactionSource
              : typeof this.commands?.execute === 'function'
                ? 'command'
                : 'none',
          probe: {
            agentGet: (() => {
              try {
                return typeof agent?.ctx?.get
              } catch {
                return 'threw'
              }
            })(),
            agentCompaction: (() => {
              try {
                if (agent?.ctx?.get?.('compaction') !== undefined) return 'object'
                return agent?.ctx?.get?.('compaction', false) === undefined ? 'undefined' : 'object(non-strict)'
              } catch (error) {
                return error instanceof Error ? error.message : 'threw'
              }
            })(),
            commandExecute: typeof this.commands?.execute,
            rootCompaction: (() => {
              try {
                return typeof this.ctx.compaction
              } catch {
                return 'throws-without-inject'
              }
            })(),
          },
          count: record?.count ?? 0,
          budget: this.config.maxCompactionsPerSession,
          before: record?.before ?? 0,
          after: record?.after ?? 0,
          saved: record?.saved ?? 0,
          at: record?.lastAt ?? 0,
        }
      })(),
      latest:
        latest === undefined
          ? null
          : {
              file: displayPath(cwd, latest.path),
              at: latest.mtimeMs,
              digestTokens: Number(latest.meta.digest_tokens) || 0,
              sourceTokens: Number(latest.meta.source_tokens) || 0,
            },
      lastAuto: lastAuto ?? null,
    }
  }

  sessionCwd(session) {
    return typeof session?.header?.cwd === 'string' && session.header.cwd.length > 0 ? session.header.cwd : process.cwd()
  }

  /**
   * The session's current goal, if the composition has the goal service.
   *
   * Goals are durable per session and their continuation activation is
   * process-local, so a new session starts with no goal at all. Reading it is
   * the only way to carry the objective across; any service error or shape
   * change degrades to "no goal" rather than failing a handoff.
   *
   * @param {object} agent
   * @returns {{id: string, objective: string, phase: string, roundsStarted: number, maxGoalRounds: number, activation?: string} | undefined}
   */
  sessionGoal(agent) {
    const service = this.goalService()
    if (service === undefined) return undefined
    let view
    try {
      view = service.get(agent)
    } catch {
      return undefined
    }
    if (view === null || typeof view !== 'object' || typeof view.objective !== 'string' || view.objective.trim().length === 0) return undefined
    return {
      id: String(view.id ?? ''),
      revision: Number(view.revision) || 1,
      objective: view.objective,
      phase: String(view.phase ?? 'unknown'),
      roundsStarted: Number(view.roundsStarted) || 0,
      maxGoalRounds: Number(view.maxGoalRounds) || 0,
      ...(typeof view.activation === 'string' ? { activation: view.activation } : {}),
    }
  }

  /** The goal service, when this composition mounts `@deepseek-ai/dsh-goal`. */
  goalService() {
    let service
    try {
      service = this.ctx.get?.('goals') ?? this.ctx.goals
    } catch {
      return undefined
    }
    if (service === undefined || service === null || typeof service.get !== 'function') return undefined
    return service
  }

  /**
   * Close the source session's goal once it has been handed to the new session.
   *
   * Two goals for one objective would be a duplicate-work trap, and an armed or
   * resumable leftover is exactly how the old chat gets revived by accident.
   * `clear` is the default because it makes no claim about the work: `complete`
   * would record the objective as achieved, and `pause` keeps a Resume chip.
   * The durable history stays in the session log either way.
   *
   * @param {object} sourceAgent
   * @param {object|undefined} goal
   * @returns {string | undefined} the operation applied.
   */
  closeSourceGoal(sourceAgent, goal) {
    const mode = this.config.handoffGoalSource
    if (goal === undefined || mode === 'keep') return undefined
    const service = this.goalService()
    if (service === undefined) return undefined
    const ref = { id: goal.id, revision: goal.revision }
    try {
      if (mode === 'pause') {
        // pause is only legal from an active phase; anything else is already stopped.
        if (goal.phase !== 'active') return undefined
        service.pause(sourceAgent, ref)
        return 'pause'
      }
      if (mode === 'complete') {
        if (goal.phase === 'complete') return undefined
        service.complete(sourceAgent, ref)
        return 'complete'
      }
      service.clear(sourceAgent, ref)
      return 'clear'
    } catch (error) {
      this.ctx.logger?.warn?.(
        `context-handoff: could not ${mode} the source goal ${goal.id}: ${error instanceof Error ? error.message : String(error)}`,
      )
      return undefined
    }
  }

  /**
   * Re-create the source session's goal in the session the handoff just started.
   *
   * `goals.create` arms automatic continuation, and the round driver queues a
   * round as soon as the agent is idle. The `paused` mode therefore creates and
   * pauses in one synchronous block: the new chat shows an inactive goal that a
   * person resumes deliberately, which is the same state a restarted session
   * shows. Only the remaining round allowance is carried over, because the
   * rounds already spent belong to the old session.
   *
   * A failure here never fails the handoff: the file already records the goal.
   *
   * @param {string} sessionId - the session that was just created.
   * @param {object|undefined} goal - the source goal view.
   * @returns {{phase: string, activation?: string} | undefined}
   */
  transferGoal(sessionId, goal) {
    if (goal === undefined || this.config.handoffGoal === 'file') return undefined
    const service = this.goalService()
    if (service === undefined || typeof service.create !== 'function') return undefined
    const newAgent = this.ctx.agents?.get?.(sessionId)
    if (newAgent === undefined) return undefined
    const remaining = Math.max(1, goal.maxGoalRounds - goal.roundsStarted)
    let view
    try {
      view = service.create(newAgent, { objective: goal.objective, maxGoalRounds: remaining })
    } catch (error) {
      this.ctx.logger?.warn?.(
        `context-handoff: could not re-create the goal in ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      )
      return undefined
    }
    const created = view
    if (this.config.handoffGoal === 'paused' && created !== null && typeof created === 'object' && created.id !== undefined) {
      try {
        view = service.pause(newAgent, { id: created.id, revision: created.revision })
      } catch (error) {
        this.ctx.logger?.warn?.(
          `context-handoff: re-created the goal in ${sessionId} but could not pause it: ${error instanceof Error ? error.message : String(error)}`,
        )
        view = created
      }
    }
    const phase = typeof view?.phase === 'string' ? view.phase : 'active'
    return { phase, ...(typeof view?.activation === 'string' ? { activation: view.activation } : {}) }
  }

  /**
   * Background jobs still running in this session.
   *
   * A job belongs to the agent that started it (`job.owner` is its session id).
   * Creating a new session neither carries it over nor stops it, and disposing
   * the old agent cancels it, so a handoff taken while a job runs abandons that
   * job's result. The registry fences reads by owner: `list(sessionId)` also
   * returns ownerless host work, which is not the user's, so only own jobs are
   * kept. A composition without the registry, or one whose shape changed,
   * reports no jobs: the guard must never break the handoff by accident.
   *
   * @param {string} sessionId
   * @returns {{id: string, label?: string, status: string}[]}
   */
  runningJobs(sessionId) {
    let service
    try {
      service = this.ctx.get?.('jobs') ?? this.ctx.jobs
    } catch {
      return []
    }
    if (service === undefined || service === null || typeof service.list !== 'function') return []
    let jobs
    try {
      jobs = service.list(sessionId)
    } catch {
      return []
    }
    if (!Array.isArray(jobs)) return []
    return jobs
      .filter(
        (job) =>
          job !== null &&
          typeof job === 'object' &&
          job.owner === sessionId &&
          (job.status === 'running' || job.status === 'stopping'),
      )
      .map((job) => ({ id: String(job.id), ...(typeof job.label === 'string' ? { label: job.label } : {}), status: job.status }))
  }

  /** Install the idle-session auto writer. */
  installAuto() {
    const plugin = this
    this.ctx.on('agent/status', ({ agent, status }) => {
      if (status !== 'idle' || agent === undefined) return
      if (plugin.autoTimer !== undefined) clearTimeout(plugin.autoTimer)
      plugin.autoTimer = setTimeout(() => {
        plugin.autoTimer = undefined
        void plugin.maybeAuto(agent)
      }, 300)
      plugin.autoTimer.unref?.()
    })
    this.ctx.effect(function* clearAutoTimer() {
      yield () => {
        if (plugin.autoTimer !== undefined) clearTimeout(plugin.autoTimer)
      }
    }, 'context-handoff auto timer')
  }

  /**
   * Idle-session policy: condense first, hand off only when condensing cannot
   * bring the session back under its recommendation point.
   *
   * Condensation is always on (there is no switch for it); the workspace switch
   * only decides whether a new session is created afterwards.
   * @param {object} agent - idle agent whose session is inspected.
   * @returns {Promise<void>}
   */
  async maybeAuto(agent) {
    const sessionId = agent?.session?.id
    if (typeof sessionId !== 'string' || this.active.has(sessionId)) return
    if (typeof agent.status === 'string' && agent.status !== 'idle') return
    if (agent.session?.header?.origin === 'subagent' || agent.session?.header?.parentSession !== undefined) return
    let snapshot
    try {
      snapshot = await this.inspect(agent, { horizon: this.config.horizonTurns })
    } catch (error) {
      this.ctx.logger?.warn?.(`context-handoff: auto inspection failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (!snapshot.plan.useful || snapshot.promptTokens < snapshot.plan.recommendedAt) return

    // 1) Condense an over-threshold session first. It keeps the same session,
    //    costs one summarization call, and usually drops the context to the
    //    summary plus the newest node.
    if (this.canCompact(agent, sessionId)) {
      const condensed = await this.compactSession(agent, snapshot, sessionId)
      if (condensed !== undefined) {
        snapshot = condensed
        if (snapshot.promptTokens < snapshot.plan.recommendedAt) return
        this.ctx.logger?.info?.(
          `context-handoff: session ${sessionId} is still at ${snapshot.promptTokens} tokens after condensing; falling back to a handoff`,
        )
      }
    }

    // 2) Condensing is unavailable, exhausted, or did not free enough: hand off.
    //    The switch gates this step only.
    if (!snapshot.auto) return
    const previous = this.lastAuto.get(sessionId)
    if (previous !== undefined) {
      if (previous.completed === true) return
      if (snapshot.promptTokens - previous.tokens < this.config.autoMinGrowthTokens) return
      if (Date.now() - previous.at < this.config.autoCooldownMinutes * 60000) return
    }
    const latest = await latestHandoff(snapshot.outputDir)
    if (latest !== undefined && Date.now() - latest.mtimeMs < this.config.autoCooldownMinutes * 60000) return
    this.lastAuto.set(sessionId, { tokens: snapshot.promptTokens, at: Date.now() })
    try {
      const result = await this.generate(agent, {
        trigger: 'auto',
        newSession: this.config.autoNewSession,
      })
      this.lastAuto.set(sessionId, { tokens: snapshot.promptTokens, at: Date.now(), completed: true })
      if (result.newSessionId !== undefined) {
        this.lastAutoBySource.set(sessionId, {
          newSessionId: result.newSessionId,
          file: result.relativePath,
          at: Date.now(),
        })
        while (this.lastAutoBySource.size > 50) {
          const oldest = this.lastAutoBySource.keys().next().value
          if (oldest === undefined) break
          this.lastAutoBySource.delete(oldest)
        }
      }
      this.ctx.logger?.info?.(
        `context-handoff: auto wrote ${result.relativePath}${result.newSessionId === undefined ? '' : ` and started session ${result.newSessionId}`}`,
      )
    } catch (error) {
      if (error instanceof HandoffBusyError) {
        // Refused before it started — a running background job or a turn that
        // is not idle. Drop the reservation so the next idle event may retry;
        // keeping it would hold the cooldown against a handoff that never ran.
        this.lastAuto.delete(sessionId)
      }
      this.ctx.logger?.warn?.(
        `context-handoff: auto handoff failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /**
   * Resolve the composition's compaction service.
   *
   * Injection is the preferred path, but a plugin mounted in a narrower scope
   * can miss the late-provided service; asking the context directly keeps the
   * feature working instead of silently falling back to a handoff.
   * @returns {object | undefined}
   */
  compactionService(agent) {
    // Agents are assembled from presets, and a preset's compaction backend is
    // mounted in that agent's isolated scope, so the agent context is the one
    // that can see it. It is read per call and never cached: two sessions may
    // run under different presets with different backends.
    // `ctx.get` reads a service without the inject requirement, which is the
    // only way into an isolated scope from outside it; plain property access
    // throws "cannot get property ... without inject".
    let scoped
    try {
      scoped = agent?.ctx?.get?.('compaction')
      // `strict` filters providers whose fiber is not fully active yet; a
      // preset that is still settling is still the right backend to ask.
      scoped ??= agent?.ctx?.get?.('compaction', false)
    } catch {
      scoped = undefined
    }
    if (scoped === undefined) {
      try {
        scoped = agent?.ctx?.compaction
      } catch {
        scoped = undefined
      }
    }
    if (scoped !== undefined) {
      this.compactionSource = 'agent'
      return scoped
    }
    if (this.compaction !== undefined) return this.compaction
    let service
    try {
      service = this.ctx.get?.('compaction')
    } catch {
      service = undefined
    }
    if (service === undefined) {
      try {
        service = this.ctx.compaction
      } catch {
        service = undefined
      }
    }
    if (service !== undefined) {
      this.compaction = service
      this.compactionSource = 'context'
    }
    return service
  }

  /**
   * Whether this composition can condense at all: either the preset's backing
   * service is reachable, or the official `/compact` command is registered and
   * can be executed on our behalf.
   * @param {object} agent - agent whose preset supplies the backend.
   * @returns {boolean}
   */
  compactionAvailable(agent) {
    if (this.compactionService(agent) !== undefined) return true
    return typeof this.commands?.execute === 'function'
  }

  /**
   * Whether this session still has condensation budget left.
   * @param {string} sessionId - session being considered.
   * @returns {boolean}
   */
  canCompact(agent, sessionId) {
    if (!this.compactionAvailable(agent)) return false
    const budget = this.config.maxCompactionsPerSession
    if (!(budget > 0)) return false
    const used = this.compactions.get(sessionId)
    if (used === undefined) return true
    if (used.count >= budget) return false
    // A condense attempt that just failed must not immediately retry.
    if (used.failedAt !== undefined && Date.now() - used.failedAt < 60000) return false
    return true
  }

  /**
   * Condense one over-threshold session through the composition's compaction
   * service, then re-measure it.
   *
   * The policy is deliberately bounded: a session may be condensed at most
   * `maxCompactionsPerSession` times, and a condense that frees less than 10%
   * of the context counts as the last one, because repeating it would only
   * produce a summary of a summary without buying headroom.
   * @param {object} agent - idle agent owning the session.
   * @param {object} snapshot - measurement taken before condensing.
   * @param {string} sessionId - session identity.
   * @returns {Promise<object | undefined>} the post-condense snapshot, when it ran.
   */
  async compactSession(agent, snapshot, sessionId) {
    const service = this.compactionService(agent)
    if (service === undefined && typeof this.commands?.execute !== 'function') return undefined
    if (this.compacting.has(sessionId)) return undefined
    this.compacting.add(sessionId)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('compaction timed out')), 15 * 60000)
    timer.unref?.()
    const used = this.compactions.get(sessionId)
    const before = snapshot.promptTokens
    let result
    try {
      if (service !== undefined) {
        result = await service.compactNow(agent, controller.signal)
      } else {
        // The command runs the same backend from inside the preset scope, so
        // it is the supported path when the service itself is out of reach.
        const execution = await this.commands.execute(agent, '/compact', [], controller.signal)
        if (execution === undefined) return undefined
        if (execution.result?.kind !== 'success') throw new Error(execution.result?.text ?? '/compact failed')
        result = execution
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.ctx.logger?.warn?.(`context-handoff: condensing skipped: ${message}`)
      this.compactions.set(sessionId, { count: used?.count ?? 0, lastAt: Date.now(), before, after: before, saved: 0, failedAt: Date.now() })
      return undefined
    } finally {
      clearTimeout(timer)
      this.compacting.delete(sessionId)
    }
    if (result === null || result === undefined) return undefined

    let after
    try {
      after = await this.inspect(agent, { horizon: this.config.horizonTurns })
    } catch (error) {
      this.ctx.logger?.warn?.(`context-handoff: post-compaction inspection failed: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
    const count = (used?.count ?? 0) + 1
    const saved = Math.max(0, before - after.promptTokens)
    // A condense that buys nothing is the last one this session gets.
    const exhausted = before > 0 && after.promptTokens >= before * 0.9
    this.compactions.set(sessionId, {
      count: exhausted ? this.config.maxCompactionsPerSession : count,
      lastAt: Date.now(),
      before,
      after: after.promptTokens,
      saved,
    })
    this.ctx.logger?.info?.(
      `context-handoff: condensed session ${sessionId} from ${before} to ${after.promptTokens} tokens (${count}/${this.config.maxCompactionsPerSession})`,
    )
    return after
  }

}

/** Combine optional abort signals without requiring AbortSignal.any. */
function combineSignals(...signals) {
  const list = signals.filter((signal) => signal !== undefined && signal !== null)
  if (list.length === 0) return undefined
  if (list.length === 1) return list[0]
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list)
  const controller = new AbortController()
  for (const signal of list) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  }
  return controller.signal
}

function hasSummarizableContent(messages) {
  return messages.some((message) =>
    (message.content ?? []).some((block) => block?.type === 'tool-call' || (block?.type === 'text' && block.text.trim().length > 0)),
  )
}

/**
 * Render the goal the source session carried into the handoff body.
 *
 * The goal is durable per session, so the new session has none unless the
 * handoff re-creates it. The section states which of the two happened instead
 * of implying automatic continuation the new chat may not have.
 *
 * @param {{objective: string, phase: string, roundsStarted: number, maxGoalRounds: number, activation?: string}} goal
 * @param {'en'|'zh'} language
 * @param {'file'|'paused'|'armed'} [mode]
 * @returns {string}
 */
function renderGoalSection(goal, language, mode = 'file') {
  const zh = language === 'zh'
  const rounds = goal.maxGoalRounds > 0 ? `${goal.roundsStarted}/${goal.maxGoalRounds}` : String(goal.roundsStarted)
  const activation = goal.activation === 'armed' ? (zh ? '已激活' : 'armed') : zh ? '未激活' : 'disarmed'
  const tail =
    mode === 'armed'
      ? zh
        ? '- 本次交接已在本会话重新创建该目标并启用自动续跑。'
        : '- This handoff re-created the goal in this session with automatic continuation armed.'
      : mode === 'paused'
        ? zh
          ? '- 本次交接已在本会话重新创建该目标并暂停；按 Resume 继续，其余时间不会自动运行。'
          : '- This handoff re-created the goal in this session and paused it; press Resume here to continue, nothing runs until then.'
        : zh
          ? '- 目标只存在于原会话。如需自动续跑，请在本会话用 `create_goal` 重新创建同样的目标。'
          : '- The goal lives in the source session only. If automatic continuation is wanted here, re-create the same objective in this session with `create_goal`.'
  const lines = zh
    ? [
        '## 目标（来自原会话）',
        '',
        `- 目标：${goal.objective}`,
        `- 阶段：${goal.phase} · 轮次 ${rounds} · 自动续跑：${activation}`,
        tail,
      ]
    : [
        '## Goal (from the source session)',
        '',
        `- Objective: ${goal.objective}`,
        `- Phase: ${goal.phase} · rounds ${rounds} · automatic continuation: ${activation}`,
        tail,
      ]
  return lines.join('\n')
}


function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

export { Config, resolveConfig }
export const name = 'context-handoff'
