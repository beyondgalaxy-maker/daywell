# Daywell

A quiet task list that sorts your day. Type what you need to do; Daywell (and Claude, if you add a key) figures out when it should happen, how long it takes, and what deserves your attention today.

**Open it:** https://beyondgalaxy-maker.github.io/daywell/

It's a static site with no server and no account. Tasks live in your browser. Optional Google sync keeps your phone and laptop in step.

## Using it

- **Today** (left) is what you're doing today, in order. **Everything else** (right) holds upcoming, undated, once-a-week, and repeating tasks.
- **Enter** adds a task. Daywell reads details at the end of what you type:

  | You type | It understands |
  | --- | --- |
  | `call mom tomorrow 3pm 15m` | date, time, takes 15 minutes |
  | `essay due friday p2` | deadline Friday, priority 2 (High) |
  | `piano every day 30-60m` | repeats daily, takes 30–60 minutes |
  | `laundry every sunday` / `gym mon, wed and fri` | fixed weekdays |
  | `call grandma weekly` | once a week, any day |
  | `cut nails every 2 weeks` | 14 days after you last did it |
  | `pay rent every 1st` | monthly |
  | `#school`, `optional` | area, nice-to-have |

  Paste several lines and Enter adds one task per line.
- **Ctrl/⌘ + Enter** (or the **Ask** button) sends what you typed to Claude. It splits brain dumps into tasks, estimates times for clear ones ("cut nails" is 10 minutes), asks quick tap-to-answer questions about unclear ones, and can edit, complete, or delete tasks when you ask ("move laundry to Saturday", "I finished piano"). You can also ask questions ("I have 30 minutes, what should I do?"). Every change is one Undo.
- **Plan my day** (automatic each morning if you like) has Claude reorder today, pull in what matters (deadlines, high priority, things you've neglected), move low-value items off an overloaded day, re-rank your Anytime list by importance, and write a short brief. It never changes your priorities or deadlines.
- **Worth doing today** suggests tasks that are due soon, waiting a long time, or overdue repeats, even without Claude.
- Drag tasks to reorder Today or pull them in from Everything else. Alt + ↑/↓ reorders with the keyboard.
- The bar under the date is your day: events, what's already passed, and how your task time fits into the free time left.
- **Calendar** shows any month and any day's plan, history, and events. **History** shows streaks, a six-month heatmap, everything you finished, and recently deleted tasks.
- Start a timer on any task; Daywell remembers how long things really took and Claude uses that to correct its estimates.

## Connect Claude

Settings → Claude → paste your Anthropic API key. Defaults: model `claude-sonnet-5-5`, effort Medium. The key is stored only in your browser and sent only to `api.anthropic.com`. Medium effort can take 10–30 seconds for long lists; Low answers in about 5.

## Google Calendar and sync (optional, free)

Daywell talks to a small Google Apps Script that runs in your own Google account. It reads your calendars and stores a compressed copy of your tasks so all your devices stay in sync.

1. Settings → Google Calendar and sync → **Copy script**. It holds no keys: the first Daywell that connects registers its own private key with it.
2. Go to [script.google.com](https://script.google.com/home/projects/create), replace the sample code, and Save.
3. **Deploy → New deployment → Web app**. Set *Execute as: Me* and *Who has access: Anyone*, then Deploy.
4. Allow access. If Google says the app isn't verified, choose *Advanced → Go to … (unsafe)*. It's your own script.
5. Paste the Web app URL (ends in `/exec`) into Daywell and press **Connect**.

On your other devices, use **Copy setup link** in Settings and open it there.

The script source is in [`apps-script/Code.gs`](apps-script/Code.gs).

## Privacy

- No Daywell server exists. The site is static files on GitHub Pages.
- Tasks are stored in your browser's local storage and, if you connect Google, in your own Apps Script's storage.
- Your Claude key never leaves your device except in requests to Anthropic. Setup links contain your keys, so only send them to yourself.
- Settings → Your data lets you download a backup or restore one.

## Development

Plain HTML, CSS, and JavaScript modules. No build step.

```sh
python3 -m http.server 8000   # then open http://localhost:8000
node --test tests/*.test.mjs  # engine tests
```

| File | What it does |
| --- | --- |
| `js/engine.js` | Dates, repeats, what shows on which day, scoring, quick-add parsing, sync merge |
| `js/store.js` | Saved state, item-level undo/redo, task changes |
| `js/ai.js` | Claude prompts, structured-output schemas, API calls |
| `js/google.js` | Apps Script client, calendar events, sync |
| `js/app.js` | Interface and interactions |
| `apps-script/Code.gs` | The Google side of calendar + sync |
| `sw.js` | Offline support |
