Padre Trenches Edge is a browser userscript that adds a live analysis panel to Padre Trenches and token trade pages.

It reads the token data already rendered on the page (via React internals — no API keys, no page clicks) and scores each card on disclosed wallet-risk metrics: fresh-wallet buy share, bundles, 
insider and linked-wallet concentration, dev holdings, snipers, and top-10 concentration. Missing data is never treated as safe — the panel shows scoring coverage separately 
so you can see how much evidence a grade isbased on.

Features

Risk scoring — 0–100 discovery score with A–D grading, plus colored warning badges for red flags (high top-10, sells outpacing buys, no website/socials).
Pattern recognition — detects candle patterns from Padre's embedded TradingView chart, falling back to Dexscreener/GeckoTerminal OHLCV when the chart doesn't expose its data.
Wallet intel tab — per-token wallet breakdowns with roles, volume, and realized PnL, linked out to Padre wallet profiles.
X/Twitter scan — checks a token's contract address for social mentions in a helper window.
Paper-trading bot — two strategies (breakout-retest and buy-low/sell-high) running in demo mode with configurable lookback, volume multiplier, stops, and risk:reward.
Optional live mode — fills Padre's native order form for review; signing and wallet approval always stay in Padre. Every attempt is logged locally and exportable as CSV.
Lightweight UI — Shadow DOM panel with no dependencies, icons, or webfonts; draggable, minimizeable, and settings persisted in localStorage.
Install: install Tampermonkey, add the .js file as a new script, then open trade.padre.gg/trenches.

