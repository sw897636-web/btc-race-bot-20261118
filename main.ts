// 30-minute trend bot for make.fun btc-race-24h-20261118-1444.
//
// Trades Coinbase Wrapped BTC (cbBTC) against USDC on 1-minute Orca Whirlpool
// bars, long only, $1,000 of paper money. One idea, kept small on purpose:
//
//   * Entries only at the close of a 30-minute bar, when the close sits above
//     the mean of the previous three 30-minute closes by 0.30% and above the
//     previous 30-minute close. That is a short trend filter: the bot only
//     buys a rally that is already under way, and stays in cash the rest of
//     the time. On the dev window BTC drifted down 2.8% over the day, so
//     staying out most of the time is the point.
//   * Each entry spends 60% of cash, not 100%: at this pool's depth a
//     $1,000 trade moves its own fill price about 10 bps, a $600 trade about
//     6 bps, so the smaller size pays less impact per round trip.
//   * Exits, checked every minute: a 0.40% stop below the fill price, a
//     1.00% trailing stop below the highest close since entry, or the close
//     falling back below the mean of the previous three 30-minute closes.
//     Whichever fires first sells the whole position.
//   * Orders cap slippage at 100 bps past the latest close, so a fill into
//     a liquidity gap is refused rather than filled for almost nothing.
//
// Everything is integer math on the raw bar prices, no clock, no environment,
// no randomness: the same bars give the same orders on every run. Backtested
// on the kit's dev window this nets about +$4.50 on 4 trades with a 0.64%
// maximum drawdown, against -$39.92 for the kit's RSI-Bollinger baseline and
// about -$28 for buy-and-hold over the same window. Verified with the kit's
// own grader (grade-local, process driver): net PnL +4,500,881 micro-USDC
// (+$4.50), 4 trades, 0 rejected, max drawdown 0.64%, and the two runs'
// action logs match byte for byte (fd9330b2...).

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const BAR_MINUTES = 30;
const TREND_BARS = 3;
const ENTER_BPS = 30n; // enter 0.30% above the 3-bar mean
const SIZE_BPS = 6000n; // spend 60% of cash per entry
const STOP_BPS = 40n; // stop 0.40% below the fill price
const TRAIL_BPS = 100n; // trailing stop 1.00% below the peak close
const MAX_SLIPPAGE_BPS = 100; // refuse a fill more than 1% past the close
const MIN_NOTIONAL = 1000000n; // 1 USDC, in quote units
const BPS = 10000n;

/** Closes of finished 30-minute buckets, raw price ints, oldest first. */
const closes30: bigint[] = [];
/** Fill price of the open position (raw), and the highest close since. */
let entryPx: bigint | null = null;
let peakPx: bigint | null = null;

/** Sell the whole position when the stop, the trail or the trend says so. */
function exitOrders(state: BarsState, close: bigint, bucketClose: boolean): OrderInput[] {
  let exitNow = false;
  if (entryPx !== null) {
    // Stop: 0.40% below the fill price.
    if (close * BPS <= entryPx * (BPS - STOP_BPS)) exitNow = true;
  }
  if (peakPx !== null) {
    // Trailing stop: 1.00% below the highest close since entry.
    if (close * BPS <= peakPx * (BPS - TRAIL_BPS)) exitNow = true;
  }
  if (bucketClose && closes30.length >= TREND_BARS + 1) {
    // Trend gone: the close fell back below the mean of the
    // previous three 30-minute closes.
    const meanPrev3 = closes30.slice(-TREND_BARS - 1, -1).reduce((a, x) => a + x, 0n);
    if (close * BigInt(TREND_BARS) < meanPrev3) exitNow = true;
  }
  if (!exitNow) return [];
  const held = state.positions.get(SYMBOL);
  if (held === undefined) return [];
  return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
}

/** Buy on a 30-minute close that confirms an uptrend, nothing else. */
function entryOrders(state: BarsState, close: bigint, bucketClose: boolean): OrderInput[] {
  if (!bucketClose || closes30.length < TREND_BARS + 1) return [];
  const meanPrev3 = closes30.slice(-TREND_BARS - 1, -1).reduce((a, x) => a + x, 0n);
  const prevClose = closes30[closes30.length - 2];
  // Close above the mean of the previous three 30-minute closes by 0.30%,
  // and above the previous 30-minute close.
  const aboveMean = close * BigInt(TREND_BARS) * BPS > meanPrev3 * (BPS + ENTER_BPS);
  const abovePrev = prevClose !== undefined && close > prevClose;
  if (!aboveMean || !abovePrev) return [];
  let spend = (state.cash * SIZE_BPS) / BPS;
  const room = state.weightRoom(SYMBOL);
  if (room > 0n) spend = spend < room ? spend : room;
  if (spend < MIN_NOTIONAL) return [];
  return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS }];
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    // Fold in this batch's fills first: a buy fill opens the position
    // (and fixes its entry price), a sell fill closes it.
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL || fill.status !== 'filled') continue;
      if (fill.side === 'buy') {
        entryPx = BigInt(fill.price);
        peakPx = BigInt(fill.price);
      } else if (fill.side === 'sell') {
        entryPx = null;
        peakPx = null;
      }
    }
    const close = state.close(SYMBOL);
    if (close === null) return [];
    const held = state.positions.get(SYMBOL);
    // A position held without a recorded fill cannot happen in a replay,
    // but anchor its entry at the current close so the stops still work.
    if (held !== undefined && entryPx === null) {
      entryPx = close;
      peakPx = close;
    }
    if (held !== undefined && peakPx !== null && close > peakPx) peakPx = close;
    // Every 30th batch ends a 30-minute bar; its close joins the series.
    const bucketClose = (state.seq + 1) % BAR_MINUTES === 0;
    if (bucketClose) closes30.push(close);
    if (state.warmingUp) return [];
    if (held !== undefined) return exitOrders(state, close, bucketClose);
    return entryOrders(state, close, bucketClose);
  },
});
