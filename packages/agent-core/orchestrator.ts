import type Anthropic from "@anthropic-ai/sdk";
import { editionFromMessage, parseEdition, type Edition } from "./edition";
import { slugifyUrl } from "./history-digest";
import { OUTPUT_PATH, buildKickoffMessage } from "./prompt";
import { DEFAULT_BLOCKED_SITES, normalizeBlockList } from "./site-filter";
import { STORAGE_KEYS, ensureAgent, ensureEnvironment, type HomepageModel } from "./setup";
import { loadAllowedPages, runGetHistory, type Emit } from "./tools";
import type {
  BrowserBridge,
  GetHistoryResult,
  GetPageHtmlResult,
  HomepageBuildResult,
  KVStore,
  PageRef,
  RunCallbacks,
} from "./types";

type SessionEvent = Anthropic.Beta.Sessions.BetaManagedAgentsSessionEvent;
type CustomToolUse = Anthropic.Beta.Sessions.BetaManagedAgentsAgentCustomToolUseEvent;

const MANAGED_AGENTS_BETA = "managed-agents-2026-04-01";

/** How many times a dropped session stream is reopened before the build gives up. */
const MAX_STREAM_RECONNECTS = 20;

/** Files mount under this root no matter what path you ask for. Ask for it directly. */
const UPLOAD_ROOT = "/mnt/session/uploads";

export interface RunOptions {
  client: Anthropic;
  bridge: BrowserBridge;
  store: KVStore;
  userSystemPrompt?: string;
  /**
   * Hosts the tools must never read. A getter is re-read before every tool call,
   * so a list saved mid-build applies to the rest of that build.
   */
  blockedSites?: string[] | (() => Promise<string[]>);
  /** Ignored when resuming: the session keeps the agent (and model) it started with. */
  model?: HomepageModel;
  callbacks?: RunCallbacks;
  signal?: AbortSignal;
  /** Reattach to an existing session instead of creating one (e.g. after the host was killed mid-run). */
  resumeSessionId?: string;
  now?: Date;
}

