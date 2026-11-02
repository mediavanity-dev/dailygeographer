# The Daily Geographer

A new country or territory every day at **https://dailygeographer.com**.

## Where things are

| What | Where |
|---|---|
| Code (local) | `C:\Users\media\Desktop\dans stuff\Development\DailyGeographer` |
| Code (GitHub) | https://github.com/mediavanity-dev/dailygeographer (public, account `mediavanity-dev`) |
| Hosting | GitHub Pages, deployed by GitHub Actions |
| Domain | `dailygeographer.com`, registered at GoDaddy (GoDaddy only provides DNS) |

## How it works

No server and no database. A scheduled GitHub Action runs `build.mjs`, which writes one JSON file per day, commits it, and deploys the `site/` folder to GitHub Pages. The page loads that day's JSON.

| File | Purpose |
|---|---|
| `site/index.html` | The whole page (HTML, CSS and JS in one file) |
| `site/data/YYYY-MM-DD.json` | One file per day, written by the build. Don't edit by hand |
| `build.mjs` | Picks the day's place and fetches facts, summary, history and news (Node, no dependencies) |
| `countries.json` | The rotation list: 243 places (ISO 3166-1 with a permanent population, plus Kosovo), each with a political status |
| `rotation.json` | Who has appeared this cycle, so each place appears once per cycle |
| `.github/workflows/update.yml` | Daily build and deploy |
| `.github/workflows/check-list.yml` | Weekly check; opens a GitHub issue if `countries.json` no longer matches its sources |

**Schedule (UTC):** 23:00 builds tomorrow's page. 00:15, 06:15, 12:15 and 18:15 refresh today's headlines. Every push to `main` redeploys. GitHub sometimes runs scheduled jobs late.

**Sources (all free, no API keys):**

- **Facts and flag:** Wikidata.
- **About and History:** Wikipedia. History is the lead of the "History of X" article, or the History section of the main article.
- **News:** GDELT for local and international lists, and Google News country editions for local headlines in the 70 places that have one.

## DNS (GoDaddy → DNS for dailygeographer.com)

| Type | Name | Value |
|---|---|---|
| A | @ | 185.199.108.153 |
| A | @ | 185.199.109.153 |
| A | @ | 185.199.110.153 |
| A | @ | 185.199.111.153 |
| CNAME | www | mediavanity-dev.github.io |

The custom domain and **Enforce HTTPS** are set in GitHub: repository → Settings → Pages. If the certificate ever gets stuck, remove the custom domain there, add it again, and save.

## Common tasks

- **Edit the page:** `git pull`, edit `site/index.html`, then `git add`, `git commit`, `git push`. It's live about a minute later. Preview locally with `npx serve site`.
- **Run a build by hand:** go to GitHub → Actions → "Update and deploy" → Run workflow. To run it locally instead: `node build.mjs`.
- **Weekly "Country list needs review" issue:** run `node build.mjs --refresh-countries`, check the diff, then commit. If a new place has no status, the refresh stops; add the status to `STATUS` in `build.mjs`.
- **Change wording of statuses or names:** edit `STATUS` and `NAMES` in `build.mjs`, then refresh the list as above.

## Known issues

- **GDELT local news is usually empty.** GDELT often rate-limits GitHub's servers (HTTP 429), and its local-outlet search hasn't returned results here. The page hides the empty list when Google News covers local headlines. Next step if revisited: test GDELT query forms in a one-off GitHub workflow, or drop GDELT's local list.
- **Editing on github.com:** commits made there can carry your personal email. In GitHub → Settings → Emails, turn on "Keep my email addresses private".
- **Node 20 warnings:** GitHub warns that `actions/checkout@v4` and `actions/setup-node@v4` target Node 20. They still run; bump the versions when newer ones are required.
