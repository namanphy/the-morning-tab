/**
 * The homepage is a fixed newspaper layout that lives in the extension. The
 * agent never writes UI: it writes one of these, and the layout fills itself in.
 *
 * Everything here is model output and therefore untrusted. `parseEdition` is the
 * only way in: it drops anything without a real http(s) link, trims every string,
 * and caps every list, so the layout can render whatever survives without checks.
 */

export interface Story {
  /** The headline, in the model's own words if the source's is poor. */
  title: string;
  /** Absolute http(s) URL taken from the scraped page. */
  url: string;
  /** Where it came from, e.g. "Hacker News", "GitHub Trending". */
  source: string;
  /** A short section label above the headline, e.g. "Security", "Open Source". */
  kicker?: string;
  /** One or two sentences: what it is and why it matters to this reader. */
  summary?: string;
  /** Small-caps facts, e.g. "906 points · 391 comments". */
  meta?: string;
  /** An image genuinely associated with the item. */
  image?: string;
}

export interface Brief {
  title: string;
  url: string;
  source: string;
}

export interface Upcoming {
  /** What is happening, e.g. "PHP security release". */
  label: string;
  /** When, as written for a reader, e.g. "Thu", "Oct 24", "Tonight". */
  when: string;
  url?: string;
}

export interface Section {
  /** e.g. "Machine Learning", "From GitHub". */
  title: string;
  stories: Story[];
}

export interface Edition {
  /** One line naming today's through-line, shown under the masthead. */
  theme: string;
  /** The single most important story. */
  lead: Story;
  /** The next 2–4 stories, beside the lead. */
  topStories: Story[];
  sections: Section[];
  /** Quick one-liners for the sidebar. */
  briefs: Brief[];
  /** Dates and events noticed in the pages. */
  upcoming: Upcoming[];
}

export const EDITION_LIMITS = {
  topStories: 4,
  sections: 6,
  storiesPerSection: 6,
  briefs: 8,
  upcoming: 6,
} as const;

/** The format, as the model is told it. Kept beside the type so they can't drift. */
export const EDITION_FORMAT = `{
  "theme": string,            // one line, <= 90 chars: today's through-line across everything you read
  "lead": Story,              // the single most important or most interesting story today
  "topStories": Story[],      // the next 2-4 stories, shown beside the lead
  "sections": [               // 2-${EDITION_LIMITS.sections} sections grouping the rest, named for what they hold
    { "title": string, "stories": Story[] }   // 2-${EDITION_LIMITS.storiesPerSection} stories each
  ],
  "briefs": Brief[],          // up to ${EDITION_LIMITS.briefs} quick one-liners worth a glance
  "upcoming": Upcoming[]      // up to ${EDITION_LIMITS.upcoming} dates/events you noticed; [] if none
}
Story    = { "title": string, "url": string, "source": string, "kicker"?: string,
             "summary"?: string, "meta"?: string, "image"?: string }
  title   - the headline (<= 120 chars). Rewrite it if the original is clickbait or cryptic.
  url     - absolute https URL copied from the scraped page. Never invented.
  source  - where it came from: "Hacker News", "r/MachineLearning", "GitHub Trending", a site name.
  kicker  - 1-3 word topic label, e.g. "Security", "Open Source", "Research".
  summary - 1-2 sentences (<= 280 chars): what it is and why this reader would care.
            Required for lead and topStories. Summarize; never copy page text verbatim.
  meta    - short facts from the page, e.g. "906 points · 391 comments", "+1,240 stars today".
  image   - absolute image URL only if genuinely tied to the item; otherwise omit.
Brief    = { "title": string, "url": string, "source": string }
Upcoming = { "label": string, "when": string, "url"?: string }   // when: "Thu", "Oct 24", "Tonight"

Every story appears once across lead, topStories and sections.`;

const MAX = { title: 160, source: 40, kicker: 30, summary: 400, meta: 80, theme: 120, label: 100, when: 30 };

