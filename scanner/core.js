'use strict';
/* ===== COMBO-X engine: BTC-breakout longs (1d) + Tenkan/Kijun-cross shorts (12h, perps >= $30M/day) =====
   Pure functions, no DOM. Rules ported 1:1 from the tested Python backtest. */
const DAY = 86400000, H12 = 43200000;
const DEFAULTS = {
  startEquity: 10000, risk: 0.005, maxGross: 1.0, maxPos: 0.25, cost: 0.008,
  minVol: 3e6, shortMinVol: 30e6, bbPeriod: 50, warmDays: 300,
  bb: { stopAtr: 4, tpR: 3, maxHold: 30 },   // 1d bars
  tk: { stopAtr: 3, tpR: 1, maxHold: 60 }    // 12h bars (= 30 days)
};

function ema(a, n) { const o = new Float64Array(a.length), al = 2 / (n + 1); o[0] = a[0]; for (let i = 1; i < a.length; i++) o[i] = al * a[i] + (1 - al) * o[i - 1]; return o; }
function trueRange(h, l, c) { const n = h.length, tr = new Float64Array(n); tr[0] = h[0] - l[0]; for (let i = 1; i < n; i++) tr[i] = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])); return tr; }
function atr(h, l, c, n = 14) { const tr = trueRange(h, l, c), o = new Float64Array(tr.length), al = 1 / n; o[0] = tr[0]; for (let i = 1; i < tr.length; i++) o[i] = al * tr[i] + (1 - al) * o[i - 1]; return o; }
function rollMax(a, n) { const o = new Float64Array(a.length).fill(NaN); for (let i = n - 1; i < a.length; i++) { let m = -Infinity; for (let k = i - n + 1; k <= i; k++) if (a[k] > m) m = a[k]; o[i] = m; } return o; }
function rollMin(a, n) { const o = new Float64Array(a.length).fill(NaN); for (let i = n - 1; i < a.length; i++) { let m = Infinity; for (let k = i - n + 1; k <= i; k++) if (a[k] < m) m = a[k]; o[i] = m; } return o; }
function shift(a, k) { const o = new Float64Array(a.length).fill(NaN); for (let i = k; i < a.length; i++) o[i] = a[i - k]; return o; }
function prevMax(a, n) { return shift(rollMax(a, n), 1); }
function ichimoku(h, l, c, t = 9, k = 26, s = 52) {
  const n = h.length, mx = (p) => rollMax(h, p), mn = (p) => rollMin(l, p);
  const mt = mx(t), nt = mn(t), mk = mx(k), nk = mn(k), ms = mx(s), ns = mn(s);
  const conv = new Float64Array(n), base = new Float64Array(n), rawB = new Float64Array(n), rawA = new Float64Array(n);
  for (let i = 0; i < n; i++) { conv[i] = (mt[i] + nt[i]) / 2; base[i] = (mk[i] + nk[i]) / 2; rawB[i] = (ms[i] + ns[i]) / 2; rawA[i] = (conv[i] + base[i]) / 2; }
  return { conv, base, sa: shift(rawA, k), sb: shift(rawB, k) };
}
function median(a) { const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : NaN; }

/* bars = {t:[open ms], o,h,l,c,v,q:[quote volume]} (typed arrays or arrays) */
function bbLongSignals(coin, btc, per) {
  const n = coin.c.length, e50 = ema(coin.c, 50), ownHH = prevMax(coin.h, per), btcHH = prevMax(btc.h, per);
  const idx = new Map(); for (let j = 0; j < btc.t.length; j++) idx.set(btc.t[j], j);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const j = idx.get(coin.t[i]); if (j === undefined) continue;
    if (!(btc.c[j] > btcHH[j])) continue;
    if (coin.c[i] <= ownHH[i] && coin.c[i] > e50[i]) out[i] = 1;
  }
  return out;
}
function tkShortSignals(b) {
  const { conv, base, sa, sb } = ichimoku(b.h, b.l, b.c), n = b.c.length, out = new Uint8Array(n);
  for (let i = 1; i < n; i++) {
    const bot = Math.min(sa[i], sb[i]);
    if (conv[i - 1] >= base[i - 1] && conv[i] < base[i] && b.c[i] < bot) out[i] = 1;
  }
  return out;
}
function btcRegimeLong(btc) { const e = ema(btc.c, 200), o = new Uint8Array(btc.c.length); for (let i = 300; i < o.length; i++) o[i] = btc.c[i] > e[i] ? 1 : 0; return o; }

/* Exit simulation for one signal at bar i. lastComplete = index of the last CLOSED bar (the final bar may still be forming).
   Stop/TP can trigger on the forming bar (those prices already happened); time exits only on closed bars. */
