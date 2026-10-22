/**
 * The two browser-backed tools, shared by every provider. Blocking is enforced
 * here, not in the prompt, so it holds whichever model is asking.
 */
import { buildHistoryDigest } from "./history-digest";
import { DEFAULTS } from "./schemas";
import { isAllowedUrl, isBlocked, isPrivateAddress } from "./site-filter";
import type { BrowserBridge, GetHistoryResult, GetPageHtmlResult, RunPhase, ScrapedPage } from "./types";

/** Callbacks with the optionality resolved, so call sites don't repeat `?.`. */
export interface Emit {
  phase(phase: RunPhase, detail?: string): void;
  text(chunk: string): void;
  log(line: string): void;
}

export async function runGetHistory(
  input: { daysToAnalyze?: number; maxResults?: number },
  bridge: BrowserBridge,
  emit: Emit,
  blockedSites: string[],
): Promise<GetHistoryResult> {
  const daysToAnalyze = input.daysToAnalyze ?? DEFAULTS.daysToAnalyze;
  const maxResults = input.maxResults ?? DEFAULTS.maxResults;

  emit.phase("history", `${daysToAnalyze}d`);
  const { sites, totalSitesSeen } = await bridge.getHistory({ daysToAnalyze, maxResults });
  const allowed = sites.filter((site) => !isBlocked(site.domain, blockedSites));
  // Blocked domains are dropped from the count too: the model is never told they exist.
  const digest = buildHistoryDigest(allowed, {
    daysToAnalyze,
    maxResults,
    totalSitesSeen: totalSitesSeen - (sites.length - allowed.length),
  });
  emit.log(`history: ${digest.sites.length} of ${digest.totalSitesSeen} domains`);
  return digest;
}

/**
 * Load the allowed URLs in the browser and drop anything that ended up somewhere
 * it shouldn't have. What comes back is safe to hand to the model.
 */
export async function loadAllowedPages(
  input: { urls: string[]; loadDelayMs?: number },
  bridge: BrowserBridge,
  emit: Emit,
  blockedSites: string[],
): Promise<{ pages: ScrapedPage[]; blocked: GetPageHtmlResult["failed"]; failed: GetPageHtmlResult["failed"] }> {
  emit.phase("scraping", `${input.urls.length} pages`);

  const allowed: string[] = [];
  const blocked: GetPageHtmlResult["failed"] = [];
  for (const url of input.urls) {
    // Match on the URL the browser will load; malformed URLs never reach the signed-in browser.
    if (isAllowedUrl(url, blockedSites)) allowed.push(url);
    else blocked.push({ url, reason: "blocked by the user's settings" });
  }

  // Skip the bridge entirely when nothing is left, so no scraper window opens.
  const { pages: loaded, failed } = allowed.length
    ? await bridge.getPageHtml({
        urls: allowed,
        loadDelayMs: input.loadDelayMs ?? DEFAULTS.loadDelayMs,
      })
    : { pages: [], failed: [] };

  // A redirect can land on a blocked host, and a public-looking name (fritz.box, an
  // intranet name) can resolve to a private address; drop what it read before anything is uploaded.
  const pages = loaded.filter((page) => {
    const urlAllowed = !page.finalUrl || isAllowedUrl(page.finalUrl, blockedSites);
    if (urlAllowed && !(page.ip && isPrivateAddress(page.ip))) return true;
    blocked.push({ url: page.url, reason: "blocked by the user's settings" });
    return false;
  });
  if (blocked.length) emit.log(`blocked: ${blocked.length} url(s)`);

  return { pages, blocked, failed };
}