export async function runHomepageBuild(opts: RunOptions): Promise<HomepageBuildResult> {
  const { client, bridge, store, callbacks, signal } = opts;
  const emit: Emit = {
    phase: (p, d) => callbacks?.onPhase?.(p, d),
    text: (t) => callbacks?.onText?.(t),
    log: (l) => callbacks?.onLog?.(l),
  };

  emit.phase("setup");
  const [agentId, environmentId] = await Promise.all([
    ensureAgent(client, store, opts.model),
    ensureEnvironment(client, store),
  ]);
  emit.log(`agent=${agentId} environment=${environmentId}`);

  let sessionId = opts.resumeSessionId;
  if (!sessionId) {
    emit.phase("session-create");
    const session = await client.beta.sessions.create({
      agent: agentId,
      environment_id: environmentId,
      title: `Homepage ${(opts.now ?? new Date()).toISOString().slice(0, 10)}`,
    });
    sessionId = session.id;
    await store.set(STORAGE_KEYS.activeSessionId, sessionId);
  }
  emit.log(`session=${sessionId}`);

  // Persist upload IDs so cleanup can still find them after a reattach.
  const uploadedFileIds: string[] =
    (await store.get<string[]>(STORAGE_KEYS.uploadedFileIds)) ?? [];
  const rememberUpload = async (id: string) => {
    uploadedFileIds.push(id);
    await store.set(STORAGE_KEYS.uploadedFileIds, uploadedFileIds);
  };

  let finalMessage = "";

  /**
   * Every path out of here must send a result. An `agent.custom_tool_use` that
   * never receives one leaves the session idle forever — the single
   * unrecoverable bug in this design.
   */
  // Results computed but not yet delivered, by tool-use id. A send that fails
  // (the connection dropped mid-build) is retried on reconnect with the same
  // result, instead of scraping the pages again.
  const undelivered = new Map<string, { is_error?: true; text: string }>();

  const runTool = async (event: CustomToolUse): Promise<{ is_error?: true; text: string }> => {
    try {
      const blockedSites = normalizeBlockList(
        (typeof opts.blockedSites === "function" ? await opts.blockedSites() : opts.blockedSites) ?? DEFAULT_BLOCKED_SITES,
      );
      let result: GetHistoryResult | GetPageHtmlResult;
      switch (event.name) {
        case "getHistory":
          result = await runGetHistory(event.input as { daysToAnalyze?: number; maxResults?: number }, bridge, emit, blockedSites);
          break;
        case "getPageHtml":
          result = await runGetPageHtml(event, { client, bridge, sessionId: sessionId!, rememberUpload, emit, blockedSites });
          break;
        default:
          throw new Error(`Unknown custom tool: ${event.name}`);
      }
      return { text: JSON.stringify(result) };
    } catch (err) {
      emit.log(`tool ${event.name} failed: ${String(err)}`);
      return { is_error: true, text: String(err) };
    }
  };

  /** Throws only if the result could not be sent; it is kept for the next attempt. */
  const dispatch = async (event: CustomToolUse): Promise<void> => {
    let result = undelivered.get(event.id);
    if (!result) {
      result = await runTool(event);
      undelivered.set(event.id, result);
    }
    await client.beta.sessions.events.send(sessionId!, {
      events: [
        {
          type: "user.custom_tool_result",
          custom_tool_use_id: event.id,
          ...(result.is_error ? { is_error: true } : {}),
          content: [{ type: "text", text: result.text }],
        },
      ],
    });
    undelivered.delete(event.id);
  };

  const observe = (event: SessionEvent) => {
    switch (event.type) {
      case "agent.message":
        for (const block of event.content) {
          if (block.type === "text") {
            finalMessage += block.text;
            emit.text(block.text);
          }
        }
        break;
      case "agent.thinking":
        emit.phase("thinking");
        break;
      case "agent.tool_use":
        emit.phase("analyzing", event.name);
        emit.log(`sandbox:${event.name}`);
        break;
      case "session.error":
        emit.log(`session.error: ${JSON.stringify(event)}`);
        break;
    }
  };

  try {
    const seen = new Set<string>();
    const answered = new Set<string>();
    let kickedOff = false;
    let finished = false;

    // A stream can close before the session is done (most often during a long
    // tool call, while no events flow). That isn't the end of the build:
    // reconnect, replay what was missed, and keep going.
    for (let attempt = 0; !finished; attempt++) {
      if (signal?.aborted) throw new Error("aborted");
      if (attempt > MAX_STREAM_RECONNECTS) {
        throw new Error(`Lost the session stream ${MAX_STREAM_RECONNECTS} times; giving up.`);
      }
      if (attempt > 0) {
        emit.log(`stream closed before the session finished; reconnecting (${attempt})`);
        await new Promise((r) => setTimeout(r, Math.min(1000 * attempt, 5000)));
      }

      // ---- Open the stream BEFORE anything else. It only delivers events emitted
      // ---- after it opens; send first and the early transitions are gone.
      const stream = await client.beta.sessions.events.stream(sessionId, undefined, { signal });

      // ---- Then replay history. Covers the gap before the stream attached, and
      // ---- is what makes a reattach (or a reconnect) lossless.
      const history: SessionEvent[] = [];
      for await (const event of client.beta.sessions.events.list(sessionId)) {
        history.push(event);
      }

      for (const event of history) {
        if (event.type === "user.custom_tool_result") answered.add(event.custom_tool_use_id);
        if (event.type === "user.message") kickedOff = true;
      }
      for (const event of history) {
        if (seen.has(event.id)) continue;
        seen.add(event.id);
        observe(event);
      }

      // Only an end after the kickoff counts; a fresh session may idle before it.
      const kickoffAt = history.findIndex((e) => e.type === "user.message");
      if (kickoffAt !== -1 && history.slice(kickoffAt).some(isTerminal)) {
        finished = true;
        break;
      }

      if (!kickedOff) {
        await client.beta.sessions.events.send(sessionId, {
          events: [
            {
              type: "user.message",
              content: [
                {
                  type: "text",
                  text: buildKickoffMessage({
                    now: opts.now ?? new Date(),
                    userSystemPrompt: opts.userSystemPrompt,
                  }),
                },
              ],
            },
          ],
        });
        kickedOff = true;
      }

      try {
        // Re-answer any tool call that was left hanging when the stream dropped.
        // `answered` only holds calls whose result reached the session.
        for (const event of history) {
          if (event.type === "agent.custom_tool_use" && !answered.has(event.id)) {
            emit.log(`re-answering orphaned tool call ${event.id}`);
            await dispatch(event);
            answered.add(event.id);
          }
        }

        for await (const event of stream) {
          if (signal?.aborted) throw new Error("aborted");

          // Live-preview events carry no `id` and are never terminal. They only
          // arrive if `event_deltas` was requested, but the stream union includes
          // them either way — reading `.id` off one would throw.
          if (event.type === "event_start" || event.type === "event_delta") continue;

          if (!seen.has(event.id)) {
            seen.add(event.id);
            observe(event);
            if (event.type === "agent.custom_tool_use" && !answered.has(event.id)) {
              await dispatch(event);
              answered.add(event.id);
            }
          }

          // Terminal checks run for *every* event, including ones we've already
          // seen. `continue`-ing on a duplicate above would skip the terminal
          // event that arrived in the history fetch, and the loop would never end.
          if (isTerminal(event)) {
            if (event.type === "session.status_idle") emit.log(`idle: ${event.stop_reason.type}`);
            finished = true;
            break;
          }
        }
      } catch (err) {
        // A dropped connection is retried like a clean close; a cancel is not.
        if (signal?.aborted) throw err;
        emit.log(`stream error: ${String(err)}`);
      }
    }

    emit.phase("writing");
    const { edition, source } = await collectDeliverable(client, sessionId, finalMessage, emit);
    emit.phase("done");
    return { edition, sessionId, source };
  } finally {
    // Privacy: the event log holds every domain, title and page body we sent,
    // and uploads persist independently of the session. Delete both, always.
    emit.phase("cleanup");
    await Promise.allSettled(uploadedFileIds.map((id) => client.beta.files.delete(id)));
    await store.remove(STORAGE_KEYS.uploadedFileIds);
    if (sessionId) {
      await deleteSessionWhenSettled(client, sessionId).catch((err) =>
        emit.log(`session ${sessionId} was not deleted: ${String(err)}`),
      );
    }
    await store.remove(STORAGE_KEYS.activeSessionId);
  }
}