function simTrade(b, a, i, side, ex, lastComplete, tfMs) {
  const n = b.c.length, e = i + 1;
  if (e > n - 1) return { status: 'pending' };
  const risk = ex.stopAtr * a[i]; if (!(risk > 0)) return { status: 'invalid' };
  const entry = b.o[e];
  const stop = side === 1 ? entry - risk : entry + risk, tp = side === 1 ? entry + ex.tpR * risk : entry - ex.tpR * risk;
  const tExit = i + ex.maxHold, last = Math.min(tExit, n - 1);
  for (let k = e; k <= last; k++) {
    let slHit, tpHit;
    if (side === 1) { slHit = b.l[k] <= stop; tpHit = b.h[k] >= tp; } else { slHit = b.h[k] >= stop; tpHit = b.l[k] <= tp; }
    if (slHit) return { status: 'closed', outcome: 'stop', e, entry, stop, tp, risk, x: k, exit: side === 1 ? Math.min(stop, b.o[k]) : Math.max(stop, b.o[k]), exitBarOpen: b.t[k], exitMs: b.t[k] + tfMs };
    if (tpHit) return { status: 'closed', outcome: 'target', e, entry, stop, tp, risk, x: k, exit: side === 1 ? Math.max(tp, b.o[k]) : Math.min(tp, b.o[k]), exitBarOpen: b.t[k], exitMs: b.t[k] + tfMs };
  }
  if (tExit <= lastComplete) return { status: 'closed', outcome: 'time', e, entry, stop, tp, risk, x: tExit, exit: b.c[tExit], exitBarOpen: b.t[tExit], exitMs: b.t[tExit] + tfMs };
  return { status: 'open', e, entry, stop, tp, risk, lastIdx: n - 1 };
}

function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

/* qv30: median daily quote volume of the 30 completed days before time tMs */
function qv30At(d1, tMs) {
  // last daily bar whose close <= tMs
  let lo = 0, hi = d1.t.length - 1, k = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (d1.t[m] + DAY <= tMs) { k = m; lo = m + 1; } else hi = m - 1; }
  if (k < 19) return 0;
  const s = []; for (let q = Math.max(0, k - 29); q <= k; q++) s.push(d1.q[q]);
  return median(s);
}

/* data = { btc: bars1d, coins: { SYM: { d1: bars, h12: bars|null, perp: bool } } , nowMs }
   returns candidates (every signal since startMs) */
function buildCandidates(data, cfg, startMs) {
  const btc = data.btc, reg = btcRegimeLong(btc), btcIdx = new Map();
  for (let j = 0; j < btc.t.length; j++) btcIdx.set(btc.t[j], j);
  const cands = [], now = data.nowMs;
  for (const sym of Object.keys(data.coins)) {
    const co = data.coins[sym], d1 = co.d1, n1 = d1.c.length;
    if (n1 > cfg.warmDays + 5) {
      const sig = bbLongSignals(d1, btc, cfg.bbPeriod), a = atr(d1.h, d1.l, d1.c, 14);
      const lastC = (d1.t[n1 - 1] + DAY <= now) ? n1 - 1 : n1 - 2;
      for (let i = cfg.warmDays; i <= lastC; i++) {
        if (!sig[i]) continue;
        const entryMs = d1.t[i] + DAY; if (entryMs < startMs) continue;
        const j = btcIdx.get(d1.t[i]); if (j === undefined || j - 1 < 0 || !reg[j - 1]) continue;
        const qv = qv30At(d1, d1.t[i] + DAY); if (qv < cfg.minVol) continue;
        cands.push({ strat: 'BB50 long', sym, side: 1, tf: '1d', tfMs: DAY, bars: d1, atrArr: a, i, lastC, ex: cfg.bb, sigMs: d1.t[i], entryMs, qv });
      }
    }
    if (co.h12 && co.perp && co.h12.c.length > cfg.warmDays * 2 + 10) {
      const h = co.h12, n2 = h.c.length, sig = tkShortSignals(h), a = atr(h.h, h.l, h.c, 14);
      const lastC = (h.t[n2 - 1] + H12 <= now) ? n2 - 1 : n2 - 2;
      for (let i = cfg.warmDays * 2; i <= lastC; i++) {
        if (!sig[i]) continue;
        const entryMs = h.t[i] + H12; if (entryMs < startMs) continue;
        const qv = qv30At(d1, h.t[i] + H12); if (qv < cfg.shortMinVol) continue;
        cands.push({ strat: 'TK short', sym, side: -1, tf: '12h', tfMs: H12, bars: h, atrArr: a, i, lastC, ex: cfg.tk, sigMs: h.t[i], entryMs, qv });
      }
    }
  }
  cands.sort((x, y) => x.entryMs - y.entryMs || hashStr(x.sym + Math.floor(x.entryMs / DAY)) - hashStr(y.sym + Math.floor(y.entryMs / DAY)));
  return cands;
}