function str(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/** Only real web links survive; javascript:, data: and relative URLs are dropped. */
function httpUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function story(raw: unknown): Story | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const title = str(r.title, MAX.title);
  const url = httpUrl(r.url);
  if (!title || !url) return undefined;
  const out: Story = { title, url, source: str(r.source, MAX.source) || new URL(url).hostname.replace(/^www\./, "") };
  const kicker = str(r.kicker, MAX.kicker);
  const summary = str(r.summary, MAX.summary);
  const meta = str(r.meta, MAX.meta);
  const image = httpUrl(r.image);
  if (kicker) out.kicker = kicker;
  if (summary) out.summary = summary;
  if (meta) out.meta = meta;
  if (image) out.image = image;
  return out;
}

function brief(raw: unknown): Brief | undefined {
  const s = story(raw);
  return s && { title: s.title, url: s.url, source: s.source };
}

function upcoming(raw: unknown): Upcoming | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const label = str(r.label ?? r.title, MAX.label);
  const when = str(r.when ?? r.date, MAX.when);
  if (!label || !when) return undefined;
  const url = httpUrl(r.url);
  return url ? { label, when, url } : { label, when };
}

function defined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

/**
 * Validate and normalize model output into an Edition. Accepts the JSON text or
 * an already-parsed value. Throws with a message written for the model, so the
 * local loop can hand it back as a tool error and have it fixed.
 */
export function parseEdition(input: unknown): Edition {
  let raw = input;
  if (typeof input === "string") {
    const text = input.trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new Error(`The edition is not valid JSON (${err instanceof Error ? err.message : String(err)}).`);
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("The edition must be a JSON object with lead, topStories, sections, briefs and upcoming.");
  }
  const r = raw as Record<string, unknown>;

  const seen = new Set<string>();
  const unique = (s: Story | undefined) => {
    if (!s || seen.has(s.url)) return undefined;
    seen.add(s.url);
    return s;
  };

  let lead = unique(story(r.lead));
  let topStories = asArray(r.topStories).map(story).map(unique).filter(defined);
  const sections = asArray(r.sections)
    .map((raw): Section | undefined => {
      if (!raw || typeof raw !== "object") return undefined;
      const s = raw as Record<string, unknown>;
      const stories = asArray(s.stories ?? s.items)
        .map(story)
        .map(unique)
        .filter(defined)
        .slice(0, EDITION_LIMITS.storiesPerSection);
      const title = str(s.title, MAX.kicker);
      return title && stories.length ? { title, stories } : undefined;
    })
    .filter(defined)
    .slice(0, EDITION_LIMITS.sections);

  // A missing or broken lead is promoted from what's there, rather than failing the build.
  if (!lead) lead = topStories.shift() ?? sections.find((s) => s.stories.length)?.stories.shift();
  if (!lead) {
    throw new Error(
      'The edition has no usable stories. Each story needs a "title" and an absolute https "url" from the scraped pages.',
    );
  }
  topStories = topStories.slice(0, EDITION_LIMITS.topStories);

  return {
    theme: str(r.theme, MAX.theme),
    lead,
    topStories,
    sections: sections.filter((s) => s.stories.length),
    briefs: asArray(r.briefs).map(brief).filter(defined).slice(0, EDITION_LIMITS.briefs),
    upcoming: asArray(r.upcoming).map(upcoming).filter(defined).slice(0, EDITION_LIMITS.upcoming),
  };
}

/** An edition the model pasted into its reply instead of writing it, if there is a usable one. */
export function editionFromMessage(message: string): Edition | undefined {
  const fenced = message.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  const candidates = [fenced?.[1], message.slice(message.indexOf("{"), message.lastIndexOf("}") + 1)];
  for (const candidate of candidates) {
    if (!candidate?.includes('"lead"')) continue;
    try {
      return parseEdition(candidate);
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}
