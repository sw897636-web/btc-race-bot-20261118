# btc-race-bot-20261118

[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/sw897636-web/btc-race-bot-20261118/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/sw897636-web/btc-race-bot-20261118/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444)

A 30-minute trend bot trading Coinbase Wrapped BTC (cbBTC) against USDC on
1-minute Orca Whirlpool bars, for the make.fun bounty
[Race a BTC trading bot live for 24 hours](https://make.fun/bounty/btc-race-24h-20261118-1444).
Long only, $1,000 of paper money, nothing traded for real.

## Strategy

- **Entries only at 30-minute closes**, when the close sits 0.30% above the
  mean of the previous three 30-minute closes and above the previous
  30-minute close: buy a rally that is already under way, stay in cash the
  rest of the time. On the dev window BTC drifted down 2.8% over the day,
  so staying out most of the time is the point.
- **Each entry spends 60% of cash**, not 100%: at this pool's depth a
  $1,000 trade moves its own fill price about 10 bps, a $600 trade about
  6 bps, so the smaller size pays less impact per round trip.
- **Exits, checked every minute**: a 0.40% stop below the fill price, a
  1.00% trailing stop below the highest close since entry, or the close
  falling back below the mean of the previous three 30-minute closes.
- Orders cap slippage at 100 bps past the latest close.

Pure integer math on the raw bar prices, no clock, no environment, no
randomness: the same bars give the same orders on every run.

## Local result (dev window, kit grade-local)

| | net PnL | trades | max drawdown |
|---|---|---|---|
| this bot | **+$4.50** | 4 | 0.64% |
| RSI-Bollinger baseline | -$39.92 | 19 | 4.35% |
| buy-and-hold | about -$28 | 1 | — |

## Run it

```sh
python3 -P -s main.py   # speaks agent-fun/bars-replay/v1 on stdin/stdout
```

Standard library only; `vendor/makefun_bars.py` is a byte-identical copy of
the kit's Python SDK shim.

## License

MIT — see [LICENSE](LICENSE).
