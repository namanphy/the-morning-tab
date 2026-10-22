/**
 * The agent loop for providers without a hosted sandbox (Gemini, OpenRouter).
 *
 * Same job and same prompt as the Managed Agents build in orchestrator.ts, but
 * the loop runs here: each turn is one OpenAI-compatible chat completion, and
 * read / grep / glob / write work over an in-memory file system holding the
 * scraped pages. Nothing is uploaded anywhere but the model request itself, so
 * there is nothing to clean up afterwards — and nothing to reattach to if the
 * host dies mid-build.
 */
import { editionFromMessage, parseEdition, type Edition } from "./edition";
import { slugifyUrl } from "./history-digest";
import { HOMEPAGE_SYSTEM_PROMPT, OUTPUT_PATH, buildKickoffMessage } from "./prompt";
import { PROVIDERS, type ProviderId } from "./providers";
import { GET_HISTORY_SCHEMA, GET_PAGE_HTML_SCHEMA } from "./schemas";
import { DEFAULT_BLOCKED_SITES, normalizeBlockList } from "./site-filter";
import { loadAllowedPages, runGetHistory, type Emit } from "./tools";
import type { BrowserBridge, GetPageHtmlResult, HomepageBuildResult, PageRef, RunCallbacks } from "./types";

/** Mirrors where the hosted sandbox mounts pages, so the shared prompt holds. */
const PAGES_DIR = "/mnt/session/uploads/pages";

/** A runaway loop costs the user's quota; a real build needs ~10–25 turns. */
const MAX_TURNS = 50;
const MAX_PAGES_PER_CALL = 8;
const MAX_PAGES_PER_BUILD = 16;

/** Tool-result caps, so one read can't blow a small model's context. */
const READ_DEFAULT_LINES = 200;
const READ_MAX_CHARS = 24_000;
const LINE_MAX_CHARS = 1_500;
const GREP_DEFAULT_RESULTS = 50;
const GREP_MAX_RESULTS = 100;
const GREP_LINE_CHARS = 300;

const MAX_RETRIES = 5;

/**
 * OpenRouter's router over whatever free models are up right now. Free models
 * are often rate-limited upstream, so it backs up the chosen one.
 */
export const OPENROUTER_FREE_ROUTER = "openrouter/free";

export interface LocalRunOptions {
  provider: Exclude<ProviderId, "anthropic">;
  apiKey: string;
  model: string;
  bridge: BrowserBridge;
  userSystemPrompt?: string;
  /** As in RunOptions: a getter is re-read before every tool call. */
  blockedSites?: string[] | (() => Promise<string[]>);
  callbacks?: RunCallbacks;
  signal?: AbortSignal;
  now?: Date;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

// ---------------------------------------------------------------------------
// chat-completions wire types (only what we read or send)
// ---------------------------------------------------------------------------

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  /** Provider extras (e.g. Gemini's thought signature) ride along untouched. */
  [k: string]: unknown;
}

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[]; [k: string]: unknown }
  | { role: "tool"; tool_call_id: string; content: string };

interface ChatResponse {
  choices?: Array<{ message: ChatMessage & { role: "assistant" }; finish_reason?: string }>;
  error?: {
    message?: string;
    code?: number | string;
    /** OpenRouter: which upstream failed, and what it actually said. */
    metadata?: { provider_name?: string; raw?: unknown };
  };
}

const LOCAL_TOOLS_PROMPT = `

## Tools in this run

Your tools are plain function calls, and your context window is limited — be economical.
- getPageHtml stores each page as a file and returns its mountPath. Pages are
  stored with roughly one HTML block per line.
- grep {pattern, path?, ignoreCase?, maxResults?}: regex search; path may be a file
  or a directory (default: every page). Returns "path:line: text".
- read {path, offset?, limit?}: lines from a file, 1-based. Default ${READ_DEFAULT_LINES} lines;
  long lines are truncated. Grep first, then read the range around the hits.
- glob {pattern}: list stored files, e.g. "${PAGES_DIR}/*.html".
- write {path, content}: call it with path "${OUTPUT_PATH}" and the edition JSON as
  content. That call is the only way to deliver the homepage. It is checked on
  write: if it reports a problem, fix it and write again.`;

