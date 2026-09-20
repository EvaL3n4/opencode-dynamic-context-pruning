/** @jsxImportSource @opentui/solid */
import type { Plugin } from "@opencode/plugin/tui"
import { ContextDialog, PanelDialog, StatsDialog, StatusDialog } from "../tui/dialogs"
import type { ViewApi } from "../tui/types"
import { rpc } from "./rpc"

export async function setup(ctx: Plugin.Context) {
    const client = ctx.client.rpc(rpc)
    const options = () => ({ location: ctx.location ?? ctx.data.location.default() })
    if (!(await client.status({}, options())).enabled) return
    const api: ViewApi = {
        theme: {
            get current() {
                // 2.0.10 token names. The installed @opencode/theme is 2.0.4 (whose types
                // declare a `contextual` map), but the binary implements `surface(name)` with
                // SurfaceName = "dialog"; the installed types typecheck a shape the runtime
                // does not have, so this is deliberately written against the runtime.
                const theme = ctx.theme.surface("dialog")
                return {
                    primary: theme.text.action.primary.base,
                    accent: theme.text.action.secondary.base,
                    text: theme.text.base,
                    textMuted: theme.text.muted,
                    background: theme.background.base,
                    backgroundElement: theme.background.raised.base,
                    borderSubtle: theme.border.base,
                    selectedListItemText: theme.background.base,
                    success: theme.text.feedback.success.base,
                    warning: theme.text.feedback.warning.base,
                    error: theme.text.feedback.error.base,
                }
            },
        },
        ui: { dialog: { clear: () => ctx.ui.dialog.clear() } },
    }
    function show(render: Parameters<typeof ctx.ui.dialog.show>[0]) {
        ctx.ui.dialog.set({ size: "xlarge" })
        ctx.ui.dialog.show(render)
    }
    async function open(page: "panel" | "context" | "stats" = "panel") {
        const route = ctx.ui.router.current()
        if (route.type !== "session") {
            show(() => (
                <StatusDialog
                    api={api}
                    title="DCP"
                    eyebrow="No session"
                    message="Open a session first."
                />
            ))
            return
        }
        const sessionID = route.sessionID
        try {
            const data = await client.snapshot({ sessionID }, options())
            const back = () => {
                void open()
            }
            if (page === "context")
                show(() => <ContextDialog api={api} breakdown={data.context} onBack={back} />)
            else if (page === "stats")
                show(() => <StatsDialog api={api} report={data.stats} onBack={back} />)
            else
                show(() => (
                    <PanelDialog
                        api={api}
                        manualMode={data.manualMode}
                        canCompress={data.canCompress}
                        blockedReason={data.blockedReason}
                        onContext={() => {
                            void open("context")
                        }}
                        onStats={() => {
                            void open("stats")
                        }}
                        onManual={(enabled) => {
                            void client
                                .manual({ sessionID, enabled }, options())
                                .then(back)
                                .catch(error)
                        }}
                    />
                ))
        } catch (cause) {
            error(cause)
        }
    }
    function error(cause: unknown) {
        const message =
            cause instanceof Error
                ? cause.message
                : typeof cause === "object" && cause && "message" in cause
                  ? String(cause.message)
                  : String(cause)
        show(() => <StatusDialog api={api} title="DCP" eyebrow="DCP Error" message={message} />)
    }
    ctx.ui.slot({
        append: "app",
        render() {
            ctx.keymap.layer(() => ({
                mode: "global",
                commands: [
                    {
                        id: "dcp.panel",
                        title: "DCP",
                        description: "Open DCP panel",
                        group: "DCP",
                        palette: true,
                        slash: { name: "dcp", arguments: true },
                        run: async (input) => {
                            if (!input?.trim()) return open()
                            const route = ctx.ui.router.current()
                            if (route.type !== "session") return open()
                            try {
                                await ctx.client.session.command({
                                    sessionID: route.sessionID,
                                    name: "dcp",
                                    text: input,
                                })
                            } catch (cause) {
                                error(cause)
                            }
                        },
                    },
                ],
            }))
            return null
        },
    })
}
