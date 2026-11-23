# Padre Trenches Edge — Token Risk + Patterns

![Version](https://img.shields.io/badge/version-1.8.23-4ade80?style=flat-square)
![Platform](https://img.shields.io/badge/platform-trade.padre.gg-101010?style=flat-square)
![Userscript](https://img.shields.io/badge/userscript-Tampermonkey-2e6748?style=flat-square)
![Dependencies](https://img.shields.io/badge/dependencies-none-6b7280?style=flat-square)

A single-file browser userscript that adds a concentration-aware token scoring panel and an OHLCV pattern-recognition tab to [Padre](https://trade.padre.gg) Trenches and token trade pages.

> **Not financial advice.** This is a heuristic research tool, not a safety guarantee or an automatic buy signal. Always verify holders, liquidity, contract permissions, and the chart yourself.

---

## Table of contents

- [Overview](#overview)
- [Features](#features)
- [The panel](#the-panel)
- [Risk scoring model](#risk-scoring-model)
- [Pattern recognition](#pattern-recognition)
- [Wallet intel](#wallet-intel)
- [X mentions](#x-mentions)
- [Trading bot](#trading-bot)
- [Installation](#installation)
- [Usage](#usage)
- [Data sources and network calls](#data-sources-and-network-calls)
- [Permissions and privacy](#permissions-and-privacy)
- [Limitations](#limitations)
- [Technical notes](#technical-notes)
- [Disclaimer](#disclaimer)

---

## Overview

Padre already loads a lot of token-level risk data into the page — fresh-wallet activity, bundles, insider and linked-wallet concentration, dev holdings, snipers, top-10 concentration — but it is spread across cards and only visible one token at a time.

Padre Trenches Edge reads that data from the React props Padre has *already rendered*, scores every visible card, and surfaces the result as a badge plus a draggable side panel. No API keys, no account connection, no clicking of trading controls, and no external data provider for the risk score itself.

The guiding constraint is simple: **missing data is not treated as safe.** If a concentration metric is absent, it neither adds nor subtracts points — instead, the panel reports how much of the model actually had data, separately from the score.

---

## Features

| Area | What it does |
| --- | --- |
| **Token risk scoring** | 0–100 discovery score, A–D grading, per-card badges, score breakdown tooltips |
| **Caution badges** | Separate warning count for structural red flags, colored yellow → orange → red |
| **Pattern recognition** | Reads Padre's 1s terminal candles, falls back to indexed 1m DEX candles where appropriate |
| **Wallet intel** | Wallet rows with roles, volume, token PnL, realized PnL, filters, search, and paging |
| **X mentions** | Opens a helper X search for the token CA and renders matching posts in-panel |
| **Paper-trading bot** | Demo swing bot with two strategies, configurable risk, presets, and a CSV trade-attempt log |
| **Native live mode** | Opt-in auto mode that submits through Padre's own order form; signing stays in the wallet |
| **Lightweight UI** | Shadow DOM, zero dependencies, inline SVG icons, no webfonts, draggable and minimizeable |

---

## The panel

The panel is injected into a Shadow DOM root so Padre's styles cannot leak in, and it remembers its position, minimized state, and active tab.

| Tab | Visible on | Purpose |
| --- | --- | --- |
| **Picks** | Trenches list | Top 5 visible cards by score, with age filters |
| **Risk** | Trenches list | Full scored list, reasons, coverage, and age filters |
| **Wallets** | Both | Wallet rows for the selected/current token |
| **Charts** | Both | Per-token pattern analysis and signal breakdown |
| **Bot** | Trade pages only | Demo/live swing bot, config, positions, logs |
| **X** | Both | Contract-address mention search on X |
| **Settings** | Both | Display, scoring thresholds, cache and position reset |

List-page filters are **All · New only · 5m · 15m · 25m**. Scoring refreshes every **8 seconds** while the page is open.

---

## Risk scoring model

Every visible card is scored from the metrics Padre exposes. The model is:

```text
score = clamp( round( weighted_average(signals) - sum(risk_penalties) ), 0, 100 )
```

If no positive signal is available, the base is a neutral 50. Penalties are then subtracted.

### Positive signals (100 weight total)

| Signal | Weight | Scoring bands |
| --- | ---: | --- |
| Market-cap / FDV fit | 20 | <$5k → 25 · <$10k → 50 · ≤$100k → 100 · ≤$500k → 75 · ≤$2M → 45 · >$2M → 20 |
| Liquidity | 20 | <$3k → 10 · <$10k → 40 · <$25k → 65 · <$100k → 85 · ≥$100k → 100 |
| Sparkline momentum | 25 | ≤−30% → 0 · −30–0% → 35–70 · 0–10% → 70–90 · 10–50% → 90 · >50% → 65 |
| Volume vs market cap | 15 | <0.01× → 20 · <0.05× → 45 · <0.15× → 70 · ≤1× → 100 · >1× → 60 |
| 5m volume pace | 10 | <0.25× 1h rate → 20 · <0.6× → 50 · ≤2× → 100 · ≤4× → 70 · >4× → 35 |
| Buy/sell flow | 10 | ≤25% buys → 0 · <50% → 35 · 50–75% → 100 · >75% → 65 |

The sparkline window is **not confirmed** — Padre's payload does not state the period — so momentum is labeled accordingly in the tooltip. Buy/sell counts may be cumulative rather than windowed. Flow requires at least 5 trades.

### Risk penalties

Thresholds are **lower bounds** — the first tier that matches applies.

| Risk metric | Tier 1 | Tier 2 | Tier 3 | Tier 4 |
| --- | ---: | ---: | ---: | ---: |
| Fresh-wallet buy share | ≥25% → −6 | ≥40% → −12 | ≥60% → −18 | — |
| Fresh-wallet buyer count *(fallback)* | ≥10 → −4 | ≥20 → −8 | ≥40 → −12 | — |
| Bundles | >5% → −4 | >10% → −10 | >20% → −18 | >35% → −25 |
| Linked / dev-controlled wallets | >8% → −6 | >15% → −13 | >30% → −20 | — |
| Insider concentration | >8% → −6 | >15% → −13 | >30% → −20 | — |
| Dev holdings | >5% → −6 | >10% → −13 | >20% → −20 | — |
| Snipers | >5% → −4 | >10% → −8 | >20% → −14 | — |
| Top-10 concentration | >25% → −4 | >35% → −9 | >50% → −14 | — |
| Holder count | <10 → −4 | — | — | — |

### Grades

| Grade | Score | Color |
| --- | --- | --- |
| **A** | 75–100 | `#4ade80` |
| **B** | 60–74 | `#a3e635` |
| **C** | 40–59 | `#fbbf24` |
| **D** | 0–39 | `#f87171` |

### Coverage counters

Two independent counters are shown on hover and in the Risk tab:

| Counter | Range | Meaning |
| --- | --- | --- |
| Scoring inputs present | 0–10 | How much of the positive-signal weight had real data |
| Concentration metrics present | 0–7 | How many of the seven risk fields were found |

A score of 82 built on 2/10 inputs is weak evidence, and the UI says so rather than implying confidence.

### Caution badges

These are counted **independently of the score** and attached to the token name:

| Check | Trigger |
| --- | --- |
| Top-10 concentration | >30% |
| Market cap vs volume | Market cap above displayed volume |
| Sell pressure | Sells outnumber buys |
| Missing website | No website found in Padre data or card links |
| Missing socials | No X / Telegram / Discord / other social link |

One check is yellow, two are orange, three or more are red. Hovering shows every failing check.

---

## Pattern recognition

The Charts tab analyzes candles per token. Analysis needs at least **8 candles**; the score starts at a neutral 50 and is adjusted by the signals below, then clamped to 0–100.

### Candle data sources

| Priority | Source | Interval | Notes |
| ---: | --- | --- | --- |
| 1 | Padre's bundled candle feed (`_recentSnapshot`) | 1s | Only trusted on the matching single-token trade route |
| 2 | Embedded TradingView widget `exportData()` | Chart interval | Read through React internals and iframe candidates |
| 3 | GeckoTerminal pool OHLCV | 1m | Only used **off** the trade route, capped at 20–100 candles, ~1 request / 7s |
| — | Dexscreener | — | Used to resolve the best pool / pair |

On a trade page, if the 1s terminal candles are not exposed, the script reports that instead of silently substituting 1m candles from another venue — the chart you are looking at is treated as the authority there.

### Signals

| Condition | Adjustment |
| --- | ---: |
| 10-candle move ≥ +12% | +8 |
| 10-candle move ≥ +4% | +4 |
| 10-candle move ≤ −10% | −9 |
| 10-candle move ≤ −20% | −15 |
| ≥3 higher lows in the last 5 candles | +6 |
| ≤1 higher low (lower-low structure) | −4 |
| Last-5 volume ≥1.5× prior-5 volume with a positive move | +5 |
| Last-5 volume ≥1.7× prior-5 volume with a move < −3% | −9 |
| Close above the prior 20-candle high with ≥1.1× volume | +7 |
| Upper wick >55% of range on a red candle | −6 |
| Average absolute candle return >25% | −7 |

### Derived levels

The same pass computes a 10-candle ATR, the recent 5-candle swing low, and ATR as a percentage of price. The bot uses these for stop placement and breakout-extension checks.

### Practical notes

- 1s candles on brand-new tokens are extremely noisy; a high pattern score on 8–10 candles is still a weak sample.
- ATR-based stops can be very wide or very tight depending on the token's launch volatility.
- The pattern score is descriptive, not predictive.

---

## Wallet intel

The Wallets tab parses Padre's own wallet tables — early buyers, top traders, insiders, snipers, holders, and the trade rows on a token page — and resolves abbreviated addresses using the React props behind the visible row.

### Per-wallet data

| Field | Source |
| --- | --- |
| Roles | Table/section the wallet appears in, plus inherited hints |
| Bought / sold / remaining | Padre trade rows, token-scoped |
| Buy count / sell count | Padre trade rows |
| Realized PnL | Padre token-table realized PnL (not unrealized) |
| Token PnL | Padre mint-positions, token-scoped |
| Account-wide overview | Unrealized PnL, realized PnL, total value, balance, win rate, TXNS, coins traded, risk/reward |

### Controls

- Sort by **R. PnL**, **Token PnL**, **Priority**, or **Volume**
- Filter **All / Open / Closed**
- Search by address, role, or token symbol
- Page size 10, with previous/next paging
- Click an address to open Padre's wallet overview; copy button for the CA

**Limitation:** the tab can only see rows Padre has rendered. Scroll the holder list first, then press refresh.

---

## X mentions

1. Select a token (or open a trade page so the route supplies it).
2. Press search — the script opens `x.com/search?q=<CA>&f=live` in a helper window.
3. A collector running on x.com publishes up to 40 matching posts through `GM_setValue`.
4. The panel renders author, text, media, timestamp, and reply/repost/like counts, then closes the helper.

You must be signed in to X. Results include statuses for `done`, `empty`, `login required`, `timeout`, and `error`. No credentials, cookies, or tokens are read by the userscript.

---

## Trading bot

The Bot tab only appears on trade pages. It evaluates **closed candles only**, so it never acts mid-candle.

### Modes

| Mode | Behavior |
| --- | --- |
| **Demo** (default) | Simulated account. Virtual entries, fees, and slippage; no orders leave the browser |
| **Real** | Opt-in auto mode. Requires a confirmation dialog, then submits through Padre's native form |

Real mode uses **$1 USD buys** (converted to SOL at submission time) and **100% market sells**. A 100% sell liquidates *all* of that token in the selected wallet, including pre-existing holdings — the confirmation says so explicitly. Every order still needs wallet approval, and Padre may prompt per order.

### Strategies

| Strategy | Entry | Exit |
| --- | --- | --- |
| **Breakout retest** | Close above prior `lookback` high with volume ≥ `volumeMultiplier`× average and extension ≤ `maxExtensionAtr` ATR | Waits up to `retestTimeout` candles for a retest that closes back above the level; stop below retest low, target `riskReward`:1 |
| **Buy low · sell high** | Candle touches the prior `lookback` low and closes back above it | Fixed stop and take-profit percentages from entry |

### Defaults

| Setting | Default | Used by |
| --- | ---: | --- |
| Lookback candles | 20 | Both |
| Volume multiplier | 1.5× | Breakout |
| Max extension | 1.5 ATR | Breakout |
| Retest timeout | 12 candles | Breakout |
| Risk : reward | 2:1 | Breakout |
| Max stop risk | 5% | Breakout |
| Low/high stop | 5% | Buy low · sell high |
| Low/high take profit | 10% | Buy low · sell high |
| Notional | $1 | Demo + live |
| Fee | 0.5% | Demo |
| Slippage | 0.3% | Demo |

Configurations can be saved, loaded, and deleted as presets.

### Live submission safety rails

Before clicking submit, the script verifies:

- The trade route still matches the signal's token
- Padre's own order form and the correct Buy/Sell radio are selected
- The order type is `MARKET_BUY` / `MARKET_SELL`
- The amount unit is SOL and the converted amount still equals ~$1 (±$0.005)
- The 100% sell control actually set 100%
- The submit button is enabled and its label matches the side
- The wallet is not flagged by Padre as lacking SOL for fees

It then waits up to 20 seconds for an order ID. Any ambiguity, timeout, or verification failure **stops auto-trading** rather than retrying, to avoid duplicate orders. If an order outcome is unknown, the panel tells you to check Padre Orders before restarting.

### Trade-attempt log

| Property | Value |
| --- | --- |
| Storage key | `padre-edge-bot-attempt-log-v1` |
| Retained | Last 2,000 entries |
| Shown in panel | Last 12 |
| Fields | timestamp, mode, strategy, token, address, event, outcome, side, price, reason, details |
| Export | CSV download from the panel |

Outcomes include `SUBMITTED_TO_PADRE`, `SUCCESS`, `PENDING_RETEST`, `REJECTED`, and `FAILED_OR_UNCONFIRMED`.

---

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) (or a compatible userscript manager).
2. Create a new script and paste the contents of `Padre Trenches Edge — Token Risk + Patterns-1.8.23.js`.
3. Save, then open `https://trade.padre.gg/trenches`.

To update, replace the script body and bump `@version`; Tampermonkey will treat it as the same script.

### Supported pages

| URL pattern | Purpose |
| --- | --- |
| `https://trade.padre.gg/trenches*` | List scoring, picks, patterns, wallets |
| `https://trade.padre.gg/trade/*` | Trade-page scoring, patterns, bot, wallet rows |
| `https://x.com/*`, `https://twitter.com/*` | X mention collector for the helper window |

Runs at `document-idle`, in the top frame only (`@noframes`).

---

## Usage

1. Open Trenches and let the page render its token cards.
2. Check **Picks** for the top 5 by score, or **Risk** for the full list. Hover a badge for the reason breakdown and coverage.
3. Switch to **Charts** to analyze the selected token's candles.
4. Open a token's trade page to unlock the **Bot** tab and wallet rows.
5. In **Settings**, hide badges, fade cards below a minimum score, clear cached token stats, or reset the panel position.

---

## Data sources and network calls

| Endpoint | Used for | Notes |
| --- | --- | --- |
| `api.dexscreener.com/latest/dex/tokens/` | Resolve token → best pool | Public, no key |
| `api.geckoterminal.com/api/v2/networks/{net}/pools/{pool}/ohlcv/` | 1m fallback candles | Rate-limited to ~1 request / 7s |
| `api.geckoterminal.com/api/v2/simple/networks/solana/token_price/` | SOL/USD quote for $1 sizing | Live mode only |
| `x.com/search` | CA mention search | Runs in a helper window you can see |

Risk scoring itself makes **no network requests** — it uses Padre's rendered data.

---

## Permissions and privacy

| Grant | Why |
| --- | --- |
| `GM_setValue` / `GM_getValue` | Hand X results from the helper tab to the panel |
| `GM_addValueChangeListener` / `GM_removeValueChangeListener` | Wait for that result |
| `unsafeWindow` | Reach Padre's page-level candle snapshot and embedded chart |

Local storage keys:

| Key | Contents |
| --- | --- |
| `padre-edge:v1` | Display and scoring settings |
| `padre-edge:ui` | Panel position, minimized state, active tab |
| `padre-edge-bot-attempt-log-v1` | Trade-attempt log |

No telemetry, analytics, remote logging, or credential access. The script never asks for a seed phrase or private key. Wallet signing and approval always happen in Padre and your wallet.

---

## Limitations

- **Heuristic, not proof.** A high score does not mean a token is safe; a low score does not guarantee a rug.
- **Coverage matters.** Missing metrics are neutral, so check the coverage counters before trusting a grade.
- **Counts may be cumulative.** Padre does not always disclose windowing for buy/sell or sparkline data.
- **Visible data only.** The script cannot score tokens Padre has not rendered, or read wallet rows you have not scrolled into view.
- **External fallbacks are rate-limited.** 1m candles on list pages may lag; on trade pages the 1s chart is authoritative and no substitution happens.
- **X search requires a login** and is subject to X's markup and rate limits.
- **Live mode is real money.** $1 is a hard size cap and exits are 100% sells. Use a dedicated wallet with no existing position in the token.

---

## Technical notes

- Single file, no build step, no runtime dependencies, no bundler.
- Runs behind a guard (`window.__padreEdgeLoaded`) so the script is never initialized twice.
- Token metrics come from React fiber props via `memoizedProps`, scored by field coverage to pick the richest matching entity.
- The UI lives in a Shadow DOM with hand-written CSS and inline 24×24 SVG icons.
- Address resolution refuses to guess: when the trade title cannot be matched to a token entity, the CA is only accepted if exactly one candidate exists.

---

## Disclaimer

This project is an independent, unofficial tool. It is not affiliated with, endorsed by, or supported by Padre, X, Dexscreener, GeckoTerminal, or TradingView.

Nothing here is financial advice. Memecoin trading is extremely risky, and automated execution can lose money faster than manual trading. The bot ships in demo mode for a reason. Use at your own risk, verify every assumption, and never trade more than you can afford to lose.