/* Paper-trading replay (deterministic): same sizing/cap/one-position-per-coin rules as the backtest portfolio.
   funding: optional { SYM: [[ms, rate], ...] } real perp funding for shorts. livePrice: { SYM: last price } */
function replay(cands, data, cfg, startMs, nowMs, livePrice, funding) {
  const startDay = Math.floor(startMs / DAY), today = Math.floor(nowMs / DAY);
  const byDay = new Map();
  for (const c of cands) { const d = Math.floor(c.entryMs / DAY); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(c); }
  const dailyClose = (sym, d) => {
    const co = data.coins[sym].d1, k = co.t.length - 1;
    // find bar with open day d
    let lo = 0, hi = k, r = -1; const tgt = d * DAY;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (co.t[m] <= tgt) { r = m; lo = m + 1; } else hi = m - 1; }
    if (r < 0) return NaN;
    if (d === today && livePrice && livePrice[sym]) return livePrice[sym];
    return co.c[r];
  };
  const fundSum = (sym, side, from, to) => {
    if (side !== -1 || !funding || !funding[sym]) return 0;
    let s = 0; for (const [t, r] of funding[sym]) if (t > from && t <= to) s += r; return s;
  };
  let cash = cfg.startEquity, eqPrev = cfg.startEquity;
  const open = [], closed = [], equity = [], log = [];
  const openCoins = new Set();
  let peak = cfg.startEquity, maxDD = 0, grossNow = 0;
  for (let d = startDay; d <= today; d++) {
    const list = byDay.get(d) || [];
    for (const c of list) {
      const rec = { strat: c.strat, sym: c.sym, side: c.side, tf: c.tf, sigMs: c.sigMs, entryMs: c.entryMs, qv: c.qv };
      const sim = simTrade(c.bars, c.atrArr, c.i, c.side, c.ex, c.lastC, c.tfMs);
      if (sim.status === 'pending' || sim.status === 'invalid') { rec.status = sim.status === 'pending' ? 'PENDING (next candle not open yet)' : 'INVALID'; log.push(rec); continue; }
      Object.assign(rec, { entry: sim.entry, stop: sim.stop, tp: sim.tp, riskPct: sim.risk / sim.entry });
      if (openCoins.has(c.sym)) { rec.status = 'SKIPPED: coin already in a position'; log.push(rec); continue; }
      let gross = 0; for (const p of open) gross += p.N;
      let N = Math.min(cfg.risk * eqPrev / rec.riskPct, cfg.maxPos * eqPrev);
      const room = cfg.maxGross * eqPrev - gross;
      if (eqPrev <= 0 || room < 0.25 * N) { rec.status = 'SKIPPED: exposure cap reached'; log.push(rec); continue; }
      N = Math.min(N, room); rec.N = N; rec.riskAmt = N * rec.riskPct;
      rec.status = 'TAKEN'; log.push(rec);
      const pos = Object.assign({}, rec, { sim, exitDay: sim.status === 'closed' ? Math.floor(sim.exitBarOpen / DAY) : Infinity });
      open.push(pos); openCoins.add(c.sym);
    }
    // exits
    for (let k = open.length - 1; k >= 0; k--) {
      const p = open[k];
      if (p.sim.status === 'closed' && p.exitDay <= d) {
        const gross = p.side * (p.sim.exit / p.entry - 1) - cfg.cost;
        const fund = p.N * fundSum(p.sym, p.side, p.entryMs, p.sim.exitMs);
        p.pnl = p.N * gross + fund; p.fund = fund; p.exitMs = p.sim.exitMs; p.exit = p.sim.exit; p.outcome = p.sim.outcome;
        p.R = p.riskAmt ? p.pnl / p.riskAmt : NaN;
        cash += p.pnl; closed.push(p); open.splice(k, 1); openCoins.delete(p.sym);
      }
    }
    // mark to market
    let unreal = 0, g = 0, fundOpen = 0;
    for (const p of open) {
      const px = dailyClose(p.sym, d); const f = Number.isFinite(px) ? px : p.entry;
      unreal += p.N * p.side * (f / p.entry - 1); g += p.N; p.last = f;
      fundOpen += p.N * fundSum(p.sym, p.side, p.entryMs, Math.min(nowMs, (d + 1) * DAY));
    }
    for (const p of open) p.unreal = p.N * p.side * (p.last / p.entry - 1);
    const eq = cash + unreal + fundOpen;
    equity.push({ d, t: d * DAY, eq }); eqPrev = eq; grossNow = g / Math.max(eq, 1e-9);
    if (eq > peak) peak = eq; maxDD = Math.min(maxDD, eq / peak - 1);
  }
  return { open, closed, equity, log, maxDD, grossNow, cash };
}

if (typeof module !== 'undefined') module.exports = { DEFAULTS, ema, atr, ichimoku, bbLongSignals, tkShortSignals, btcRegimeLong, simTrade, buildCandidates, replay, qv30At, median, prevMax, DAY, H12 };
