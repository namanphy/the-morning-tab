/**
 * Proves the agent's deliverable is a usable edition, not merely JSON-shaped:
 * it validates through parseEdition (as the extension does), carries real
 * scraped links, and renders in the extension's own newspaper layout.
 *
 * Run: pnpm agent:verify [path]   (default: the last pnpm agent:run output)
 */
import { readFileSync } from "node:fs";
import React from "react";
import { renderToString } from "react-dom/server";
import { parseEdition, type Edition } from "@homepage/agent-core";
import { Newspaper } from "../apps/extension/entrypoints/newtab/components/Newspaper";
import { OUT_PATH } from "./node-bridge";

const path = process.argv[2] ?? OUT_PATH;

function fail(msg: string): never {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

// ---- 1. validate ----------------------------------------------------------
let edition: Edition;
try {
  edition = parseEdition(readFileSync(path, "utf-8"));
} catch (err) {
  fail(`${path} is not a usable edition: ${err}`);
}
const stories = [edition.lead, ...edition.topStories, ...edition.sections.flatMap((s) => s.stories)];
console.log(`✅ valid edition: ${stories.length} stories, ${edition.sections.length} sections, ${edition.briefs.length} briefs`);

// ---- 2. real, linkable content -------------------------------------------
const links = new Set([...stories, ...edition.briefs].map((s) => s.url));
if (links.size < 5) fail(`only ${links.size} distinct links — expected real scraped URLs`);
console.log(`✅ ${links.size} distinct links`);

const placeholders = [...links].filter((h) => /example\.com|placeholder/.test(h));
if (placeholders.length) fail(`placeholder links present: ${placeholders.slice(0, 3).join(", ")}`);
console.log(`✅ no placeholder links`);

if (!edition.lead.summary) fail("the lead story has no summary");
console.log(`✅ lead: ${edition.lead.title}`);

// ---- 3. renders in the extension's layout ---------------------------------
let html: string;
try {
  html = renderToString(React.createElement(Newspaper, { edition, builtAt: new Date().toISOString() }));
} catch (err) {
  fail(`layout threw while rendering: ${err}`);
}
const rendered = [...html.matchAll(/href="(https?:\/\/[^"]+)"/g)].length;
if (rendered < links.size) fail(`rendered ${rendered} links, expected at least ${links.size}`);
console.log(`✅ renders to ${html.length} bytes of HTML with ${rendered} links`);
