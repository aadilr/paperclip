import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";

export interface RunProcessResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

interface RunningProcess {
  child: ChildProcess;
  graceSec: number;
}

type ChildProcessWithEvents = ChildProcess & {
  on(event: "error", listener: (err: Error) => void): ChildProcess;
  on(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): ChildProcess;
};

export const runningProcesses = new Map<string, RunningProcess>();
export const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
export const MAX_EXCERPT_BYTES = 32 * 1024;
const SENSITIVE_ENV_KEY = /(key|token|secret|password|passwd|authorization|cookie)/i;

export function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function parseJson(value: string): Record<string, unknown> | null {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function appendWithCap(prev: string, chunk: string, cap = MAX_CAPTURE_BYTES) {
  const combined = prev + chunk;
  return combined.length > cap ? combined.slice(combined.length - cap) : combined;
}

export function resolvePathValue(obj: Record<string, unknown>, dottedPath: string) {
  const parts = dottedPath.split(".");
  let cursor: unknown = obj;

  for (const part of parts) {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) {
      return "";
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }

  if (cursor === null || cursor === undefined) return "";
  if (typeof cursor === "string") return cursor;
  if (typeof cursor === "number" || typeof cursor === "boolean") return String(cursor);

  try {
    return JSON.stringify(cursor);
  } catch {
    return "";
  }
}

export function renderTemplate(template: string, data: Record<string, unknown>) {
  return template.replace(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g, (_, path) => resolvePathValue(data, path));
}

export function redactEnvForLogs(env: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    redacted[key] = SENSITIVE_ENV_KEY.test(key) ? "***REDACTED***" : value;
  }
  return redacted;
}

export function buildPaperclipEnv(agent: { id: string; companyId: string }): Record<string, string> {
  const resolveHostForUrl = (rawHost: string): string => {
    const host = rawHost.trim();
    if (!host || host === "0.0.0.0" || host === "::") return "localhost";
    if (host.includes(":") && !host.startsWith("[") && !host.endsWith("]")) return `[${host}]`;
    return host;
  };
  const vars: Record<string, string> = {
    PAPERCLIP_AGENT_ID: agent.id,
    PAPERCLIP_COMPANY_ID: agent.companyId,
  };
  const runtimeHost = resolveHostForUrl(
    process.env.PAPERCLIP_LISTEN_HOST ?? process.env.HOST ?? "localhost",
  );
  const runtimePort = process.env.PAPERCLIP_LISTEN_PORT ?? process.env.PORT ?? "3100";
  const apiUrl = process.env.PAPERCLIP_API_URL ?? `http://${runtimeHost}:${runtimePort}`;
  vars.PAPERCLIP_API_URL = apiUrl;
  return vars;
}

export function defaultPathForPlatform() {
  if (process.platform === "win32") {
    return "C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem";
  }
  return "/usr/local/bin:/opt/homebrew/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin";
}

export function ensurePathInEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (typeof env.PATH === "string" && env.PATH.length > 0) return env;
  if (typeof env.Path === "string" && env.Path.length > 0) return env;
  return { ...env, PATH: defaultPathForPlatform() };
}

