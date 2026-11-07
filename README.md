# COMBO-X autopilot (paper trading)

Runs by itself on GitHub every 30 minutes. No server, no API keys, no browser needed.
It scans Binance public data, runs the paper account, and saves everything in this repo (`docs/data/`).
A web page (GitHub Pages) shows the results. Paper trading only: it never places real orders.

## Set up (about 10 minutes, once)
1. On github.com click **New repository**. Name it `combo-x`, choose **Public**, click Create.
2. Click **uploading an existing file** and drag in everything from this folder (`.github`, `docs`, `scanner`, `config.json`, `README.md`), then **Commit changes**.
   - If the hidden `.github` folder does not upload: click **Add file > Create new file**, type `.github/workflows/scan.yml` as the name and paste the content of that file from this folder.
3. **Settings > Pages**: Source = *Deploy from a branch*, Branch = `main`, folder = `/docs`, Save. Your page address appears there after a minute or two.
4. **Actions** tab: if GitHub asks, click *I understand my workflows, enable them*. Open **COMBO-X scan** and click **Run workflow**. The first run starts your paper account and takes 1-3 minutes.
5. Open your Pages address. Bookmark it. That is all: it updates by itself.

## Settings
Edit `config.json` on GitHub (pencil icon): `risk` (0.005 = 0.5% per trade), `startEquity`, `cost` (round trip, 0.008 = 0.8%).
The next scan recomputes the whole paper account with the new values. To restart the account from today, delete the `startMs` line.

## Optional phone alerts (Telegram)
Create a bot with @BotFather, send it a message, find your chat id, then in the repo **Settings > Secrets and variables > Actions** add
`TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`. New paper signals are sent to you.

## Things to know
- GitHub may pause scheduled jobs after 60 days with no human activity in the repo. If the page says the data is old, open the Actions tab and re-enable the workflow.
- GitHub servers are in the US, where Binance blocks its futures API. The scanner then uses Binance's public data archive to know which coins have perpetual contracts and cannot include funding on shorts. The dashboard says so.
- Results are saved only when something changes or every 3 hours, so the repo history stays small. `docs/data/signal_log.csv` and `closed_trades.csv` are your database.
- The paper account fills at the exact candle open, which is optimistic. Judge it after 3 months and 50+ closed trades, not before.
