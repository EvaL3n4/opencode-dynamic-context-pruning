import { execFileSync, spawn } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

process.umask(0o077)
const launch = JSON.parse(await readFile("/input/launch.json", "utf8"))
const auth = JSON.parse(await readFile("/input/auth.json", "utf8"))
try {
    execFileSync(
        "npm",
        [
            "install",
            "--prefix",
            "/lab/plugins",
            "--omit=dev",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            ...launch.packages.map((file) => join("/input", file)),
        ],
        { stdio: "pipe" },
    )
} catch (error) {
    console.error(error.stderr?.toString() || error.message)
    process.exit(1)
}
const logger = "/lab/plugins/node_modules/opencode-request-logger"
const dcp = "/lab/plugins/node_modules/@tarquinen/opencode-dcp"
const { createRelay } = await import(pathToFileURL(join(logger, "relay.mjs")))
const { watch } = await import(pathToFileURL(join(logger, "readable.mjs")))
const logs = join("/lab/logs", launch.stamp)
const raw = join(logs, "raw")
const config = process.env.OPENCODE_CONFIG_DIR
await Promise.all([raw, config, "/lab/project"].map((path) => mkdir(path, { recursive: true })))
const readable = await watch(raw, join(logs, "readable"))
const relay = createRelay({ directory: raw })
await new Promise((resolve) => relay.server.listen(0, "127.0.0.1", resolve))
try {
    await writeFile(
        join(config, "opencode.json"),
        JSON.stringify(
            launch.major === 1
                ? {
                      $schema: "https://opencode.ai/config.json",
                      autoupdate: false,
                      model: launch.model,
                      small_model: launch.model,
                      plugin: [dcp, logger],
                      permission: { compress: "allow" },
                      provider: {
                          openai: {
                              options: {
                                  baseURL: "https://chatgpt.com/backend-api/codex",
                                  apiKey: "{env:DCP_TOKEN}",
                                  headers: {
                                      "chatgpt-account-id": "{env:DCP_ACCOUNT}",
                                      originator: "opencode",
                                  },
                              },
                          },
                      },
                  }
                : {
                      $schema: "https://opencode.ai/config.json",
                      update: "disable",
                      model: launch.model,
                      plugins: [
                          { package: dcp },
                          {
                              package: logger,
                              options: {
                                  directory: raw,
                                  relay: `ws://127.0.0.1:${relay.server.address().port}`,
                              },
                          },
                      ],
                      permissions: [{ action: "compress", resource: "*", effect: "allow" }],
                      providers: {
                          openai: {
                              settings: {
                                  baseURL: "https://chatgpt.com/backend-api/codex",
                                  apiKey: "{env:DCP_TOKEN}",
                              },
                              headers: {
                                  "chatgpt-account-id": "{env:DCP_ACCOUNT}",
                                  originator: "opencode",
                              },
                              models: {
                                  [launch.model.slice("openai/".length)]: {
                                      transport: launch.transport,
                                  },
                              },
                          },
                      },
                  },
            null,
            2,
        ) + "\n",
    )
    if (launch.major === 1) {
        // Register the panel once, retaining later user terminal preferences.
        try {
            await writeFile(
                join(config, "tui.json"),
                JSON.stringify({ plugin: [dcp] }, null, 2) + "\n",
                { flag: "wx" },
            )
        } catch (error) {
            if (error.code !== "EEXIST") throw error
        }
    }
    try {
        await writeFile(
            join(config, "dcp.jsonc"),
            JSON.stringify(
                {
                    $schema:
                        "https://raw.githubusercontent.com/Opencode-DCP/opencode-dynamic-context-pruning/main/dcp.schema.json",
                    autoUpdate: false,
                    debug: true,
                    pruneNotification: "off",
                },
                null,
                2,
            ) + "\n",
            { flag: "wx" },
        )
    } catch (error) {
        if (error.code !== "EEXIST") throw error
    }
    const child = spawn(
        `/opt/opencode/node_modules/.bin/${launch.major === 1 ? "opencode" : "opencode2"}`,
        [...launch.args, ...(launch.major === 1 ? [] : ["--standalone"])],
        {
            cwd: "/lab/project",
            stdio: "inherit",
            env: {
                ...process.env,
                DCP_TOKEN: auth.access,
                DCP_ACCOUNT: auth.account,
                OPENCODE_LOG_LEVEL: "DEBUG",
                ...(launch.major === 1 ? { OPENCODE_EXPERIMENTAL_WEBSOCKETS: "false" } : {}),
                REQUEST_LOG_DIR: raw,
            },
        },
    )
    const stop = () => child.kill("SIGTERM")
    process.on("SIGTERM", stop)
    process.on("SIGINT", stop)
    try {
        process.exitCode = await new Promise((resolve, reject) => {
            child.once("error", reject)
            child.once("exit", (code) => resolve(code ?? 1))
        })
    } finally {
        process.off("SIGTERM", stop)
        process.off("SIGINT", stop)
    }
} finally {
    await relay.close()
    await readable.close()
}