export async function ensureAbsoluteDirectory(
  cwd: string,
  opts: { createIfMissing?: boolean } = {},
) {
  if (!path.isAbsolute(cwd)) {
    throw new Error(`Working directory must be an absolute path: "${cwd}"`);
  }

  const assertDirectory = async () => {
    const stats = await fs.stat(cwd);
    if (!stats.isDirectory()) {
      throw new Error(`Working directory is not a directory: "${cwd}"`);
    }
  };

  try {
    await assertDirectory();
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (!opts.createIfMissing || code !== "ENOENT") {
      if (code === "ENOENT") {
        throw new Error(`Working directory does not exist: "${cwd}"`);
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  try {
    await fs.mkdir(cwd, { recursive: true });
    await assertDirectory();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not create working directory "${cwd}": ${reason}`);
  }
}

export async function ensureCommandResolvable(command: string, cwd: string, env: NodeJS.ProcessEnv) {
  const hasPathSeparator = command.includes("/") || command.includes("\\");
  if (hasPathSeparator) {
    const absolute = path.isAbsolute(command) ? command : path.resolve(cwd, command);
    try {
      await fs.access(absolute, fsConstants.X_OK);
    } catch {
      throw new Error(`Command is not executable: "${command}" (resolved: "${absolute}")`);
    }
    return;
  }

  const pathValue = env.PATH ?? env.Path ?? "";
  const delimiter = process.platform === "win32" ? ";" : ":";
  const dirs = pathValue.split(delimiter).filter(Boolean);
  const windowsExt = process.platform === "win32"
    ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];

  for (const dir of dirs) {
    for (const ext of windowsExt) {
      const candidate = path.join(dir, process.platform === "win32" ? `${command}${ext}` : command);
      try {
        await fs.access(candidate, fsConstants.X_OK);
        return;
      } catch {
        // continue scanning PATH
      }
    }
  }

  throw new Error(`Command not found in PATH: "${command}"`);
}

export async function runChildProcess(
  runId: string,
  command: string,
  args: string[],
  opts: {
    cwd: string;
    env: Record<string, string>;
    timeoutSec: number;
    graceSec: number;
    onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
    onLogError?: (err: unknown, runId: string, message: string) => void;
    stdin?: string;
  },
): Promise<RunProcessResult> {
  const onLogError = opts.onLogError ?? ((err, id, msg) => console.warn({ err, runId: id }, msg));

  return new Promise<RunProcessResult>((resolve, reject) => {
    const mergedEnv = ensurePathInEnv({ ...process.env, ...opts.env });
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: mergedEnv,
      shell: false,
      stdio: [opts.stdin != null ? "pipe" : "ignore", "pipe", "pipe"],
    }) as ChildProcessWithEvents;

    if (opts.stdin != null && child.stdin) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    }

    runningProcesses.set(runId, { child, graceSec: opts.graceSec });

    let timedOut = false;
    let stdout = "";
    let stderr = "";
    let logChain: Promise<void> = Promise.resolve();

    const timeout =
      opts.timeoutSec > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            setTimeout(() => {
              if (!child.killed) {
                child.kill("SIGKILL");
              }
            }, Math.max(1, opts.graceSec) * 1000);
          }, opts.timeoutSec * 1000)
        : null;

    child.stdout?.on("data", (chunk: unknown) => {
      const text = String(chunk);
      stdout = appendWithCap(stdout, text);
      logChain = logChain
        .then(() => opts.onLog("stdout", text))
        .catch((err) => onLogError(err, runId, "failed to append stdout log chunk"));
    });

    child.stderr?.on("data", (chunk: unknown) => {
      const text = String(chunk);
      stderr = appendWithCap(stderr, text);
      logChain = logChain
        .then(() => opts.onLog("stderr", text))
        .catch((err) => onLogError(err, runId, "failed to append stderr log chunk"));
    });

    child.on("error", (err: Error) => {
      if (timeout) clearTimeout(timeout);
      runningProcesses.delete(runId);
      const errno = (err as NodeJS.ErrnoException).code;
      const pathValue = mergedEnv.PATH ?? mergedEnv.Path ?? "";
      const msg =
        errno === "ENOENT"
          ? `Failed to start command "${command}" in "${opts.cwd}". Verify adapter command, working directory, and PATH (${pathValue}).`
          : `Failed to start command "${command}" in "${opts.cwd}": ${err.message}`;
      reject(new Error(msg));
    });

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (timeout) clearTimeout(timeout);
      runningProcesses.delete(runId);
      void logChain.finally(() => {
        resolve({
          exitCode: code,
          signal,
          timedOut,
          stdout,
          stderr,
        });
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Token-based cost estimation for adapters that don't report cost natively
// ---------------------------------------------------------------------------

/**
 * Per-million-token pricing for known models.
 * Prices are in USD per 1 million tokens.
 * cachedInput pricing is optional; defaults to inputPer1M if not specified.
 */
interface ModelPricing {
  inputPer1M: number;
  cachedInputPer1M?: number;
  outputPer1M: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  // OpenAI Codex / GPT-5 family
  "gpt-5.4":              { inputPer1M: 2.00, cachedInputPer1M: 0.50, outputPer1M: 8.00 },
  "gpt-5.3-codex":        { inputPer1M: 2.00, cachedInputPer1M: 0.50, outputPer1M: 8.00 },
  "gpt-5.3-codex-spark":  { inputPer1M: 0.50, cachedInputPer1M: 0.125, outputPer1M: 2.00 },
  "gpt-5":                { inputPer1M: 2.00, cachedInputPer1M: 0.50, outputPer1M: 8.00 },
  "gpt-5-mini":           { inputPer1M: 0.30, cachedInputPer1M: 0.075, outputPer1M: 1.20 },
  "gpt-5-nano":           { inputPer1M: 0.10, cachedInputPer1M: 0.025, outputPer1M: 0.40 },
  "o3":                   { inputPer1M: 2.00, cachedInputPer1M: 0.50, outputPer1M: 8.00 },
  "o4-mini":              { inputPer1M: 1.10, cachedInputPer1M: 0.275, outputPer1M: 4.40 },
  "o3-mini":              { inputPer1M: 1.10, cachedInputPer1M: 0.275, outputPer1M: 4.40 },
  "codex-mini-latest":    { inputPer1M: 1.50, cachedInputPer1M: 0.375, outputPer1M: 6.00 },

  // Google Gemini family
  "gemini-2.5-pro":       { inputPer1M: 1.25, cachedInputPer1M: 0.3125, outputPer1M: 10.00 },
  "gemini-2.5-flash":     { inputPer1M: 0.15, cachedInputPer1M: 0.0375, outputPer1M: 0.60 },
  "gemini-2.5-flash-lite":{ inputPer1M: 0.075, cachedInputPer1M: 0.01875, outputPer1M: 0.30 },

  // Anthropic (fallback for adapters that route through codex/gemini but report claude models)
  "claude-opus-4-6":              { inputPer1M: 15.00, cachedInputPer1M: 1.50, outputPer1M: 75.00 },
  "claude-sonnet-4":              { inputPer1M: 3.00, cachedInputPer1M: 0.30, outputPer1M: 15.00 },
  "claude-sonnet-4-20250514":     { inputPer1M: 3.00, cachedInputPer1M: 0.30, outputPer1M: 15.00 },
};

/**
 * Estimate the cost in USD for a given model and token usage.
 * Returns null if the model is unknown (no pricing data).
 *
 * @param model - The model identifier string
 * @param inputTokens - Number of non-cached input tokens
 * @param outputTokens - Number of output tokens
 * @param cachedInputTokens - Number of cached input tokens (optional, defaults to 0)
 */
export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0,
): number | null {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return null;

  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  const cachedInputPer1M = pricing.cachedInputPer1M ?? pricing.inputPer1M;

  const cost =
    (uncachedInputTokens / 1_000_000) * pricing.inputPer1M +
    (cachedInputTokens / 1_000_000) * cachedInputPer1M +
    (outputTokens / 1_000_000) * pricing.outputPer1M;

  return cost;
}