const TOOLS = [
  {
    name: "getHistory",
    description:
      "Returns a ranked digest of the user's most-visited domains over a recent window: visit " +
      "counts, unique page counts, last-visit timestamps, relevance scores, and a few sample page " +
      "titles per domain. Call this first, once.",
    parameters: GET_HISTORY_SCHEMA,
  },
  {
    name: "getPageHtml",
    description:
      "Loads URLs in the user's real, logged-in browser, sanitizes the HTML, and stores each page " +
      "as a file. Returns a mountPath and byte count per page plus a list of failures. Use " +
      "grep/read on the returned mountPath.",
    parameters: GET_PAGE_HTML_SCHEMA,
  },
  {
    name: "grep",
    description: "Regex search over stored files. Returns matching lines as path:line: text.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "JavaScript regular expression." },
        path: { type: "string", description: "A file or directory. Default: all pages." },
        ignoreCase: { type: "boolean", description: "Default true." },
        maxResults: { type: "integer", minimum: 1, maximum: GREP_MAX_RESULTS },
      },
      required: ["pattern"],
    },
  },
  {
    name: "read",
    description: "Read lines from a stored file, with line numbers.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "integer", minimum: 1, description: "First line, 1-based. Default 1." },
        limit: { type: "integer", minimum: 1, description: `Lines to read. Default ${READ_DEFAULT_LINES}.` },
      },
      required: ["path"],
    },
  },
  {
    name: "glob",
    description: "List stored files matching a glob pattern (* and ** supported).",
    parameters: {
      type: "object",
      properties: { pattern: { type: "string" } },
      required: ["pattern"],
    },
  },
  {
    name: "write",
    description: `Write a file. Use it to deliver the edition JSON at ${OUTPUT_PATH}.`,
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
].map((fn) => ({ type: "function" as const, function: fn }));

