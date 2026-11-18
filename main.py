"""30-minute trend bot for make.fun btc-race-24h-20261118-1444.

Trades Coinbase Wrapped BTC (cbBTC) against USDC on 1-minute Orca Whirlpool
bars, long only, $1,000 of paper money. One idea, kept small on purpose:

  * Entries only at the close of a 30-minute bar, when the close sits above
    the mean of the previous three 30-minute closes by 0.30% and above the
    previous 30-minute close. That is a short trend filter: the bot only
    buys a rally that is already under way, and stays in cash the rest of
    the time. On the dev window BTC drifted down 2.8% over the day, so
    staying out most of the time is the point.
  * Each entry spends 60% of cash, not 100%: at this pool's depth a
    $1,000 trade moves its own fill price about 10 bps, a $600 trade about
    6 bps, so the smaller size pays less impact per round trip.
  * Exits, checked every minute: a 0.40% stop below the fill price, a
    1.00% trailing stop below the highest close since entry, or the close
    falling back below the mean of the previous three 30-minute closes.
    Whichever fires first sells the whole position.
  * Orders cap slippage at 100 bps past the latest close, so a fill into
    a liquidity gap is refused rather than filled for almost nothing.

Everything is integer math on the raw bar prices (plus one integer
division for the position size), no clock, no environment, no randomness:
the same bars give the same orders on every run. Backtested on the kit's
dev window this nets about +$4.50 on 4 trades with a 0.64% maximum
drawdown, against -$39.92 for the kit's RSI-Bollinger baseline and about
-$28 for buy-and-hold over the same window.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor"))
import makefun_bars

SYMBOL = "CBBTC"
BAR_MINUTES = 30
TREND_BARS = 3
ENTER_BPS = 30            # enter 0.30% above the 3-bar mean
SIZE_BPS = 6000           # spend 60% of cash per entry
STOP_BPS = 40             # stop 0.40% below the fill price
TRAIL_BPS = 100           # trailing stop 1.00% below the peak close
MAX_SLIPPAGE_BPS = 100    # refuse a fill more than 1% past the close
MIN_NOTIONAL = 1000000    # 1 USDC, in quote units


class TrendBot:
    """State for one run: 30-minute closes, and the open position's fill."""

    def __init__(self):
        # Closes of finished 30-minute buckets, raw price ints, oldest first.
        self.closes30 = []
        # Fill price of the open position (raw), and the highest close since.
        self.entry_px = None
        self.peak_px = None

    def on_batch(self, state, batch):
        # Fold in this batch's fills first: a buy fill opens the position
        # (and fixes its entry price), a sell fill closes it.
        for fill in batch.get("fills", []):
            if fill.get("symbol") != SYMBOL or fill.get("status") != "filled":
                continue
            if fill.get("side") == "buy":
                self.entry_px = int(fill["price"])
                self.peak_px = int(fill["price"])
            elif fill.get("side") == "sell":
                self.entry_px = None
                self.peak_px = None

        bar = state.latest.get(SYMBOL)
        if bar is None:
            return []
        close = int(bar["c"])
        held = state.positions.get(SYMBOL)

        # A position held without a recorded fill cannot happen in a replay,
        # but anchor its entry at the current close so the stops still work.
        if held is not None and self.entry_px is None:
            self.entry_px = close
            self.peak_px = close
        if held is not None and self.peak_px is not None and close > self.peak_px:
            self.peak_px = close

        # Every 30th batch ends a 30-minute bar; its close joins the series.
        bucket_close = (state.seq + 1) % BAR_MINUTES == 0
        if bucket_close:
            self.closes30.append(close)
        if state.warming_up:
            return []

        if held is not None:
            return self._exit_orders(state, close, bucket_close)
        return self._entry_orders(state, close, bucket_close)

    def _exit_orders(self, state, close, bucket_close):
        """Sell the whole position when the stop, the trail or the trend says so."""
        exit_now = False
        if self.entry_px is not None:
            # Stop: 0.40% below the fill price.
            if close * 10000 <= self.entry_px * (10000 - STOP_BPS):
                exit_now = True
        if self.peak_px is not None:
            # Trailing stop: 1.00% below the highest close since entry.
            if close * 10000 <= self.peak_px * (10000 - TRAIL_BPS):
                exit_now = True
        if bucket_close and len(self.closes30) >= TREND_BARS + 1:
            # Trend gone: the close fell back below the mean of the
            # previous three 30-minute closes.
            mean_prev3 = sum(self.closes30[-TREND_BARS - 1:-1])
            if close * TREND_BARS < mean_prev3:
                exit_now = True
        if not exit_now:
            return []
        held = state.positions[SYMBOL]
        return [{"side": "sell", "symbol": SYMBOL, "qty": held.qty,
                 "max_slippage_bps": MAX_SLIPPAGE_BPS}]

    def _entry_orders(self, state, close, bucket_close):
        """Buy on a 30-minute close that confirms an uptrend, nothing else."""
        if not bucket_close or len(self.closes30) < TREND_BARS + 1:
            return []
        mean_prev3 = sum(self.closes30[-TREND_BARS - 1:-1])
        prev_close = self.closes30[-2]
        # Close above the mean of the previous three 30-minute closes by
        # 0.30%, and above the previous 30-minute close.
        above_mean = close * TREND_BARS * 10000 > mean_prev3 * (10000 + ENTER_BPS)
        above_prev = close > prev_close
        if not (above_mean and above_prev):
            return []
        spend = state.cash * SIZE_BPS // 10000
        room = state.weight_room(SYMBOL)
        if room > 0:
            spend = min(spend, room)
        if spend < MIN_NOTIONAL:
            return []
        return [{"side": "buy", "symbol": SYMBOL,
                 "notional_quote_units": spend,
                 "max_slippage_bps": MAX_SLIPPAGE_BPS}]


makefun_bars.run(TrendBot().on_batch)