/** The session is done with this turn: it ended, or went idle for any reason but a pending tool call. */
function isTerminal(event: SessionEvent): boolean {
  if (event.type === "session.status_terminated") return true;
  return event.type === "session.status_idle" && event.stop_reason.type !== "requires_action";
}

// ---------------------------------------------------------------------------
// tool implementations
// ---------------------------------------------------------------------------

async function runGetPageHtml(
  event: CustomToolUse,
  ctx: {
    client: Anthropic;
    bridge: BrowserBridge;
    sessionId: string;
    rememberUpload: (id: string) => Promise<void>;
    emit: Emit;
    blockedSites: string[];
  },
): Promise<GetPageHtmlResult> {
  const { pages, blocked, failed } = await loadAllowedPages(
    event.input as { urls: string[]; loadDelayMs?: number },
    ctx.bridge,
    ctx.emit,
    ctx.blockedSites,
  );

  const refs: PageRef[] = [];
  const mountFailures = [...blocked, ...failed];

  for (const page of pages) {
    try {
      const filename = `${slugifyUrl(page.url)}_${refs.length}.html`;
      const upload = await ctx.client.beta.files.upload({
        file: new File([page.html], filename, { type: "text/html" }),
      });
      await ctx.rememberUpload(upload.id);

      // Mount mid-session, while the session idles awaiting this very result.
      // The API re-roots every mount under /mnt/session/uploads (see below).
      const resource = await ctx.client.beta.sessions.resources.add(ctx.sessionId, {
        type: "file",
        file_id: upload.id,
        mount_path: `${UPLOAD_ROOT}/pages/${filename}`,
      });

      refs.push({
        url: page.url,
        title: page.title,
        // The API re-roots every mount under /mnt/session/uploads. Report what it
        // resolved, not what we asked for, or the model greps a path that isn't there.
        mountPath: resource.mount_path,
        bytes: page.html.length,
      });
      ctx.emit.log(`mounted ${page.url} -> ${resource.mount_path} (${page.html.length}b)`);
    } catch (err) {
      mountFailures.push({ url: page.url, reason: `mount failed: ${String(err)}` });
    }
  }

  if (refs.length === 0 && mountFailures.length > 0 && blocked.length === 0) {
    throw new Error(
      `No pages could be mounted. Failures: ${mountFailures
        .map((f) => `${f.url} (${f.reason})`)
        .join("; ")}`,
    );
  }

  return { pages: refs, failed: mountFailures };
}