export async function runLocalHomepageBuild(opts: LocalRunOptions): Promise<HomepageBuildResult> {
  const { bridge, callbacks, signal } = opts;
  const info = PROVIDERS[opts.provider];
  const doFetch = opts.fetch ?? fetch;
  const emit: Emit = {
    phase: (p, d) => callbacks?.onPhase?.(p, d),
    text: (t) => callbacks?.onText?.(t),
    log: (l) => callbacks?.onLog?.(l),
  };

  emit.phase("setup");
  emit.log(`provider=${opts.provider} model=${opts.model}`);

  const files = new Map<string, string>();
  let pagesLoaded = 0;
  let edition: Edition | undefined;
  let finalMessage = "";

  const messages: ChatMessage[] = [
    { role: "system", content: HOMEPAGE_SYSTEM_PROMPT + LOCAL_TOOLS_PROMPT },
    {
      role: "user",
      content: buildKickoffMessage({ now: opts.now ?? new Date(), userSystemPrompt: opts.userSystemPrompt }),
    },
  ];

  // OpenRouter tries `models` in order, moving on when one is down or rate-limited.
  const modelParams =
    opts.provider === "openrouter" && opts.model !== OPENROUTER_FREE_ROUTER && opts.model.endsWith(":free")
      ? { models: [opts.model, OPENROUTER_FREE_ROUTER] }
      : { model: opts.model };

  const chat = async (): Promise<ChatMessage & { role: "assistant" }> => {
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw new Error("aborted");
      let res: Response;
      try {
        res = await doFetch(`${info.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${opts.apiKey}`,
            // OpenRouter's app attribution; ignored elsewhere.
            ...(opts.provider === "openrouter" ? { "X-Title": "AI Homepage" } : {}),
          },
          body: JSON.stringify({ ...modelParams, messages, tools: TOOLS, tool_choice: "auto" }),
          signal,
        });
      } catch (err) {
        if (signal?.aborted || attempt >= MAX_RETRIES) throw err;
        emit.log(`request failed (${String(err)}); retrying`);
        await sleep(backoff(attempt), signal);
        continue;
      }

      const raw = await res.text();
      let body: ChatResponse | undefined;
      try {
        body = JSON.parse(raw) as ChatResponse;
      } catch {
        body = undefined;
      }
      const errorMessage = describeError(body) ?? (res.ok ? undefined : raw.slice(0, 300));
      // Free tiers rate-limit hard, and OpenRouter can report an upstream error in a 200.
      const status = !res.ok ? res.status : Number(body?.error?.code) || (body?.error ? 502 : 200);
      if (status === 429 || status >= 500) {
        // A spent daily quota won't come back in a minute; say so instead of retrying.
        // Gemini says "quota … per day"; OpenRouter says "free-models-per-day".
        const quotaSpent = status === 429 && /per[- ]?day|daily/i.test(errorMessage ?? "");
        if (quotaSpent || attempt >= MAX_RETRIES) {
          const hint = status === 429 ? " Quota or rate limit reached: pick another model or provider in Settings." : "";
          throw new Error(`${info.label} (${opts.model}): ${errorMessage ?? `HTTP ${status}`}.${hint}`);
        }
        const retryAfter = Number(res.headers.get("retry-after"));
        const wait = retryAfter > 0 ? Math.min(retryAfter * 1000, 60_000) : backoff(attempt);
        emit.log(`${info.label} HTTP ${status}${errorMessage ? `: ${errorMessage}` : ""}; retrying in ${Math.round(wait / 1000)}s`);
        await sleep(wait, signal);
        continue;
      }
      if (status >= 400 || errorMessage) {
        const hint = status === 401 || status === 403 ? " Check the API key in Settings." : status === 404 ? " Pick another model in Settings." : "";
        throw new Error(`${info.label} (${opts.model}): ${errorMessage ?? `HTTP ${status}`}.${hint}`);
      }
      const message = body?.choices?.[0]?.message;
      if (!message) throw new Error(`${info.label} returned no message: ${raw.slice(0, 300)}`);
      return message;
    }
  };

  const runTool = async (name: string, args: Record<string, unknown>): Promise<string> => {
    switch (name) {
      case "getHistory": {
        const blockedSites = await resolveBlocked(opts.blockedSites);
        return JSON.stringify(await runGetHistory(args, bridge, emit, blockedSites));
      }
      case "getPageHtml": {
        const urls = Array.isArray(args.urls) ? args.urls.filter((u): u is string => typeof u === "string") : [];
        if (urls.length === 0) throw new Error("urls must be a non-empty array of strings");
        if (urls.length > MAX_PAGES_PER_CALL) throw new Error(`at most ${MAX_PAGES_PER_CALL} urls per call`);
        if (pagesLoaded + urls.length > MAX_PAGES_PER_BUILD) {
          throw new Error(`page budget spent: at most ${MAX_PAGES_PER_BUILD} pages per build. Work with what you have.`);
        }
        pagesLoaded += urls.length;
        const blockedSites = await resolveBlocked(opts.blockedSites);
        const loadDelayMs = typeof args.loadDelayMs === "number" ? args.loadDelayMs : undefined;
        const { pages, blocked, failed } = await loadAllowedPages({ urls, loadDelayMs }, bridge, emit, blockedSites);
        const refs: PageRef[] = pages.map((page, i) => {
          const mountPath = `${PAGES_DIR}/${slugifyUrl(page.url)}_${files.size + i}.html`;
          files.set(mountPath, splitBlocks(page.html));
          emit.log(`stored ${page.url} -> ${mountPath} (${page.html.length}b)`);
          return { url: page.url, title: page.title, mountPath, bytes: page.html.length };
        });
        const result: GetPageHtmlResult = { pages: refs, failed: [...blocked, ...failed] };
        return JSON.stringify(result);
      }
      case "grep":
        emit.phase("analyzing", "grep");
        return grep(files, args);
      case "read":
        emit.phase("analyzing", "read");
        return read(files, args);
      case "glob":
        emit.phase("analyzing", "glob");
        return glob(files, args);
      case "write": {
        const path = String(args.path ?? "");
        // Some models pass the JSON as an object rather than a string.
        const content = typeof args.content === "string" ? args.content : JSON.stringify(args.content ?? "");
        if (!path) throw new Error("path is required");
        if (path === OUTPUT_PATH || (path.endsWith(".json") && !path.startsWith(PAGES_DIR))) {
          // Validate now, while the model can still fix it.
          const parsed = parseEdition(content);
          edition = parsed;
          files.set(OUTPUT_PATH, content);
          emit.phase("writing");
          const count = 1 + parsed.topStories.length + parsed.sections.reduce((n, s) => n + s.stories.length, 0);
          emit.log(`edition written: ${count} stories, ${parsed.sections.length} sections`);
          return `Saved the edition: ${count} stories in ${parsed.sections.length} sections, ${parsed.briefs.length} briefs, ${parsed.upcoming.length} upcoming. Reply with your two-sentence summary.`;
        }
        files.set(path, content);
        emit.log(`wrote ${path} (${content.length}b)`);
        return `Wrote ${content.length} bytes to ${path}.`;
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  };

  let nudged = false;
  for (let turn = 0; ; turn++) {
    if (turn >= MAX_TURNS) throw new Error(`The model did not finish within ${MAX_TURNS} turns.`);
    emit.phase("thinking");
    const message = await chat();

    // Some hosts omit tool-call ids; the result has to point back at something.
    const toolCalls = (message.tool_calls ?? []).map((call, i) => ({
      ...call,
      id: call.id || `call_${turn}_${i}`,
      type: "function" as const,
    }));
    messages.push({ ...message, role: "assistant", content: message.content ?? null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });

    const text = contentText(message.content);
    if (text) {
      finalMessage += text;
      emit.text(text);
    }

    if (toolCalls.length === 0) {
      if (edition) break;
      // Weaker models often describe the homepage instead of writing it. One nudge.
      if (nudged || editionFromMessage(finalMessage)) break;
      nudged = true;
      messages.push({
        role: "user",
        content: `You have not written the edition yet. Call write with path "${OUTPUT_PATH}" and the edition JSON as content.`,
      });
      continue;
    }

    for (const call of toolCalls) {
      if (signal?.aborted) throw new Error("aborted");
      let content: string;
      try {
        const args = parseArgs(call.function.arguments);
        content = await runTool(call.function.name, args);
      } catch (err) {
        emit.log(`tool ${call.function.name} failed: ${String(err)}`);
        content = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
      messages.push({ role: "tool", tool_call_id: call.id, content });
    }
  }

  emit.phase("writing");
  const sessionId = `local-${opts.provider}`;
  if (edition) {
    emit.phase("done");
    return { edition, sessionId, source: "local-file" };
  }
  const inline = editionFromMessage(finalMessage);
  if (inline) {
    emit.log("deliverable recovered from message");
    emit.phase("done");
    return { edition: inline, sessionId, source: "message-fence" };
  }
  throw new Error(
    `Agent produced no homepage. Expected a file at ${OUTPUT_PATH}. Final message: ${finalMessage.slice(0, 400)}`,
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** The error message, plus the upstream's own words when OpenRouter wraps them. */
function describeError(body: ChatResponse | undefined): string | undefined {
  const error = body?.error;
  if (!error?.message) return undefined;
  const { provider_name, raw } = error.metadata ?? {};
  if (raw === undefined) return error.message;
  let detail = typeof raw === "string" ? raw : JSON.stringify(raw);
  try {
    // Upstreams often nest their own JSON error; pull the message out of it.
    const parsed = JSON.parse(detail);
    detail = parsed?.error?.message ?? parsed?.message ?? detail;
  } catch {
    // Not JSON; use as is.
  }
  return `${error.message}${provider_name ? ` (${provider_name})` : ""}: ${String(detail).slice(0, 300)}`;
}

async function resolveBlocked(blockedSites: LocalRunOptions["blockedSites"]): Promise<string[]> {
  return normalizeBlockList(
    (typeof blockedSites === "function" ? await blockedSites() : blockedSites) ?? DEFAULT_BLOCKED_SITES,
  );
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
  }
  return "";
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    throw new Error(`arguments are not valid JSON: ${raw.slice(0, 200)}`);
  }
}

/** Sanitized HTML is often one huge line. Break after block elements so grep and read have lines. */
function splitBlocks(html: string): string {
  return html
    .replace(/(<\/(?:p|li|div|h[1-6]|tr|table|ul|ol|blockquote|pre|figure|section|article|header|footer|nav|main)>)/gi, "$1\n")
    .replace(/(<br\s*\/?>)/gi, "$1\n")
    .replace(/\n{2,}/g, "\n");
}

function grep(files: Map<string, string>, args: Record<string, unknown>): string {
  const pattern = String(args.pattern ?? "");
  if (!pattern) throw new Error("pattern is required");
  const flags = args.ignoreCase === false ? "" : "i";
  let re: RegExp;
  try {
    re = new RegExp(pattern, flags);
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
  }
  const scope = typeof args.path === "string" && args.path ? args.path.replace(/\/+$/, "") : PAGES_DIR;
  const max = Math.min(Number(args.maxResults) || GREP_DEFAULT_RESULTS, GREP_MAX_RESULTS);

  const out: string[] = [];
  let total = 0;
  for (const [path, content] of files) {
    if (path !== scope && !path.startsWith(`${scope}/`)) continue;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = re.exec(lines[i]);
      if (!m) continue;
      total++;
      if (out.length < max) out.push(`${path}:${i + 1}: ${around(lines[i], m.index, GREP_LINE_CHARS)}`);
    }
  }
  if (total === 0) return `No matches for /${pattern}/ under ${scope}.`;
  return out.join("\n") + (total > out.length ? `\n… ${total - out.length} more matches; narrow the pattern or path.` : "");
}

function read(files: Map<string, string>, args: Record<string, unknown>): string {
  const path = String(args.path ?? "");
  const content = files.get(path);
  if (content === undefined) throw new Error(`No such file: ${path}. Use glob to list files.`);
  const lines = content.split("\n");
  const offset = Math.max(1, Number(args.offset) || 1);
  const limit = Math.max(1, Number(args.limit) || READ_DEFAULT_LINES);

  const out: string[] = [];
  let chars = 0;
  let last = offset - 1;
  for (let i = offset - 1; i < Math.min(lines.length, offset - 1 + limit); i++) {
    const line = lines[i].length > LINE_MAX_CHARS ? `${lines[i].slice(0, LINE_MAX_CHARS)} …[line truncated]` : lines[i];
    if (chars + line.length > READ_MAX_CHARS && out.length > 0) break;
    out.push(`${i + 1}\t${line}`);
    chars += line.length;
    last = i + 1;
  }
  const tail = last < lines.length ? `\n[lines ${offset}-${last} of ${lines.length}; continue with offset ${last + 1}]` : "";
  return out.join("\n") + tail;
}

function glob(files: Map<string, string>, args: Record<string, unknown>): string {
  const pattern = String(args.pattern ?? "**");
  const source = pattern
    .split(/(\*\*\/?|\*|\?)/)
    .map((part) =>
      part === "**" || part === "**/" ? ".*" : part === "*" ? "[^/]*" : part === "?" ? "[^/]" : part.replace(/[.+^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  const re = new RegExp(`^${source}$`);
  // A bare name like "*.html" matches anywhere, as a shell user would expect.
  const matches = [...files.entries()].filter(([path]) => re.test(path) || (!pattern.includes("/") && re.test(path.split("/").pop()!)));
  if (matches.length === 0) return `No files match ${pattern}.`;
  return matches.map(([path, content]) => `${path} (${content.length}b)`).join("\n");
}

function around(line: string, index: number, width: number): string {
  if (line.length <= width) return line.trim();
  const start = Math.max(0, Math.min(index - Math.floor(width / 3), line.length - width));
  return `${start > 0 ? "…" : ""}${line.slice(start, start + width).trim()}${start + width < line.length ? "…" : ""}`;
}

function backoff(attempt: number): number {
  return Math.min(2000 * 2 ** attempt, 30_000);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
