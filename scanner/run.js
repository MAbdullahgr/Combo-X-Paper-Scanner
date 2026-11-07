'use strict';
/* COMBO-X autopilot: runs on GitHub Actions every 30 min. Fetches Binance public data, runs the paper-trading replay,
   writes docs/data/state.json (+ CSVs). No API keys. Paper trading only. */
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const C = require('./core.js');
const { DAY, H12, DEFAULTS } = C;
const ROOT = path.join(__dirname, '..'), DATA = path.join(ROOT, 'docs', 'data'), CFG_PATH = path.join(ROOT, 'config.json');
const API = 'https://data-api.binance.vision', FAPI = 'https://fapi.binance.com';
const S3 = 'https://s3-ap-northeast-1.amazonaws.com/data.binance.vision', VIS = 'https://data.binance.vision';
const STABLE = new Set(['USDC','TUSD','BUSD','USDP','USDS','FDUSD','DAI','AEUR','EUR','EURI','UST','PAX','SUSD','GBP','AUD','TRY','BRL','RUB','UAH','NGN','ZAR','IDR','PLN','RON','ARS','JPY','CZK','MXN','COP','WBTC','PAXG','XAUT','USD1','PYUSD','RLUSD','XUSD','BFUSD','VAI','BIDR','IDRT','BVND']);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function jget(url, tries = 4) {
  for (let t = 0; t < tries; t++) {
    try {
      const r = await fetch(url);
      if (r.status === 429 || r.status === 418) { await sleep(3000 * (t + 1)); continue; }
      if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
      return await r.json();
    } catch (e) { if (e.status === 451 || e.status === 403 || t === tries - 1) throw e; await sleep(700 * (t + 1)); }
  }
}
async function pool(items, limit, fn) {
  let i = 0; const out = new Array(items.length);
  await Promise.all(Array.from({ length: limit }, async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch (e) { out[k] = null; } } }));
  return out;
}
function toBars(rows) {
  const n = rows.length, b = { t: new Array(n), o: new Float64Array(n), h: new Float64Array(n), l: new Float64Array(n), c: new Float64Array(n), v: new Float64Array(n), q: new Float64Array(n) };
  for (let i = 0; i < n; i++) { const r = rows[i]; b.t[i] = r[0]; b.o[i] = +r[1]; b.h[i] = +r[2]; b.l[i] = +r[3]; b.c[i] = +r[4]; b.v[i] = +r[5]; b.q[i] = +r[7]; }
  return b;
}
const klines = (s, tf, n) => jget(`${API}/api/v3/klines?symbol=${s}&interval=${tf}&limit=${n}`).then(toBars);
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

/* ---- which coins have a Binance USDT perpetual right now ---- */
async function loadPerps(candidates) {
  try {
    const ex = await jget(`${FAPI}/fapi/v1/exchangeInfo`, 2);
    return { set: new Set(ex.symbols.filter(x => x.contractType === 'PERPETUAL' && x.status === 'TRADING' && x.quoteAsset === 'USDT').map(x => x.symbol)), mode: 'futures API' };
  } catch (e) { log('futures API unavailable (' + (e.status || e.message) + '), using the public data archive instead'); }
  // fallback: public archive listing + "has a daily file from the last two days"
  const all = new Set(); let marker = null;
  for (let g = 0; g < 20; g++) {
    const u = `${S3}?prefix=data/futures/um/daily/klines/&delimiter=/` + (marker ? `&marker=${encodeURIComponent(marker)}` : '');
    const r = await fetch(u); if (!r.ok) throw new Error('archive listing HTTP ' + r.status);
    const xml = await r.text();
    for (const m of xml.matchAll(/<Prefix>data\/futures\/um\/daily\/klines\/([A-Z0-9_]+)\/<\/Prefix>/g)) all.add(m[1]);
    if (/<IsTruncated>true<\/IsTruncated>/.test(xml)) { const nm = /<NextMarker>([^<]+)<\/NextMarker>/.exec(xml); marker = nm ? nm[1] : null; if (!marker) break; } else break;
  }
  const out = new Set(), d1 = ymd(Date.now() - DAY), d2 = ymd(Date.now() - 2 * DAY), d3 = ymd(Date.now() - 3 * DAY);
  await pool(candidates, 8, async (s) => {
    const b = s.slice(0, -4);
    for (const ps of [s, '1000' + b + 'USDT']) {
      if (!all.has(ps)) continue;
      for (const d of [d1, d2, d3]) {
        const r = await fetch(`${VIS}/data/futures/um/daily/klines/${ps}/1d/${ps}-1d-${d}.zip`, { method: 'HEAD' });
        if (r.ok) { out.add(ps); return; }
      }
    }
  });
  return { set: out, mode: 'data archive (futures API blocked here)' };
}

