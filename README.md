# The Morning Tab

**A Chrome new tab that reads the internet for you.**

An AI agent looks at what you've been browsing, opens the sites you actually
follow (signed in as you), and prints a fresh front page of what's new there.

![The Morning Tab, a newspaper-style new tab page](docs/preview.png)
<sub>Illustration. Your front page is built from your own browsing, so its stories will differ.</sub>

- **Fixed newspaper layout.** A lead story, top stories, sections, briefs and dates to
  watch. The AI only picks and summarizes the stories; it never changes the design.
- **Bring your own model.** Works with **Anthropic (Claude)**, **Google Gemini** (free
  tier) or **OpenRouter** (free models).
- **No server.** Everything runs in your browser and talks straight to the model provider.

## Install (2 minutes)

1. **Download** `the-morning-tab-chrome.zip` from the
   [latest release](../../releases/latest).
2. **Unzip** it. You get a folder named `the-morning-tab-chrome`.
3. Open **`chrome://extensions`** in Chrome (Edge, Brave and Arc work too).
4. Turn on **Developer mode** (top-right switch).
5. Click **Load unpacked** and select the unzipped folder.
6. Open a new tab. If Chrome asks whether to keep the new-tab page, choose **Keep it**.

> Keep the unzipped folder somewhere permanent. Chrome loads the extension from it,
> so deleting or moving the folder removes the extension.

## First run

1. Pick a provider and paste an API key:

   | Provider | Get a key | Cost |
   | --- | --- | --- |
   | Google Gemini | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | Free tier available |
   | OpenRouter | [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) | Free models (about 2 builds a day) |
   | Anthropic | [console.anthropic.com](https://console.anthropic.com) | Paid, best results |

2. Click **Print today's edition** and watch it work. The first build takes a few minutes.
   You can close the tab while it runs.

After that, it rebuilds once each morning on its own (you can turn this off).

## Settings

Click **Settings** in the top-right corner of the page.

- **Provider, key and model:** switch at any time. If a free model hits its limit,
  pick another model or provider here.
- **Instructions:** steer what goes on the page, e.g. *"Lead with AI research"* or
  *"Skip sports and politics."*
- **Sites the agent never reads:** one host per line. Webmail, banking and sign-in
  pages are blocked by default, as are local-network addresses.
- **Rebuild automatically each morning:** on by default.

## Privacy

To build your page, the extension sends a summary of your browsing history (top
domains, visit counts, a few page titles) and the cleaned-up text of up to 8 pages
to the provider you chose, using your own key. Those pages load in your signed-in
browser, so they can include private content.

- **Anthropic:** the session and uploaded pages are deleted after each build.
- **Gemini free tier and OpenRouter free models:** what you send may be logged or used
  for training.

Your keys stay in the extension's local storage on your machine. Anyone with access
to your browser profile can read them, so don't install this on a shared computer.

## Build from source

You need [Node.js](https://nodejs.org) 20+.

```bash
git clone <this repo's URL>
cd ai-newtab
npx pnpm@10.11.1 install
npx pnpm@10.11.1 build
```

Then load `apps/extension/.output/chrome-mv3` with **Load unpacked** as above.
`npx pnpm@10.11.1 zip` builds the same zip that's attached to each release.

For how it works inside, see [ARCHITECTURE.md](./ARCHITECTURE.md).

## Credits and license

Based on [ThariqS/ai-newtab](https://github.com/ThariqS/ai-newtab). MIT licensed:
see [LICENSE](./LICENSE).