// ---------------------------------------------------------------------------
// deliverable retrieval
// ---------------------------------------------------------------------------

async function collectDeliverable(
  client: Anthropic,
  sessionId: string,
  finalMessage: string,
  emit: Emit,
): Promise<{ edition: Edition; source: HomepageBuildResult["source"] }> {
  let invalid: string | undefined;
  // There is a short indexing lag between status_idle and outputs appearing.
  for (let attempt = 0; attempt < 5 && !invalid; attempt++) {
    try {
      for await (const file of client.beta.files.list({
        scope_id: sessionId,
        betas: [MANAGED_AGENTS_BETA],
      })) {
        if (!/\.json$/.test(file.filename)) continue;
        const response = await client.beta.files.download(file.id);
        const text = await response.text();
        if (!text.trim()) continue;
        emit.log(`deliverable from session output: ${file.filename} (${text.length}b)`);
        try {
          return { edition: parseEdition(text), source: "session-output" };
        } catch (err) {
          invalid = err instanceof Error ? err.message : String(err);
          emit.log(`session output rejected: ${invalid}`);
        }
      }
    } catch (err) {
      emit.log(`files.list attempt ${attempt + 1} failed: ${String(err)}`);
    }
    if (!invalid) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }

  // Fallback: the model sometimes answers with the JSON inline instead of
  // (or as well as) writing it. Better than failing the run outright.
  const inline = editionFromMessage(finalMessage);
  if (inline) {
    emit.log("deliverable recovered from message");
    return { edition: inline, source: "message-fence" };
  }

  throw new Error(
    invalid
      ? `The agent's edition was unusable: ${invalid}`
      : `Agent produced no homepage. Expected a file at ${OUTPUT_PATH}. Final message: ${finalMessage.slice(0, 400)}`,
  );
}

/**
 * A running session can't be deleted ("cannot delete while running"). After a
 * normal finish that's only the brief lag between the stream's idle and the
 * queryable status. After a cancel or error the agent is still mid-turn, so it
 * gets interrupted and has to reach a safe boundary before it goes idle.
 */
const SETTLE_POLLS_BEFORE_INTERRUPT = 10;
const INTERRUPT_DEADLINE_MS = 60_000;

async function deleteSessionWhenSettled(client: Anthropic, sessionId: string): Promise<void> {
  const deadline = Date.now() + INTERRUPT_DEADLINE_MS;
  let interrupted = false;
  for (let attempt = 0; Date.now() < deadline; attempt++) {
    const session = await client.beta.sessions.retrieve(sessionId);
    if (session.status !== "running") break;
    if (!interrupted && attempt >= SETTLE_POLLS_BEFORE_INTERRUPT) {
      await client.beta.sessions.events.send(sessionId, { events: [{ type: "user.interrupt" }] });
      interrupted = true;
    }
    await new Promise((r) => setTimeout(r, interrupted ? 1000 : 200));
  }
  await client.beta.sessions.delete(sessionId);
}
