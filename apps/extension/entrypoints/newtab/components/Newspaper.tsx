import type { ReactNode } from "react";
import type { Brief, Edition, Story, Upcoming } from "@homepage/agent-core";

/**
 * The homepage. The layout is fixed and lives here; each build only supplies an
 * Edition (validated by parseEdition, so every link is a real http(s) URL and
 * every list is capped). With no edition yet, the same layout renders as a
 * placeholder.
 */
export function Newspaper({
  edition,
  builtAt,
  toolbar,
  children,
}: {
  edition: Edition | null;
  /** ISO timestamp of the build. */
  builtAt?: string;
  /** Controls shown in the masthead's top-right corner. */
  toolbar?: ReactNode;
  /** Overlaid on the placeholder, e.g. the first-build call to action. */
  children?: ReactNode;
}) {
  const date = builtAt ? new Date(builtAt) : new Date();

  return (
    <div className="paper">
      <div className="paper-sheet">
        <header className="mast">
          <div className="mast-top">
            <span>
              Vol. I · No. {dayOfYear(date)}
            </span>
            <span className="mast-top-mid">Your corner of the internet</span>
            <span className="mast-tools">{toolbar ?? "Price: one open tab"}</span>
          </div>
          <h1 className="mast-title">The Morning Tab</h1>
          <p className="mast-motto">“All the news that fits your history.”</p>
          <div className="mast-date">
            <span>{date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</span>
            <span>{editionName(date)}</span>
            <span className="mast-theme">{edition?.theme ? `Today: ${edition.theme}` : edition ? "" : "Awaiting the presses"}</span>
          </div>
        </header>

        {edition ? <FrontPage edition={edition} /> : <Placeholder />}

        <footer className="paper-foot">
          {edition
            ? `Built from your browsing history · Printed ${date.toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" })}`
            : "Built from your browsing history"}
        </footer>
      </div>
      {children && <div className="paper-overlay">{children}</div>}
    </div>
  );
}

function FrontPage({ edition }: { edition: Edition }) {
  const { lead, topStories, sections, briefs, upcoming } = edition;
  const hasRail = briefs.length > 0 || upcoming.length > 0;

  return (
    <>
      <main className={`front${hasRail ? "" : " front-norail"}`}>
        <article className="lead">
          {lead.kicker && <div className="kicker">{lead.kicker}</div>}
          <h2 className="lead-head">
            <a href={lead.url}>{lead.title}</a>
          </h2>
          {lead.image && <img className="lead-img" src={lead.image} alt="" loading="lazy" onError={hide} />}
          {lead.summary && <p className="lead-body">{lead.summary}</p>}
          <Byline story={lead} />
        </article>

        {topStories.length > 0 && (
          <div className="tops">
            {topStories.map((story, i) => (
              <article key={story.url} className={i === 0 ? "top top-first" : "top"}>
                {story.kicker && <div className="kicker">{story.kicker}</div>}
                <h3 className={i === 0 ? "top-head top-head-big" : "top-head"}>
                  <a href={story.url}>{story.title}</a>
                </h3>
                {story.summary && <p className="body">{story.summary}</p>}
                <Byline story={story} />
              </article>
            ))}
          </div>
        )}

        {hasRail && (
          <aside className="rail">
            {briefs.length > 0 && <BriefsBox briefs={briefs} />}
            {upcoming.length > 0 && <UpcomingBox upcoming={upcoming} />}
          </aside>
        )}
      </main>

      {sections.map((section) => (
        <section key={section.title} className="desk">
          <h2 className="desk-title">
            <span>{section.title}</span>
          </h2>
          <div className="desk-grid">
            {section.stories.map((story) => (
              <article key={story.url} className="desk-story">
                {story.kicker && <div className="kicker">{story.kicker}</div>}
                <h3 className="desk-head">
                  <a href={story.url}>{story.title}</a>
                </h3>
                {story.summary && <p className="body body-small">{story.summary}</p>}
                <Byline story={story} />
              </article>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

function Byline({ story }: { story: Story }) {
  return (
    <div className="byline">
      Via {story.source}
      {story.meta ? ` · ${story.meta}` : ""}
    </div>
  );
}

function BriefsBox({ briefs }: { briefs: Brief[] }) {
  return (
    <div className="box">
      <div className="box-title">In Brief</div>
      <ul className="box-list">
        {briefs.map((brief) => (
          <li key={brief.url}>
            <a href={brief.url}>{brief.title}</a>
            <span className="box-aside">{brief.source}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function UpcomingBox({ upcoming }: { upcoming: Upcoming[] }) {
  return (
    <div className="box">
      <div className="box-title">On the Calendar</div>
      <ul className="box-list box-list-row">
        {upcoming.map((item) => (
          <li key={`${item.label}-${item.when}`}>
            {item.url ? <a href={item.url}>{item.label}</a> : <span>{item.label}</span>}
            <span className="box-when">{item.when}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The same front page with grey bars where the stories go. */
function Placeholder() {
  const bars = (widths: number[], cls = "ph") => widths.map((w, i) => <div key={i} className={cls} style={{ width: `${w}%` }} />);
  return (
    <div aria-hidden="true">
      <main className="front">
        <div className="lead">
          {bars([22], "ph ph-kicker")}
          {bars([95, 88, 70], "ph ph-head")}
          <div style={{ height: 18 }} />
          {bars([100, 97, 99, 94, 98, 60])}
        </div>
        <div className="tops">
          {[0, 1, 2].map((i) => (
            <div key={i} className={i === 0 ? "top top-first" : "top"}>
              {bars([30], "ph ph-kicker")}
              {bars(i === 0 ? [92, 80, 55] : [85, 50], "ph ph-subhead")}
              {bars([100, 96, 70])}
            </div>
          ))}
        </div>
        <aside className="rail">
          {[0, 1].map((box) => (
            <div key={box} className="box">
              {bars([45], "ph ph-kicker")}
              <div style={{ height: 10 }} />
              {bars([90, 75, 85, 65])}
            </div>
          ))}
        </aside>
      </main>
      <section className="desk">
        {bars([18], "ph ph-kicker")}
        <div className="desk-grid">
          {[0, 1, 2].map((i) => (
            <div key={i} className="desk-story">
              {bars([88, 60], "ph ph-subhead")}
              {bars([100, 92, 50])}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function hide(e: { currentTarget: HTMLImageElement }) {
  e.currentTarget.style.display = "none";
}

function dayOfYear(date: Date): number {
  const start = new Date(date.getFullYear(), 0, 0);
  return Math.floor((date.getTime() - start.getTime()) / 86_400_000);
}

function editionName(date: Date): string {
  const hour = date.getHours();
  if (hour >= 5 && hour < 12) return "Morning Edition";
  if (hour >= 12 && hour < 17) return "Afternoon Edition";
  if (hour >= 17 && hour < 22) return "Evening Edition";
  return "Late Edition";
}