function cleanPos(p) {
  const o = {}; for (const k of ['strat', 'sym', 'side', 'tf', 'sigMs', 'entryMs', 'qv', 'entry', 'stop', 'tp', 'riskPct', 'N', 'riskAmt', 'status', 'exit', 'exitMs', 'outcome', 'pnl', 'R', 'fund', 'last', 'unreal']) if (p[k] !== undefined) o[k] = Number.isFinite(p[k]) || typeof p[k] !== 'number' ? p[k] : null;
  return o;
}

async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  let user = {}; try { user = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); } catch (e) {}
  const cfg = Object.assign({}, DEFAULTS, user);
  let cfgChanged = false;
  if (!cfg.startMs) { cfg.startMs = Date.now(); user.startMs = cfg.startMs; cfgChanged = true; log('paper account starts now:', new Date(cfg.startMs).toISOString()); }
  if (cfgChanged || !fs.existsSync(CFG_PATH)) fs.writeFileSync(CFG_PATH, JSON.stringify(Object.assign({ risk: cfg.risk, startEquity: cfg.startEquity, cost: cfg.cost }, user), null, 2) + '\n');

  log('loading tickers');
  const tick = await jget(`${API}/api/v3/ticker/24hr`);
  const live = {}, vol = {}; for (const t of tick) { live[t.symbol] = +t.lastPrice; vol[t.symbol] = +t.quoteVolume; }
  const syms = tick.map(t => t.symbol).filter(s => s.endsWith('USDT')).filter(s => {
    const b = s.slice(0, -4); if (STABLE.has(b) || b.endsWith('USD')) return false;
    for (const suf of ['UP', 'DOWN', 'BULL', 'BEAR']) if (b.endsWith(suf) && live[b.slice(0, -suf.length) + 'USDT'] !== undefined) return false;
    return vol[s] >= 1.5e6;
  });
  if (!syms.includes('BTCUSDT')) syms.push('BTCUSDT');
  log('BTC history');
  const btc = await klines('BTCUSDT', '1d', 1000);
  log(`daily candles for ${syms.length} coins`);
  const d1 = await pool(syms, 6, s => klines(s, '1d', 500));
  const coins = {};
  syms.forEach((s, k) => { const b = d1[k]; if (!b || b.c.length < cfg.warmDays + 10) return; const q = C.median(Array.from(b.q.slice(-31, -1))); if (q >= cfg.minVol) coins[s] = { d1: b, h12: null, perp: false, qv30: q }; });
  const shortCands = Object.keys(coins).filter(s => coins[s].qv30 >= cfg.shortMinVol);
  const perps = await loadPerps(shortCands);
  const pSym = (s) => perps.set.has(s) ? s : (perps.set.has('1000' + s.slice(0, -4) + 'USDT') ? '1000' + s.slice(0, -4) + 'USDT' : null);
  for (const s of shortCands) coins[s].perp = !!pSym(s);
  const tkSyms = shortCands.filter(s => coins[s].perp);
  log(`${Object.keys(coins).length} coins pass the volume filter; ${tkSyms.length} eligible for TK shorts (perps via ${perps.mode})`);
  const h12 = await pool(tkSyms, 6, s => klines(s, '12h', 1000));
  tkSyms.forEach((s, k) => { if (h12[k]) coins[s].h12 = h12[k]; });

  const now = Date.now(), data = { btc, coins, nowMs: now };
  const watchFrom = Math.min(cfg.startMs, now - 7 * DAY);
  const cands = C.buildCandidates(data, cfg, watchFrom);
  const before = cands.filter(c => c.entryMs < cfg.startMs), traded = cands.filter(c => c.entryMs >= cfg.startMs);
  let funding = {}, fundNote = 'funding on shorts not included (futures API not reachable from this server)';
  let res = C.replay(traded, data, cfg, cfg.startMs, now, live, funding);
  const shorts = [...new Set(res.open.concat(res.closed).filter(p => p.side === -1).map(p => p.sym))];
  if (shorts.length && perps.mode === 'futures API') {
    await pool(shorts, 4, async s => { const ps = pSym(s); if (!ps) return; const rows = await jget(`${FAPI}/fapi/v1/fundingRate?symbol=${ps}&startTime=${cfg.startMs - 8 * 3600e3}&limit=1000`); funding[s] = rows.map(r => [r.fundingTime, +r.fundingRate]); });
    if (Object.keys(funding).length) { res = C.replay(traded, data, cfg, cfg.startMs, now, live, funding); fundNote = 'real funding rates included for shorts'; }
  }
  for (const c of before) res.log.push({ strat: c.strat, sym: c.sym, side: c.side, tf: c.tf, sigMs: c.sigMs, entryMs: c.entryMs, qv: c.qv, status: 'BEFORE PAPER START (not traded)', entry: c.bars.o[c.i + 1] || null });
  res.log.sort((a, b) => b.entryMs - a.entryMs);

  // first-seen log (persistent)
  const seenPath = path.join(DATA, 'seen.json'); let seen = {}; try { seen = JSON.parse(fs.readFileSync(seenPath, 'utf8')); } catch (e) {}
  const fresh = [];
  for (const r of res.log) { const k = `${r.strat}|${r.sym}|${r.sigMs}`; if (!seen.keys) seen.keys = {}; if (!seen.keys[k]) { seen.keys[k] = now; if (now - r.entryMs < 6 * 3600e3 && String(r.status).startsWith('TAKEN')) fresh.push(r); } r.seen = seen.keys[k]; }
  const ks = Object.keys(seen.keys); if (ks.length > 4000) ks.sort((a, b) => seen.keys[a] - seen.keys[b]).slice(0, ks.length - 4000).forEach(k => delete seen.keys[k]);

  // BTC regime summary for the dashboard
  const n = btc.c.length, e200 = C.ema(btc.c, 200), hh = C.prevMax(btc.h, cfg.bbPeriod), lastC = (btc.t[n - 1] + DAY <= now) ? n - 1 : n - 2;
  const regime = { btcClose: btc.c[n - 1], ema200: e200[n - 1], above: btc.c[lastC] > e200[lastC], hh: hh[n - 1], breakout: btc.c[n - 1] > hh[n - 1], bbPeriod: cfg.bbPeriod };

  const closed = res.closed.map(cleanPos), open = res.open.map(cleanPos);
  const eq = res.equity.length ? res.equity[res.equity.length - 1].eq : cfg.startEquity;
  const state = { updatedMs: now, cfg: { startMs: cfg.startMs, startEquity: cfg.startEquity, risk: cfg.risk, maxGross: cfg.maxGross, maxPos: cfg.maxPos, cost: cfg.cost, minVol: cfg.minVol, shortMinVol: cfg.shortMinVol, bbPeriod: cfg.bbPeriod, bb: cfg.bb, tk: cfg.tk },
    regime, equityNow: eq, maxDD: res.maxDD, grossNow: res.grossNow, scanned: Object.keys(coins).length, tkEligible: tkSyms.length, perpMode: perps.mode, fundNote,
    open, closed: closed.slice(-400), closedCount: closed.length, equity: res.equity.map(e => ({ t: e.t, eq: Math.round(e.eq * 100) / 100 })), log: res.log.slice(0, 400).map(cleanPos).map((x, i) => Object.assign(x, { seen: res.log[i].seen })) };
  // commit policy: only when something changed, or every 3 hours
  const fp = crypto.createHash('md5').update(JSON.stringify([open.map(p => p.sym + p.entryMs), closed.length, res.log.filter(x => String(x.status).startsWith('TAKEN')).length])).digest('hex');
  const lastCommit = seen.lastCommitMs || 0, changed = fp !== seen.fp, stale = now - lastCommit > 3 * 3600e3;
  const write = changed || stale || !fs.existsSync(path.join(DATA, 'state.json'));
  if (write) {
    fs.writeFileSync(path.join(DATA, 'state.json'), JSON.stringify(state));
    fs.writeFileSync(path.join(DATA, 'closed_trades.csv'), 'exit_utc,strategy,coin,side,entry,exit,outcome,notional,pnl,R,funding\n' + closed.map(p => [new Date(p.exitMs).toISOString(), p.strat, p.sym, p.side === 1 ? 'long' : 'short', p.entry, p.exit, p.outcome, p.N.toFixed(2), p.pnl.toFixed(2), (+p.R).toFixed(3), (p.fund || 0).toFixed(2)].join(',')).join('\n') + '\n');
    fs.writeFileSync(path.join(DATA, 'signal_log.csv'), 'first_seen_utc,entry_candle_utc,strategy,coin,side,status\n' + res.log.map(x => [new Date(x.seen).toISOString(), new Date(x.entryMs).toISOString(), x.strat, x.sym, x.side === 1 ? 'long' : 'short', '"' + x.status + '"'].join(',')).join('\n') + '\n');
    seen.fp = fp; seen.lastCommitMs = now;
  }
  fs.writeFileSync(seenPath, JSON.stringify(seen));
  log(`equity $${eq.toFixed(0)}, ${open.length} open, ${closed.length} closed, ${fresh.length} fresh signals, state ${write ? 'written' : 'unchanged (skipped)'}`);

  // optional Telegram alert (set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID as repository secrets)
  const tok = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (tok && chat && fresh.length) {
    const txt = fresh.slice(0, 6).map(r => `${r.side === 1 ? 'LONG' : 'SHORT'} ${r.sym}  (${r.strat})\nentry ${r.entry}  stop ${r.stop}  target ${r.tp}\nnotional $${Math.round(r.N)}  risk $${Math.round(r.riskAmt)}`).join('\n\n');
    try { await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text: 'COMBO-X paper signals\n\n' + txt }) }); } catch (e) { log('telegram failed'); }
  }
}
main().catch(e => { console.error('FAILED:', e); process.exit(1); });
