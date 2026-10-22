import { expect, test } from "bun:test";
import { OUTPUT_PATH, runLocalHomepageBuild, type BrowserBridge } from "@homepage/agent-core";
import { fixtureHistory } from "./node-bridge";

const EDITION = {
  theme: "Rust everywhere",
  lead: { title: "Story about Rust", url: "https://example.com/a", source: "Example", summary: "It matters." },
  topStories: [{ title: "Second", url: "https://example.com/b", source: "Example" }],
  sections: [{ title: "More", stories: [{ title: "Third", url: "https://example.com/c", source: "Example" }] }],
  briefs: [],
  upcoming: [{ label: "Release", when: "Thu" }],
};
const COMPONENT = JSON.stringify(EDITION);

/** A fake chat-completions endpoint that plays back one assistant message per request. */
function scripted(turns: Array<(req: any) => any>) {
  const requests: any[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const req = JSON.parse(String(init.body));
    requests.push(req);
    const turn = turns[requests.length - 1];
    if (!turn) throw new Error("model called more often than scripted");
    const message = turn(req);
    if (message instanceof Response) return message;
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", ...message } }] }));
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

const call = (id: string, name: string, args: unknown) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

function bridge(calls: string[][] = []): BrowserBridge {
  return {
    getHistory: async () => ({ sites: fixtureHistory(), totalSitesSeen: fixtureHistory().length }),
    getPageHtml: async ({ urls }) => {
      calls.push(urls);
      return {
        pages: urls.map((url) => ({
          url,
          title: "Example",
          html: `<div><h2>Headline one</h2><p><a href="/a">Story about Rust</a></p></div><p>Footer</p>`,
        })),
        failed: [],
      };
    },
  };
}

const lastToolResult = (req: any) => req.messages.at(-1).content as string;

test("runs tools over stored pages and returns the written file", async () => {
  let mountPath = "";
  const { fetchImpl, requests } = scripted([
    () => ({ content: null, tool_calls: [call("h", "getHistory", { maxResults: 3 })] }),
    () => ({ content: null, tool_calls: [call("p", "getPageHtml", { urls: ["https://example.com/", "http://localhost:3000/"] })] }),
    (req) => {
      const result = JSON.parse(lastToolResult(req));
      expect(result.failed).toEqual([{ url: "http://localhost:3000/", reason: "blocked by the user's settings" }]);
      mountPath = result.pages[0].mountPath;
      return { content: null, tool_calls: [call("g", "grep", { pattern: "rust" })] };
    },
    (req) => {
      expect(lastToolResult(req)).toContain(`${mountPath}:2:`);
      return { content: null, tool_calls: [call("r", "read", { path: mountPath, offset: 1, limit: 1 })] };
    },
    (req) => {
      expect(lastToolResult(req)).toContain("1\t<div><h2>Headline one</h2>");
      expect(lastToolResult(req)).toContain("continue with offset 2");
      return { content: null, tool_calls: [call("w", "write", { path: OUTPUT_PATH, content: COMPONENT })] };
    },
    () => ({ content: "Built it." }),
  ]);
  const calls: string[][] = [];
  const result = await runLocalHomepageBuild({
    provider: "openrouter",
    apiKey: "sk-or-test",
    model: "test/model:free",
    bridge: bridge(calls),
    fetch: fetchImpl,
  });
  expect(result).toMatchObject({ edition: EDITION, source: "local-file" });
  // Blocked hosts never reach the browser.
  expect(calls).toEqual([["https://example.com/"]]);
  // Every tool call is answered with a matching id before the next request.
  expect(requests[1].messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "h" });
});

test("nudges once when the model answers without writing, then accepts JSON pasted in the reply", async () => {
  const { fetchImpl, requests } = scripted([
    () => ({ content: "Here is the plan." }),
    (req) => {
      expect(req.messages.at(-1).content).toContain("You have not written the edition yet");
      return { content: "```json\n" + COMPONENT + "\n```" };
    },
  ]);
  const result = await runLocalHomepageBuild({ provider: "gemini", apiKey: "k", model: "m", bridge: bridge(), fetch: fetchImpl });
  expect(result.source).toBe("message-fence");
  expect(requests).toHaveLength(2);
});

test("tool errors go back to the model instead of ending the build", async () => {
  const { fetchImpl } = scripted([
    () => ({ content: null, tool_calls: [{ id: "", type: "function", function: { name: "read", arguments: "{bad" } }] }),
    (req) => {
      expect(req.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call_0_0" });
      expect(lastToolResult(req)).toStartWith("Error: arguments are not valid JSON");
      return { content: null, tool_calls: [call("w", "write", { path: OUTPUT_PATH, content: COMPONENT })] };
    },
    () => ({ content: "Done." }),
  ]);
  const result = await runLocalHomepageBuild({ provider: "gemini", apiKey: "k", model: "m", bridge: bridge(), fetch: fetchImpl });
  expect(result.edition).toEqual(EDITION);
});

test("surfaces a bad key without retrying", async () => {
  const { fetchImpl, requests } = scripted([
    () => new Response(JSON.stringify({ error: { message: "invalid key" } }), { status: 401 }),
  ]);
  await expect(
    runLocalHomepageBuild({ provider: "openrouter", apiKey: "k", model: "m", bridge: bridge(), fetch: fetchImpl }),
  ).rejects.toThrow(/invalid key.*Check the API key/);
  expect(requests).toHaveLength(1);
});

test("OpenRouter free models fall back to the free router, and upstream errors show their cause", async () => {
  const { fetchImpl, requests } = scripted([
    () =>
      new Response(
        JSON.stringify({
          error: {
            message: "Provider returned error",
            code: 400,
            metadata: { provider_name: "Google AI Studio", raw: JSON.stringify({ error: { message: "model is overloaded" } }) },
          },
        }),
        { status: 400 },
      ),
  ]);
  await expect(
    runLocalHomepageBuild({ provider: "openrouter", apiKey: "k", model: "google/gemma-4-31b-it:free", bridge: bridge(), fetch: fetchImpl }),
  ).rejects.toThrow("Provider returned error (Google AI Studio): model is overloaded");
  expect(requests[0].models).toEqual(["google/gemma-4-31b-it:free", "openrouter/free"]);
  expect(requests[0].model).toBeUndefined();
});

test("a spent daily limit fails at once instead of retrying", async () => {
  const { fetchImpl, requests } = scripted([
    () => new Response(JSON.stringify({ error: { message: "Rate limit exceeded: free-models-per-day", code: 429 } }), { status: 429 }),
  ]);
  await expect(
    runLocalHomepageBuild({ provider: "openrouter", apiKey: "k", model: "openrouter/free", bridge: bridge(), fetch: fetchImpl }),
  ).rejects.toThrow(/free-models-per-day.*another model or provider/);
  expect(requests).toHaveLength(1);
  expect(requests[0].model).toBe("openrouter/free");
});

test("an invalid edition goes back to the model to fix", async () => {
  const { fetchImpl } = scripted([
    () => ({ content: null, tool_calls: [call("w1", "write", { path: OUTPUT_PATH, content: JSON.stringify({ lead: { title: "No link" } }) })] }),
    (req) => {
      expect(lastToolResult(req)).toStartWith("Error: The edition has no usable stories");
      // Passing the object itself, not a string, is accepted too.
      return { content: null, tool_calls: [call("w2", "write", { path: OUTPUT_PATH, content: { ...EDITION, lead: { ...EDITION.lead, url: "javascript:alert(1)" } } })] };
    },
    (req) => {
      // The unsafe lead is dropped and the next story promoted.
      expect(lastToolResult(req)).toStartWith("Saved the edition: 2 stories");
      return { content: "Done." };
    },
  ]);
  const result = await runLocalHomepageBuild({ provider: "gemini", apiKey: "k", model: "m", bridge: bridge(), fetch: fetchImpl });
  expect(result.edition.lead.url).toBe("https://example.com/b");
  expect(result.edition.topStories).toEqual([]);
});
