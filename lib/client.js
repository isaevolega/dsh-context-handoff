window.__ModuleLoader__.load({
  id: "dsh-context-handoff",
  factory: (require) => {
    const React = require("react");
    const { createElement: h, useCallback, useEffect, useRef, useState } = React;

    const API = "/context-handoff/api";
    const TAB_ID = "dsh-context-handoff/panel";
    const TAB_KIND = "context-handoff";
    let hostCtx;

    async function request(path, init) {
      const response = await fetch(API + path, {
        cache: "no-store",
        credentials: "same-origin",
        ...init,
        headers: { ...(init && init.headers ? init.headers : {}) },
      });
      let body;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }
      if (!response.ok) {
        throw new Error((body && body.error) || `HTTP ${response.status}`);
      }
      return body;
    }

    function post(path, payload) {
      return request(path, {
        method: "POST",
        headers: { "content-type": "application/json", "x-context-handoff": "1" },
        body: JSON.stringify(payload),
      });
    }

    function currentSessionId(ctx, element) {
      try {
        // The tab body can find its own sidebar owner, which is the exact
        // session it is drawing even when another session is kept mounted.
        const own = element && typeof element.closest === "function"
          ? element.closest("[data-sidebar-right-session]")
          : undefined;
        const ownId = own && own.dataset ? own.dataset.sidebarRightSession : undefined;
        if (ownId) return ownId;

        // Fall back to the first visible sidebar owner; background sessions can
        // stay mounted and must not steal the switch.
        if (typeof document !== "undefined") {
          const owners = Array.from(document.querySelectorAll("[data-sidebar-right-session]"));
          const visible = owners.find((owner) => {
            if (owner.closest("[hidden], [aria-hidden=\"true\"]")) return false;
            return owner.getClientRects().length > 0;
          });
          const fromDom = (visible || owners[0])?.dataset?.sidebarRightSession;
          if (fromDom) return fromDom;
        }

        const list = ctx.sessions.list.getSnapshot();
        const rows = Object.values((list && list.byId) || {});
        const current = rows.find((row) => ((row && row.retainedBy && row.retainedBy.mainView) || 0) > 0);
        return current ? current.id : undefined;
      } catch {
        return undefined;
      }
    }

    function useCurrentSessionId(ctx, rootRef) {
      const [id, setId] = useState(() => currentSessionId(ctx, rootRef.current));
      useEffect(() => {
        let list;
        try {
          list = ctx.sessions.list;
        } catch {
          return undefined;
        }
        if (!list || typeof list.subscribe !== "function") return undefined;
        const sync = () => setId(currentSessionId(ctx, rootRef.current));
        const dispose = list.subscribe(sync);
        sync();
        return dispose;
      }, [ctx, rootRef]);

      // A tab can mount before the sidebar has written its session marker.
      // Poll briefly instead of leaving the switch disabled forever.
      useEffect(() => {
        if (id) return undefined;
        const timer = setInterval(() => {
          const next = currentSessionId(ctx, rootRef.current);
          if (next) setId(next);
        }, 1000);
        return () => clearInterval(timer);
      }, [ctx, id, rootRef]);

      return id;
    }

    function useSessionState(sessionId) {
      const [state, setState] = useState(null);
      const [error, setError] = useState("");
      const [busy, setBusy] = useState(false);

      const refresh = useCallback(async () => {
        if (!sessionId) {
          setState(null);
          return;
        }
        try {
          const next = await request(`/state?session=${encodeURIComponent(sessionId)}`);
          setState(next);
          setError(next && next.ok === false ? next.error || "state unavailable" : "");
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }, [sessionId]);

      useEffect(() => {
        let stopped = false;
        refresh();
        const timer = setInterval(() => {
          if (!stopped && (typeof document === "undefined" || document.visibilityState !== "hidden")) refresh();
        }, 5000);
        return () => {
          stopped = true;
          clearInterval(timer);
        };
      }, [refresh]);

      const writeAuto = useCallback(
        async (enabled) => {
          if (!sessionId) return;
          setBusy(true);
          try {
            const next = await post("/auto", { sessionId, enabled });
            setState(next);
            setError("");
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          } finally {
            setBusy(false);
          }
        },
        [sessionId],
      );

      const run = useCallback(
        async (newSession) => {
          if (!sessionId) return;
          setBusy(true);
          try {
            const response = await post("/run", { sessionId, newSession });
            const result = response && response.result;
            if (result && result.newSessionId) {
              openSession(result.newSessionId);
              await post("/ack", { sessionId, newSessionId: result.newSessionId }).catch(() => {});
            }
            await refresh();
            setError("");
            return result;
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
            return undefined;
          } finally {
            setBusy(false);
          }
        },
        [refresh, sessionId],
      );

      return { state, error, busy, refresh, writeAuto, run };
    }

    function openSession(id) {
      try {
        const uiWorkspace =
          (hostCtx.get && hostCtx.get("uiWorkspace")) || hostCtx.uiWorkspace;
        if (!uiWorkspace || typeof uiWorkspace.openSession !== "function") return false;
        uiWorkspace.openSession(id);
        return true;
      } catch (cause) {
        console.error("[context-handoff] could not open the new session", cause);
        return false;
      }
    }

    function formatTokens(value) {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) return "—";
      if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
      if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}k`;
      return String(Math.round(n));
    }

    function sidebarRightService() {
      try {
        return (hostCtx.get && hostCtx.get("sidebarRight")) || hostCtx.sidebarRight;
      } catch {
        return undefined;
      }
    }

    function openHandoffPanel() {
      const right = sidebarRightService();
      if (!right || typeof right.openTab !== "function") return false;
      try {
        right.openTab("context-handoff");
        return true;
      } catch (cause) {
        console.error("[context-handoff] could not open the sidebar tab", cause);
        return false;
      }
    }

    /**
     * A compact copy of the panel's headline numbers for the session header.
     * It polls slowly: the chip is an entry point, not the source of truth.
     */
    function useChipState(sessionId) {
      const [state, setState] = useState(null);
      useEffect(() => {
        if (!sessionId) return undefined;
        let stopped = false;
        const tick = async () => {
          if (!stopped && typeof document !== "undefined" && document.visibilityState === "hidden") return;
          try {
            const next = await request(`/state?session=${encodeURIComponent(sessionId)}`);
            if (!stopped && next && next.ok !== false) setState(next);
          } catch {
            // A missing route just leaves the chip out; the panel reports details.
          }
        };
        void tick();
        const timer = setInterval(tick, 15000);
        return () => {
          stopped = true;
          clearInterval(timer);
        };
      }, [sessionId]);
      return state;
    }

    function HandoffAction(props) {
      const sessionId = props && typeof props.sessionId === "string" ? props.sessionId : undefined;
      const state = useChipState(sessionId);
      if (!sessionId) return null;

      const ready = Boolean(state) && state.ok !== false;
      const used = ready ? Number(state.promptTokens) || 0 : 0;
      const window = ready ? Number(state.windowTokens) || 0 : 0;
      const threshold = ready ? Number(state.recommendedAt) || 0 : 0;
      const over = threshold > 0 && used >= threshold;
      const auto = ready && Boolean(state.auto);
      // The chip is the way in, so it stays visible even while the host state
      // is still loading or unavailable; the panel explains the details.
      const tip = ready
        ? [
            auto ? "Auto handoff is on" : "Auto handoff is off",
            `Context ${formatTokens(used)}${window > 0 ? ` / ${formatTokens(window)}` : ""}`,
            threshold > 0 ? `Recommended at ${formatTokens(threshold)}` : "",
            over && !auto ? "Past the recommendation point: turning auto on writes the file and opens a new session" : "",
            "Click to open the context handoff panel",
          ]
            .filter(Boolean)
            .join(" · ")
        : "Context handoff · click to open the panel";

      return h(
        "button",
        {
          type: "button",
          style: styles.chip,
          title: tip,
          "aria-label": tip,
          onClick: () => {
            openHandoffPanel();
          },
        },
        h("span", {
          style: {
            ...styles.chipDot,
            background: over ? "#e0932f" : auto ? "var(--dsh-accent, #4f8cff)" : "rgba(127,127,127,.5)",
          },
        }),
        h("span", null, auto ? "Auto handoff" : "Context"),
        ready ? h("span", { style: styles.chipValue }, formatTokens(used)) : null,
      );
    }

    const styles = {
      root: {
        padding: "16px",
        color: "inherit",
        font: "inherit",
        fontSize: "13px",
        lineHeight: 1.55,
        display: "flex",
        flexDirection: "column",
        gap: "14px",
      },
      header: { display: "flex", flexDirection: "column", gap: "2px" },
      title: { fontSize: "14px", fontWeight: 650, letterSpacing: "0.01em" },
      muted: { opacity: 0.62, fontSize: "12px" },
      card: {
        border: "1px solid rgba(127,127,127,.22)",
        borderRadius: "12px",
        padding: "12px",
        display: "flex",
        flexDirection: "column",
        gap: "10px",
      },
      row: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" },
      switch: {
        width: "40px",
        height: "22px",
        borderRadius: "99px",
        border: "1px solid rgba(127,127,127,.28)",
        padding: "2px",
        cursor: "pointer",
        background: "rgba(127,127,127,.18)",
        display: "flex",
        alignItems: "center",
        transition: "background .15s ease",
      },
      switchOn: { background: "var(--dsh-accent, #4f8cff)", borderColor: "transparent" },
      knob: {
        width: "16px",
        height: "16px",
        borderRadius: "50%",
        background: "#fff",
        boxShadow: "0 1px 2px rgba(0,0,0,.25)",
        transform: "translateX(0)",
        transition: "transform .15s ease",
      },
      knobOn: { transform: "translateX(18px)" },
      bar: {
        position: "relative",
        height: "8px",
        borderRadius: "99px",
        background: "rgba(127,127,127,.18)",
        overflow: "hidden",
      },
      fill: {
        position: "absolute",
        left: 0,
        top: 0,
        bottom: 0,
        background: "var(--dsh-accent, #4f8cff)",
        borderRadius: "99px",
      },
      marker: {
        position: "absolute",
        top: "-2px",
        bottom: "-2px",
        width: "2px",
        background: "rgba(127,127,127,.7)",
      },
      buttons: { display: "flex", gap: "8px", flexWrap: "wrap" },
      button: {
        appearance: "none",
        border: "1px solid rgba(127,127,127,.28)",
        background: "rgba(127,127,127,.10)",
        color: "inherit",
        font: "inherit",
        fontSize: "12px",
        padding: "6px 10px",
        borderRadius: "8px",
        cursor: "pointer",
      },
      primary: {
        appearance: "none",
        border: "1px solid transparent",
        background: "var(--dsh-accent, #4f8cff)",
        color: "#fff",
        font: "inherit",
        fontSize: "12px",
        padding: "6px 10px",
        borderRadius: "8px",
        cursor: "pointer",
      },
      error: { color: "#d9534f", fontSize: "12px", margin: 0 },
      chip: {
        appearance: "none",
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        height: "24px",
        padding: "0 9px 0 8px",
        borderRadius: "999px",
        border: "1px solid var(--dsw-alias-border-l3, rgba(127,127,127,.28))",
        background: "transparent",
        color: "var(--dsw-alias-label-secondary, inherit)",
        font: "inherit",
        fontSize: "12px",
        lineHeight: 1,
        cursor: "pointer",
        whiteSpace: "nowrap",
        flex: "none",
      },
      chipDot: { width: "6px", height: "6px", borderRadius: "50%", flex: "none" },
      chipValue: { fontVariantNumeric: "tabular-nums", opacity: 0.75 },
      code: {
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: "11px",
        opacity: 0.8,
        wordBreak: "break-all",
      },
    };

    function HandoffPanel(props) {
      const rootRef = useRef(null);
      // The slot framework binds every session-scoped seat to its own session;
      // DOM sniffing stays as a fallback for runtimes that do not pass it.
      const bound = props && typeof props.sessionId === "string" ? props.sessionId : undefined;
      const guessed = useCurrentSessionId(hostCtx, rootRef);
      const sessionId = bound || guessed;
      const { state, error, busy, refresh, writeAuto, run } = useSessionState(sessionId);
      const handled = useRef(new Set());
      const [lastResult, setLastResult] = useState(undefined);

      const lastAuto = state && state.lastAuto;
      useEffect(() => {
        if (!lastAuto || !sessionId) return;
        if (lastAuto.newSessionId === sessionId) {
          void post("/ack", { sessionId, newSessionId: lastAuto.newSessionId }).catch(() => {});
          return;
        }
        if (handled.current.has(lastAuto.newSessionId)) return;
        if (openSession(lastAuto.newSessionId)) {
          handled.current.add(lastAuto.newSessionId);
          void post("/ack", { sessionId, newSessionId: lastAuto.newSessionId }).catch(() => {});
        }
      }, [lastAuto, sessionId]);

      if (!sessionId) {
        return h(
          "div",
          { ref: rootRef, style: styles.root },
          h("div", { style: styles.header }, h("div", { style: styles.title }, "Context handoff")),
          h("p", { style: styles.muted }, "Open a session first, then configure auto handoff."),
        );
      }

      const prompt = Number(state && state.promptTokens) || 0;
      const window = Number(state && state.windowTokens) || 0;
      const threshold = Number(state && state.recommendedAt) || 0;
      const percent = window > 0 ? Math.min(100, Math.round((prompt / window) * 100)) : 0;
      const thresholdPercent = window > 0 && threshold > 0 ? Math.min(100, Math.round((threshold / window) * 100)) : 0;
      const auto = Boolean(state && state.auto);
      const compaction = state && state.compaction;
      const running = Boolean(state && state.running) || busy;
      const backgroundJobs = Array.isArray(state && state.backgroundJobs) ? state.backgroundJobs : [];
      const jobBlocked = backgroundJobs.length > 0;
      const jobText =
        backgroundJobs.length === 1
          ? `Background job ${backgroundJobs[0].id}${backgroundJobs[0].label ? ` "${backgroundJobs[0].label}"` : ""} is still running: a handoff would leave its output behind in this session. Wait for it to finish or stop it with job_kill.`
          : `${backgroundJobs.length} background jobs are still running (${backgroundJobs.map((job) => job.id).join(", ")}): a handoff would leave their output behind in this session. Wait for them to finish or stop them with job_kill.`;
      const loading = state === null && !error;
      const resumeMode = state && typeof state.resumeMode === "string" ? state.resumeMode : "";
      const resumeText =
        resumeMode === "auto"
          ? "New session: it reads the handoff file and continues on its own (resumeMode=auto)."
          : resumeMode === "brief"
            ? "New session: it reads the handoff file, names the next step, then stops (resumeMode=brief)."
            : resumeMode === "manual"
              ? "New session: created and left idle, the turn is yours (resumeMode=manual)."
              : "";
      const unavailable = Boolean(error) || Boolean(state && state.ok === false);

      const toggle = () => {
        void writeAuto(!auto);
      };

      const runNow = (newSession) => {
        void run(newSession).then((result) => {
          if (result) setLastResult(result);
        });
      };

      return h(
        "div",
        { ref: rootRef, style: styles.root },
        h(
          "div",
          { style: styles.header },
          h("div", { style: styles.title }, "Context handoff"),
          h("div", { style: styles.muted }, "At the threshold it condenses first; only a context still over the threshold gets a handoff file and a new session"),
        ),

        h(
          "div",
          { style: styles.card },
          loading
            ? h("div", { style: styles.muted }, "Reading the current session state…")
            : h(
                "div",
                { style: styles.row },
                h(
                  "div",
                  null,
                  h("div", { style: { fontWeight: 600 } }, unavailable ? "State unavailable" : auto ? "Auto handoff is on" : "Auto handoff is off"),
                  h("div", { style: styles.muted }, unavailable ? "Use Retry below to read it again" : "Applies to this workspace only"),
                ),
                h(
                  "button",
                  {
                    type: "button",
                    role: "switch",
                    "aria-checked": auto,
                    "aria-label": "Auto handoff",
                    disabled: busy || unavailable,
                    onClick: toggle,
                    style: { ...styles.switch, ...(auto ? styles.switchOn : {}), opacity: busy || unavailable ? 0.6 : 1, flex: "0 0 auto" },
                  },
                  h("span", { style: { ...styles.knob, ...(auto ? styles.knobOn : {}) } }),
                ),
              ),
          h(
            "div",
            null,
            h(
              "div",
              { style: { ...styles.row, marginBottom: "5px" } },
              h("span", { style: styles.muted }, `Current ${formatTokens(prompt)}${window > 0 ? ` / ${formatTokens(window)}` : ""}`),
              h("span", { style: styles.muted }, `Recommended at ${formatTokens(threshold)}`),
            ),
            h(
              "div",
              { style: styles.bar, title: `Recommendation point: ${formatTokens(threshold)} tokens` },
              h("div", { style: { ...styles.fill, width: `${percent}%` } }),
              thresholdPercent > 0 ? h("div", { style: { ...styles.marker, left: `${thresholdPercent}%` } }) : null,
            ),
            h(
              "div",
              { style: { ...styles.muted, marginTop: "5px" } },
              window > 0
                ? `${percent}% of the window used · recommendation at ${thresholdPercent}%${state && state.savingPerTurn ? ` · about ${formatTokens(state.savingPerTurn)} saved per turn` : ""}`
                : "Model window unknown; the threshold falls back to the economic one",
            ),
            compaction && compaction.available
              ? h(
                  "div",
                  { style: { ...styles.muted, marginTop: "6px" } },
                  compaction.count > 0
                    ? `Auto-condensed ${compaction.count}/${compaction.budget} times${compaction.before > 0 ? ` · ${formatTokens(compaction.before)} → ${formatTokens(compaction.after)}` : ""}`
                    : `Idle below the threshold; at ${formatTokens(threshold)} it condenses first, at most ${compaction.budget} times`,
                )
              : h("div", { style: { ...styles.muted, marginTop: "6px" } }, "This composition has no compaction service; at the threshold it goes straight to a handoff."),
            threshold > 0 && prompt >= threshold && !auto
              ? h(
                  "div",
                  { style: { ...styles.muted, marginTop: "6px", color: "#b7791f" } },
                  "The context is past the recommendation point: it condenses first, and a new session is needed only if it is still over the threshold afterwards (with the switch off it only condenses).",
                )
              : null,
            jobBlocked
              ? h(
                  "div",
                  { style: { ...styles.muted, marginTop: "6px", color: "#b7791f" } },
                  jobText,
                )
              : null,
            resumeText
              ? h("div", { style: { ...styles.muted, marginTop: "6px" } }, resumeText)
              : null,
          ),
          h(
            "div",
            { style: styles.buttons },
            h(
              "button",
              {
                type: "button",
                style: styles.button,
                disabled: busy || loading || unavailable,
                onClick: toggle,
              },
              auto ? "Turn auto handoff off" : "Turn auto handoff on",
            ),
            h(
              "button",
              {
                type: "button",
                style: styles.primary,
                disabled: running || loading || unavailable || jobBlocked,
                title: jobBlocked ? jobText : undefined,
                onClick: () => runNow(true),
              },
              jobBlocked ? "Waiting for the background job" : running ? "Generating…" : "Write file + new session",
            ),
            h(
              "button",
              {
                type: "button",
                style: styles.button,
                disabled: running || loading || unavailable || jobBlocked,
                title: jobBlocked ? jobText : undefined,
                onClick: () => runNow(false),
              },
              "File only",
            ),
          ),
          error
            ? h(
                "div",
                { style: { ...styles.error, display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" } },
                h("span", null, error),
                h(
                  "button",
                  { type: "button", style: styles.button, onClick: () => void refresh() },
                  "Retry",
                ),
              )
            : null,
        ),

        state && state.latest
          ? h(
              "div",
              { style: styles.card },
              h("div", { style: { fontWeight: 600 } }, "Latest handoff"),
              h("div", { style: styles.code }, state.latest.file),
              h(
                "div",
                { style: styles.muted },
                `${formatTokens(state.latest.digestTokens)} digest · source ${formatTokens(state.latest.sourceTokens)}`,
              ),
            )
          : null,

        lastAuto && lastAuto.newSessionId !== sessionId
          ? h(
              "div",
              { style: styles.card },
              h("div", { style: { fontWeight: 600 } }, "New session created automatically"),
              h("div", { style: styles.code }, lastAuto.newSessionId),
              h(
                "button",
                {
                  type: "button",
                  style: styles.primary,
                  onClick: () => {
                    if (openSession(lastAuto.newSessionId)) {
                      void post("/ack", { sessionId, newSessionId: lastAuto.newSessionId }).catch(() => {});
                    }
                  },
                },
                "Open new session",
              ),
            )
          : null,

        lastResult && lastResult.text
          ? h(
              "div",
              { style: styles.card },
              h("div", { style: { fontWeight: 600 } }, "Just completed"),
              h(
                "pre",
                {
                  style: {
                    margin: 0,
                    whiteSpace: "pre-wrap",
                    fontFamily: "inherit",
                    fontSize: "12px",
                    opacity: 0.78,
                  },
                },
                lastResult.text,
              ),
            )
          : null,

        h(
          "div",
          { style: styles.muted },
          "Threshold = max(economic break-even, 55% of the window), capped at 256k and by the window headroom. Condensation is always automatic, at most maxCompactionsPerSession times; the switch only decides whether a new session is created when the context is still over the threshold afterwards. The switch is stored in the workspace .dsh/handoff/auto.json.",
        ),
      );
    }

    function HandoffIcon() {
      return h(
        "svg",
        {
          width: 24,
          height: 24,
          viewBox: "0 0 24 24",
          fill: "none",
          "aria-hidden": true,
        },
        h("path", {
          d: "M6 3.5h8l4 4V20a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 6 20V3.5Z",
          stroke: "currentColor",
          strokeWidth: 1.5,
        }),
        h("path", { d: "M14 3.5V8h4", stroke: "currentColor", strokeWidth: 1.5 }),
        h("path", { d: "M9 13h6M9 16.5h4", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" }),
      );
    }

    const name = "context-handoff-client";
    const inject = ["slots", "sidebarRight", "sidebarRightTabs", "sessions"];

    function apply(ctx) {
      hostCtx = ctx;
      const tabs = ctx.sidebarRightTabs;
      const slots = ctx.slots;
      if (!tabs || !slots) return;
      const disposers = [];
      try {
        disposers.push(
          tabs.register({
            id: TAB_ID,
            kind: TAB_KIND,
            title: () => "Context handoff",
            guide: [
              {
                id: "context-handoff",
                order: 86,
                title: () => "Context handoff",
                description: () => "Auto handoff, threshold alert, new session",
                icon: HandoffIcon,
              },
            ],
          }),
        );
        disposers.push(
          slots.inject("sidebar.right.pane.tab", () =>
            slots.register(
              {
                name: "sidebar.right.pane.tab",
                key: TAB_ID,
              },
              HandoffPanel,
            ),
          ),
        );
        // A visible way in: the chip sits beside the session title, so the
        // switch is reachable without knowing that the right sidebar exists.
        disposers.push(
          slots.inject("conversation.session.header.actions", () =>
            slots.register(
              {
                name: "conversation.session.header.actions",
                id: "context-handoff",
                order: 30,
              },
              HandoffAction,
            ),
          ),
        );
      } catch (error) {
        console.error("[context-handoff] sidebar registration failed", error);
      }
      ctx.effect(function* disposeHandoffClient() {
        yield () => {
          for (const dispose of disposers.reverse()) {
            try {
              dispose();
            } catch {
              // A failed tab registration may already be gone.
            }
          }
        };
      }, "context-handoff-client");
    }

    const exports = { apply, inject, name };
    return exports;
  },
});
