// ==UserScript==
// @name         Padre Trenches Edge — Token Risk + Patterns
// @namespace    https://trade.padre.gg/
// @version      1.8.23
// @description  Concentration-aware token scoring and OHLCV pattern recognition for Padre Trenches.
// @match        https://trade.padre.gg/trenches*
// @match        https://trade.padre.gg/trade/*
// @match        https://x.com/*
// @match        https://twitter.com/*
// @run-at       document-idle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @grant        unsafeWindow
// @noframes
// ==/UserScript==

/*
 * Padre Trenches Edge
 * -------------------
 * Scores visible token cards using disclosed wallet-risk metrics (fresh-wallet
 * buy share/count, bundles, insider/linked-wallet concentration, dev holding,
 * and snipers). Missing values are not treated as safe; the UI reports data
 * coverage separately from the score.
 *
 * Pattern Recognition first attempts to read OHLCV from Padre's embedded
 * TradingView chart, then falls back to indexed DEX OHLCV if the chart does not
  * expose its data API. Optional live mode can submit through Padre's native
  * form; signing and wallet approval remain in Padre.
 */
(function () {
  'use strict';

  if (window.__padreEdgeLoaded) return;
  window.__padreEdgeLoaded = true;

  const VERSION = '1.8.23';
  const SCAN_MS = 8000;
  const STORE_KEY = 'padre-edge:v1';
  const UI_KEY = 'padre-edge:ui';
  const DEX_API = 'https://api.dexscreener.com/latest/dex/tokens/';
  const GECKO_API = 'https://api.geckoterminal.com/api/v2/networks/';
  const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const DEFAULTS = { enabled: true, showBadges: true, dimRisky: false, minScore: 0, chartInterval: 'second', chartLimit: 40 };
  const state = {
    settings: loadSettings(), records: new Map(), wallets: new Map(), root: null, panel: null,
    list: null, recommendations: null, patterns: null, walletsEl: null, count: null, activeTab: 'recommended', ageFilter: 'all',
    walletBatch: [], walletReturned: new Set(), walletBatchContext: 'trenches', tradeRecord: null, mintPositions: new Map(), mintPositionsLoading: new Set(), mintPositionsErrors: new Map(), walletAccountStats: new Map(), pendingWalletOverview: null, walletOverviewObserver: null, walletSearch: '', walletFilter: 'all', walletSort: 'realized', walletPage: 0, walletPageSize: 10, walletPageCount: 1, scanTimer: null, selectedPatternAddress: null,
    xWindow: null, xScans: new Map(), xQueryMap: new Map(), xTimeout: null, xRequestId: '', xStorageListener: null, mintTooltipPrimed: '',
    bot: {
      mode: 'demo', execution: 'manual', editingStrategy: 'breakout', pendingLiveSignal: null, livePosition: null, breakoutSetup: null,
      liveOrderInFlight: false, liveOrderId: '', liveOrderObserverInstalled: false,
      running: false, lastPrice: null, lastCandleAt: null, sampleCount: 0,
      lastSignature: '', lastSignal: 'Waiting for a new candle after start.', position: null,
      trades: [], realizedPnl: 0, logs: [], logsLoaded: false,
      config: { strategy: 'breakout', lookback: 20, volumeMultiplier: 1.5, maxExtensionAtr: 1.5, retestTimeout: 12, riskReward: 2, stopPct: 5, lowHighStopPct: 5, lowHighTakeProfitPct: 10, notionalUsd: 1, feePct: 0.5, slippagePct: 0.3 },
    },
    patternQueue: [], patternRunning: false, patternRunId: 0,
    patternProgress: { done: 0, total: 0, label: 'Idle' }, currentChartAbort: null,
    lastPatternAt: 0,
    errors: 0, lastScanAt: 0, ui: loadUiState(), signature: '', recommendationSignature: '', patternSignature: '', walletsSignature: '',
  };

  function loadUiState() {
    try { return Object.assign({ left: null, top: null, minimized: false, activeTab: 'recommended' }, JSON.parse(localStorage.getItem(UI_KEY) || '{}')); }
    catch (e) { return { left: null, top: null, minimized: false, activeTab: 'recommended' }; }
  }
  function saveUiState(patch) {
    Object.assign(state.ui, patch);
    try { localStorage.setItem(UI_KEY, JSON.stringify(state.ui)); } catch (e) { /* private mode */ }
  }

  // Inline stroke icons (24x24 viewBox). No icon library or web font.
  const ICONS = {
    spark: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>',
    shield: '<path d="M12 3l7 3v6c0 4.4-3 8.3-7 9-4-.7-7-4.6-7-9V6z"/>',
    users: '<circle cx="9" cy="8" r="3"/><path d="M2.5 19a6.5 6.5 0 0 1 13 0"/><path d="M16 5.6a3 3 0 0 1 0 5.6"/><path d="M18 19a5.5 5.5 0 0 0-2.4-4.5"/>',
    chart: '<path d="M4 20V5"/><path d="M4 20h16"/><path d="M8 16l3.5-4 3 2.5L20 8"/>',
    at: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>',
    sliders: '<path d="M4 7h9"/><path d="M17 7h3"/><path d="M4 17h4"/><path d="M12 17h8"/><circle cx="15" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
    refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>',
    copy: '<rect x="9" y="9" width="10" height="10" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h9"/>',
    'chevron-left': '<path d="M15 18l-6-6 6-6"/>',
    'chevron-right': '<path d="M9 18l6-6-6-6"/>',
    'chevron-up': '<path d="M6 15l6-6 6 6"/>',
    'chevron-down': '<path d="M6 9l6 6 6-6"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
    warning: '<path d="M12 4l9 16H3z"/><path d="M12 10v4"/><path d="M12 17h.01"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
    external: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    close: '<path d="M6 6l12 12"/><path d="M18 6L6 18"/>',
    play: '<path d="M8 5l11 7-11 7z"/>',
    pause: '<path d="M9 5v14"/><path d="M15 5v14"/>',
    check: '<path d="M5 12l4.5 4.5L19 7"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  };
  function icon(name, size) {
    return '<svg width="' + (size || 16) + '" height="' + (size || 16) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + (ICONS[name] || '') + '</svg>';
  }
  function infoBtn(text, label) {
    return '<button type="button" class="info-btn" data-info="' + esc(text) + '" aria-label="' + esc(label || 'Details') + '" title="' + esc(label || 'Details') + '">' + icon('info', 12) + '</button>';
  }
  function emptyState(iconName, text, action) {
    return '<div class="empty">' + icon(iconName || 'info', 22) + '<div>' + esc(text) + '</div>' +
      (action ? '<button class="btn ghost" data-action="' + esc(action.action) + '" data-age="' + esc(action.age || '') + '">' + esc(action.label) + '</button>' : '') +
      '</div>';
  }

  const METRIC_KEYS = [
    'tokenAddress', 'pumpfunAddress', 'itemKey', 'fdvInUsd', 'marketCap', 'liquidityInUsd',
    'volumeInUsd', 'm5VolumeInUsd', 'activityStats', 'sparkline',
    'devHoldingPcnt', 'top10HoldingPcnt', 'totalHolders', 'volumeInUsd',
    'totalBuys', 'totalSells', 'bundlesHoldingPcntCurrent',
    'insidersHoldingPcnt', 'totalSnipers', 'freshWalletBuys', 'freshWalletBuyers', 'insiderBuys', 'totalInsiderBuys', 'insiderBuyers', 'insiderBuyCount',
  ];

  function loadSettings() {
    try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(STORE_KEY) || '{}')); }
    catch (e) { return Object.assign({}, DEFAULTS); }
  }
  function saveSettings() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state.settings)); } catch (e) { /* private mode */ }
  }
  const n = (v) => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
    return null;
  };
  function firstNum(raw, keys) {
    for (const key of keys) { const v = n(raw && raw[key]); if (v !== null) return v; }
    return null;
  }
  async function requestJson(url, options) {
    const opts = options || {};
    const timeoutMs = Math.max(1000, Number(opts.timeoutMs) || 12000);
    const controller = new AbortController();
    const parentSignal = opts.signal;
    const abortFromParent = () => controller.abort(parentSignal && parentSignal.reason);
    if (parentSignal) {
      if (parentSignal.aborted) abortFromParent();
      else parentSignal.addEventListener('abort', abortFromParent, { once: true });
    }
    const timer = setTimeout(() => controller.abort(new Error('Request timed out')), timeoutMs);
    try {
      const { timeoutMs: _timeoutMs, signal: _parentSignal, ...fetchOptions } = opts;
      const response = await fetch(url, { ...fetchOptions, signal: controller.signal });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return await response.json();
    } catch (error) {
      if (parentSignal && parentSignal.aborted) throw new Error('Request cancelled');
      if (controller.signal.aborted) throw new Error('Request timed out');
      throw error;
    } finally {
      clearTimeout(timer);
      if (parentSignal) parentSignal.removeEventListener('abort', abortFromParent);
    }
  }
  function pct(v) {
    if (v === null || v === undefined) return null;
    let x = n(v);
    if (x === null) return null;
    if (x > 100 && x <= 10000) x /= 100;
    return Math.max(0, Math.min(100, x));
  }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  }
  function fmtUsd(v) {
    if (v == null || !Number.isFinite(v)) return '—';
    if (v < 0) return '-' + fmtUsd(-v);
    if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e4) return '$' + Math.round(v / 1e3) + 'K';
    if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(v);
  }
  function fmtBotUsd(v) {
    if (v == null || !Number.isFinite(v)) return '—';
    if (v < 0) return '-$' + Math.abs(v).toFixed(2);
    return '$' + v.toFixed(2);
  }
  const BOT_LOG_KEY = 'padre-edge-bot-attempt-log-v1';
  function ensureBotLogs() {
    const bot = state.bot;
    if (bot.logsLoaded) return bot.logs;
    bot.logsLoaded = true;
    try {
      const saved = JSON.parse(localStorage.getItem(BOT_LOG_KEY) || '[]');
      bot.logs = Array.isArray(saved) ? saved.filter(item => item && typeof item === 'object').slice(-2000) : [];
    } catch (_) { bot.logs = []; }
    return bot.logs;
  }
  function recordBotLog(entry) {
    const bot = state.bot;
    const logs = ensureBotLogs();
    const route = tradePageContext();
    const record = {
      timestamp: new Date().toISOString(), mode: bot.mode,
      strategy: bot.config.strategy === 'lowHigh' ? 'Buy low · sell high' : 'Breakout retest',
      token: state.tradeRecord?.t?.symbol || (route ? addressShort(route.address) : 'unknown'),
      address: route ? addressShort(route.address) : '',
      event: String(entry.event || ''), outcome: String(entry.outcome || ''),
      side: String(entry.side || ''), price: Number.isFinite(Number(entry.price)) ? Number(entry.price) : '',
      reason: String(entry.reason || ''), details: String(entry.details || ''),
    };
    const last = logs[logs.length - 1];
    if (last && ['event', 'outcome', 'mode', 'address', 'side', 'reason', 'details'].every(key => last[key] === record[key])
      && Date.now() - new Date(last.timestamp).getTime() < 3000) return last;
    logs.push(record);
    if (logs.length > 2000) logs.splice(0, logs.length - 2000);
    try { localStorage.setItem(BOT_LOG_KEY, JSON.stringify(logs)); }
    catch (_) { /* keep this session's log visible even if storage is unavailable */ }
    renderBotLog();
    return record;
  }
  function logBotRejectionIfRelevant(reason, side) {
    if (!reason || !/(rejected|cancelled|timed out|above the .*max|level failed)/i.test(reason)) return;
    recordBotLog({ event: 'ENTRY_ATTEMPT', outcome: 'REJECTED', side, reason });
  }
  function renderBotLog() {
    if (!state.root) return;
    const logs = ensureBotLogs();
    const count = state.root.querySelector('[data-bot-log-count]');
    if (count) count.textContent = `(${logs.length})`;
    const list = state.root.querySelector('[data-bot-log-list]');
    if (!list) return;
    list.innerHTML = logs.length ? logs.slice(-12).reverse().map(item => {
      const color = item.outcome === 'FAILED' || item.outcome === 'REJECTED' ? '#f87171'
        : item.outcome === 'SUCCESS' || item.outcome === 'USER_REPORTED_FILLED' ? '#4ade80' : '#fbbf24';
      const when = new Date(item.timestamp).toLocaleTimeString();
      return `<div class="bot-log-row"><span class="bot-log-time">${esc(when)}</span><b style="color:${color}">${esc(item.outcome)}</b><span>${esc(item.event)}${item.side ? ' · ' + esc(item.side) : ''}</span><span class="bot-log-reason">${esc(item.reason)}</span></div>`;
    }).join('') : 'No attempts logged yet.';
  }
  function exportBotLog() {
    const logs = ensureBotLogs();
    if (!logs.length) { state.bot.lastSignal = 'The trade-attempt log is empty.'; renderBot(); return; }
    const columns = ['timestamp', 'mode', 'strategy', 'token', 'address', 'event', 'outcome', 'side', 'price', 'reason', 'details'];
    const quoteCsv = value => '"' + String(value == null ? '' : value).replace(/"/g, '""') + '"';
    const csv = [columns.join(','), ...logs.map(item => columns.map(key => quoteCsv(item[key])).join(','))].join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `padre-edge-trade-log-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
  function clearBotLog() {
    if (!ensureBotLogs().length || !window.confirm('Clear the saved trade-attempt log? This cannot be undone.')) return;
    state.bot.logs = [];
    try { localStorage.removeItem(BOT_LOG_KEY); } catch (_) {}
    renderBotLog();
    state.bot.lastSignal = 'Trade-attempt log cleared.';
    renderBot();
  }
  function fmtPct(v) { return v == null ? '—' : (v < 10 ? v.toFixed(1) : v.toFixed(0)) + '%'; }
  function fmtPrice(v) {
    if (v == null || !Number.isFinite(v)) return '—';
    if (v >= 1) return '$' + v.toFixed(4);
    if (v >= 0.01) return '$' + v.toFixed(6);
    if (v >= 0.000001) return '$' + v.toFixed(8);
    return '$' + v.toExponential(3);
  }
  function fmtAge(sec) {
    if (sec == null) return '—';
    if (sec < 60) return Math.round(sec) + 's';
    if (sec < 3600) return Math.round(sec / 60) + 'm';
    if (sec < 86400) return Math.round(sec / 3600) + 'h';
    return Math.round(sec / 86400) + 'd';
  }
  function addressShort(s) { return s && s.length > 12 ? s.slice(0, 5) + '…' + s.slice(-4) : (s || ''); }
  function parseItem(value) {
    if (!value) return null;
    const colon = value.indexOf(':');
    const dash = value.lastIndexOf('-');
    if (colon < 1 || dash <= colon) return null;
    return { chain: value.slice(0, colon).toUpperCase(), address: value.slice(colon + 1, dash), mode: value.slice(dash + 1).toUpperCase() };
  }

  let fiberKey = '';
  function getFiber(el) {
    if (fiberKey && el[fiberKey]) return el[fiberKey];
    for (const key of Object.keys(el)) {
      if (key.startsWith('__reactFiber$') || key === '_reactInternalFiber') {
        fiberKey = key; return el[key];
      }
    }
    return null;
  }
  function scoreProps(p) {
    if (!p || typeof p !== 'object') return -1;
    let score = 0;
    for (const key of METRIC_KEYS) if (p[key] != null) score++;
    return score;
  }
  function findEntity(el, address) {
    return findEntityFromFiber(getFiber(el), address);
  }
  function findEntityFromFiber(rootFiber, address) {
    const stack = [rootFiber], seen = new Set();
    let best = null, bestScore = -1, steps = 0;
    while (stack.length && steps++ < 1800) {
      const f = stack.pop();
      if (!f || seen.has(f)) continue;
      seen.add(f);
      const p = f.memoizedProps;
      if (p && typeof p === 'object') {
        const token = p.token && typeof p.token === 'object' ? p.token : p;
        const keys = ['tokenAddress', 'pumpfunAddress', 'mintAddress', 'baseAddress', 'baseTokenAddress', 'address', 'marketAddress', 'pairAddress', 'poolAddress', 'itemKey', 'sourceAddress'];
        const match = keys.some(k => token[k] === address || p[k] === address || (typeof p[k] === 'string' && p[k].startsWith(address)));
        if (match) {
          const s = scoreProps(token);
          if (s > bestScore) { best = token; bestScore = s; }
        }
      }
      if (f.child) stack.push(f.child);
      if (f.sibling) stack.push(f.sibling);
    }
    return best || {};
  }
  function findTradeEntity(address) {
    const roots = new Set();
    const selector = 'main,[role="main"],#root,#app,[id*="root" i],[data-trenches-item],[class*="token" i],[class*="header" i],[class*="chart" i]';
    for (const el of document.querySelectorAll(selector)) {
      let fiber = getFiber(el), depth = 0;
      while (fiber && fiber.return && depth++ < 40) fiber = fiber.return;
      if (fiber) roots.add(fiber);
    }
    let best = {}, bestScore = -1;
    for (const rootFiber of roots) {
      const raw = findEntityFromFiber(rootFiber, address);
      const score = scoreProps(raw);
      if (score > bestScore) { best = raw; bestScore = score; }
    }
    return best;
  }
  function mintAddressFromObject(root, routeAddress) {
    if (!root || typeof root !== 'object') return '';
    const stack = [{ value: root, depth: 0 }], seen = new Set();
    const candidates = new Map();
    let nodes = 0;
    const dedicated = /^(tokenaddress|mintaddress|pumpfunaddress|contractaddress|tokenmint|basetokenaddress|baseaddress|basetokenaddress|caaddress)$/i;
    while (stack.length && nodes++ < 1200) {
      const { value, depth } = stack.pop();
      if (!value || typeof value !== 'object' || seen.has(value) || depth > 7) continue;
      seen.add(value);
      const entries = Object.entries(value);
      const tokenLike = entries.some(([k]) => /^(symbol|ticker|name|customname|tokenname|decimals|tokenaddress|mintaddress|pumpfunaddress|baseaddress|basetokenaddress)$/i.test(k));
      for (const [key, child] of entries) {
        const normalized = key.replace(/[^a-z]/gi, '');
        if (typeof child === 'string' && isWalletAddress(child) && child !== routeAddress) {
          let priority = dedicated.test(normalized) ? 100 : normalized === 'mint' ? 90 : normalized === 'address' && tokenLike ? 80 : 0;
          if (priority) candidates.set(child, Math.max(candidates.get(child) || 0, priority + Math.min(20, entries.length)));
        } else if (child && typeof child === 'object') stack.push({ value: child, depth: depth + 1 });
      }
    }
    return [...candidates].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  }
  function mintAddressFromPage(routeAddress) {
    const expectedSymbol = tradeTitleInfo()?.symbol.toLowerCase() || '';
    const roots = new Set();
    for (const el of document.querySelectorAll('main,[role="main"],#root,#app,[id*="root" i],[data-trenches-item],[class*="token" i],[class*="header" i],[class*="chart" i]')) {
      let fiber = getFiber(el), depth = 0;
      while (fiber && fiber.return && depth++ < 40) fiber = fiber.return;
      if (fiber) roots.add(fiber);
    }
    const seen = new Set();
    const fallbackCandidates = new Set();
    for (const root of roots) {
      const stack = [root];
      let steps = 0;
      while (stack.length && steps++ < 2500) {
        const fiber = stack.pop();
        if (!fiber || seen.has(fiber)) continue;
        seen.add(fiber);
        const props = fiber.memoizedProps;
        const candidate = mintAddressFromObject(props, routeAddress);
        if (candidate) {
          fallbackCandidates.add(candidate);
          const propSymbol = props && (props.symbol || props.ticker || props.token?.symbol || props.token?.ticker || props.data?.symbol || props.entity?.symbol || props.customName);
          if (expectedSymbol && propSymbol != null && String(propSymbol).toLowerCase() === expectedSymbol) return candidate;
        }
        if (fiber.child) stack.push(fiber.child);
        if (fiber.sibling) stack.push(fiber.sibling);
      }
    }
    // Last resort: Padre's copy controls often retain the full value in their
    // React props even when the visible address is abbreviated.
    for (const el of document.querySelectorAll('button,[role="button"],[data-address],[data-ca],[data-mint]')) {
      const candidate = mintAddressFromObject(getFiber(el)?.memoizedProps, routeAddress);
      if (candidate) fallbackCandidates.add(candidate);
      for (const attr of [...el.attributes]) {
        if (!/token|mint|contract|(^|-)ca($|-)/i.test(attr.name)) continue;
        if (isWalletAddress(attr.value) && attr.value !== routeAddress) fallbackCandidates.add(attr.value);
      }
    }
    // Padre renders the full CA in a hover tooltip on the token-name/CA control.
    // Read it when present; never click the copy/trade controls to obtain it.
    const tooltipRoots = [...document.querySelectorAll('[role="tooltip"],[data-radix-popper-content-wrapper],[data-state="open"]')];
    for (const tooltip of tooltipRoots) {
      const text = tooltip.innerText || tooltip.textContent || '';
      if (!/\bCA\b/i.test(text) || /\bPair\b/i.test(text) && !/\bTicker\b/i.test(text)) continue;
      const addresses = text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) || [];
      const candidate = addresses.find(value => value !== routeAddress);
      if (candidate) return candidate;
      for (const node of [tooltip, ...tooltip.querySelectorAll('button,[role="button"],[data-ca],[data-mint],[title],[aria-label]')]) {
        const fromProps = mintAddressFromObject(getFiber(node)?.memoizedProps, routeAddress);
        if (fromProps) return fromProps;
        for (const attr of [...node.attributes || []]) {
          if (/token|mint|contract|(^|-)ca($|-)/i.test(attr.name) && isWalletAddress(attr.value) && attr.value !== routeAddress) return attr.value;
        }
      }
    }
    // Never guess among several unrelated token/wallet addresses. If Padre's
    // title did not let us match the token entity, accept only one candidate.
    return fallbackCandidates.size === 1 ? [...fallbackCandidates][0] : '';
  }
  function primeTokenCaTooltip() {
    const route = tradePageContext();
    if (!route || state.mintTooltipPrimed === route.address) return;
    state.mintTooltipPrimed = route.address;
    const symbol = tradeTitleInfo()?.symbol;
    if (!symbol) return;
    const candidates = [...document.querySelectorAll('button,[role="button"],[title],[aria-label],span,a')]
      .filter(el => (el.textContent || '').trim().toLowerCase() === symbol.toLowerCase())
      .sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
    const target = candidates.find(el => el.getBoundingClientRect().width && el.getBoundingClientRect().height);
    if (!target) return;
    // Padre reveals the CA in a hover tooltip. Trigger only hover semantics;
    // never click the CA copy control or any trading control.
    for (const type of ['pointerover', 'mouseover', 'mouseenter']) {
      try { target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window })); } catch (e) { /* optional tooltip */ }
    }
    setTimeout(() => {
      const mint = mintAddressFromPage(route.address);
      if (!mint || tradePageContext()?.address !== route.address) return;
      if (state.tradeRecord) state.tradeRecord.mintAddress = mint;
      state.walletsSignature = null;
      renderXMentions();
      updateStatusStrip();
    }, 350);
  }

  function recursiveMetric(raw, pattern, maxDepth) {
    const stack = [{ value: raw, depth: 0 }], seen = new Set();
    while (stack.length) {
      const { value, depth } = stack.pop();
      if (!value || typeof value !== 'object' || seen.has(value) || depth > maxDepth) continue;
      seen.add(value);
      for (const [key, val] of Object.entries(value)) {
        if (pattern.test(key)) {
          const found = n(val);
          if (found !== null) return found;
          if (Array.isArray(val)) return val.length;
        }
        if (val && typeof val === 'object') stack.push({ value: val, depth: depth + 1 });
      }
    }
    return null;
  }
  function metadataFlags(raw, el) {
    const flags = { website: false, social: false };
    const stack = [{ value: raw, depth: 0 }], seen = new Set();
    let nodes = 0;
    while (stack.length && nodes++ < 500) {
      const { value, depth } = stack.pop();
      if (!value || typeof value !== 'object' || seen.has(value) || depth > 5) continue;
      seen.add(value);
      for (const [key, child] of Object.entries(value)) {
        if (typeof child === 'string' && child.trim() && !/^(null|undefined|n\/a|none|-)$/i.test(child.trim())) {
          const k = key.toLowerCase();
          if (/website|web.?url|homepage|home.?page|project.?site|site.?url/.test(k)) flags.website = true;
          if (/twitter|telegram|discord|instagram|tiktok|youtube|social|(^|_)x(url|link)?($|_)/.test(k)) flags.social = true;
        } else if (child && typeof child === 'object') stack.push({ value: child, depth: depth + 1 });
      }
    }
    for (const link of (el && el.querySelectorAll ? el.querySelectorAll('a[href]') : [])) {
      try {
        const host = new URL(link.href).hostname.toLowerCase().replace(/^www\./, '');
        if (/^(x\.com|twitter\.com|t\.me|telegram\.me|telegram\.org|discord\.gg|discord\.com|instagram\.com|tiktok\.com|youtube\.com)$/.test(host)) flags.social = true;
        else if (!/(^|\.)(padre\.gg|pump\.fun|solscan\.io|dexscreener\.com|geckoterminal\.com)$/.test(host)) flags.website = true;
      } catch (e) { /* ignore invalid link */ }
    }
    return flags;
  }
  function warningChecks(t) {
    const warnings = [];
    if (t.top10Pct != null && t.top10Pct > 30) warnings.push('Top 10 holders exceed 30% (' + fmtPct(t.top10Pct) + ').');
    if (t.marketCap != null && t.volumeUsd != null && t.marketCap > t.volumeUsd) warnings.push('Market cap is higher than the displayed volume (' + fmtUsd(t.marketCap) + ' vs ' + fmtUsd(t.volumeUsd) + ').');
    if (t.buys != null && t.sells != null && t.sells > t.buys) warnings.push('Sellers outnumber buyers (' + t.sells + ' sells vs ' + t.buys + ' buys).');
    if (t.metadata && !t.metadata.website) warnings.push('No website found in Padre data/card.');
    if (t.metadata && !t.metadata.social) warnings.push('No social-media link found in Padre data/card.');
    return warnings;
  }
  function warningBadgeColors(count) {
    if (count === 1) return { background: '#eab308', foreground: '#171717', label: '1 caution check' };
    if (count === 2) return { background: '#f97316', foreground: '#fff', label: '2 caution checks' };
    return { background: '#ef4444', foreground: '#fff', label: count + ' caution checks' };
  }
  function extractMetrics(raw, parsed, el) {
    const text = (el && el.innerText) || '';
    const freshCount = firstNum(raw, [
      'freshWalletBuyers', 'freshWalletBuys', 'freshBuyers', 'newWalletBuyers',
      'freshWalletCount', 'freshBuyersCount', 'freshWalletsBuying', 'newWalletBuys',
    ]) ?? recursiveMetric(raw, /(fresh.*(wallet|buyer|buy)|(wallet|buyer|buy).*fresh)/i, 3);
    const freshPct = pct(firstNum(raw, [
      'freshWalletBuyersPcnt', 'freshWalletBuysPcnt', 'freshBuyersPcnt',
      'freshWalletsPcnt', 'freshWalletPct', 'newWalletBuyersPcnt',
    ]) ?? recursiveMetric(raw, /fresh.*(pcnt|pct|percent|share)/i, 3));
    const linkedPct = pct(firstNum(raw, [
      'devControlledWalletsPcnt', 'devWalletsHoldingPcnt', 'linkedWalletsHoldingPcnt',
      'sameFundedWalletsPcnt', 'walletClusterHoldingPcnt', 'devClusterHoldingPcnt',
    ]) ?? recursiveMetric(raw, /(dev|linked|cluster|sameFunded).*?(pcnt|pct|percent|holding)/i, 3));
    const freshBuyers = firstNum(raw, ['totalFreshWalletBuyers', 'freshWalletBuyersCount', 'freshBuyerCount']) ?? freshCount;
    const buyers = firstNum(raw, ['uniqueBuyers', 'totalBuyers', 'buyersCount', 'buyerCount']);
    const freshShare = freshPct !== null ? freshPct :
      (freshBuyers !== null && buyers > 0 ? Math.min(100, freshBuyers / buyers * 100) : null);
    const symbol = raw.symbol || raw.translatedSymbol || (text.trim().split(/\s+/)[0] || '?').replace(/^\$/, '');
    const name = raw.name || raw.translatedName || '';
    let ageSec = firstNum(raw, ['tokenAgeInSeconds', 'ageInSeconds']);
    const created = firstNum(raw, ['createdAt', 'createdAtMs', 'pairCreatedAt']);
    if (ageSec === null && created !== null) ageSec = Math.max(0, (Date.now() - (created < 1e12 ? created * 1000 : created)) / 1000);
    if (ageSec === null) {
      const m = /(?:^|\s)(\d+)\s*(s|m|h|d)(?:\s|$)/i.exec(text);
      if (m) ageSec = Number(m[1]) * ({ s: 1, m: 60, h: 3600, d: 86400 }[m[2].toLowerCase()]);
    }
    const mc = firstNum(raw, ['fdvInUsd', 'marketCapInUsd', 'marketCap', 'fdv', 'mcap']);
    return {
      address: parsed.address, chain: parsed.chain, mode: parsed.mode,
      symbol: String(symbol || '?').replace(/^\$/, ''), name: String(name),
      ageSec, marketCap: mc, devPct: pct(firstNum(raw, ['devHoldingPcnt', 'devHoldingPct', 'devHoldingPercent', 'deployerHoldingPcnt'])),
      top10Pct: pct(firstNum(raw, ['top10HoldingPcnt', 'top10HoldersPcnt', 'top10Pct'])),
      bundlePct: pct(firstNum(raw, ['bundlesHoldingPcntCurrent', 'bundlesHoldingPcnt', 'bundleHoldingPcnt', 'bundlePct'])),
      insiderPct: pct(firstNum(raw, ['insidersHoldingPcnt', 'topInsidersHoldingPct', 'insiderPct'])),
      insiderBuys: firstNum(raw, ['insiderBuys', 'totalInsiderBuys', 'insiderBuyers', 'insiderBuyersCount', 'insiderBuyCount', 'insiderTransactions']) ?? recursiveMetric(raw, /insider.*(buy|buyer)|(?:buy|buyer).*insider/i, 3),
      linkedPct, sniperPct: pct(firstNum(raw, ['snipersHoldingPcnt', 'snipersHoldingsPct', 'sniperPct'])),
      freshBuyers, freshShare,
      holders: firstNum(raw, ['totalHolders', 'holdersCount', 'holderCount']),
      buys: firstNum(raw, ['totalBuys', 'buys']), sells: firstNum(raw, ['totalSells', 'sells']),
      volumeUsd: firstNum(raw, ['volumeInUsd', 'volumeUsd', 'volume']),
      volume5mUsd: firstNum(raw, ['m5VolumeInUsd', 'volume5mInUsd', 'volume5mUsd']),
      volume1hUsd: firstNum(raw && raw.activityStats && raw.activityStats.h1, ['volUsd', 'volumeInUsd', 'volumeUsd']),
      liquidityUsd: firstNum(raw, ['liquidityInUsd', 'liquidityUsd', 'liquidity']),
      sparkline: Array.isArray(raw && raw.sparkline) ? raw.sparkline : null,
      totalBuys: firstNum(raw, ['totalBuys', 'buys']), totalSells: firstNum(raw, ['totalSells', 'sells']),
      curve: pct(firstNum(raw, ['curveProgress', 'bondingCurveProgress'])),
      metadata: metadataFlags(raw, el),
    };
  }

  function sparklineMomentum(values) {
    if (!Array.isArray(values)) return null;
    const points = values.map(value => {
      if (Array.isArray(value)) return n(value[value.length - 1]);
      if (value && typeof value === 'object') return n(value.priceInUsd ?? value.price ?? value.value ?? value.y);
      return n(value);
    }).filter(value => value !== null && value > 0);
    if (points.length < 4) return null;
    const first = points[0], last = points[points.length - 1];
    return Number.isFinite(first) && first > 0 ? (last / first - 1) * 100 : null;
  }
  // Discovery score: market-cap fit, liquidity, activity, momentum and flow,
  // then subtract observable concentration risks. Missing signals stay neutral.
  function scoreToken(t) {
    let points = 0, weight = 0;
    const reasons = [];
    const signal = (value, signalWeight, label) => {
      if (value == null || !Number.isFinite(value)) return;
      points += Math.max(0, Math.min(100, value)) * signalWeight;
      weight += signalWeight;
      reasons.push({ d: Math.round(value * signalWeight / 100), label });
    };
    let riskPenalty = 0;
    const risk = (amount, label) => { riskPenalty += amount; reasons.push({ d: -amount, label }); };

    if (t.marketCap != null && t.marketCap > 0) {
      const mc = t.marketCap;
      const value = mc < 5000 ? 25 : mc < 10000 ? 50 : mc <= 100000 ? 100 : mc <= 500000 ? 75 : mc <= 2000000 ? 45 : 20;
      signal(value, 20, 'MC/FDV fit ' + fmtUsd(mc));
    }
    if (t.liquidityUsd != null && t.liquidityUsd > 0) {
      const liq = t.liquidityUsd;
      signal(liq < 3000 ? 10 : liq < 10000 ? 40 : liq < 25000 ? 65 : liq < 100000 ? 85 : 100, 20, 'liquidity ' + fmtUsd(liq));
    }
    const momentum = sparklineMomentum(t.sparkline);
    if (momentum != null) {
      const value = momentum <= -30 ? 0 : momentum < 0 ? 35 + ((momentum + 30) / 30) * 35
        : momentum < 10 ? 70 + momentum * 2 : momentum < 50 ? 90 : 65;
      signal(value, 25, 'sparkline momentum ' + (momentum > 0 ? '+' : '') + momentum.toFixed(1) + '% (window not confirmed)');
    }
    const volume = t.volume1hUsd ?? t.volumeUsd;
    if (volume != null && volume >= 0) {
      const ratio = t.marketCap > 0 ? volume / t.marketCap : null;
      const value = ratio == null ? Math.min(100, Math.log10(volume + 1) * 20)
        : ratio < 0.01 ? 20 : ratio < 0.05 ? 45 : ratio < 0.15 ? 70 : ratio <= 1 ? 100 : 60;
      signal(value, 15, (t.volume1hUsd != null ? '1h' : 'reported') + ' volume ' + fmtUsd(volume));
    }
    if (t.volume5mUsd != null && t.volume1hUsd > 0) {
      const acceleration = (t.volume5mUsd * 12) / t.volume1hUsd;
      const value = acceleration < 0.25 ? 20 : acceleration < 0.6 ? 50 : acceleration <= 2 ? 100 : acceleration <= 4 ? 70 : 35;
      signal(value, 10, '5m volume pace ' + acceleration.toFixed(1) + '× 1h average');
    }
    if (t.buys != null && t.sells != null && t.buys + t.sells >= 5) {
      const buyShare = t.buys / (t.buys + t.sells);
      signal(buyShare <= 0.25 ? 0 : buyShare < 0.5 ? 35 : buyShare <= 0.75 ? 100 : 65, 10,
        'buy/sell flow ' + Math.round(buyShare * 100) + '% buys (counts may be cumulative)');
    }

    if (t.freshShare != null) {
      if (t.freshShare >= 60) risk(18, 'fresh-wallet buy share ' + fmtPct(t.freshShare));
      else if (t.freshShare >= 40) risk(12, 'fresh-wallet buy share ' + fmtPct(t.freshShare));
      else if (t.freshShare >= 25) risk(6, 'fresh-wallet buy share ' + fmtPct(t.freshShare));
    } else if (t.freshBuyers != null) {
      if (t.freshBuyers >= 40) risk(12, t.freshBuyers + ' fresh-wallet buys');
      else if (t.freshBuyers >= 20) risk(8, t.freshBuyers + ' fresh-wallet buys');
      else if (t.freshBuyers >= 10) risk(4, t.freshBuyers + ' fresh-wallet buys');
    }
    if (t.bundlePct != null) {
      if (t.bundlePct > 35) risk(25, 'bundles ' + fmtPct(t.bundlePct));
      else if (t.bundlePct > 20) risk(18, 'bundles ' + fmtPct(t.bundlePct));
      else if (t.bundlePct > 10) risk(10, 'bundles ' + fmtPct(t.bundlePct));
      else if (t.bundlePct > 5) risk(4, 'bundles ' + fmtPct(t.bundlePct));
    }
    if (t.linkedPct != null) {
      if (t.linkedPct > 30) risk(20, 'likely linked wallets ' + fmtPct(t.linkedPct));
      else if (t.linkedPct > 15) risk(13, 'likely linked wallets ' + fmtPct(t.linkedPct));
      else if (t.linkedPct > 8) risk(6, 'likely linked wallets ' + fmtPct(t.linkedPct));
    }
    if (t.insiderPct != null) {
      if (t.insiderPct > 30) risk(20, 'insider concentration ' + fmtPct(t.insiderPct));
      else if (t.insiderPct > 15) risk(13, 'insider concentration ' + fmtPct(t.insiderPct));
      else if (t.insiderPct > 8) risk(6, 'insider concentration ' + fmtPct(t.insiderPct));
    }
    if (t.devPct != null) {
      if (t.devPct > 20) risk(20, 'dev holds ' + fmtPct(t.devPct));
      else if (t.devPct > 10) risk(13, 'dev holds ' + fmtPct(t.devPct));
      else if (t.devPct > 5) risk(6, 'dev holds ' + fmtPct(t.devPct));
    }
    if (t.sniperPct != null) {
      if (t.sniperPct > 20) risk(14, 'snipers ' + fmtPct(t.sniperPct));
      else if (t.sniperPct > 10) risk(8, 'snipers ' + fmtPct(t.sniperPct));
      else if (t.sniperPct > 5) risk(4, 'snipers ' + fmtPct(t.sniperPct));
    }
    if (t.top10Pct != null) {
      if (t.top10Pct > 50) risk(14, 'top-10 holds ' + fmtPct(t.top10Pct));
      else if (t.top10Pct > 35) risk(9, 'top-10 holds ' + fmtPct(t.top10Pct));
      else if (t.top10Pct > 25) risk(4, 'top-10 holds ' + fmtPct(t.top10Pct));
    }
    if (t.holders != null && t.holders < 10) risk(4, 'only ' + t.holders + ' holders');

    const base = weight ? points / weight : 50;
    const score = Math.max(0, Math.min(100, Math.round(base - riskPenalty)));
    const riskCoverage = [t.freshShare, t.bundlePct, t.insiderPct, t.linkedPct, t.devPct, t.sniperPct, t.top10Pct].filter(x => x != null).length;
    return { score, reasons, coverage: riskCoverage, signalCoverage: Math.round(weight / 10), grade: score >= 75 ? 'A' : score >= 60 ? 'B' : score >= 40 ? 'C' : 'D' };
  }

  function scanCards() {
    const walletContextChanged = ensureWalletContext();
    refreshTradeRecord();
    const elements = document.querySelectorAll('[data-trenches-item]');
    const seen = new Set();
    for (const el of elements) {
      const parsed = parseItem(el.getAttribute('data-trenches-item'));
      if (!parsed || !parsed.address) continue;
      const key = parsed.chain + ':' + parsed.address;
      seen.add(key);
      const raw = findEntity(el, parsed.address);
      const t = extractMetrics(raw, parsed, el);
      const s = scoreToken(t);
      const rec = state.records.get(key) || { key, address: parsed.address, chart: null, pair: null };
      Object.assign(rec, { el, raw, t, score: s.score, grade: s.grade, reasons: s.reasons, coverage: s.coverage, signalCoverage: s.signalCoverage, lastSeen: Date.now() });
      state.records.set(key, rec);
      if (state.activeTab === 'wallets') collectWalletSignals(rec);
      paintCard(rec);
    }
    for (const [key, rec] of state.records) {
      if (!seen.has(key) && Date.now() - rec.lastSeen > 30000) {
        if (rec.badge) rec.badge.remove();
        state.records.delete(key);
      }
    }
    if (state.activeTab === 'wallets' && tradePageContext()) {
      scanTradeWallets();
      fillWalletBatch();
    }
    render();
    if (state.tradeRecord) {
      const routeRec = visibleRecords().find(rec => rec.address === state.tradeRecord.address) || state.tradeRecord;
      if (!routeRec.chartState && !routeRec.chartRequest) {
        state.patternProgress.label = 'Auto';
        analyzeOne(routeRec);
      }
    }
    state.lastScanAt = Date.now();
    updateStatusStrip();
  }
  const COLORS = { A: '#4ade80', B: '#a3e635', C: '#fbbf24', D: '#f87171' };
  function paintCard(rec) {
    if (!rec.el || !rec.el.isConnected) return;
    if (!state.settings.enabled) {
      delete rec.el.dataset.peGrade;
      rec.el.style.removeProperty('--pe-color');
      if (rec.badge) { rec.badge.remove(); rec.badge = null; }
      if (rec.warningBadge) { rec.warningBadge.remove(); rec.warningBadge = null; }
      rec.el.style.opacity = '';
      return;
    }
    rec.el.dataset.peGrade = rec.grade;
    rec.el.style.setProperty('--pe-color', COLORS[rec.grade]);
    rec.el.style.opacity = state.settings.dimRisky && rec.score < state.settings.minScore ? '.38' : '';
    paintWarningBadge(rec);
    if (!state.settings.showBadges) { if (rec.badge) rec.badge.remove(); rec.badge = null; return; }
    if (!rec.badge || !rec.badge.isConnected) {
      rec.badge = document.createElement('span');
      rec.badge.className = 'pe-badge';
      rec.badge.style.cssText = 'display:inline-flex;vertical-align:middle;align-items:center;justify-content:center;margin-left:5px;min-width:23px;height:17px;padding:0 4px;border-radius:5px;color:#101010;font:800 10px/17px system-ui;box-shadow:0 1px 3px #0006;pointer-events:auto';
      const ticker = findNameElement(rec);
      if (ticker) ticker.insertAdjacentElement('afterend', rec.badge);
      else {
        const heading = rec.el.querySelector('[class*="symbol"],[class*="ticker"],[class*="name"]');
        if (heading) heading.appendChild(rec.badge);
        else rec.el.appendChild(rec.badge);
      }
    }
    const activityText = isHighActivity(rec) ? ' 🔥' : '';
    const badgeText = String(rec.score) + activityText;
    if (rec.badge.textContent !== badgeText) rec.badge.textContent = badgeText;
    rec.badge.style.background = COLORS[rec.grade];
    rec.badge.title = 'Discovery score ' + rec.score + '/100\n' + rec.reasons.map(r => (r.d > 0 ? '+' : '') + r.d + ' ' + r.label).join('\n') + '\nScoring inputs present: ' + (rec.signalCoverage || 0) + '/10 · concentration metrics present: ' + rec.coverage + '/7' + (activityText ? '\nHigh visible activity: ' + rec.t.buys + ' buys / ' + rec.t.sells + ' sells (counts may be cumulative).' : '');
  }
  function paintWarningBadge(rec) {
    const warnings = warningChecks(rec.t);
    if (!warnings.length) {
      if (rec.warningBadge) rec.warningBadge.remove();
      rec.warningBadge = null;
      return;
    }
    if (!rec.warningBadge || !rec.warningBadge.isConnected) {
      rec.warningBadge = document.createElement('span');
      rec.warningBadge.className = 'pe-warning-badge';
      rec.warningBadge.textContent = '!';
      rec.warningBadge.setAttribute('aria-label', 'Token warnings');
      rec.warningBadge.style.cssText = 'display:inline-flex;vertical-align:middle;align-items:center;justify-content:center;width:16px;height:16px;margin-right:4px;border-radius:50%;font:900 11px/16px system-ui;box-shadow:0 1px 3px #0008;cursor:help';
      const ticker = findNameElement(rec);
      if (ticker) ticker.insertAdjacentElement('beforebegin', rec.warningBadge);
      else {
        const heading = rec.el.querySelector('[class*="symbol"],[class*="ticker"],[class*="name"]');
        if (heading) heading.insertBefore(rec.warningBadge, heading.firstChild);
        else rec.el.insertBefore(rec.warningBadge, rec.el.firstChild);
      }
    }
    const colors = warningBadgeColors(warnings.length);
    rec.warningBadge.style.background = colors.background;
    rec.warningBadge.style.color = colors.foreground;
    rec.warningBadge.title = colors.label + ' — not financial advice:\n' + warnings.join('\n');
  }
  function isHighActivity(rec) {
    return rec && rec.t && rec.t.buys != null && rec.t.sells != null && rec.t.buys >= 25 && rec.t.sells >= 25 && rec.t.buys + rec.t.sells >= 100;
  }
  function findNameElement(rec) {
    const wanted = new Set([rec.t.symbol, rec.t.name].filter(Boolean).map(x => String(x).trim().toLowerCase()));
    if (!wanted.size) return null;
    let match = null;
    for (const el of rec.el.querySelectorAll('*')) {
      if (el.classList && el.classList.contains('pe-badge')) continue;
      const text = (el.textContent || '').trim().toLowerCase();
      if (wanted.has(text) || wanted.has(text.replace(/^\$/, ''))) {
        if (!match || el.childElementCount < match.childElementCount) match = el;
        if (el.childElementCount === 0) return el;
      }
    }
    return match;
  }

  function stylePage() {
    if (document.getElementById('padre-edge-page-style')) return;
    const st = document.createElement('style'); st.id = 'padre-edge-page-style';
    st.textContent = '[data-pe-grade]{position:relative!important}[data-pe-grade]::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--pe-color,#4ade80);z-index:10;pointer-events:none;border-radius:2px 0 0 2px}';
    (document.head || document.documentElement).appendChild(st);
  }

  function buildUI() {
    const host = document.createElement('div');
    host.id = 'padre-edge-host';
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483000;pointer-events:none';
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        *{box-sizing:border-box} .panel{position:fixed;right:18px;top:88px;width:370px;max-height:78vh;display:flex;flex-direction:column;background:#101010;color:#e8e8e8;border:1px solid #303030;border-radius:12px;box-shadow:0 12px 40px #0009;font:12px/1.4 ui-sans-serif,system-ui;pointer-events:auto;overflow:hidden}.tab[hidden],.pane[hidden]{display:none!important}
        .head{display:flex;align-items:center;gap:7px;padding:10px;background:#171717;border-bottom:1px solid #292929}.dot{width:8px;height:8px;border-radius:50%;background:#4ade80}.title{font-weight:800}.count{font-size:10px;color:#888}.spacer{flex:1}.head button,.btn,.tab{cursor:pointer;color:#bbb;background:#1b1b1b;border:1px solid #333;border-radius:6px;padding:5px 8px;font:600 10px system-ui}.tabs{display:flex;gap:3px;padding:6px 8px 0;border-bottom:1px solid #282828}.tab{flex:1;border:0;border-bottom:2px solid transparent;background:transparent;padding:8px 3px}.tab.active{color:#fff;border-bottom-color:#4ade80}.body{overflow:auto;min-height:0;padding:8px}.pane{display:none}.pane.active{display:block}.row{display:flex;align-items:center;gap:7px;padding:7px;margin-bottom:5px;background:#171717;border:1px solid #262626;border-radius:8px;cursor:pointer}.score{width:31px;height:31px;border-radius:7px;display:grid;place-items:center;color:#111;font-weight:900;flex:none}.main{flex:1;min-width:0}.line{display:flex;align-items:center;gap:5px;white-space:nowrap;overflow:hidden}.sym{font-weight:800;color:#fff}.muted{font-size:10px;color:#888}.meta{font-size:10px;color:#999;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.chip{font-size:9px;border:1px solid #333;border-radius:4px;padding:1px 4px;color:#aaa}.controls{display:flex;gap:6px;align-items:center;margin-bottom:8px;flex-wrap:wrap}.btn{background:#173c2b;border-color:#2e6748;color:#d9ffe6}.btn:hover{background:#205339}.btn.ghost{background:#181818;color:#aaa;border-color:#333}.small{font-size:9px;color:#777;line-height:1.4;margin:5px 2px 8px}.pattern{background:#151515;border:1px solid #292929;border-radius:8px;padding:8px;margin:6px 0}.pat-head{display:flex;justify-content:space-between;align-items:center}.signals{display:flex;gap:4px;flex-wrap:wrap;margin-top:6px}.bull{color:#4ade80;border:1px solid #205339}.bear{color:#f87171;border:1px solid #512929}.neutral{color:#fbbf24;border:1px solid #4b3a17}.settings label{display:flex;justify-content:space-between;padding:8px 3px;border-bottom:1px solid #242424}.foot{padding:6px 9px;border-top:1px solid #292929;font-size:9px;color:#777}.empty{text-align:center;color:#888;padding:24px 8px}.status{font-size:10px;color:#aaa}.form{background:#1a1a1a;color:#eee;border:1px solid #353535;border-radius:5px;padding:5px}
        .head{cursor:move;user-select:none;touch-action:none}.token-trade-link{display:inline-flex;align-items:center;gap:5px;color:inherit;text-decoration:none}.token-trade-link:hover .sym{text-decoration:underline;color:#9ae6b4}.age-filter{padding:4px 6px!important;flex:1}.age-filter.active{color:#fff;background:#285238;border-color:#4ade80}.wallet-toolbar{display:grid;grid-template-columns:1fr auto;gap:6px;margin:7px 0}.wallet-search{min-width:0;width:100%;background:#111;border:1px solid #343434;border-radius:6px;color:#eee;padding:7px 8px;font:11px system-ui}.wallet-filters{display:flex;gap:4px;margin:5px 0 8px}.wallet-filter.active{color:#fff;background:#285238;border-color:#4ade80}.wallet-item{background:#141414;border:1px solid #292929;border-radius:8px;padding:7px 8px;margin:5px 0}.wallet-top{display:flex;align-items:center;gap:5px;min-width:0}.wallet-address{font:700 11px ui-monospace,Consolas,monospace;color:#e7e7e7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}.wallet-status{font-size:9px;border:1px solid #333;border-radius:10px;padding:2px 6px;color:#aaa;white-space:nowrap}.wallet-status.open{color:#4ade80;border-color:#285238;background:#102017}.wallet-status.closed{color:#999}.wallet-roles{display:flex;gap:4px;flex-wrap:wrap;margin-top:4px}.wallet-metrics{display:grid;grid-template-columns:1fr 1fr;gap:2px 8px;margin-top:6px}.wallet-metric{font-size:10px;color:#999;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.wallet-metric b{color:#ddd;font-weight:600}.wallet-bottom{display:flex;gap:12px;justify-content:space-between;border-top:1px solid #242424;padding-top:5px;margin-top:5px}.wallet-bottom .wallet-metric{font-size:10px}.wallet-bottom .pnl-positive{color:#4ade80}.wallet-bottom .pnl-negative{color:#f87171}.wallet-actions{display:flex;gap:5px;margin-top:6px}.wallet-actions .btn{padding:4px 6px}.panel.minimized .tabs,.panel.minimized .body,.panel.minimized .foot{display:none}.panel.minimized{width:auto;max-height:none}
        .wallet-open{background:none;border:0;padding:0;text-align:left;cursor:pointer}.wallet-open:hover{color:#9ae6b4;text-decoration:underline}
        /* UI shell v1.6.0: icon tabs, compact header, status strip */
        .panel{width:380px;max-height:82vh;background:#0e0e0e;border-color:#2a2a2a}
        .head{gap:8px;padding:8px 10px;background:#141414;border-bottom:1px solid #242424}
        .head .title{font:800 12px/1.2 ui-sans-serif,system-ui;letter-spacing:.2px;white-space:nowrap}
        .head .count{font:600 10px/1 ui-sans-serif,system-ui;color:#9a9a9a;background:#1d1d1d;border:1px solid #2f2f2f;border-radius:20px;padding:3px 7px}
        .dot{width:7px;height:7px;flex:none;background:#4ade80;box-shadow:0 0 0 3px #4ade801f;transition:background .12s}
        .dot.loading{background:#fbbf24;box-shadow:0 0 0 3px #fbbf241f}
        .dot.error{background:#f87171;box-shadow:0 0 0 3px #f871711f}
        .head button.icon-btn{display:grid;place-items:center;width:24px;height:24px;padding:0;background:transparent;border:1px solid transparent;border-radius:6px;color:#9a9a9a}
        .head button.icon-btn:hover{background:#1f1f1f;border-color:#333;color:#eee}
        .tabs{gap:2px;padding:4px 6px 0;background:#111;border-bottom:1px solid #242424}
        .tab{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;flex:1;min-width:0;padding:7px 2px 6px;border:0;border-bottom:2px solid transparent;border-radius:0;background:transparent;color:#8a8a8a;font:600 9px/1 ui-sans-serif,system-ui;white-space:nowrap}
        .tab svg{opacity:.9}
        .tab:hover{color:#d0d0d0;background:#171717}
        .tab.active{color:#fff;border-bottom-color:#4ade80;background:transparent}
        .tab.active svg{color:#4ade80}
        .body{padding:8px 8px 10px}
        .foot{display:flex;align-items:center;gap:8px;padding:6px 9px;background:#0f0f0f;border-top:1px solid #242424;font:500 9px/1.3 ui-sans-serif,system-ui;color:#6f6f6f;white-space:nowrap;overflow:hidden}
        .foot .foot-right{margin-left:auto;display:flex;gap:8px;align-items:center;color:#8a8a8a}
        .foot .foot-item{display:inline-flex;align-items:center;gap:4px;min-width:0;overflow:hidden;text-overflow:ellipsis}
        .foot .foot-item svg{opacity:.8;flex:none}
        .foot .foot-item b{font-weight:600;color:#9a9a9a}
        .panel.minimized{width:auto}
        .panel.minimized .head{border-bottom:0}
        @media (max-width:379px){.tab span{display:none}.tab{padding:9px 2px}}
        :focus-visible{outline:2px solid #4ade80;outline-offset:1px}
        /* Phase 2: token cards, toolbars, info popover */
        .icon-btn{display:grid;place-items:center;width:26px;height:26px;padding:0;background:#1b1b1b;border:1px solid #333;border-radius:6px;color:#b6b6b6;cursor:pointer;flex:none}
        .icon-btn:hover{background:#242424;border-color:#454545;color:#fff}
        .icon-btn:disabled{opacity:.4;cursor:default}
        .btn:disabled{opacity:.45;cursor:default}
        .toolbar{display:flex;align-items:center;gap:6px;margin:0 0 7px;min-height:26px}
        .toolbar-label{display:inline-flex;align-items:center;gap:4px;font:600 10px/1 ui-sans-serif,system-ui;color:#9a9a9a;letter-spacing:.2px;text-transform:uppercase}
        .toolbar-spacer{flex:1}
        .info-btn{display:inline-grid;place-items:center;width:16px;height:16px;padding:0;background:transparent;border:0;border-radius:50%;color:#6f6f6f;cursor:help;flex:none}
        .info-btn:hover,.info-btn:focus-visible{color:#7dd3fc;background:#7dd3fc1a}
        .info-pop{position:fixed;z-index:10;max-width:240px;padding:8px 9px;background:#1c1c1c;border:1px solid #3a3a3a;border-radius:8px;box-shadow:0 8px 24px #000a;color:#d4d4d4;font:400 10px/1.45 ui-sans-serif,system-ui;pointer-events:none}
        .info-pop[hidden]{display:none}
        .controls.age-filters{gap:3px;margin-bottom:8px;flex-wrap:nowrap}
        .age-filter{border-radius:6px!important;border:1px solid #2f2f2f!important;background:#171717!important;color:#8f8f8f!important;font:600 9px/1 ui-sans-serif,system-ui!important;padding:5px 4px!important;min-width:0}
        .age-filter:hover{color:#d0d0d0!important;border-color:#3f3f3f!important}
        .age-filter.active{color:#fff!important;background:#1d3528!important;border-color:#4ade80!important}
        .row{gap:8px;padding:8px;margin-bottom:6px;background:#151515;border-color:#282828;border-radius:8px;transition:border-color .12s,background .12s}
        .row:hover{background:#191919;border-color:#3a3a3a}
        .row .score{width:34px;height:34px;border-radius:8px;font:900 13px/1 ui-sans-serif,system-ui;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:0;line-height:1}
        .row .score .fire{font-size:8px;line-height:1;margin-top:1px}
        .row .line{gap:5px}
        .row .sym{font:800 12px/1.2 ui-sans-serif,system-ui}
        .row .muted{font:400 10px/1.2 ui-sans-serif,system-ui;color:#8a8a8a;overflow:hidden;text-overflow:ellipsis}
        .row .meta{font:500 10px/1.5 ui-monospace,Consolas,monospace;color:#8f8f8f}
        .row .meta.risk{color:#9a9a9a;font-family:ui-sans-serif,system-ui;display:flex;align-items:center;gap:4px;min-width:0}
        .row .trade-live-facts{display:flex;gap:9px;flex-wrap:wrap;color:#888;font:500 9px/1.45 ui-sans-serif,system-ui}
        .row .trade-live-facts>b{color:#4ade80;font-weight:700}
        .row .trade-live-facts span{white-space:nowrap}
        .row .trade-live-facts span b{color:#ddd;font:700 9px ui-monospace,Consolas,monospace;margin-left:3px}
        .row .meta.risk span.trunc{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
        .row .chip{font:600 9px/1 ui-sans-serif,system-ui;padding:2px 5px;border-radius:4px;flex:none}
        .row .chip.age{color:#9a9a9a;border-color:#333;background:#1b1b1b}
        .row .chip.more{color:#7dd3fc;border-color:#1f3d4d;background:#0f1e26;cursor:help}
        .row .evidence{color:#9a9a9a;border-bottom:1px dotted #555;cursor:help}
        .row-chart{width:28px;height:28px;align-self:center}
        .empty{display:flex;flex-direction:column;align-items:center;gap:7px;padding:22px 12px;text-align:center;color:#7d7d7d;font:400 11px/1.4 ui-sans-serif,system-ui;background:#121212;border:1px dashed #2c2c2c;border-radius:8px}
        .empty svg{color:#4a4a4a}
        .empty .btn{margin-top:2px}
        /* Phase 3: wallet cards, search, pager */
        .info-pop{white-space:pre-line}
        .wallet-filters{display:flex;gap:3px;margin:0 0 6px;flex-wrap:nowrap}
        .wallet-filter{flex:1;min-width:0;padding:5px 4px;background:#171717;border:1px solid #2f2f2f;border-radius:6px;color:#8f8f8f;font:600 9px/1 ui-sans-serif,system-ui;cursor:pointer}
        .wallet-filter:hover{color:#d0d0d0;border-color:#3f3f3f}
        .wallet-filter.active{color:#fff;background:#1d3528;border-color:#4ade80}
        .wallet-search-wrap{position:relative;display:flex;align-items:center;gap:6px;margin:0 0 7px;padding:0 7px;height:30px;background:#121212;border:1px solid #303030;border-radius:6px;color:#6f6f6f}
        .wallet-search-wrap:focus-within{border-color:#4ade80;color:#9a9a9a}
        .wallet-search-wrap .wallet-search{flex:1;min-width:0;width:auto;padding:0;background:transparent;border:0;outline:0;color:#ededed;font:500 11px/1 ui-sans-serif,system-ui}
        .wallet-search::-webkit-search-cancel-button{display:none}
        .wallet-clear{display:none;place-items:center;width:18px;height:18px;padding:0;background:transparent;border:0;border-radius:4px;color:#7d7d7d;cursor:pointer;flex:none}
        .wallet-search-wrap.has-value .wallet-clear{display:grid}
        .wallet-clear:hover{color:#fff;background:#2a2a2a}
        .wallet-item{padding:6px 8px;margin:0 0 5px;background:#151515;border-color:#282828;border-radius:8px}
        .wallet-top{gap:7px}
        .wallet-address{font:700 11px/1.3 ui-monospace,Consolas,monospace;color:#ededed}
        .wallet-status{display:inline-flex;align-items:center;gap:4px;font:600 9px/1 ui-sans-serif,system-ui;padding:3px 6px;border-radius:10px;background:#1b1b1b;border-color:#333;color:#9a9a9a}
        .wallet-status::before{content:"";width:5px;height:5px;border-radius:50%;background:currentColor;flex:none}
        .wallet-status.open{color:#4ade80;border-color:#285238;background:#102017}
        .wallet-status.closed{color:#8a8a8a}
        .wallet-copy{width:20px;height:20px;border-radius:4px;background:transparent;border-color:transparent;color:#6f6f6f}
        .wallet-copy:hover{background:#242424;border-color:#3a3a3a;color:#ddd}
        .wallet-roles{display:flex;gap:4px;flex-wrap:nowrap;overflow:hidden;margin-top:2px;font:500 9px/1.35 ui-sans-serif,system-ui;color:#8a8a8a;white-space:nowrap;text-overflow:ellipsis}
        .wallet-roles .chip{flex:none;border-radius:4px;padding:1px 4px;font-size:9px}
        .wallet-metrics{gap:0 10px;margin-top:4px}
        .wallet-metric{font:500 10px/1.4 ui-sans-serif,system-ui;color:#8a8a8a}
        .wallet-metric b{font:700 10px/1.4 ui-monospace,Consolas,monospace;color:#dedede;margin-left:3px}
        .wallet-bottom{border-top-color:#242424;padding-top:4px;margin-top:4px}
        .wallet-bottom .wallet-metric{display:inline-flex;align-items:baseline;gap:3px}
        .wallet-bottom .pnl-positive b{color:#4ade80}
        .wallet-bottom .pnl-negative b{color:#f87171}
        .pager{display:flex;align-items:center;justify-content:center;gap:10px;padding:4px 0 2px}
        .pager .muted{font:600 9px/1 ui-sans-serif,system-ui;color:#8a8a8a;min-width:78px;text-align:center}
        .pager .icon-btn{width:24px;height:24px}
        .icon-btn.loading{color:#fbbf24;border-color:#4b3a17}
        /* Phase 4: pattern toolbar, progress, cards */
        .seg{display:inline-flex;gap:2px;padding:2px;background:#161616;border:1px solid #2f2f2f;border-radius:6px}
        .seg-btn{padding:3px 7px;background:transparent;border:0;border-radius:4px;color:#8a8a8a;font:600 9px/1 ui-sans-serif,system-ui;cursor:pointer}
        .seg-btn:hover{color:#d0d0d0}
        .seg-btn.active{background:#243a2c;color:#fff}
        .progress-row{display:flex;align-items:center;gap:7px;margin:0 0 8px}
        .progress-track{flex:1;height:2px;background:#242424;border-radius:2px;overflow:hidden}
        .progress-fill{height:100%;width:0;background:#4ade80;transition:width .12s}
        .progress-label{font:600 9px/1 ui-monospace,Consolas,monospace;color:#8a8a8a;white-space:nowrap;min-width:34px;text-align:right}
        .patterns .pattern{padding:8px;margin:0 0 6px;background:#151515;border-color:#282828}
        .patterns .pattern:hover{border-color:#3a3a3a}
        .patterns .pattern.selected{border-color:#4ade80}
        .pat-head{align-items:flex-start;gap:6px}
        .pat-title{display:flex;align-items:center;gap:4px;min-width:0}
        .pat-title .token-trade-link{min-width:0;overflow:hidden}
        .pat-title b{font:800 12px/1.2 ui-sans-serif,system-ui;color:#fff}
        .pat-title .muted{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .pat-status{font:600 8px/1 ui-sans-serif,system-ui;padding:3px 5px;border-radius:4px;border:1px solid #333;background:#1b1b1b;color:#9a9a9a;white-space:nowrap;flex:none}
        .pat-status.ready{color:#4ade80;border-color:#285238;background:#102017}
        .pat-status.loading{color:#fbbf24;border-color:#4b3a17;background:#1f1a0b}
        .pat-status.error{color:#f87171;border-color:#512929;background:#1f1010}
        .pat-status.missing{color:#a3a3a3;border-color:#3a3a3a}
        .pat-metrics{display:flex;flex-wrap:wrap;gap:2px 10px;margin-top:5px;font:500 9px/1.5 ui-sans-serif,system-ui;color:#7d7d7d}
        .pat-metrics b{font:700 10px/1.5 ui-monospace,Consolas,monospace;color:#cfcfcf;margin-left:2px}
        .pat-metrics .pos b{color:#4ade80}
        .pat-metrics .neg b{color:#f87171}
        .bot-title-row{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:3px 1px 9px}.bot-eyebrow,.bot-section-label{font:800 9px/1.2 ui-sans-serif,system-ui;letter-spacing:.7px;color:#777}.bot-token{display:block;margin-top:3px;font:800 13px/1.25 ui-sans-serif,system-ui;color:#f3f4f6;overflow-wrap:anywhere}.bot-feed{flex:none;padding:4px 7px;border:1px solid #285238;border-radius:12px;background:#102017;color:#86efac;font:700 9px/1.2 ui-sans-serif,system-ui}.bot-grid{display:grid;gap:6px}.bot-market-grid,.bot-account-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.bot-kpi{min-width:0;padding:8px 7px;background:#151a17;border:1px solid #29352d;border-radius:7px}.bot-kpi span{display:block;color:#8f9a92;font:600 9px/1.2 ui-sans-serif,system-ui}.bot-kpi b{display:block;margin-top:5px;color:#f0f4f1;font:800 12px/1.2 ui-monospace,Consolas,monospace;overflow-wrap:anywhere}.bot-section-label{margin:11px 0 5px;color:#a0a8a2}.bot-rule-grid{grid-template-columns:1fr 1fr}.bot-rule{padding:8px;background:#171714;border:1px solid #3a3320;border-radius:7px}.bot-rule span{display:block;color:#fbbf24;font:800 8px/1.2 ui-sans-serif,system-ui;letter-spacing:.6px}.bot-rule b{display:block;margin-top:4px;color:#f3f0e8;font:700 10px/1.35 ui-sans-serif,system-ui}.bot-rule small{display:block;margin-top:3px;color:#aaa394;font:500 9px/1.3 ui-sans-serif,system-ui}.bot-signal{margin-top:9px;padding:8px 9px;border-left:3px solid #60a5fa;border-radius:4px;background:#121a24;color:#cbd5e1;font:600 10px/1.4 ui-sans-serif,system-ui}.bot-run-row{display:flex;align-items:center;gap:9px;margin-top:9px}.bot-run-btn{min-width:140px;min-height:32px;font-size:11px!important}.bot-run-status{color:#a7f3d0;font:600 9px/1.3 ui-sans-serif,system-ui}.bot-assumptions{margin-top:9px;padding:7px 8px;background:#141414;border:1px solid #2d2d2d;border-radius:6px;color:#b8b8b8;font:500 9px/1.4 ui-sans-serif,system-ui}.bot-assumptions summary{color:#cfcfcf;font-weight:700;cursor:pointer}.bot-assumptions div{padding-top:6px;color:#999}.bot-history{display:grid;gap:4px;color:#aaa;font:500 9px/1.4 ui-sans-serif,system-ui}.bot-trade-row{display:flex;justify-content:space-between;gap:6px;padding:5px 7px;background:#151515;border:1px solid #292929;border-radius:5px}.bot-trade-row b{font-family:ui-monospace,Consolas,monospace}.bot-disclaimer{margin-top:9px;color:#777;font:500 9px/1.4 ui-sans-serif,system-ui}
        .bot-mode-row{display:flex;align-items:center;gap:5px;margin:0 0 8px;padding:6px 7px;background:#151515;border:1px solid #292929;border-radius:6px;color:#999;font:600 9px ui-sans-serif,system-ui}.bot-mode-row .btn{padding:4px 7px!important;font-size:9px!important}.bot-mode-row .btn.active{color:#a7f3d0;border-color:#28643c;background:#102017}.bot-live-review{margin-top:8px;padding:8px;background:#1a1710;border:1px solid #59451e;border-radius:7px}.bot-live-review[hidden]{display:none}.bot-live-detail{margin:5px 0;color:#ddd;font:600 9px/1.45 ui-sans-serif,system-ui;overflow-wrap:anywhere}.bot-live-review small{display:block;margin-top:6px;color:#b5a987;font:500 9px/1.4 ui-sans-serif,system-ui}.bot-config{margin:8px 0}.bot-config-grid{display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;padding-top:8px}.bot-strategy-switch{grid-column:1/-1;display:grid;grid-template-columns:1fr 1fr;gap:5px}.bot-strategy-switch .btn{min-height:30px;padding:5px 7px!important;font-size:9px!important;white-space:normal}.bot-strategy-switch .btn.active{border-color:#3b8052;background:#14251a;color:#a7f3c7}.bot-config-grid [hidden]{display:none!important}.bot-config-grid label{display:flex;align-items:center;justify-content:space-between;gap:6px;color:#aaa;font:600 9px/1.2 ui-sans-serif,system-ui}.bot-config-grid input,.bot-config-grid select{width:88px;min-width:0;padding:5px 6px;border:1px solid #3a3a3a;border-radius:5px;background:#0e0e0e;color:#eee;font:700 10px ui-monospace,Consolas,monospace;text-align:right}.bot-config-grid input:focus,.bot-config-grid select:focus{outline:1px solid #4ade80;border-color:#4ade80}.bot-recommend-row{display:flex;align-items:center;gap:6px;margin-top:8px}.bot-recommend-row .btn{flex:none;padding:5px 7px!important;font-size:9px!important}.bot-recommend-row span{color:#888;font:500 8px/1.35 ui-sans-serif,system-ui}.bot-preset-row{display:flex;align-items:center;gap:4px;margin-top:8px}.bot-preset-row select{flex:1;min-width:0;padding:5px;background:#111;color:#ddd;border:1px solid #333;border-radius:5px;font:600 9px ui-sans-serif,system-ui}.bot-preset-row .btn{padding:4px 6px!important;font-size:9px!important}.bot-config-apply{margin-top:8px;padding:6px 9px!important;font-size:10px!important}.bot-log-heading{display:flex;align-items:center;justify-content:space-between;gap:6px;margin-top:10px}.bot-log-heading .bot-section-label{margin:0}.bot-log-actions{display:flex;gap:4px}.bot-log-actions .btn{padding:3px 6px!important;font-size:8px!important}.bot-log-list{display:grid;gap:3px;margin-top:5px}.bot-log-row{display:grid;grid-template-columns:45px auto auto minmax(50px,1fr);align-items:center;gap:5px;padding:4px 5px;border:1px solid #292929;border-radius:4px;background:#141414;color:#aaa;font:500 8px/1.25 ui-sans-serif,system-ui}.bot-log-time{color:#777;font-family:ui-monospace,Consolas,monospace}.bot-log-reason{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:#999}.bot-log-note{margin-top:4px;color:#777;font:500 8px/1.35 ui-sans-serif,system-ui}
        .bot-pane{padding-bottom:5px}.bot-title-row{padding:5px 3px 10px}.bot-mode-row{min-height:36px;background:linear-gradient(120deg,#171a18,#141414);border-color:#303732}.bot-mode-label{font-size:8px;font-weight:800;letter-spacing:.7px;color:#7f8b82}.bot-auto-note{margin-left:auto;color:#777;font:600 8px/1.2 ui-sans-serif,system-ui;white-space:nowrap}.bot-market-grid{gap:5px}.bot-market-grid .bot-kpi{padding:8px 7px;background:#111713;border-color:#26332a}.bot-market-grid .bot-kpi b{font-size:11px}.bot-run-row{margin-top:8px;padding:8px;background:#111512;border:1px solid #29332d;border-radius:8px}.bot-run-btn{flex:none;min-width:130px;min-height:34px;border:1px solid #2f8650!important;background:#143321!important;color:#a7f3c7!important}.bot-run-btn:hover{background:#19432b!important}.bot-run-btn.is-running{border-color:#8f3939!important;background:#321919!important;color:#fecaca!important}.bot-run-status{flex:1;min-width:0;overflow-wrap:anywhere;color:#9ca99f}.bot-section-label{margin:12px 1px 6px;font-size:8px;letter-spacing:.8px}.bot-rule-grid{gap:7px}.bot-rule{min-height:73px;padding:9px;background:linear-gradient(145deg,#191a16,#141414);border-color:#332f23}.bot-entry-rule{border-top:2px solid #43b581}.bot-exit-rule{border-top:2px solid #e2a64b}.bot-rule span{font-size:8px;letter-spacing:.9px}.bot-rule b{font-size:10px;line-height:1.4}.bot-rule small{font-size:9px;line-height:1.35}.bot-account-grid .bot-kpi{padding:8px;background:#121613;border-color:#29322d}.bot-account-grid .bot-kpi span{font-size:8px}.bot-account-grid .bot-kpi b{font-size:11px}.bot-signal{margin-top:8px;padding:9px 10px;border-left-width:3px;background:#111821;line-height:1.45}.bot-config,.bot-history-details,.bot-log-details{margin-top:8px;padding:0 8px;background:#131313;border-color:#2c2c2c}.bot-assumptions summary{position:relative;padding:8px 0;list-style:none}.bot-assumptions summary::-webkit-details-marker{display:none}.bot-assumptions summary:after{content:"＋";float:right;color:#777}.bot-assumptions[open] summary:after{content:"−"}.bot-config-grid{padding:2px 0 5px}.bot-preset-row .btn{white-space:nowrap}.bot-recommend-row span{font-size:8px}.bot-history-details .bot-history{padding:0 0 8px}.bot-log-details .bot-log-actions{padding:0 0 5px}.bot-log-details .bot-log-list{padding-bottom:5px}.bot-log-details .bot-log-note{padding-bottom:8px}.bot-live-actions{display:flex;flex-wrap:wrap;gap:5px;margin-top:7px}.bot-live-actions .btn{min-height:28px;padding:5px 7px!important;font-size:9px!important}.bot-live-review{padding:10px;background:linear-gradient(145deg,#1c190f,#14120d);border-color:#59451e}.bot-disclaimer{padding:4px 2px;color:#737373;line-height:1.45}
        .bot-live-actions [hidden]{display:none!important}
        .patterns .signals{gap:3px;margin-top:5px}
        .patterns .signals .chip{font:500 9px/1.3 ui-sans-serif,system-ui;padding:2px 5px;border-radius:4px}
        .pat-actions{display:flex;align-items:center;gap:7px;margin-top:6px}
        .pat-actions .btn{display:inline-flex;align-items:center;gap:4px;padding:4px 7px;font-size:9px}
        .pat-actions .muted{margin-left:auto;font:500 9px/1 ui-monospace,Consolas,monospace;color:#6f6f6f;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .pat-error{display:flex;align-items:center;gap:6px;margin-top:6px;padding:5px 6px;background:#1f1010;border:1px solid #512929;border-radius:5px;color:#fca5a5;font:500 9px/1.35 ui-sans-serif,system-ui}
        .pat-error span{flex:1;min-width:0}
        .pat-error .btn{padding:3px 6px;font-size:9px;flex:none}
        .pat-detail{margin-top:6px;padding-top:6px;border-top:1px solid #242424}
        .pat-detail .small{margin:4px 0}
        .pat-wallet{display:flex;align-items:center;gap:5px;margin:3px 0;font:500 9px/1.4 ui-monospace,Consolas,monospace;color:#8a8a8a}
        /* Phase 5: X mentions */
        .x-token{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:6px 8px;margin:0 0 6px;background:#151515;border:1px solid #282828;border-radius:6px;font:600 10px/1.3 ui-sans-serif,system-ui;color:#8a8a8a}
        .x-token b{color:#fff;font-weight:800}
        .x-token .meta{font:500 9px/1.3 ui-monospace,Consolas,monospace;color:#8a8a8a}
        .x-token button{background:transparent;border:1px dashed #3a3a3a;border-radius:5px;padding:3px 7px;color:#8a8a8a;font:600 9px/1 ui-sans-serif,system-ui;cursor:pointer}
        .x-token button:hover{color:#ddd;border-color:#555}
        .x-actions{display:flex;align-items:center;gap:8px;margin:0 0 7px;min-width:0}
        .x-actions .btn{display:inline-flex;align-items:center;gap:4px;padding:5px 8px;flex:none}
        .x-status{font:500 9px/1.3 ui-sans-serif,system-ui;color:#8a8a8a;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .x-post{padding:7px 8px;margin:0 0 6px;background:#151515;border:1px solid #282828;border-radius:7px}
        .x-post:hover{border-color:#3a3a3a}
        .x-post .x-head{display:flex;align-items:center;gap:6px;min-width:0}
        .x-post .x-avatar{width:24px;height:24px;border-radius:50%;object-fit:cover;background:#292929;flex:none}
        .x-post .x-author-wrap{display:flex;flex-direction:column;min-width:0;overflow:hidden}
        .x-post .x-display{font:700 10px/1.2 ui-sans-serif,system-ui;color:#ededed;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .x-post .x-author{font:500 9px/1.2 ui-sans-serif,system-ui;color:#777;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .x-post .x-time{font:500 9px/1.3 ui-sans-serif,system-ui;color:#6f6f6f;margin-left:auto;flex:none}
        .x-post .x-text{display:-webkit-box;-webkit-line-clamp:6;-webkit-box-orient:vertical;overflow:hidden;margin-top:6px;font:400 10px/1.45 ui-sans-serif,system-ui;color:#cfcfcf;white-space:pre-wrap;word-break:break-word}
        .x-post .x-media{display:block;width:100%;max-height:150px;object-fit:cover;margin-top:6px;border:1px solid #2d2d2d;border-radius:6px;background:#101010}
        .x-post .x-meta{margin-top:4px;font:500 9px/1.3 ui-monospace,Consolas,monospace;color:#6f6f6f}
        /* Phase 6: settings */
        .settings-group{margin:0 0 10px;background:#151515;border:1px solid #282828;border-radius:8px;overflow:hidden}
        .settings-title{display:flex;align-items:center;gap:5px;padding:6px 9px;background:#181818;border-bottom:1px solid #262626;font:700 9px/1 ui-sans-serif,system-ui;color:#9a9a9a;text-transform:uppercase;letter-spacing:.4px}
        .setting-row{display:flex;align-items:center;gap:10px;padding:7px 9px;border-bottom:1px solid #212121;cursor:pointer}
        .setting-row:last-child{border-bottom:0}
        .setting-row > span{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1}
        .setting-row b{font:600 10px/1.3 ui-sans-serif,system-ui;color:#dedede}
        .setting-row small{font:400 9px/1.3 ui-sans-serif,system-ui;color:#777;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .setting-row input[type="checkbox"]{appearance:none;width:28px;height:16px;border-radius:9px;background:#2a2a2a;border:1px solid #3a3a3a;position:relative;cursor:pointer;flex:none;transition:background .12s,border-color .12s}
        .setting-row input[type="checkbox"]::after{content:"";position:absolute;top:2px;left:2px;width:10px;height:10px;border-radius:50%;background:#8a8a8a;transition:transform .12s,background .12s}
        .setting-row input[type="checkbox"]:checked{background:#1d3528;border-color:#4ade80}
        .setting-row input[type="checkbox"]:checked::after{transform:translateX(12px);background:#4ade80}
        .setting-row input[type="number"]{width:58px;text-align:center;flex:none}
        .setting-row .btn{padding:4px 8px;flex:none;font-size:9px}
      </style>
      <div class="panel">
        <div class="head"><span class="dot" title="Scanner idle"></span><span class="title">Trenches Edge</span><span class="count">0</span><span class="spacer"></span><button class="icon-btn" data-action="minimize" aria-label="Minimize panel" title="Minimize">${icon('chevron-up')}</button></div>
        <div class="tabs" role="tablist" aria-label="Trenches Edge sections">
          <button class="tab active" data-tab="recommended" role="tab" aria-selected="true" title="Recommended Buys">${icon('spark')}<span>Picks</span></button>
          <button class="tab" data-tab="picks" role="tab" aria-selected="false" title="Token Risk">${icon('shield')}<span>Risk</span></button>
          <button class="tab" data-tab="wallets" role="tab" aria-selected="false" title="Wallets">${icon('users')}<span>Wallets</span></button>
          <button class="tab" data-tab="patterns" role="tab" aria-selected="false" title="Pattern Recognition">${icon('chart')}<span>Charts</span></button>
          <button class="tab" data-tab="bot" role="tab" aria-selected="false" title="Swing bot" hidden>${icon('play')}<span>Bot</span></button>
          <button class="tab" data-tab="xmentions" role="tab" aria-selected="false" title="X Mentions">${icon('at')}<span>X</span></button>
          <button class="tab" data-tab="settings" role="tab" aria-selected="false" title="Settings">${icon('sliders')}<span>Settings</span></button>
        </div>
        <div class="body">
          <section role="tabpanel" class="pane active" data-pane="recommended"><div class="toolbar"><span class="toolbar-label">Top 5 by score ${infoBtn('Ranks visible Trenches cards using MC/FDV, liquidity, volume/activity, sparkline momentum and buy/sell flow, reduced by observable concentration risks. Sparkline period and cumulative count windows may be unknown. Heuristic only, not an automatic buy signal.', 'About picks')}</span><span class="toolbar-spacer"></span><span class="muted" data-picks-count></span></div><div class="controls age-filters"></div><div class="top-picks"></div></section>
          <section role="tabpanel" class="pane" data-pane="picks"><div class="toolbar"><span class="toolbar-label">Discovery score ${infoBtn('Score combines available market/activity signals with observable holder-concentration penalties. Missing data is neutral, and coverage is shown separately; score is not proof of safety or a buy instruction.', 'About scores')}</span><span class="toolbar-spacer"></span><button class="icon-btn" data-action="scan" aria-label="Rescan tokens" title="Rescan tokens">${icon('refresh', 14)}</button></div><div class="controls age-filters"></div><div class="list"></div></section>
          <section role="tabpanel" class="pane" data-pane="wallets"><div class="toolbar"><span class="muted" data-wallet-count>0 wallets</span><span class="muted" data-wallet-api-status></span><button class="btn ghost" data-action="wallet-api-retry" hidden>Retry stats</button><span class="toolbar-spacer"></span>${infoBtn('R. PnL is Padre’s token-table realized PnL, not unrealized PnL. Token PnL from mint-positions is shown separately and is token-scoped. Wallet overview metrics are account-wide.', 'About wallet data')}<select class="form" data-wallet-sort aria-label="Sort wallet rows" title="Sort wallet rows"><option value="realized">R. PnL ↓</option><option value="tokenPnl">Token PnL ↓</option><option value="priority">Priority</option><option value="volume">Volume ↓</option></select><button class="icon-btn" data-action="wallet-rescan" aria-label="Refresh wallet rows" title="Refresh wallet rows">${icon('refresh', 14)}</button></div><div class="wallet-filters"><button class="wallet-filter active" data-action="wallet-filter" data-wallet-filter="all">All</button><button class="wallet-filter" data-action="wallet-filter" data-wallet-filter="open">Open</button><button class="wallet-filter" data-action="wallet-filter" data-wallet-filter="closed">Closed</button></div><div class="wallet-search-wrap">${icon('search', 13)}<input class="wallet-search" type="search" placeholder="Search address, role, or token…" data-wallet-search><button class="wallet-clear" data-action="wallet-clear" aria-label="Clear wallet search" title="Clear search">${icon('close', 12)}</button></div><div class="wallets"></div><div class="pager"><button class="icon-btn" data-action="wallet-page-prev" aria-label="Previous page" title="Previous page">${icon('chevron-left', 14)}</button><span class="muted" data-wallet-page>Page 1 / 1</span><button class="icon-btn" data-action="wallet-page-next" aria-label="Next page" title="Next page">${icon('chevron-right', 14)}</button></div></section>
           <section role="tabpanel" class="pane" data-pane="patterns"><div class="toolbar"><span class="toolbar-label">Padre chart analysis · 1s ${infoBtn('Chart analysis uses the loaded Padre Terminal one-second candles. If the live chart data is unavailable, the analyzer reports that rather than silently substituting slower indexed candles. Chart signals are separate from the discovery score.', 'About chart analysis')}</span><span class="toolbar-spacer"></span><button class="icon-btn" data-action="patterns" aria-label="Analyze visible tokens" title="Analyze visible tokens">${icon('play', 13)}</button><button class="icon-btn" data-action="pattern-stop" aria-label="Stop chart analysis" title="Stop chart analysis">${icon('pause', 13)}</button></div><div class="progress-row"><div class="progress-track"><div class="progress-fill" data-pattern-bar></div></div><span class="progress-label" data-pattern-progress>Idle</span></div><div class="patterns"></div></section>
             <section role="tabpanel" class="pane bot-pane" data-pane="bot">
              <div class="bot-title-row"><div><div class="bot-eyebrow" data-bot-mode-label>DEMO SWING BOT</div><b class="bot-token" data-bot-token>Open token</b></div><span class="bot-feed" data-bot-feed-state>Waiting for chart</span></div>
              <div class="bot-mode-row"><span class="bot-mode-label">MODE</span><button class="btn ghost active" data-action="bot-mode" data-mode="demo">Demo</button><button class="btn ghost" data-action="bot-mode" data-mode="real">Real · auto</button><span class="bot-auto-note">Real orders use Padre’s native form</span></div>
              <div class="bot-grid bot-market-grid"><div class="bot-kpi"><span>1s candles</span><b data-bot-candle-count>—</b></div><div class="bot-kpi"><span>Last close</span><b data-bot-price>—</b></div><div class="bot-kpi"><span>Trade time</span><b data-bot-age>—</b></div></div>
              <div class="bot-run-row"><button class="btn bot-run-btn" data-action="bot-monitor">Start demo trading</button><span class="bot-run-status" data-bot-monitor-status>Demo stopped</span></div>
              <div class="bot-section-label" data-bot-strategy-label>STRATEGY</div>
              <div class="bot-grid bot-rule-grid"><div class="bot-rule bot-entry-rule"><span>ENTRY</span><b data-bot-entry-rule>Break above prior high, then retest</b><small data-bot-entry-volume>Volume-confirmed</small></div><div class="bot-rule bot-exit-rule"><span>EXIT</span><b data-bot-exit-rule>Stop · target</b><small data-bot-exit-note>Conservative candle handling</small></div></div>
              <div class="bot-section-label" data-bot-account-label>SIMULATED ACCOUNT</div>
              <div class="bot-grid bot-account-grid"><div class="bot-kpi"><span>Position</span><b data-bot-position>None</b></div><div class="bot-kpi"><span>Realized PnL</span><b data-bot-pnl>$0.00</b></div><div class="bot-kpi"><span>Closed</span><b data-bot-count>0</b></div></div>
              <div class="bot-signal" data-bot-signal>Waiting for a new candle after start.</div>
              <div class="bot-live-review" data-bot-live-review hidden><div class="bot-section-label">AUTO LIVE ORDER · PADRE NATIVE</div><div class="bot-live-detail" data-bot-live-detail>No pending live order.</div><div class="bot-live-detail" data-bot-form-summary>Padre order form not detected.</div><div class="bot-live-actions"><button class="btn bot-run-btn" data-action="bot-live-review">Review in Padre</button><button class="btn ghost" data-action="bot-live-filled" hidden>Mark BUY filled</button><button class="btn ghost" data-action="bot-live-closed" hidden>Mark SELL filled</button><button class="btn ghost" data-action="bot-live-failed" hidden>Log failed / skipped</button></div><small>Automation submits through Padre’s form and waits for Padre order status. Padre may require wallet approval.</small></div>
              <details class="bot-assumptions bot-config"><summary>Strategy settings</summary><div class="bot-config-grid"><div class="bot-strategy-switch" role="group" aria-label="Bot strategy"><button type="button" class="btn ghost" data-action="bot-strategy" data-strategy="breakout" aria-pressed="false">Breakout + volume</button><button type="button" class="btn ghost" data-action="bot-strategy" data-strategy="lowHigh" aria-pressed="false">Buy low &#183; sell high</button></div><select data-bot-config="strategy" aria-hidden="true" tabindex="-1" style="display:none"><option value="breakout">Breakout + volume</option><option value="lowHigh">Buy low &#183; sell high</option></select><label>Range lookback candles<input type="number" min="5" max="300" step="1" data-bot-config="lookback"></label><label data-bot-strategy-field="breakout">Volume multiplier<input type="number" min="1" max="20" step="0.1" data-bot-config="volumeMultiplier"></label><label data-bot-strategy-field="breakout">Max breakout stretch (ATR)<input type="number" min="0.1" max="10" step="0.1" data-bot-config="maxExtensionAtr"></label><label data-bot-strategy-field="breakout">Retest timeout candles<input type="number" min="2" max="60" step="1" data-bot-config="retestTimeout"></label><label data-bot-strategy-field="breakout">Breakout target (R:R)<input type="number" min="1" max="5" step="0.1" data-bot-config="riskReward"></label><label data-bot-strategy-field="breakout">Max stop risk %<input type="number" min="0.1" max="90" step="0.1" data-bot-config="stopPct"></label><label data-bot-strategy-field="lowHigh">Stop loss %<input type="number" min="0.1" max="90" step="0.1" data-bot-config="lowHighStopPct"></label><label data-bot-strategy-field="lowHigh">Take profit %<input type="number" min="0.1" max="500" step="0.1" data-bot-config="lowHighTakeProfitPct"></label><label data-bot-strategy-field="demo">Demo virtual size $<input type="number" min="1" max="100000" step="1" data-bot-config="notionalUsd"></label><label data-bot-strategy-field="demo">Demo fee assumption %<input type="number" min="0" max="10" step="0.05" data-bot-config="feePct"></label><label data-bot-strategy-field="demo">Demo slippage assumption %<input type="number" min="0" max="20" step="0.05" data-bot-config="slippagePct"></label></div><div class="bot-recommend-row"><button class="btn ghost" data-action="bot-recommend">Load recommended values</button><span data-bot-recommendation>Chart-based estimates, not a profit guarantee.</span></div><div class="bot-preset-row"><select class="form" data-bot-preset aria-label="Saved strategy presets"><option value="">Saved presets…</option></select><button class="btn ghost" data-action="bot-preset-load">Load</button><button class="btn ghost" data-action="bot-preset-save">Save as…</button><button class="btn ghost" data-action="bot-preset-delete">Delete</button></div><button class="btn ghost bot-config-apply" data-action="bot-config-apply">Apply settings</button></details>
              <details class="bot-assumptions bot-history-details"><summary>Recent demo trades</summary><div class="bot-history" data-bot-history>No demo trades yet.</div></details>
              <details class="bot-assumptions bot-log-details"><summary>Trade attempt log <span data-bot-log-count>(0)</span></summary><div class="bot-log-actions"><button class="btn ghost" data-action="bot-log-export">Export CSV</button><button class="btn ghost" data-action="bot-log-clear">Clear</button></div><div class="bot-log-list" data-bot-log-list>No attempts logged yet.</div><div class="bot-log-note">Saved in this browser · live failures/fills need manual reporting.</div></details>
              <div class="bot-disclaimer" data-bot-disclaimer>Demo only. No wallet connection, signing, or real orders.</div>
             </section>
           <section role="tabpanel" class="pane" data-pane="xmentions"><div class="toolbar"><span class="toolbar-label">X mentions ${infoBtn('Searches the exact contract address and renders the results inside this panel. A minimized helper window collects the public X results, then closes automatically.', 'About in-panel X feed')}</span><span class="toolbar-spacer"></span><button class="icon-btn" data-action="x-rescan" aria-label="Refresh in-panel X feed" title="Refresh in-panel X feed">${icon('refresh', 13)}</button></div><div class="x-token" data-x-token>Select a token from Risk first.</div><div class="x-actions"><button class="btn" data-action="x-search">${icon('search', 12)} Search X</button><span class="x-status" data-x-status>Ready when a token is selected.</span></div><div class="x-results"></div></section>
          <section role="tabpanel" class="pane settings" data-pane="settings"><div class="settings-group"><div class="settings-title">Display</div><label class="setting-row"><span><b>Score badges</b><small>Show the score badge on Padre cards</small></span><input type="checkbox" data-setting="showBadges"></label><label class="setting-row"><span><b>Fade risky cards</b><small>Dim cards below the minimum score</small></span><input type="checkbox" data-setting="dimRisky"></label></div><div class="settings-group"><div class="settings-title">Scoring</div><label class="setting-row"><span><b>Minimum score</b><small>Cards below this are faded</small></span><input type="number" min="0" max="100" class="form" data-setting="minScore"></label><label class="setting-row"><span><b>Extension enabled</b><small>Master switch for badges and panel data</small></span><input type="checkbox" data-setting="enabled"></label></div><div class="settings-group"><div class="settings-title">Data ${infoBtn('Missing wallet metrics are not assumed safe. Scores are heuristics; verify holders, liquidity, contract permissions, and the chart before trading.', 'About data')}</div><div class="setting-row"><span><b>Cached token stats</b><small>Clear current-token position cache</small></span><button class="btn ghost" data-action="clear-token-cache">Clear</button></div><div class="setting-row"><span><b>Panel position</b><small>Reset drag position</small></span><button class="btn ghost" data-action="reset-position">Reset</button></div></div></section>
        </div>
        <div class="info-pop" role="tooltip" hidden></div>
        <div class="foot"><span>v${VERSION} · read-only</span><span class="foot-right"><span class="foot-item" data-status-scan title="Last scan">${icon('clock', 11)}<b>Not scanned</b></span><span class="foot-item" data-status-request title="Current-token stats"><b></b></span><span class="foot-item" data-status-errors title="Scan errors" style="display:none">${icon('warning', 11)}<b></b></span></span></div>
      </div>`;
    state.root = root;
    state.panel = root.querySelector('.panel');
    state.list = root.querySelector('.list');
    state.recommendations = root.querySelector('.top-picks');
    state.patterns = root.querySelector('.patterns');
    state.patternProgressEl = root.querySelector('[data-pattern-progress]');
    state.xResultsEl = root.querySelector('.x-results');
    state.walletsEl = root.querySelector('.wallets');
    state.count = root.querySelector('.count');
    state.infoPop = root.querySelector('.info-pop');
    applyUiState();
    root.querySelectorAll('[data-setting]').forEach(el => {
      const key = el.dataset.setting;
      if (el.type === 'checkbox') el.checked = !!state.settings[key]; else el.value = state.settings[key];
    });
    root.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (btn) {
        if (btn.dataset.action === 'wallet-modal') {
          const wallet = state.wallets.get(btn.dataset.address || '');
          const source = wallet && wallet.sourceLabel;
          if (source && source.isConnected) {
            state.pendingWalletOverview = wallet.address;
            source.click();
            watchWalletOverview();
          }
          else if (wallet) copyText(wallet.address);
        }
        if (btn.dataset.action === 'minimize') {
          state.panel.classList.toggle('minimized');
          const minimized = state.panel.classList.contains('minimized');
          btn.innerHTML = icon(minimized ? 'chevron-down' : 'chevron-up');
          btn.setAttribute('aria-label', minimized ? 'Restore panel' : 'Minimize panel');
          btn.title = minimized ? 'Restore' : 'Minimize';
          saveUiState({ minimized });
        }
        if (btn.dataset.action === 'scan') scanCards();
        if (btn.dataset.action === 'patterns') analyzeVisible();
        if (btn.dataset.action === 'pattern-stop') stopPatternRun();
        if (btn.dataset.action === 'bot-strategy') {
          const strategySelect = state.root.querySelector('[data-bot-config="strategy"]');
          if (strategySelect && ['breakout', 'lowHigh'].includes(btn.dataset.strategy)) {
            state.bot.editingStrategy = btn.dataset.strategy;
            strategySelect.value = btn.dataset.strategy;
            updateBotStrategyControls();
            state.bot.lastSignal = 'Strategy selected. Press Apply settings to use it for new entries.';
            const signal = state.root.querySelector('[data-bot-signal]');
            if (signal) signal.textContent = state.bot.lastSignal;
          }
        }
        if (btn.dataset.action === 'bot-monitor') {
          if (state.bot.running) {
            state.bot.running = false;
            state.bot.breakoutSetup = null;
            state.bot.lastSignal = state.bot.mode === 'real'
              ? 'Live signal monitoring stopped. Any manually tracked fill remains recorded.'
              : 'Demo stopped. Any open virtual position remains recorded.';
            recordBotLog({ event: 'MONITOR', outcome: 'STOPPED', reason: state.bot.lastSignal });
          } else {
            if (!applyBotConfig()) return;
            state.bot.running = true;
            state.bot.breakoutSetup = null;
            state.bot.lastSignature = currentBotCandleSignature();
            if (state.bot.mode === 'real' && !window.confirm('Start Padre native auto-trading on this token? The bot may submit $1 BUYs and 100% SELLs continuously until Stop. A 100% SELL liquidates ALL of this token in the selected wallet, including any pre-existing holdings. Use a dedicated wallet with no existing token position. Padre may request wallet approval for each order.')) {
              state.bot.running = false;
              return;
            }
            state.bot.lastSignal = state.bot.mode === 'real'
              ? 'Live auto-trading started; waiting for a fresh 1-second candle.'
              : 'Demo started; waiting for the next candle update.';
            recordBotLog({ event: 'MONITOR', outcome: 'STARTED', reason: state.bot.lastSignal });
          }
          renderBot();
        }
        if (btn.dataset.action === 'bot-config-apply') applyBotConfig();
        if (btn.dataset.action === 'bot-recommend') loadRecommendedBotValues();
        if (btn.dataset.action === 'bot-preset-save') saveBotPreset();
        if (btn.dataset.action === 'bot-preset-load') loadBotPreset();
        if (btn.dataset.action === 'bot-preset-delete') deleteBotPreset();
        if (btn.dataset.action === 'bot-live-filled') markLiveEntryFilled();
        if (btn.dataset.action === 'bot-live-closed') markLiveExitFilled();
        if (btn.dataset.action === 'bot-live-failed') logLiveFailure();
        if (btn.dataset.action === 'bot-log-export') exportBotLog();
        if (btn.dataset.action === 'bot-log-clear') clearBotLog();
        if (btn.dataset.action === 'bot-mode') {
          if (state.bot.liveOrderInFlight || state.bot.pendingLiveSignal) {
            state.bot.lastSignal = 'Cannot change mode while a live order is in flight or its outcome is unresolved. Check Padre Orders first.';
            renderBot();
            return;
          }
          if (state.bot.livePosition && btn.dataset.mode !== 'real') {
            state.bot.lastSignal = 'Cannot leave Real mode while a live position is being tracked. Confirm it is closed in Padre before switching modes.';
            renderBot();
            return;
          }
          if (!applyBotConfig()) return;
          if (state.bot.running) {
            state.bot.running = false;
            state.bot.lastSignature = '';
          }
          state.bot.mode = btn.dataset.mode === 'real' ? 'real' : 'demo';
          state.bot.execution = state.bot.mode === 'real' ? 'auto' : 'manual';
          state.bot.pendingLiveSignal = null;
          if (state.bot.mode !== 'real') state.bot.position = null;
          state.bot.breakoutSetup = null;
          state.bot.lastSignal = state.bot.mode === 'real'
            ? 'Real auto mode selected. Press Start to allow native Padre form submissions.'
            : 'Demo mode selected. Start to evaluate fresh candles.';
          recordBotLog({ event: 'MODE_SWITCH', outcome: 'INFO', reason: `Mode changed to ${state.bot.mode}.` });
          renderBot();
        }
        if (btn.dataset.action === 'bot-live-review') reviewLiveSignalInPadre();
        if (btn.dataset.action === 'chart-interval') {
          state.settings.chartInterval = 'second';
          saveSettings();
          renderPatterns();
        }
        if (btn.dataset.action === 'copy-wallet') copyText(btn.dataset.address || '');
        if (btn.dataset.action === 'wallet-rescan') rescanWalletBatch();
        if (btn.dataset.action === 'wallet-api-retry') {
          const mint = currentTradeMintAddress();
          if (mint) {
            state.mintPositions.delete(mint);
            state.mintPositionsErrors.delete(mint);
            fetchMintPositions(mint);
          }
        }
        if (btn.dataset.action === 'wallet-clear') {
          state.walletSearch = '';
          state.walletPage = 0;
          const input = root.querySelector('[data-wallet-search]');
          if (input) { input.value = ''; input.focus(); }
          renderWallets();
        }
        if (btn.dataset.action === 'wallet-page-prev' || btn.dataset.action === 'wallet-page-next') {
          const delta = btn.dataset.action === 'wallet-page-next' ? 1 : -1;
          const nextPage = Math.max(0, Math.min(state.walletPageCount - 1, state.walletPage + delta));
          if (nextPage !== state.walletPage) {
            state.walletPage = nextPage;
            const mint = currentTradeMintAddress();
            // Initial page stays local and cheap. Fetch Padre's current-token
            // position set only when the user first pages beyond it.
            if (nextPage > 0 && mint && !state.mintPositions.has(mint)) fetchMintPositions(mint);
            renderWallets();
          }
        }
        if (btn.dataset.walletFilter) {
          state.walletFilter = btn.dataset.walletFilter;
          state.walletPage = 0;
          root.querySelectorAll('[data-wallet-filter]').forEach(filter => filter.classList.toggle('active', filter === btn));
          renderWallets();
        }
        if (btn.dataset.action === 'x-search') startXSearch(false);
        if (btn.dataset.action === 'x-rescan') startXSearch(true);
        if (btn.dataset.action === 'x-select-token') setTab('picks');
        if (btn.dataset.action === 'clear-token-cache') {
          state.mintPositions.clear();
          state.mintPositionsLoading.clear();
          state.mintPositionsErrors.clear();
          state.walletsSignature = null;
          renderWallets();
          updateStatusStrip();
        }
        if (btn.dataset.action === 'reset-position') {
          state.panel.style.left = '';
          state.panel.style.top = '';
          state.panel.style.right = '18px';
          state.panel.style.top = '88px';
          saveUiState({ left: null, top: null });
        }
        if (btn.dataset.action === 'age-filter') { state.ageFilter = btn.dataset.age || 'all'; render(); }
        const card = e.target.closest('.row');
        if (btn.dataset.action === 'analyze-one') {
          const address = btn.dataset.address || (card && card.dataset.address);
          state.selectedPatternAddress = address;
          setTab('patterns');
          analyzeOne(findByAddress(address));
        }
        return;
      }
      const tab = e.target.closest('[data-tab]');
      if (tab) { setTab(tab.dataset.tab); saveUiState({ activeTab: tab.dataset.tab }); }
      const row = e.target.closest('.row');
      if (row && !e.target.closest('button,a')) {
        const rec = findByAddress(row.dataset.address);
        if (rec) {
          state.selectedPatternAddress = rec.address;
          setTab('patterns');
          analyzeOne(rec);
        }
        return;
      }
      const pattern = e.target.closest('.pattern[data-address]');
      if (pattern && state.activeTab === 'patterns' && !e.target.closest('button,a')) {
        const rec = findByAddress(pattern.dataset.address);
        if (rec) {
          state.selectedPatternAddress = rec.address;
          renderPatterns();
          analyzeOne(rec);
        }
      }
    });
    const showInfo = (target) => {
      if (!state.infoPop || !target) return;
      const text = target.getAttribute('data-info');
      if (!text) return;
      state.infoPop.textContent = text;
      state.infoPop.hidden = false;
      const r = target.getBoundingClientRect();
      const pw = state.infoPop.offsetWidth, ph = state.infoPop.offsetHeight;
      const left = Math.min(window.innerWidth - pw - 8, Math.max(8, r.left + r.width / 2 - pw / 2));
      let top = r.bottom + 6;
      if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 6);
      state.infoPop.style.left = Math.round(left) + 'px';
      state.infoPop.style.top = Math.round(top) + 'px';
    };
    const hideInfo = () => { if (state.infoPop) state.infoPop.hidden = true; };
    root.addEventListener('pointerover', (e) => {
      const target = e.target.closest && e.target.closest('[data-info]');
      if (target) showInfo(target);
    });
    root.addEventListener('pointerout', (e) => {
      const target = e.target.closest && e.target.closest('[data-info]');
      if (target && !target.contains(e.relatedTarget)) hideInfo();
    });
    root.addEventListener('focusin', (e) => {
      const target = e.target.closest && e.target.closest('[data-info]');
      if (target) showInfo(target);
    });
    root.addEventListener('focusout', () => hideInfo());
    root.addEventListener('focus', (e) => {
      const target = e.target.closest && e.target.closest('[data-info]');
      if (target) showInfo(target);
    }, true);
    root.addEventListener('blur', () => hideInfo(), true);
    root.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideInfo(); });
    const dragHandle = root.querySelector('.head');
    let drag = null;
    dragHandle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const rect = state.panel.getBoundingClientRect();
      drag = { x: e.clientX, y: e.clientY, left: rect.left, top: rect.top };
      state.panel.style.left = rect.left + 'px';
      state.panel.style.top = rect.top + 'px';
      state.panel.style.right = 'auto';
      dragHandle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    dragHandle.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const maxLeft = Math.max(0, window.innerWidth - state.panel.offsetWidth);
      const maxTop = Math.max(0, window.innerHeight - state.panel.offsetHeight);
      state.panel.style.left = Math.min(maxLeft, Math.max(0, drag.left + e.clientX - drag.x)) + 'px';
      state.panel.style.top = Math.min(maxTop, Math.max(0, drag.top + e.clientY - drag.y)) + 'px';
    });
    const endDrag = () => {
      if (drag) {
        const rect = state.panel.getBoundingClientRect();
        saveUiState({ left: Math.round(rect.left), top: Math.round(rect.top) });
      }
      drag = null;
    };
    dragHandle.addEventListener('pointerup', endDrag);
    dragHandle.addEventListener('pointercancel', endDrag);
    dragHandle.addEventListener('dblclick', (e) => {
      if (e.target.closest('button')) return;
      const minimize = root.querySelector('[data-action="minimize"]');
      if (minimize) minimize.click();
    });
    const tabList = root.querySelector('[role="tablist"]');
    if (tabList) tabList.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      const tabs = [...tabList.querySelectorAll('[data-tab]')];
      const current = root.activeElement || e.target.closest('[data-tab]');
      const index = tabs.indexOf(current);
      if (index < 0) return;
      e.preventDefault();
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1
        : (index + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next].focus();
      tabs[next].click();
    });
    root.addEventListener('change', (e) => {
      if (e.target.matches('[data-bot-config="strategy"]')) { renderBot(); return; }
      if (e.target.matches('[data-wallet-sort]')) {
        state.walletSort = ['volume', 'tokenPnl', 'realized'].includes(e.target.value) ? e.target.value : 'priority';
        state.walletPage = 0;
        renderWallets();
        return;
      }
      const el = e.target.closest('[data-setting]'); if (!el) return;
      const key = el.dataset.setting;
      state.settings[key] = el.type === 'checkbox' ? el.checked : (el.type === 'number' ? Number(el.value) : el.value);
      saveSettings();
      for (const rec of state.records.values()) paintCard(rec);
      render();
    });
    root.addEventListener('input', e => {
      if (e.target.matches('[data-wallet-search]')) {
        state.walletSearch = e.target.value.trim().toLowerCase();
        state.walletPage = 0;
        renderWallets();
      }
    });
    window.addEventListener('message', handleXMessage);
  }
  function applyUiState() {
    if (!state.panel) return;
    const { left, top, minimized } = state.ui;
    if (Number.isFinite(left) && Number.isFinite(top)) {
      state.panel.style.left = Math.max(0, Math.min(window.innerWidth - 60, left)) + 'px';
      state.panel.style.top = Math.max(0, Math.min(window.innerHeight - 40, top)) + 'px';
      state.panel.style.right = 'auto';
    }
    if (minimized) {
      state.panel.classList.add('minimized');
      const btn = state.root.querySelector('[data-action="minimize"]');
      if (btn) {
        btn.innerHTML = icon('chevron-down');
        btn.setAttribute('aria-label', 'Restore panel');
        btn.title = 'Restore';
      }
    }
  }
  function updateStatusStrip() {
    if (!state.root) return;
    const loading = state.mintPositionsLoading.size > 0;
    const dot = state.root.querySelector('.dot');
    if (dot) {
      dot.classList.toggle('loading', loading && !state.errors);
      dot.classList.toggle('error', !!state.errors);
      dot.title = state.errors ? state.errors + ' scan error(s)' : loading ? 'Loading token stats…' : 'Scanner idle';
    }
    const setText = (selector, text) => {
      const el = state.root.querySelector(selector);
      if (el) el.textContent = text;
    };
    setText('[data-status-scan] b', state.lastScanAt
      ? 'Scanned ' + Math.max(0, Math.round((Date.now() - state.lastScanAt) / 1000)) + 's ago'
      : 'Not scanned');
    const mint = currentTradeMintAddress();
    setText('[data-status-request] b', !mint ? '' : loading ? 'stats loading' : state.mintPositions.has(mint) ? 'stats cached' : 'stats on demand');
    const errorEl = state.root.querySelector('[data-status-errors]');
    if (errorEl) {
      errorEl.style.display = state.errors ? '' : 'none';
      const errorText = errorEl.querySelector('b');
      if (errorText) errorText.textContent = state.errors ? state.errors + ' errors' : '';
    }
  }
  function setTab(name) {
    state.activeTab = name;
    state.root.querySelectorAll('.tab').forEach(x => {
      const active = x.dataset.tab === name;
      x.classList.toggle('active', active);
      x.setAttribute('aria-selected', String(active));
      x.tabIndex = active ? 0 : -1;
    });
    state.root.querySelectorAll('.pane').forEach(x => x.classList.toggle('active', x.dataset.pane === name));
    if (name === 'patterns') renderPatterns();
    if (name === 'bot') renderBot();
    if (name === 'xmentions') renderXMentions();
    if (name === 'wallets') {
      scanCards();
      scanTradeWallets();
      if (!state.walletBatch.length) fillWalletBatch();
      renderWallets();
    }
    if (name === 'patterns') scanCards();
  }
  function findByAddress(addr) { return [...state.records.values()].find(r => r.address === addr) || null; }
  function visibleRecords() { return [...state.records.values()].filter(r => r.el && r.el.isConnected); }
  function patternRecords() {
    const records = visibleRecords();
    const route = tradePageContext();
    if (route && state.tradeRecord && !records.some(r => r.address === route.address)) records.unshift(state.tradeRecord);
    return records;
  }

  function isWalletAddress(value) {
    return typeof value === 'string' && (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) || /^0x[a-fA-F0-9]{40}$/.test(value));
  }
  function tradePageContext() {
    const match = /^\/trade\/([^/]+)\/([^/?#]+)/i.exec(location.pathname);
    if (!match) return null;
    return { chain: match[1].toUpperCase(), address: decodeURIComponent(match[2]) };
  }
  function currentTradeMintAddress() {
    const route = tradePageContext();
    if (!route) return '';
    const record = state.tradeRecord;
    return mintAddressFromVisibleTooltip(route.address) || record && record.mintAddress || mintAddressFromObject(record && record.raw, route.address) || mintAddressFromPage(route.address) || '';
  }
  function mintAddressFromVisibleTooltip(routeAddress) {
    for (const tooltip of document.querySelectorAll('[role="tooltip"],[data-radix-popper-content-wrapper],[data-state="open"]')) {
      const text = tooltip.innerText || tooltip.textContent || '';
      if (!/\bCA\b/i.test(text) || /\bPair\b/i.test(text) && !/\bTicker\b/i.test(text)) continue;
      const direct = (text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) || []).find(value => value !== routeAddress);
      if (direct) return direct;
      for (const node of [tooltip, ...tooltip.querySelectorAll('button,[role="button"],[data-ca],[data-mint],[title],[aria-label]')]) {
        const candidate = mintAddressFromObject(getFiber(node)?.memoizedProps, routeAddress);
        if (candidate) return candidate;
        for (const attr of [...(node.attributes || [])]) {
          if (/token|mint|contract|(^|-)ca($|-)/i.test(attr.name) && isWalletAddress(attr.value) && attr.value !== routeAddress) return attr.value;
        }
      }
    }
    return '';
  }
  function tradeTitleInfo() {
    let title = (document.title || '').trim();
    title = title.replace(/\s*[|–—-]\s*(?:padre|terminal|trade|trenches).*$/i, '').trim();
    title = title.replace(/\s*[↓↑]\s*.*$/, '').replace(/\s+\$[\d,.]+\s*[KMB]?\s*.*$/i, '').trim();
    if (!title || /padre|trade|trenches|harness|terminal/i.test(title)) return null;
    const symbol = title.replace(/^\$/, '').split(/\s+/)[0].replace(/[^\w.-]/g, '');
    return symbol ? { symbol, name: title.replace(/^\$/, '') } : null;
  }
  function ensureWalletContext() {
    const route = tradePageContext();
    const next = route ? 'trade:' + route.address : 'trenches';
    if (state.walletBatchContext === next) return false;
    state.walletBatchContext = next;
    state.bot.running = false;
    state.bot.pendingLiveSignal = null;
    state.bot.livePosition = null;
    state.bot.position = null;
    state.bot.breakoutSetup = null;
    state.bot.trades = [];
    state.bot.realizedPnl = 0;
    state.bot.lastSignature = '';
    state.bot.lastSignal = 'Waiting for a new candle after start.';
    state.tradeRecord = route ? createTradeRecord(route) : null;
    state.mintTooltipPrimed = '';
    if (route) state.selectedPatternAddress = route.address;
    state.wallets.clear();
    state.walletBatch = [];
    state.walletPage = 0;
    state.walletReturned.clear();
    state.mintPositions.clear();
    state.mintPositionsLoading.clear();
    state.mintPositionsErrors.clear();
    state.walletsSignature = null;
    return true;
  }
  function createTradeRecord(route) {
    const chain = String(route.chain || '').toUpperCase();
    const title = tradeTitleInfo();
    const symbol = title ? title.symbol : addressShort(route.address);
    const t = { address: route.address, chain, mode: 'TRADE', symbol, name: title ? title.name : '', ageSec: null, marketCap: null, devPct: null, top10Pct: null, bundlePct: null, insiderPct: null, insiderBuys: null, linkedPct: null, sniperPct: null, freshBuyers: null, freshShare: null, holders: null, buys: null, sells: null, volumeUsd: null, liquidityUsd: null, curve: null, metadata: null };
    const scored = scoreToken(t);
    return { key: chain + ':' + route.address, address: route.address, routeAddress: route.address, mintAddress: '', raw: null, t, score: scored.score, grade: scored.grade, reasons: scored.reasons, coverage: scored.coverage, chart: null, pair: null };
  }
  function readTradePageFacts() {
    const text = (document.body && document.body.innerText || '').replace(/\u00a0/g, ' ');
    const amount = label => {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = new RegExp('(?:^|\\n)\\s*' + escaped + '\\s*[:]?\\s*\\$?([\\d,.]+)\\s*([KMB])?', 'i').exec(text) ||
        new RegExp('\\b' + escaped + '\\b\\s+\\$?([\\d,.]+)\\s*([KMB])?', 'i').exec(text);
      if (!match) return null;
      const value = Number(match[1].replace(/,/g, ''));
      return Number.isFinite(value) ? value * (({ K: 1e3, M: 1e6, B: 1e9 })[(match[2] || '').toUpperCase()] || 1) : null;
    };
    const holdersMatch = /\bHolders\s*\(([\d,]+)\)/i.exec(text);
    const ageMatch = /(?:^|\s)(\d+)\s*(s|m|h|d)\s+(?:ago\b)?/i.exec(text.slice(0, 1600));
    return {
      marketCap: amount('MC') ?? amount('Market Cap'),
      liquidityUsd: amount('Liquidity'),
      volumeUsd: amount('Volume'),
      holders: holdersMatch ? Number(holdersMatch[1].replace(/,/g, '')) : null,
      ageSec: ageMatch ? Number(ageMatch[1]) * ({ s: 1, m: 60, h: 3600, d: 86400 }[ageMatch[2].toLowerCase()]) : null,
    };
  }
  function refreshTradeRecord() {
    const route = tradePageContext();
    if (!route) { state.tradeRecord = null; return; }
    if (!state.tradeRecord || state.tradeRecord.address !== route.address) state.tradeRecord = createTradeRecord(route);
    const rec = state.tradeRecord;
    const raw = findTradeEntity(route.address);
    const pageFacts = readTradePageFacts();
    rec.routeAddress = route.address;
    rec.mintAddress = mintAddressFromObject(raw, route.address) || mintAddressFromPage(route.address) || rec.mintAddress || '';
    if (Object.keys(raw).length) {
      const parsed = { chain: route.chain.toUpperCase(), address: route.address, mode: 'TRADE' };
      const next = extractMetrics(raw, parsed, null);
      if (!next.symbol || next.symbol === '?') next.symbol = rec.t.symbol;
      if (!next.name) next.name = rec.t.name;
      if (next.marketCap == null) next.marketCap = rec.t.marketCap;
      if (next.ageSec == null) next.ageSec = rec.t.ageSec;
      rec.raw = raw;
      rec.t = next;
      rec.t.mintAddress = rec.mintAddress;
    }
    for (const [key, value] of Object.entries(pageFacts)) if (value != null) rec.t[key] = value;
    rec.pageFacts = pageFacts;
    const title = tradeTitleInfo();
    if (title && (!rec.raw || !rec.raw.symbol)) {
      rec.t.symbol = title.symbol;
      rec.t.name = title.name;
    }
    const scored = scoreToken(rec.t);
    Object.assign(rec, { score: scored.score, grade: scored.grade, reasons: scored.reasons, coverage: scored.coverage, signalCoverage: scored.signalCoverage });
  }
  function tradeWalletRole() {
    const section = document.querySelector('[data-testid="token-section-orders"]');
    const active = [...(section || document).querySelectorAll('[role="tab"][aria-selected="true"],[data-state="active"],button.active,[role="tab"].active')]
      .map(el => (el.innerText || el.textContent || '').trim().toLowerCase()).find(Boolean) || '';
    if (/early.?buyer|buyer/.test(active)) return 'buyer';
    if (/top.?trader|trader/.test(active)) return 'trader';
    if (/insider/.test(active)) return 'insider';
    if (/sniper/.test(active)) return 'sniper';
    if (/holder/.test(active)) return 'holder';
    return 'trader';
  }
  function scanTradeWallets() {
    const context = tradePageContext();
    if (!context) return;
    const tokenMint = currentTradeMintAddress();
    const tokenAddresses = new Set([context.address, tokenMint].filter(Boolean));
    const fallbackRole = tradeWalletRole();
    const tokenRec = [...state.records.values()].find(rec => rec.address === context.address);
    const tokenLabel = tokenRec ? tokenRec.t.symbol : state.tradeRecord?.t?.symbol || addressShort(tokenMint || context.address);
    const rowsRoot = document.querySelector('[data-testid="token-section-orders"]') || document;
    const rowCandidates = [...new Set([
      ...rowsRoot.querySelectorAll('[data-frontrun-padre-address]'),
      ...rowsRoot.querySelectorAll('tbody tr,[role="row"],tr,[class*="_columns_"][class*="_row_"]'),
    ])].filter(row => {
      const rect = row.getBoundingClientRect();
      const text = (row.innerText || '').slice(0, 450);
      const walletHint = /[1-9A-HJ-NP-Za-km-z]{3,8}(?:…|\.{2,3})[1-9A-HJ-NP-Za-km-z]{2,8}/.test(text);
      return rect.width > 0 && rect.height > 0 && (row.querySelectorAll('td,[role="cell"]').length > 0 || walletHint);
    }).slice(0, 100);
    let rows = rowCandidates;
    if (!rows.length) {
      rows = [...rowsRoot.querySelectorAll('[class*="row"],[class*="Row"]')].filter(row => {
        const rect = row.getBoundingClientRect();
        const text = (row.innerText || '').slice(0, 450);
        return rect.width > 0 && rect.height > 0 && /[1-9A-HJ-NP-Za-km-z]{3,8}(?:…|\.{2,3})[1-9A-HJ-NP-Za-km-z]{2,8}/.test(text);
      }).slice(0, 100);
    }
    if (!rows.length) {
      rows = [...rowsRoot.querySelectorAll('span,div,li')].filter(el => {
        const rect = el.getBoundingClientRect();
        const text = (el.innerText || el.textContent || '').trim();
        return rect.width > 0 && rect.height > 0 && text.length < 450 && /[1-9A-HJ-NP-Za-km-z]{3,8}(?:…|\.{2,3})[1-9A-HJ-NP-Za-km-z]{2,8}/.test(text);
      }).slice(0, 60);
    }
    for (const rowEl of rows) {
      const found = new Map();
      const add = (address, role) => {
        if (!isWalletAddress(address) || tokenAddresses.has(address) || walletRoleRank({ roles: new Set([role]) }) === 0) return;
        let row = found.get(address);
        if (!row) {
          const directAddress = rowEl.getAttribute('data-frontrun-padre-address');
          const padreRow = rowEl.matches('[class*="_columns_"][class*="_row_"]');
          row = { roles: new Set(), details: directAddress === address || padreRow ? readTradeRowDetails(rowEl, address) : null };
          found.set(address, row);
        }
        row.roles.add(role);
      };
      add(rowEl.getAttribute('data-frontrun-padre-address'), fallbackRole);
      for (const link of rowEl.querySelectorAll('a[href]')) {
        const href = link.href;
        if (!/wallet|profile|address|tracker/i.test(href)) continue;
        const matches = href.match(/(?:0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})/g) || [];
        for (const address of matches) add(address, fallbackRole);
      }
      for (const attr of [...rowEl.attributes]) {
        if (/wallet|address|owner|trader|buyer|holder/i.test(attr.name)) add(attr.value, fallbackRole);
      }
      for (const tagged of rowEl.querySelectorAll('[data-wallet-address],[data-address],[data-wallet]')) {
        for (const attr of [...tagged.attributes]) if (/wallet|address/i.test(attr.name)) add(attr.value, fallbackRole);
      }
      let fiber = getFiber(rowEl);
      let ancestors = 0;
      while (fiber && ancestors++ < 3) {
        const stack = [{ value: fiber.memoizedProps, depth: 0, role: fallbackRole }];
        const seen = new Set();
        let steps = 0;
        while (stack.length && steps++ < 160) {
          const item = stack.pop();
          const value = item.value;
          if (!value || typeof value !== 'object' || seen.has(value) || item.depth > 3) continue;
          seen.add(value);
          for (const [key, child] of Object.entries(value)) {
            const role = walletRole(key, item.role);
            const excludedKey = /token|mint|pool|market|contract|program|chain|creator|deployer|dev/i.test(key);
            if (typeof child === 'string' && !excludedKey) add(child, walletRoleRank({ roles: new Set([role]) }) ? role : fallbackRole);
            else if (child && typeof child === 'object') stack.push({ value: child, depth: item.depth + 1, role });
          }
        }
        fiber = fiber.return;
      }
      for (const [address, foundRow] of found) {
        let target = state.wallets.get(address);
        if (!target) {
          target = { address, roles: new Set(), tokens: new Set(), profileUrl: null };
          state.wallets.set(address, target);
        }
        const sourceProfileUrl = padreWalletProfileHref(rowEl, address);
        if (sourceProfileUrl) target.profileUrl = sourceProfileUrl;
        const shortPrefix = address.slice(0, 4).toLowerCase();
        const shortSuffix = address.slice(-4).toLowerCase();
        const labelNodes = [...rowEl.querySelectorAll('span,button,[role="button"]')];
        target.sourceLabel = labelNodes.find(el => {
          const text = (el.innerText || el.textContent || '').trim().toLowerCase();
          const labelClass = [...el.classList].some(name => name.startsWith('_label_'));
          return labelClass || (text.length < 90 && text.includes(shortPrefix) && text.includes(shortSuffix));
        }) || target.sourceLabel || null;
        for (const role of foundRow.roles) target.roles.add(role);
        target.tokens.add(tokenLabel);
        if (foundRow.details) target.tradeDetails = foundRow.details;
      }
    }
  }
  function padreWalletProfileHref(rowEl, address) {
    const prefix = String(address || '').slice(0, 4).toLowerCase();
    const suffix = String(address || '').slice(-4).toLowerCase();
    for (const link of rowEl.querySelectorAll('a[href]')) {
      let url;
      try { url = new URL(link.href, location.href); } catch (e) { continue; }
      if (url.origin !== 'https://trade.padre.gg' || /^\/trade\//.test(url.pathname)) continue;
      const href = decodeURIComponent(url.href).toLowerCase();
      const label = (link.innerText || link.textContent || link.getAttribute('aria-label') || '').toLowerCase();
      if (href.includes(String(address).toLowerCase()) || (prefix && suffix && label.includes(prefix) && label.includes(suffix))) return url.href;
    }
    return null;
  }
  function watchWalletOverview() {
    if (state.walletOverviewObserver) state.walletOverviewObserver.disconnect();
    const started = Date.now();
    const inspect = () => {
      const address = state.pendingWalletOverview;
      const panels = [...document.querySelectorAll('[data-app-panel]')].filter(el => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && /Realized PNL/.test(el.innerText || '');
      });
      for (const panel of panels) {
        const panelText = panel.innerText || '';
        let matchedAddress = address || null;
        if (!matchedAddress) {
          // Padre's modal header abbreviates the wallet (for example 6ckZ4…Ntdk).
          // Match that visible prefix/suffix against wallet rows already scanned.
          const abbreviated = /\b([1-9A-HJ-NP-Za-km-z]{4,8})\s*(?:…|\.\.\.?)\s*([1-9A-HJ-NP-Za-km-z]{4,8})\b/.exec(panelText);
          if (abbreviated) {
            const prefix = abbreviated[1].toLowerCase(), suffix = abbreviated[2].toLowerCase();
            matchedAddress = [...state.wallets.keys()].find(wallet => wallet.toLowerCase().startsWith(prefix) && wallet.toLowerCase().endsWith(suffix)) || null;
          }
        }
        if (!matchedAddress) continue;
        const readValue = label => {
          const node = [...panel.querySelectorAll('span')].find(el => el.textContent.trim().toLowerCase() === label.toLowerCase());
          if (!node) return null;
          return (node.parentElement && node.parentElement.innerText || '').replace(new RegExp(label, 'i'), '').replace(/\s+/g, ' ').trim() || null;
        };
        const realizedText = readValue('Realized PNL');
        const unrealizedText = readValue('Unrealized PNL');
        const totalValueText = readValue('Total Value');
        const currentBalanceText = readValue('Current balance');
        const winRateText = readValue('Win rate');
        const txnsText = readValue('TXNS');
        const winsText = readValue('Wins');
        const lossesText = readValue('Losses');
        const coinsText = readValue('Coins traded');
        const riskRewardText = readValue('Risk/Reward');
        if (!realizedText && !winRateText) continue;
        state.walletAccountStats.set(matchedAddress, {
          realizedPnl: realizedText,
          unrealizedPnl: unrealizedText,
          totalValue: totalValueText,
          currentBalance: currentBalanceText,
          winRate: winRateText && (/\d+(?:\.\d+)?\s*%/.exec(winRateText) || [])[0] || null,
          transactions: txnsText && (txnsText.match(/\d+/) || [])[0] || null,
          wins: winsText && (winsText.match(/\d+/) || [])[0] || null,
          losses: lossesText && (lossesText.match(/\d+/) || [])[0] || null,
          coinsTraded: coinsText && (coinsText.match(/\d+/) || [])[0] || null,
          riskReward: riskRewardText,
        });
        if (state.pendingWalletOverview === matchedAddress) state.pendingWalletOverview = null;
        state.walletsSignature = null;
        renderWallets();
        if (address) {
          if (state.walletOverviewObserver) state.walletOverviewObserver.disconnect();
          state.walletOverviewObserver = null;
          watchWalletOverview();
          return true;
        }
      }
      return !!address && Date.now() - started > 12000;
    };
    const observer = new MutationObserver(() => { if (inspect()) observer.disconnect(); });
    state.walletOverviewObserver = observer;
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    setTimeout(() => { if (inspect()) observer.disconnect(); }, 250);
    if (state.pendingWalletOverview) setTimeout(() => {
      observer.disconnect();
      state.pendingWalletOverview = null;
      if (state.walletOverviewObserver === observer) {
        state.walletOverviewObserver = null;
        watchWalletOverview();
      }
    }, 12050);
  }
  function readTradeRowDetails(rowEl, walletAddress) {
    const columnsRoot = rowEl.querySelector('[class*="_columns_"]') || rowEl;
    const columns = [...columnsRoot.children];
    const columnText = index => {
      const col = columns[index];
      return col ? (col.innerText || col.textContent || '').replace(/\s+/g, ' ').trim() : '';
    };
    const details = {
      bought: columnText(3), sold: columnText(4), realizedPnl: columnText(5), remaining: columnText(6),
      buyCount: null, sellCount: null,
    };
    // Padre's holder cells commonly display transaction counts as "$value MC / count".
    // Read those visible counts before falling back to React props.
    const visibleCount = value => {
      const match = /\/\s*(\d+)\b/.exec(String(value || ''));
      return match ? Number(match[1]) : null;
    };
    details.buyCount = visibleCount(details.bought);
    details.sellCount = visibleCount(details.sold);
    const countKeys = {
      buys: /^(?:total|num)?buys?(?:count|txcount|transactions|transactioncount|trades)?$|^(?:total)?buy(?:count|txcount|transactions|trades)$/,
      sells: /^(?:total|num)sells?(?:count|txcount|transactions|transactioncount|trades)?$|^(?:total)?sell(?:count|txcount|transactions|trades)$/,
    };
    const inspectProps = props => {
      const stack = [{ value: props, depth: 0 }], seen = new Set();
      let steps = 0;
      while (stack.length && steps++ < 220) {
        const { value, depth } = stack.pop();
        if (!value || typeof value !== 'object' || seen.has(value) || depth > 4) continue;
        seen.add(value);
        const entries = Object.entries(value);
        const matchesWallet = entries.some(([key, child]) => /address|wallet/i.test(key) && child === walletAddress);
        if (matchesWallet) {
          for (const [key, child] of entries) {
            const normalized = key.toLowerCase().replace(/[^a-z]/g, '');
            const numeric = typeof child === 'number' && Number.isFinite(child) ? child : Array.isArray(child) ? child.length : null;
            if (numeric == null) continue;
            if (countKeys.buys.test(normalized)) details.buyCount = numeric;
            if (countKeys.sells.test(normalized)) details.sellCount = numeric;
          }
        }
        for (const [, child] of entries) if (child && typeof child === 'object') stack.push({ value: child, depth: depth + 1 });
      }
    };
    const fiberEls = [rowEl, ...rowEl.querySelectorAll('[class*="_cell_"],[class*="_address_"],span,button')].slice(0, 30);
    const seenFibers = new Set();
    for (const el of fiberEls) {
      let fiber = getFiber(el), levels = 0;
      while (fiber && levels++ < 2 && !seenFibers.has(fiber)) {
        seenFibers.add(fiber);
        inspectProps(fiber.memoizedProps);
        fiber = fiber.return;
      }
    }
    const remainingPercent = /(-?\d+(?:\.\d+)?)\s*%/.exec(details.remaining);
    details.openPosition = remainingPercent ? Number(remainingPercent[1]) > 0 : null;
    return details;
  }
  function walletRole(key, inherited) {
    const k = String(key || '').toLowerCase();
    if (/dev|deployer|creator|owner|authority/.test(k)) return 'creator/dev';
    if (/bundle/.test(k)) return 'bundle-associated';
    if (/insider/.test(k)) return 'insider';
    if (/sniper/.test(k)) return 'sniper';
    if (/fresh.*(buyer|wallet)|buyer|buy/.test(k)) return 'buyer';
    if (/holder/.test(k)) return 'holder';
    if (/trader/.test(k)) return 'trader';
    if (/wallet|user/.test(k)) return inherited || 'wallet reference';
    if (/address/.test(k)) return inherited || '';
    return inherited;
  }
  function collectWalletSignals(rec) {
    for (const signal of walletSignalsFor(rec)) {
      let row = state.wallets.get(signal.address);
      if (!row) {
        row = { address: signal.address, roles: new Set(), tokens: new Set(), profileUrl: signal.profileUrl };
        state.wallets.set(signal.address, row);
      }
      for (const role of signal.roles) row.roles.add(role);
      row.tokens.add(rec.t.symbol || rec.address);
    }
  }
  async function fetchMintPositions(mint) {
    const route = tradePageContext();
    if (!mint || !route || route.chain !== 'SOLANA' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint) || state.mintPositions.has(mint) || state.mintPositionsLoading.has(mint)) return;
    state.mintPositionsLoading.add(mint);
    try {
      const positions = new Map();
      const pageSize = 100;
      let totalCount = Infinity;
      // Padre returns hasMore/totalCount. Page 1 is the first page; continue
      // until all reported rows are collected or the endpoint stops advancing.
      for (let page = 1; page <= 20 && positions.size < totalCount; page++) {
        const pageParam = page > 1 ? '&page=' + page : '';
        const url = `https://frontend-api-v3.pump.fun/mint-positions/${encodeURIComponent(mint)}?sortBy=LATEST&withThesis=true&pageSize=${pageSize}${pageParam}`;
        const payload = await requestJson(url, { cache: 'no-store', timeoutMs: 12000 });
        if (!Array.isArray(payload.positions)) throw new Error('Unexpected positions response');
        totalCount = n(payload.totalCount) ?? totalCount;
        let added = 0;
        for (const position of payload.positions) {
          const address = position && position.walletAddress;
          if (!isWalletAddress(address)) continue;
          if (!positions.has(address)) added++;
          positions.set(address, {
            userName: position.userName || '',
            amountHeld: n(position.amountHeld), pnlUsd: n(position.pnlUsd), pnlPercentage: n(position.pnlPercentage),
            realizedPnlUsd: n(position.realizedPnlUsd), costBasisUsd: n(position.costBasisUsd), amountBoughtUsd: n(position.amountBoughtUsd),
          });
          let row = state.wallets.get(address);
          if (!row) {
            row = { address, roles: new Set(), tokens: new Set(), profileUrl: null };
            state.wallets.set(address, row);
          }
          row.roles.add('token position');
          row.tokens.add(state.tradeRecord && state.tradeRecord.t.symbol || addressShort(mint));
        }
        if (!payload.hasMore || !payload.positions.length || !added) break;
      }
      state.mintPositions.set(mint, positions);
      state.mintPositionsErrors.delete(mint);
      if (currentTradeMintAddress() === mint) fillWalletBatch();
    } catch (error) {
      // Do not cache a failed request as an empty result; keep it retryable.
      state.mintPositionsErrors.set(mint, String(error.message || error));
    } finally {
      state.mintPositionsLoading.delete(mint);
      if (state.activeTab === 'wallets' && currentTradeMintAddress() === mint) renderWallets();
      updateStatusStrip();
    }
  }
  function walletSignalsFor(rec) {
    if (rec.walletSignalsRaw === rec.raw && rec.walletSignals) return rec.walletSignals;
    const stack = [{ value: rec.raw, depth: 0, role: '' }], seen = new Set();
    const found = new Map();
    let nodes = 0;
    while (stack.length && nodes++ < 350) {
      const item = stack.pop();
      const value = item.value;
      if (!value || typeof value !== 'object' || seen.has(value) || item.depth > 5) continue;
      seen.add(value);
      for (const [key, child] of Object.entries(value)) {
        const role = walletRole(key, item.role);
        const keyLooksLikeContract = /token|mint|pool|market|contract|program|chain|caaddress/i.test(key);
        if (isWalletAddress(child) && child !== rec.address && role && !keyLooksLikeContract) {
          let row = found.get(child);
          if (!row) {
            row = { address: child, roles: new Set(), profileUrl: null };
            found.set(child, row);
          }
          row.roles.add(role);
        } else if (child && typeof child === 'object') {
          stack.push({ value: child, depth: item.depth + 1, role });
        }
      }
    }
    rec.walletSignalsRaw = rec.raw;
    rec.walletSignals = [...found.values()];
    return rec.walletSignals;
  }
  function displayedUsdAmount(value) {
    const match = /\$\s*([\d,]+(?:\.\d+)?)\s*([KMB])?/i.exec(String(value || ''));
    if (!match) return null;
    const amount = Number(match[1].replace(/,/g, ''));
    const scale = ({ K: 1e3, M: 1e6, B: 1e9 })[(match[2] || '').toUpperCase()] || 1;
    return Number.isFinite(amount) ? amount * scale : null;
  }
  function cleanTradeValue(value) {
    const text = String(value == null ? '' : value).replace(/^(bought|sold|remaining|u\.?pnl)\s*:?\s*/i, '').trim();
    return text || '—';
  }
  function walletVolume(row) {
    const d = row.tradeDetails;
    if (!d) return null;
    const bought = displayedUsdAmount(d.bought), sold = displayedUsdAmount(d.sold);
    if (bought == null && sold == null) return null;
    return (bought || 0) + (sold || 0);
  }
  function walletDisplayedRealizedPnl(row) {
    const value = row.tradeDetails && row.tradeDetails.realizedPnl;
    if (!value || !/\$/.test(String(value))) return null;
    const text = String(value);
    const match = /-?\s*\$\s*-?\s*([\d,]+(?:\.\d+)?)\s*([KMB])?/i.exec(text);
    if (!match) return null;
    const amount = Number(match[1].replace(/,/g, ''));
    const scale = ({ K: 1e3, M: 1e6, B: 1e9 })[(match[2] || '').toUpperCase()] || 1;
    const negative = /-\s*\$|\$\s*-|\(\s*-?\s*\$/.test(text);
    return Number.isFinite(amount) ? (negative ? -1 : 1) * amount * scale : null;
  }
  function renderWallets() {
    if (!state.walletsEl) return;
    const mint = currentTradeMintAddress();
    const perMint = mint ? state.mintPositions.get(mint) : null;
    const apiError = mint ? state.mintPositionsErrors.get(mint) : '';
    const apiStatus = state.root.querySelector('[data-wallet-api-status]');
    const apiRetry = state.root.querySelector('[data-action="wallet-api-retry"]');
    if (apiStatus) {
      apiStatus.textContent = apiError ? 'Token stats unavailable' : mint && state.mintPositionsLoading.has(mint) ? 'Loading token stats…' : '';
      apiStatus.title = apiError || '';
    }
    if (apiRetry) apiRetry.hidden = !apiError;
    const allRows = state.walletBatch.map(address => state.wallets.get(address)).filter(Boolean);
    if (state.walletSort === 'volume') allRows.sort((a, b) => (walletVolume(b) ?? -1) - (walletVolume(a) ?? -1));
    if (state.walletSort === 'realized') allRows.sort((a, b) => {
      const av = walletDisplayedRealizedPnl(a);
      const bv = walletDisplayedRealizedPnl(b);
      if (av == null) return bv == null ? 0 : 1;
      if (bv == null) return -1;
      return bv - av;
    });
    if (state.walletSort === 'tokenPnl') allRows.sort((a, b) => {
      const av = perMint && perMint.get(a.address)?.pnlUsd;
      const bv = perMint && perMint.get(b.address)?.pnlUsd;
      if (av == null) return bv == null ? 0 : 1;
      if (bv == null) return -1;
      return bv - av;
    });
    const query = state.walletSearch;
    const rows = allRows.filter(row => {
      const d = row.tradeDetails;
      const tokenPosition = perMint && perMint.get(row.address);
      if (state.walletFilter === 'open' && !(tokenPosition ? tokenPosition.amountHeld != null && tokenPosition.amountHeld > 0 : d && d.openPosition === true)) return false;
      if (state.walletFilter === 'closed' && !(tokenPosition ? tokenPosition.amountHeld != null && tokenPosition.amountHeld <= 0 : d && d.openPosition === false)) return false;
      if (!query) return true;
      return [row.address, ...row.roles, ...row.tokens].join(' ').toLowerCase().includes(query);
    });
    state.walletPageCount = Math.max(1, Math.ceil(rows.length / state.walletPageSize));
    state.walletPage = Math.max(0, Math.min(state.walletPage, state.walletPageCount - 1));
    const pageStart = state.walletPage * state.walletPageSize;
    const pageRows = rows.slice(pageStart, pageStart + state.walletPageSize);
    const pageEl = state.root.querySelector('[data-wallet-page]');
    const prevButton = state.root.querySelector('[data-action="wallet-page-prev"]');
    const nextButton = state.root.querySelector('[data-action="wallet-page-next"]');
    const loadingStats = !!(mint && state.mintPositionsLoading.has(mint));
    if (pageEl) pageEl.textContent = `Page ${state.walletPage + 1} / ${state.walletPageCount}`;
    if (prevButton) prevButton.disabled = state.walletPage === 0;
    if (nextButton) {
      nextButton.disabled = state.walletPage >= state.walletPageCount - 1;
      const needsStats = !!mint && !perMint && state.walletPage === 0;
      nextButton.classList.toggle('loading', loadingStats);
      nextButton.title = loadingStats ? 'Loading token stats…' : needsStats ? 'Next page · load token stats' : 'Next page';
      nextButton.setAttribute('aria-label', nextButton.title);
    }
    const searchWrap = state.root.querySelector('.wallet-search-wrap');
    if (searchWrap) searchWrap.classList.toggle('has-value', !!query);
    const sig = pageRows.map(row => row.address + ':' + [...row.roles].sort().join(',') + ':' + [...row.tokens].sort().join(',') + ':' + JSON.stringify(row.tradeDetails || null) + ':' + JSON.stringify(perMint && perMint.get(row.address) || null) + ':' + JSON.stringify(state.walletAccountStats.get(row.address) || null)).join('|') + ':' + query + ':' + state.walletFilter + ':' + state.walletSort + ':' + state.walletPage;
    const countEl = state.root.querySelector('[data-wallet-count]');
    if (countEl) countEl.textContent = rows.length === allRows.length ? rows.length + ' wallets' : rows.length + ' / ' + allRows.length + ' wallets';
    if (sig === state.walletsSignature && state.walletsEl.childElementCount) return;
    state.walletsSignature = sig;
    state.walletsEl.innerHTML = pageRows.length ? pageRows.map(row => {
      const tokenPosition = perMint && perMint.get(row.address);
      const usefulRoles = [...row.roles].filter(role => ['buyer', 'trader', 'holder', 'insider', 'sniper', 'bundle-associated', 'token position'].includes(role));
      const d = row.tradeDetails;
      const buyCount = d && d.buyCount != null ? String(d.buyCount) : '—';
      const sellCount = d && d.sellCount != null ? String(d.sellCount) : '—';
       const isOpen = tokenPosition ? tokenPosition.amountHeld != null && tokenPosition.amountHeld > 0 : d && d.openPosition === true;
       const known = tokenPosition ? tokenPosition.amountHeld != null : !!(d && d.openPosition != null);
      const position = !known ? 'Unknown' : isOpen ? 'Open' : 'Closed';
      const positionClass = !known ? 'closed' : isOpen ? 'open' : 'closed';
       const pnl = tokenPosition && tokenPosition.pnlUsd != null ? fmtUsd(tokenPosition.pnlUsd) : d && d.realizedPnl || '—';
       const pnlLabel = tokenPosition && tokenPosition.pnlUsd != null ? 'Token PnL' : 'R. PnL';
      const tokenBought = tokenPosition && tokenPosition.amountBoughtUsd != null ? fmtUsd(tokenPosition.amountBoughtUsd) : null;
      const bought = cleanTradeValue(tokenBought || (d && d.bought));
      const sold = cleanTradeValue(d && d.sold);
      const remaining = tokenPosition ? (tokenPosition.amountHeld == null ? '—' : String(tokenPosition.amountHeld) + ' Tok') : cleanTradeValue(d && d.remaining);
      const accountStats = state.walletAccountStats.get(row.address);
      const pnlClass = /-\s*\$|\(\s*-/.test(pnl) ? 'pnl-negative' : /\$/.test(pnl) && pnl !== '—' ? 'pnl-positive' : '';
      const tokenScope = tokenPosition
        ? `Token position · ${tokenPosition.userName || addressShort(row.address)}\nHeld: ${tokenPosition.amountHeld == null ? '—' : tokenPosition.amountHeld}\nToken PnL: ${tokenPosition.pnlUsd == null ? '—' : fmtUsd(tokenPosition.pnlUsd)}${tokenPosition.pnlPercentage == null ? '' : ' (' + (tokenPosition.pnlPercentage > 0 ? '+' : '') + tokenPosition.pnlPercentage.toFixed(1) + '%)'}\nCost basis: ${tokenPosition.costBasisUsd == null ? '—' : fmtUsd(tokenPosition.costBasisUsd)}\nAmount bought: ${tokenPosition.amountBoughtUsd == null ? '—' : fmtUsd(tokenPosition.amountBoughtUsd)}\nToken realized PnL: ${tokenPosition.realizedPnlUsd == null ? '—' : fmtUsd(tokenPosition.realizedPnlUsd)}\nSource: Padre mint-positions · token-scoped`
        : 'No current-token API row for this wallet yet.';
       const walletScope = accountStats
         ? `\n\nWallet overview · account-wide · Padre\nUnrealized PnL: ${accountStats.unrealizedPnl || '—'}\nRealized PnL: ${accountStats.realizedPnl || '—'}\nTotal value: ${accountStats.totalValue || '—'}\nCurrent balance: ${accountStats.currentBalance || '—'}\nWin rate: ${accountStats.winRate || '—'}\nTXNS: ${accountStats.transactions || '—'} (${accountStats.wins || '—'} wins / ${accountStats.losses || '—'} losses)\nCoins traded: ${accountStats.coinsTraded || '—'}${accountStats.riskReward ? '\nRisk/Reward: ' + accountStats.riskReward : ''}`
        : '';
      const hoverStats = tokenScope + walletScope;
      const roleLine = usefulRoles.length ? usefulRoles.join(' · ') : 'wallet';
      const tokenLine = [...row.tokens].join(', ');
      const roleTitle = roleLine + (tokenLine ? ' · ' + tokenLine : '');
       return `<div class="wallet-item"><div class="wallet-top"><button class="wallet-address wallet-open" data-action="wallet-modal" data-address="${esc(row.address)}" data-info="${esc(hoverStats)}" aria-label="Open Padre wallet overview for ${esc(row.address)}">${esc(addressShort(row.address))}</button><span class="wallet-status ${positionClass}">${position}</span><button class="icon-btn wallet-copy" data-action="copy-wallet" data-address="${esc(row.address)}" aria-label="Copy wallet address" title="Copy address">${icon('copy', 12)}</button></div><div class="wallet-roles" title="${esc(roleTitle)}">${esc(roleLine)}${tokenLine ? ' · ' + esc(tokenLine) : ''}</div><div class="wallet-metrics"><div class="wallet-metric">Bought<b>${esc(bought)}</b></div><div class="wallet-metric">Sold<b>${esc(sold)}</b></div><div class="wallet-metric">Buys<b>${esc(buyCount)}</b></div><div class="wallet-metric">Sells<b>${esc(sellCount)}</b></div></div><div class="wallet-bottom"><span class="wallet-metric">Remaining<b>${esc(remaining)}</b></span><span class="wallet-metric ${pnlClass}">${pnlLabel}<b>${esc(pnl)}</b></span></div></div>`;
    }).join('') : emptyState('users', 'No wallets loaded. Scroll Padre’s holder list, then press refresh.', { action: 'wallet-rescan', label: 'Refresh rows' });
  }
  function fillWalletBatch() {
    const next = [...state.wallets.values()].filter(row => walletRoleRank(row) > 0)
      .sort((a, b) => (Number(!!(b.tradeDetails && b.tradeDetails.openPosition)) * 100 + walletRoleRank(b) + b.tokens.size * 12) - (Number(!!(a.tradeDetails && a.tradeDetails.openPosition)) * 100 + walletRoleRank(a) + a.tokens.size * 12)).slice(0, 100);
    state.walletBatch = next.map(row => row.address);
    for (const row of next) state.walletReturned.add(row.address);
    state.walletsSignature = null;
  }
  function walletRoleRank(row) {
    if (row.roles.has('token position')) return 30;
    if (row.roles.has('buyer')) return 60;
    if (row.roles.has('trader')) return 55;
    if (row.roles.has('insider')) return 45;
    if (row.roles.has('sniper')) return 40;
    if (row.roles.has('bundle-associated')) return 35;
    if (row.roles.has('holder')) return 30;
    return 0;
  }
  function rescanWalletBatch() {
    if (state.activeTab !== 'wallets') return;
    scanCards();
    scanTradeWallets();
    fillWalletBatch();
    renderWallets();
  }
  function copyText(value) {
    if (!value) return;
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(value).catch(() => {});
  }

  function selectedTokenContext() {
    const route = tradePageContext();
    if (route && !currentTradeMintAddress()) primeTokenCaTooltip();
    const routeRec = route && state.tradeRecord;
    const address = (route && currentTradeMintAddress()) || (!route ? state.selectedPatternAddress || '' : '');
    const rec = address ? findByAddress(address) : null;
    const tradeRec = routeRec || rec;
    return { address, rec: rec || tradeRec, chain: rec ? rec.t.chain : route ? route.chain : '', label: (rec || tradeRec)?.t?.symbol ? '$' + (rec || tradeRec).t.symbol : address ? addressShort(address) : 'No token selected', routeAddress: route && route.address };
  }
  function xSearchUrl(address, requestId) {
    return 'https://x.com/search?q=' + encodeURIComponent(address) + '&src=typed_query&f=live&pc=padre-edge-x-' + encodeURIComponent(requestId);
  }
  function receiveXStorageResult(payload) {
    if (!payload || payload.requestId !== state.xRequestId) return;
    const address = state.xQueryMap.get(String(payload.query || '').trim().toLowerCase());
    if (!address) return;
    const scan = state.xScans.get(address) || { query: payload.query, tweets: [] };
    scan.at = Date.now();
    scan.tweets = Array.isArray(payload.tweets) ? payload.tweets.slice(0, 40) : [];
    scan.status = payload.status || (payload.loginRequired ? 'login' : payload.error ? 'error' : payload.empty || !scan.tweets.length ? 'empty' : 'done');
    scan.error = payload.error || '';
    scan.source = 'x-page';
    state.xScans.set(address, scan);
    clearTimeout(state.xTimeout);
    closeXHelper();
    removeXStorageListener();
    renderXMentions();
  }
  function listenForXResults(requestId) {
    removeXStorageListener();
    if (!requestId || typeof GM_addValueChangeListener !== 'function') return;
    const key = 'padre-edge-x-result-' + requestId;
    const id = GM_addValueChangeListener(key, (_key, _oldValue, newValue) => receiveXStorageResult(newValue));
    state.xStorageListener = { key, id };
  }
  function removeXStorageListener() {
    const current = state.xStorageListener;
    if (!current) return;
    try { if (typeof GM_removeValueChangeListener === 'function') GM_removeValueChangeListener(current.id); } catch (e) { /* listener cleanup is best-effort */ }
    state.xStorageListener = null;
  }
  function closeXHelper() {
    try { if (state.xWindow && !state.xWindow.closed) state.xWindow.close(); } catch (e) { /* helper may already be closed */ }
    state.xWindow = null;
  }
  function renderXMentions() {
    if (!state.root) return;
    const token = selectedTokenContext();
    const tokenEl = state.root.querySelector('[data-x-token]');
    const statusEl = state.root.querySelector('[data-x-status]');
    const searchButton = state.root.querySelector('[data-action="x-search"]');
    const address = token.address;
    const scan = address ? state.xScans.get(address) : null;
    if (tokenEl) tokenEl.innerHTML = address
      ? `<a class="token-trade-link" href="${esc(padreTradeUrl(token.chain, token.routeAddress || address))}" title="Open token on Padre"><b>${esc(token.label)}</b></a><span class="meta" title="${esc(address)}">CA ${esc(addressShort(address))}</span>${token.routeAddress && token.routeAddress !== address ? `<span class="meta" title="Padre trade route / pair address">· pair ${esc(addressShort(token.routeAddress))}</span>` : ''}${token.rec ? `<span class="meta">· score ${token.rec.score}/100 · ${token.rec.signalCoverage || 0}/10 inputs</span>` : ''}`
      : '<button type="button" data-action="x-select-token">Select a token</button>';
    if (searchButton) searchButton.disabled = !address;
    const labels = { scanning: 'Waiting for results…', done: (scan && scan.tweets.length || 0) + ' mentions loaded', empty: 'No posts matched this address on X.', login: 'Sign in to X and retry.', timeout: 'No response from the scanner.', error: scan && scan.error || 'X search failed.' };
    if (statusEl) statusEl.textContent = scan ? (labels[scan.status] || 'Ready.') : address ? 'Ready to search this CA.' : 'Ready when a token is selected.';
    if (!state.xResultsEl) return;
    const tweets = scan && scan.tweets || [];
    state.xResultsEl.innerHTML = tweets.length ? tweets.map(tweet => {
      const date = tweet.createdAt ? new Date(tweet.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
      const metrics = tweet.metrics || {};
      const counts = [['reply', 'replies'], ['retweet', 'reposts'], ['like', 'likes']].filter(([key]) => metrics[key] != null).map(([key, label]) => `${esc(metrics[key])} ${label}`).join(' · ');
      const avatar = tweet.avatar ? `<img class="x-avatar" src="${esc(tweet.avatar)}" alt="" loading="lazy">` : '<span class="x-avatar"></span>';
      const media = Array.isArray(tweet.media) ? tweet.media.slice(0, 4).map(src => `<img class="x-media" src="${esc(src)}" alt="" loading="lazy">`).join('') : '';
      return `<div class="x-post"><div class="x-head">${avatar}<span class="x-author-wrap"><span class="x-display">${esc(tweet.displayName || tweet.author || 'Unknown')}</span><span class="x-author">@${esc(tweet.author || 'unknown')}</span></span>${date ? `<span class="x-time">${esc(date)}</span>` : ''}</div><div class="x-text">${esc(tweet.text || '')}</div>${media}${counts ? `<div class="x-meta">${counts}</div>` : ''}</div>`;
    }).join('') : scan && (scan.status === 'empty' || scan.status === 'done') ? emptyState('at', 'No posts matched this address on X.') : '';
  }
  function startXSearch(rescan) {
    const token = selectedTokenContext();
    if (!token.address) { renderXMentions(); return; }
    const address = token.address;
    const query = address;
    const requestId = String(Date.now()) + String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
    state.xRequestId = requestId;
    const url = xSearchUrl(query, requestId);
    listenForXResults(requestId);
    try {
      if (typeof GM_setValue === 'function') GM_setValue('padre-edge-x-request-' + requestId, { requestId, query, expiresAt: Date.now() + 60000 });
    } catch (e) { /* storage bridge is optional; popup message fallback remains */ }
    let popup = state.xWindow;
    try {
      if (popup && !popup.closed) popup.location.href = url;
      else popup = window.open(url, 'padre_edge_x_mentions', 'popup=1,width=2,height=2,left=-10000,top=-10000,resizable=no,scrollbars=no');
    } catch (e) { popup = null; }
    if (!popup) {
      state.xScans.set(address, { status: 'error', error: 'Popup blocked. Allow popups for Padre, then retry.', tweets: [] });
      removeXStorageListener();
      renderXMentions();
      return;
    }
    state.xWindow = popup;
    state.xQueryMap.set(query.toLowerCase(), address);
    state.xScans.set(address, { status: 'scanning', tweets: [], query, at: Date.now(), rescan: !!rescan });
    clearTimeout(state.xTimeout);
    state.xTimeout = setTimeout(() => {
      const current = state.xScans.get(address);
      if (current && current.status === 'scanning') {
        current.status = 'timeout';
        closeXHelper();
        removeXStorageListener();
        renderXMentions();
      }
    }, 24000);
    renderXMentions();
  }
  function handleXMessage(event) {
    // X may promote a popup into a regular tab. In that case Chromium can
    // expose a different WindowProxy even though it is still the opener.
    // Origin plus the active query are the security checks we need here.
    if (!['https://x.com', 'https://twitter.com'].includes(event.origin)) return;
    const data = event.data;
    if (!data || data.source !== 'padre-copilot-x' || data.type !== 'results') return;
    const address = state.xQueryMap.get(String(data.query || '').trim().toLowerCase());
    if (!address) return;
    const scan = state.xScans.get(address) || { query: data.query, tweets: [] };
    scan.at = Date.now();
    scan.tweets = Array.isArray(data.tweets) ? data.tweets.slice(0, 40) : [];
    scan.status = data.loginRequired ? 'login' : data.error ? 'error' : data.empty || !scan.tweets.length ? 'empty' : 'done';
    scan.error = data.error || '';
    state.xScans.set(address, scan);
    clearTimeout(state.xTimeout);
    closeXHelper();
    removeXStorageListener();
    renderXMentions();
  }

  function runXSearchCollector() {
    const parseLocation = () => {
      const params = new URLSearchParams(location.search);
      const rawQuery = params.get('q') || '';
      let query = rawQuery;
      try { query = decodeURIComponent(query); } catch (e) { /* already decoded */ }
      const marker = /^padre-edge-x-([A-Za-z0-9_-]+)$/.exec(params.get('pc') || '');
      return { query: query.trim(), requestId: marker ? marker[1] : '' };
    };
    const context = parseLocation();
    if (!context.query || !context.requestId || typeof GM_getValue !== 'function' || typeof GM_setValue !== 'function') return;
    let request;
    try { request = GM_getValue('padre-edge-x-request-' + context.requestId, null); } catch (e) { return; }
    if (!request || request.expiresAt < Date.now() || request.query.toLowerCase() !== context.query.toLowerCase()) return;
    if (context.requestId !== request.requestId) return;
    const loginWall = () => {
      if (/\/(i\/flow\/login|i\/jf\/onboarding|login)/.test(location.pathname)) return true;
      if (document.querySelector('[data-testid="loginButton"]') && !document.querySelector('article[data-testid="tweet"]')) return true;
      const text = (document.body && document.body.innerText || '').toLowerCase();
      return /sign in to x|log in to x|bejelentkez|iniciar sesi[oó]n|se connecter/.test(text) && !document.querySelector('article[data-testid="tweet"]');
    };
    const emptyState = () => {
      if (document.querySelector('[data-testid="emptyState"]')) return true;
      const text = (document.body && document.body.innerText || '').toLowerCase();
      return /no results for|no results|try searching for something else|nincs tal[aá]lat|sem resultados/.test(text);
    };
    const extract = () => {
      const out = [], seen = new Set();
      for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
        const text = (article.querySelector('[data-testid="tweetText"]')?.innerText || '').trim();
        if (!text) continue;
        const userText = (article.querySelector('[data-testid="User-Name"]')?.innerText || '').replace(/\s+/g, ' ').trim();
        const handle = /@([A-Za-z0-9_]{1,15})/.exec(userText)?.[1] || '';
        const displayName = userText.replace(/\s*@?[A-Za-z0-9_]{1,15}.*$/, '').trim() || handle;
        const time = article.querySelector('time');
        let url = time?.closest('a[href*="/status/"]')?.getAttribute('href') || [...article.querySelectorAll('a[href*="/status/"]')].map(a => a.getAttribute('href') || '').find(h => /\/status\/\d+/.test(h)) || '';
        if (url.startsWith('/')) url = 'https://x.com' + url;
        const id = /\/status\/(\d+)/.exec(url)?.[1];
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const avatarEl = article.querySelector('[data-testid="UserAvatar-Container-unknown"] img, [data-testid="Tweet-User-Avatar"] img, img[src*="profile_images"]');
        const metrics = {};
        for (const key of ['reply', 'retweet', 'like']) {
          const el = article.querySelector('[data-testid="' + key + '"]');
          const match = /([\d,.]+)/.exec(el?.getAttribute('aria-label') || '');
          if (match) metrics[key] = match[1];
        }
        const media = [...article.querySelectorAll('img[src*="pbs.twimg.com/media"],video[poster]')].map(el => el.currentSrc || el.src || el.poster || '').filter(Boolean).slice(0, 4);
        out.push({ id, author: handle, displayName, avatar: avatarEl?.currentSrc || avatarEl?.src || '', text: text.slice(0, 1000), createdAt: time?.getAttribute('datetime') || '', url, metrics, media });
        if (out.length >= 40) break;
      }
      return out;
    };
    let elapsed = 0, previousCount = -1, stable = 0, finished = false;
    const timer = setInterval(() => {
      if (finished) { clearInterval(timer); return; }
      elapsed += 500;
      let status = '', tweets = [], error = '';
      if (loginWall()) status = 'login';
      else if (document.body && /something went wrong|try reloading|try again later/i.test(document.body.innerText)) { status = 'error'; error = 'X search error.'; }
      else {
        tweets = extract();
        if (tweets.length) {
          stable = tweets.length === previousCount ? stable + 1 : 0;
          previousCount = tweets.length;
          if (stable >= 3 || elapsed >= 8000) status = 'done';
        } else if (emptyState() && elapsed >= 1500) status = 'empty';
        else if (elapsed >= 18000) status = 'empty';
      }
      if (!status) return;
      finished = true;
      const payload = { requestId: request.requestId, query: request.query, status, tweets, empty: status === 'empty' || status === 'login', loginRequired: status === 'login', error, completedAt: Date.now() };
      try {
        const stored = GM_setValue('padre-edge-x-result-' + request.requestId, payload);
        Promise.resolve(stored).finally(() => setTimeout(() => { try { window.close(); } catch (e) { /* ignored */ } }, 250));
      } catch (e) { /* parent will time out */ }
      clearInterval(timer);
    }, 500);
  }

  function rowHtml(rec) {
    const t = rec.t;
    const labels = rec.reasons.map(r => (r.d > 0 ? '+' : '') + r.d + ' ' + r.label);
    const riskText = labels.slice(0, 2).map(esc).join(' · ') || 'Neutral score: no scoring inputs available';
    const more = labels.length > 2 ? `<span class="chip more" title="${esc(labels.slice(2).join('\n'))}">+${labels.length - 2}</span>` : '';
    const fire = isHighActivity(rec);
    const warnings = warningChecks(t);
    const warningColors = warningBadgeColors(warnings.length);
    const warningIcon = warnings.length ? `<span class="pe-warning-badge" title="${esc(warningColors.label + '\n' + warnings.join('\n'))}" style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;flex:none;border-radius:50%;background:${warningColors.background};color:${warningColors.foreground};font:900 10px/14px system-ui">!</span>` : '';
    const evidenceTip = (rec.signalCoverage || 0) + ' of 10 weighted discovery inputs present; ' + rec.coverage + ' of 7 concentration-risk inputs present. Missing data is neutral, not proof of safety.';
    const liveFacts = t.mode === 'TRADE' ? [
      ['Liquidity', t.liquidityUsd == null ? null : fmtUsd(t.liquidityUsd)],
      ['Volume', t.volumeUsd == null ? null : fmtUsd(t.volumeUsd)],
      ['Holders', t.holders == null ? null : t.holders.toLocaleString()],
    ].filter(([, value]) => value != null).map(([label, value]) => `<span>${label}<b>${esc(value)}</b></span>`).join('') : '';
    const liveFactsHtml = liveFacts ? `<div class="meta trade-live-facts"><b>Live Padre</b>${liveFacts}</div>` : '';
    const scoreTitle = rec.score + '/100 discovery score · ' + (rec.signalCoverage || 0) + '/10 weighted inputs present. Not a buy signal.';
    return `<div class="row" data-address="${esc(rec.address)}"><div class="score" style="background:${COLORS[rec.grade]}" title="${esc(scoreTitle)}">${rec.score}${fire ? '<span class="fire">🔥</span>' : ''}</div><div class="main"><div class="line">${warningIcon}<a class="token-trade-link" href="${esc(padreTradeUrl(t.chain, rec.address))}" title="Open $${esc(t.symbol)} on Padre"><span class="sym">$${esc(t.symbol)}</span><span class="muted">${esc(t.name)}</span></a><span class="chip age">${esc(fmtAge(t.ageSec))}</span></div><div class="meta">CA ${esc(addressShort(rec.address))} · MC/FDV ${esc(fmtUsd(t.marketCap))} · <span class="evidence" title="${esc(evidenceTip)}">${rec.signalCoverage || 0}/10</span></div><div class="meta risk"><span class="trunc" title="${esc(labels.join('\n'))}">${riskText}</span>${more}</div>${liveFactsHtml}</div><button class="icon-btn row-chart" data-action="analyze-one" aria-label="Analyze chart for $${esc(t.symbol)}" title="Analyze chart">${icon('chart', 15)}</button></div>`;
  }
  function filterAgeRows(rows) {
    if (state.ageFilter === 'new') return rows.filter(r => r.t.mode === 'NEW');
    const maxAge = Number(state.ageFilter);
    if (!Number.isFinite(maxAge)) return rows;
    return rows.filter(r => r.t.ageSec != null && r.t.ageSec <= maxAge * 60);
  }
  function renderAgeFilters() {
    const filters = [['all', 'All'], ['new', 'New only'], ['5', '5m'], ['15', '15m'], ['25', '25m']];
    for (const bar of state.root.querySelectorAll('.age-filters')) {
      bar.innerHTML = filters.map(([value, label]) => `<button class="btn ghost age-filter ${state.ageFilter === value ? 'active' : ''}" data-action="age-filter" data-age="${value}">${label}</button>`).join('');
    }
  }
  function render() {
    if (!state.root) return;
    const route = tradePageContext();
    const currentTradeRec = route && (visibleRecords().find(r => r.address === route.address) || state.tradeRecord);
    const allRows = (route ? (currentTradeRec ? [currentTradeRec] : []) : visibleRecords()).sort((a, b) => b.score - a.score);
    const rows = filterAgeRows(allRows);
    const sig = rows.map(r => r.address + ':' + r.score + ':' + Math.round(r.t.marketCap || 0) + ':' + Math.round(r.t.liquidityUsd || 0) + ':' + Math.round(r.t.volumeUsd || 0) + ':' + (r.t.holders || '') + ':' + r.t.symbol + ':' + r.t.name).join('|') + ':' + state.ageFilter;
    renderAgeFilters();
    state.count.textContent = rows.length ? (rows.length === allRows.length ? rows.length : rows.length + '/' + allRows.length) + ' tokens' : tradePageContext() ? 'Token detail' : '0 tokens';
    const picksCount = state.root.querySelector('[data-picks-count]');
    if (picksCount) picksCount.textContent = rows.length ? Math.min(5, rows.length) + ' shown' : '';
    if (sig !== state.signature) {
      state.signature = sig;
      state.list.innerHTML = rows.length ? rows.map(rowHtml).join('') : emptyState('shield', 'No tokens match this age filter.', { action: 'age-filter', age: 'all', label: 'Clear filter' });
    }
    const isTradePage = !!route;
    const recommendedTab = state.root.querySelector('.tab[data-tab="recommended"]');
    const recommendedPane = state.root.querySelector('.pane[data-pane="recommended"]');
    const botTab = state.root.querySelector('.tab[data-tab="bot"]');
    if (botTab) botTab.hidden = !isTradePage;
    if (recommendedTab) recommendedTab.hidden = isTradePage;
    if (recommendedPane) recommendedPane.hidden = isTradePage;
    if (isTradePage && state.activeTab === 'recommended') setTab('picks');
    if (!isTradePage && state.activeTab === 'bot') setTab('patterns');
    const topFive = rows.slice().sort((a, b) => b.score - a.score).slice(0, 5);
    const recSig = topFive.map(r => r.address + ':' + r.score + ':' + Math.round(r.t.marketCap || 0)).join('|') + ':' + state.ageFilter;
    if (recSig !== state.recommendationSignature) {
      state.recommendationSignature = recSig;
      state.recommendations.innerHTML = topFive.length ? topFive.map(rowHtml).join('') : emptyState('spark', 'No visible cards match this age filter.', { action: 'age-filter', age: 'all', label: 'Clear filter' });
    }
    if (state.activeTab === 'patterns') renderPatterns();
    if (state.activeTab === 'bot') renderBot();
    if (state.activeTab === 'xmentions') renderXMentions();
    if (state.activeTab === 'wallets') renderWallets();
  }

  function updateBotStrategyControls() {
    if (!state.root) return;
    const selected = state.bot.editingStrategy || state.bot.config.strategy;
    const strategySelect = state.root.querySelector('[data-bot-config="strategy"]');
    if (strategySelect) strategySelect.value = selected;
    for (const button of state.root.querySelectorAll('[data-action="bot-strategy"]')) {
      const active = button.dataset.strategy === selected;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    for (const field of state.root.querySelectorAll('[data-bot-strategy-field]')) {
      const kind = field.dataset.botStrategyField;
      field.hidden = kind === 'demo' ? state.bot.mode === 'real'
        : kind === 'lowHigh' ? selected !== 'lowHigh'
          : selected !== 'breakout';
    }
  }
  function syncBotConfigInputs() {
    if (!state.root) return;
    state.bot.editingStrategy = state.bot.config.strategy;
    for (const input of state.root.querySelectorAll('[data-bot-config]')) {
      const key = input.dataset.botConfig;
      if (key === 'strategy') input.value = state.bot.editingStrategy;
      else if (Object.prototype.hasOwnProperty.call(state.bot.config, key)) input.value = String(state.bot.config[key]);
    }
    updateBotStrategyControls();
  }
  function renderBot() {
    if (!state.root) return;
    const route = tradePageContext();
    const rec = route && state.tradeRecord;
    const snapshot = pageWindow._recentSnapshot;
    const candles = snapshot && Array.isArray(snapshot.candles) ? snapshot.candles : [];
    const latest = candles.length ? candles[candles.length - 1] : null;
    let timestamp = latest && Number(latest[5]);
    if (timestamp > 1e12) timestamp /= 1000;
    const ageMs = Number.isFinite(timestamp) ? Math.max(0, Date.now() - timestamp * 1000) : null;
    const price = latest && Number.isFinite(Number(latest[2])) ? Number(latest[2]) : null;
    processDemoBot(candles, route);
    state.bot.sampleCount = candles.length;
    state.bot.lastPrice = price;
    state.bot.lastCandleAt = Number.isFinite(timestamp) ? timestamp : null;
    const setText = (selector, value) => { const el = state.root.querySelector(selector); if (el) el.textContent = value; };
    setText('[data-bot-token]', rec ? '$' + (rec.t.symbol || addressShort(route.address)) + ' · ' + addressShort(currentTradeMintAddress() || route.address) : 'No open token');
    setText('[data-bot-candle-count]', candles.length ? candles.length.toLocaleString() : 'Unavailable');
    setText('[data-bot-price]', price == null ? '—' : fmtPrice(price));
    setText('[data-bot-age]', ageMs == null ? '—' : ageMs < 1000 ? 'just now' : Math.round(ageMs / 1000) + 's ago');
    const heartbeat = Number(pageWindow._padre_lastMxMsgMs);
    const heartbeatAge = Number.isFinite(heartbeat) && heartbeat > 0 ? Math.max(0, Date.now() - heartbeat) : null;
    setText('[data-bot-feed-state]', !latest ? 'Waiting for chart' : heartbeatAge != null && heartbeatAge <= 15000 ? 'Padre feed connected' : 'Chart snapshot loaded');
    setText('[data-bot-monitor-status]', state.bot.running ? (state.bot.mode === 'real' ? 'AUTO LIVE · Padre native orders' : 'Demo running · no real orders') : (state.bot.mode === 'real' ? 'Auto stopped · no new orders' : 'Demo stopped'));
    setText('[data-bot-position]', state.bot.mode === 'real'
      ? state.bot.livePosition ? 'Auto tracking @ ' + fmtPrice(state.bot.livePosition.entryPrice) : 'No open position'
      : state.bot.position ? fmtUsd(state.bot.position.notionalUsd) + ' virtual @ ' + fmtPrice(state.bot.position.entryPrice) : 'None');
    setText('[data-bot-pnl]', state.bot.mode === 'real' ? 'Not tracked' : fmtBotUsd(state.bot.realizedPnl));
    setText('[data-bot-count]', state.bot.mode === 'real' ? '—' : String(state.bot.trades.length));
    setText('[data-bot-signal]', state.bot.lastSignal);
    const modeLabel = state.root.querySelector('[data-bot-mode-label]');
    if (modeLabel) modeLabel.textContent = state.bot.mode === 'real' ? 'REAL MODE · PADRE NATIVE AUTO' : 'DEMO SWING BOT';
    for (const modeButton of state.root.querySelectorAll('[data-action="bot-mode"]')) {
      modeButton.classList.toggle('active', modeButton.dataset.mode === state.bot.mode);
    }
    const review = state.root.querySelector('[data-bot-live-review]');
    if (review) review.hidden = state.bot.mode !== 'real' || (!state.bot.pendingLiveSignal && !state.bot.livePosition && !state.bot.liveOrderInFlight);
    const liveDetail = state.root.querySelector('[data-bot-live-detail]');
    if (liveDetail) liveDetail.textContent = state.bot.pendingLiveSignal
      ? `${state.bot.pendingLiveSignal.side} signal · ${state.bot.pendingLiveSignal.reason} · chart close ${fmtPrice(state.bot.pendingLiveSignal.price)}`
      : state.bot.livePosition
        ? `Manually marked position open @ ${fmtPrice(state.bot.livePosition.entryPrice)} · stop ${fmtPrice(state.bot.livePosition.stopPrice)} · target ${fmtPrice(state.bot.livePosition.targetPrice)}`
        : 'No pending live signal.';
    const formSummary = state.root.querySelector('[data-bot-form-summary]');
    if (formSummary) formSummary.textContent = formatPadreOrderSummary(readPadreOrderForm());
    const markBuy = state.root.querySelector('[data-action="bot-live-filled"]');
    if (markBuy) markBuy.hidden = true;
    const markSell = state.root.querySelector('[data-action="bot-live-closed"]');
    if (markSell) markSell.hidden = true;
    const markFailed = state.root.querySelector('[data-action="bot-live-failed"]');
    if (markFailed) markFailed.hidden = !(state.bot.pendingLiveSignal && !state.bot.liveOrderInFlight && !state.bot.running);
    const manualReview = state.root.querySelector('[data-action="bot-live-review"]');
    if (manualReview) manualReview.hidden = true;
    setText('[data-bot-disclaimer]', state.bot.mode === 'real'
      ? 'Live mode submits through Padre’s native form and checks Padre order status. $1 entry cap; 100% exits sell the entire wallet balance for this token. Use a dedicated wallet with no existing token holdings. Stop prevents new orders; an in-flight order may still complete.'
      : 'Demo only. No wallet connection, signing, or real orders. Starts from new candle updates; loaded history is not replayed.');
    setText('[data-bot-account-label]', state.bot.mode === 'real' ? 'LIVE ACCOUNT · NOT TRACKED' : 'SIMULATED ACCOUNT');
    setText('[data-bot-strategy-label]', state.bot.mode === 'real' ? 'LIVE STRATEGY · $1 ENTRY · FULL EXIT' : 'DEMO STRATEGY');
    const cfg = state.bot.config;
    setText('[data-bot-entry-rule]', cfg.strategy === 'lowHigh'
      ? `Touch prior ${cfg.lookback}-candle low, then close back above it`
      : `Break above prior ${cfg.lookback}-candle high, then retest`);
    setText('[data-bot-entry-volume]', cfg.strategy === 'lowHigh'
      ? `Stop −${cfg.lowHighStopPct}% · take profit +${cfg.lowHighTakeProfitPct}% from entry`
      : `Volume ≥ ${cfg.volumeMultiplier}× · retest within ${cfg.retestTimeout} candles · reject > ${cfg.maxExtensionAtr} ATR`);
    setText('[data-bot-exit-rule]', cfg.strategy === 'lowHigh'
      ? `Stop −${cfg.lowHighStopPct}% · take profit +${cfg.lowHighTakeProfitPct}%`
      : `Stop below retest low · ${cfg.riskReward}:1 R:R target`);
    setText('[data-bot-exit-note]', cfg.strategy === 'lowHigh'
      ? 'Both measured from buy price; stop wins if both hit in one candle'
      : 'If both hit in one candle, stop wins');
    updateBotPresetSelect();
    const preserveConfigDraft = !!state.root.querySelector('.bot-config')?.open;
    for (const input of state.root.querySelectorAll('[data-bot-config]')) {
      if (input.dataset.botConfig === 'strategy') continue;
      if (preserveConfigDraft || state.root.activeElement === input || document.activeElement === input) continue;
      input.value = String(cfg[input.dataset.botConfig]);
    }
    updateBotStrategyControls();
    const button = state.root.querySelector('[data-action="bot-monitor"]');
    if (button) {
      button.textContent = state.bot.running
        ? (state.bot.mode === 'real' ? 'Stop live auto' : 'Stop demo')
        : (state.bot.mode === 'real' ? 'Start live auto' : 'Start demo trading');
      button.classList.toggle('is-running', state.bot.running);
      button.setAttribute('aria-pressed', String(state.bot.running));
    }
    const history = state.root.querySelector('[data-bot-history]');
    if (history) history.innerHTML = state.bot.trades.length
      ? state.bot.trades.slice(-5).reverse().map(trade => `<div class="bot-trade-row"><span>${esc(trade.symbol)} · ${esc(trade.reason)}</span><b style="color:${trade.pnl >= 0 ? '#4ade80' : '#f87171'}">${esc(fmtBotUsd(trade.pnl))}</b></div>`).join('')
      : 'No demo trades yet.';
    renderBotLog();
  }
  function applyBotConfig() {
    const config = state.bot.config;
    const bounds = {
      lookback: [5, 300, true], volumeMultiplier: [1, 20, false], maxExtensionAtr: [0.1, 10, false],
      retestTimeout: [2, 60, true], riskReward: [1, 5, false],
      stopPct: [0.1, 90, false],
      lowHighStopPct: [0.1, 90, false], lowHighTakeProfitPct: [0.1, 500, false],
      notionalUsd: [1, 100000, false], feePct: [0, 10, false], slippagePct: [0, 20, false],
    };
    const next = {};
    const strategy = state.bot.editingStrategy || state.root.querySelector('[data-bot-config="strategy"]')?.value;
    if (!['breakout', 'lowHigh'].includes(strategy)) {
      state.bot.lastSignal = 'Choose a valid strategy.';
      renderBot();
      return false;
    }
    next.strategy = strategy;
    for (const [key, [min, max, integer]] of Object.entries(bounds)) {
      const input = state.root.querySelector(`[data-bot-config="${key}"]`);
      const value = Number(input?.value);
      if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
        state.bot.lastSignal = `Invalid ${key}: enter ${integer ? 'a whole number' : 'a number'} from ${min} to ${max}.`;
        renderBot();
        input?.focus();
        return false;
      }
      next[key] = value;
    }
    state.bot.config = { ...config, ...next };
    state.bot.editingStrategy = next.strategy;
    state.bot.breakoutSetup = null;
    state.bot.lastSignal = 'Settings applied for ' + (state.bot.mode === 'real' ? 'live auto-trading' : 'demo') + '. Open positions keep their entry-time exit settings.';
    renderBot();
    return true;
  }
  function loadRecommendedBotValues() {
    if (!applyBotConfig()) return;
    const rows = pageWindow._recentSnapshot?.candles;
    const candles = Array.isArray(rows) ? rows.map(row => ({
      high: Number(row[1]), low: Number(row[3]), close: Number(row[2]), volume: Number(row[4]),
    })).filter(c => [c.high, c.low, c.close, c.volume].every(Number.isFinite) && c.close > 0 && c.high >= c.low) : [];
    if (candles.length < 30) {
      state.bot.lastSignal = `Need at least 30 valid loaded chart candles for recommendations; found ${candles.length}.`;
      renderBot();
      return;
    }
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    const quantile = (values, q) => {
      const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
      return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))] : null;
    };
    const lookback = Math.round(clamp(Math.sqrt(candles.length), 5, 100));
    const trueRangePct = [];
    const volumeRatios = [];
    for (let i = 1; i < candles.length; i++) {
      const candle = candles[i], prev = candles[i - 1];
      const tr = Math.max(candle.high - candle.low, Math.abs(candle.high - prev.close), Math.abs(candle.low - prev.close));
      if (tr >= 0 && prev.close > 0) trueRangePct.push(tr / prev.close * 100);
      if (i >= lookback) {
        const recentVolumes = candles.slice(i - lookback, i).map(c => c.volume);
        const average = recentVolumes.reduce((sum, v) => sum + v, 0) / recentVolumes.length;
        if (average > 0 && candle.volume > 0) volumeRatios.push(candle.volume / average);
      }
    }
    const medianRangePct = quantile(trueRangePct, 0.5);
    if (!(medianRangePct > 0)) {
      state.bot.lastSignal = 'Could not estimate volatility from the loaded candles; settings were not changed.';
      renderBot();
      return;
    }
    const stopPct = Math.round(clamp(medianRangePct * 2, 0.1, 20) * 100) / 100;
    const targetPct = Math.round(clamp(stopPct * 2, 0.2, 50) * 100) / 100;
    const volThreshold = quantile(volumeRatios, 0.75);
    const volumeMultiplier = volThreshold == null ? state.bot.config.volumeMultiplier : Math.round(clamp(volThreshold, 1.1, 5) * 10) / 10;
    state.bot.config = {
      ...state.bot.config, lookback, volumeMultiplier, maxExtensionAtr: 1.5,
      retestTimeout: Math.round(clamp(lookback / 2, 5, 30)), riskReward: 2,
      stopPct,
      ...(state.bot.config.strategy === 'lowHigh' ? { lowHighStopPct: stopPct, lowHighTakeProfitPct: targetPct } : {}),
    };
    syncBotConfigInputs();
    state.bot.breakoutSetup = null;
    state.bot.lastSignal = `Loaded ${state.bot.config.strategy === 'lowHigh' ? 'buy-low/sell-high' : 'breakout-retest'} suggestions from ${candles.length} candles (median true range ${medianRangePct.toFixed(3)}%). Heuristic only; not backtested or a profit guarantee.`;
    const note = state.root.querySelector('[data-bot-recommendation]');
    if (note) note.textContent = `${candles.length} candles · ${state.bot.config.strategy === 'lowHigh' ? 'range strategy' : 'breakout/retest'} · median range ${medianRangePct.toFixed(3)}% · chart-based fields updated; size/cost assumptions unchanged.`;
    renderBot();
  }
  const BOT_PRESETS_KEY = 'padre-edge-bot-presets-v1';
  function getBotPresets() {
    try {
      const value = JSON.parse(localStorage.getItem(BOT_PRESETS_KEY) || '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch (_) { return {}; }
  }
  function updateBotPresetSelect() {
    const select = state.root?.querySelector('[data-bot-preset]');
    if (!select || select === state.root.activeElement || select === document.activeElement) return;
    const previous = select.value;
    const presets = getBotPresets();
    select.innerHTML = '<option value="">Saved presets…</option>' + Object.keys(presets).sort((a, b) => a.localeCompare(b)).map(name => `<option value="${esc(name)}">${esc(name)}</option>`).join('');
    if (Object.prototype.hasOwnProperty.call(presets, previous)) select.value = previous;
  }
  function saveBotPreset() {
    if (!applyBotConfig()) return;
    const name = window.prompt('Name this strategy preset (available in Demo and Real · auto):');
    if (!name) return;
    const cleanName = name.trim().slice(0, 40);
    if (!cleanName) return;
    const presets = getBotPresets();
    presets[cleanName] = { ...state.bot.config };
    try {
      localStorage.setItem(BOT_PRESETS_KEY, JSON.stringify(presets));
      state.bot.lastSignal = `Saved preset “${cleanName}”.`;
    } catch (_) { state.bot.lastSignal = 'Could not save preset in local storage.'; }
    renderBot();
    const select = state.root.querySelector('[data-bot-preset]');
    if (select) select.value = cleanName;
  }
  function loadBotPreset() {
    const select = state.root.querySelector('[data-bot-preset]');
    const name = select?.value;
    const preset = name && getBotPresets()[name];
    if (!preset) { state.bot.lastSignal = 'Choose a saved preset to load.'; renderBot(); return; }
    if (state.bot.running) {
      state.bot.running = false;
      state.bot.lastSignature = currentBotCandleSignature();
    }
    const nextConfig = { ...state.bot.config, ...preset };
    if (preset.strategy === 'lowHigh') {
      if (!Object.prototype.hasOwnProperty.call(preset, 'lowHighStopPct')) nextConfig.lowHighStopPct = preset.stopPct ?? nextConfig.lowHighStopPct;
      if (!Object.prototype.hasOwnProperty.call(preset, 'lowHighTakeProfitPct')) nextConfig.lowHighTakeProfitPct = preset.targetPct ?? nextConfig.lowHighTakeProfitPct;
    }
    state.bot.config = nextConfig;
    state.bot.editingStrategy = nextConfig.strategy;
    syncBotConfigInputs();
    state.bot.position = null;
    state.bot.breakoutSetup = null;
    state.bot.pendingLiveSignal = null;
    state.bot.lastSignal = `Loaded “${name}”. Start again to evaluate fresh candles.`;
    renderBot();
  }
  function deleteBotPreset() {
    const select = state.root.querySelector('[data-bot-preset]');
    const name = select?.value;
    const presets = getBotPresets();
    if (!name || !presets[name]) { state.bot.lastSignal = 'Choose a saved preset to delete.'; renderBot(); return; }
    if (!window.confirm(`Delete saved preset “${name}”?`)) return;
    delete presets[name];
    try { localStorage.setItem(BOT_PRESETS_KEY, JSON.stringify(presets)); state.bot.lastSignal = `Deleted “${name}”.`; }
    catch (_) { state.bot.lastSignal = 'Could not update saved presets.'; }
    renderBot();
  }
  function currentBotCandleSignature() {
    const candles = pageWindow._recentSnapshot?.candles;
    const last = Array.isArray(candles) && candles.length ? candles[candles.length - 1] : null;
    return last ? JSON.stringify(last) : '';
  }
  function readPadreOrderForm() {
    const panel = document.querySelector('[data-testid="order-form-content"]');
    if (!panel) return null;
    const side = panel.querySelector('input[type="radio"][value="BUY"]:checked, input[type="radio"][value="SELL"]:checked')?.value || 'unknown';
    const amount = panel.querySelector('input[name="quantityValue"]')?.value?.trim() || '';
    const orderType = panel.querySelector('input[aria-hidden="true"][value^="MARKET"],input[aria-hidden="true"][value^="LIMIT"]')?.value || 'unknown';
    const text = (panel.innerText || '').replace(/\s+/g, ' ').trim();
    const feeLine = text.match(/Gas\s*[-–]?\s*[^\d]{0,12}([\d.]+)[^\d]{0,40}([\d.]+)?/i);
    const slipMatch = text.match(/([\d.]+)\s*%/);
    const submit = panel.querySelector('form button[type="submit"], button[type="submit"]');
    const units = [...panel.querySelectorAll('input[name="quantityValue"] ~ span, [data-slot="compound-input"] span')]
      .map(el => (el.textContent || '').trim()).filter(Boolean);
    return { panel, side, amount, orderType, units, submit, gasText: feeLine ? feeLine.slice(1).filter(Boolean).join(' / ') : 'not detected', slippage: slipMatch ? slipMatch[0] : 'not detected' };
  }

  // Watch Padre's own create-order response and status endpoint. This does not
  // construct/sign requests; the native form and Padre wallet flow remain in
  // charge. If Padre changes this flow or status is unavailable, automation
  // fails closed rather than retrying an uncertain order.
  function installNativeOrderObserver() {
    const bot = state.bot;
    if (bot.liveOrderObserverInstalled || !pageWindow || typeof pageWindow.fetch !== 'function') return;
    bot.liveOrderObserverInstalled = true;
    const originalFetch = pageWindow.fetch.bind(pageWindow);
    pageWindow.fetch = function (input, init) {
      const requestUrl = typeof input === 'string' ? input : input?.url || '';
      const method = String(init?.method || input?.method || 'GET').toUpperCase();
      const result = originalFetch(input, init);
      if (method === 'POST' && /\/users\/[^/]+\/chains\/[^/]+\/wallets\/[^/]+\/create(?:\?|$)/.test(requestUrl)) {
        result.then(response => {
          if (!response.ok || !state.bot.liveOrderWaiter) return;
          response.clone().json().then(payload => {
            const id = findOrderId(payload);
            const waiter = state.bot.liveOrderWaiter;
            if (id && waiter) waiter.resolve({ id, origin: new URL(requestUrl, location.href).origin });
          }).catch(() => {});
        }).catch(() => {});
      }
      return result;
    };
  }
  function findOrderId(value, depth) {
    if (!value || typeof value !== 'object' || (depth || 0) > 4) return '';
    if (typeof value.orderId === 'string' && value.orderId) return value.orderId;
    for (const child of Object.values(value)) {
      const found = findOrderId(child, (depth || 0) + 1);
      if (found) return found;
    }
    return '';
  }
  async function waitForPadreOrderResult(orderId, origin) {
    const url = `${origin}/orders/${encodeURIComponent(orderId)}/slim-status`;
    const deadline = Date.now() + 60000;
    let lastError = '';
    while (Date.now() < deadline) {
      try {
        const response = await fetch(url, { credentials: 'include', cache: 'no-store' });
        if (!response.ok) throw new Error(`Padre status HTTP ${response.status}`);
        const payload = await response.json();
        const status = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
        if (status.txnStatus === 'TIMED_OUT' || status.txnStatus === 'FAILED' || status.txnStatus === 'REVERTED'
          || status.orderStatus === 'EXECUTION_FAILED' || status.orderStatus === 'CANCELED') {
          throw new Error(status.errorExplanation || `Padre reported ${status.orderStatus || status.txnStatus}.`);
        }
        if (status.orderStatus === 'FILLED' || status.orderStatus === 'MULTI_FILL'
          || (status.orderStatus === 'EXECUTING' && status.isFilledBasedOnProcessed === true)) return status;
      } catch (error) {
        if (/Padre reported|TIMED_OUT|EXECUTION_FAILED|CANCELED/.test(String(error.message))) throw error;
        lastError = error.message || String(error);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error(lastError ? `Order outcome could not be verified: ${lastError}` : 'Timed out waiting for Padre order confirmation. Check Padre Orders before restarting.');
  }
  function setNativeInputValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!input || !setter) throw new Error('Padre amount input is unavailable.');
    setter.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  async function getSolUsdPrice() {
    const mint = 'So11111111111111111111111111111111111111112';
    const json = await requestJson(`https://api.geckoterminal.com/api/v2/simple/networks/solana/token_price/${mint}`, { timeoutMs: 8000 });
    const price = n(json?.data?.attributes?.token_prices?.[mint]);
    if (!(price > 0)) throw new Error('Could not get a valid SOL/USD quote; no order submitted.');
    return price;
  }
  async function prepareAndSubmitPadreOrder(signal) {
    const bot = state.bot;
    const route = tradePageContext();
    const order = readPadreOrderForm();
    if (!route || route.address !== signal.address || !order) throw new Error('Current token or Padre order form changed; no order submitted.');
    const form = order.panel.closest('form[data-testid="order-form"]') || order.panel.closest('form');
    if (!form) throw new Error('Padre native order form not found.');
    const sideLabel = signal.side === 'BUY' ? 'Buy' : 'Sell';
    const side = [...form.querySelectorAll('[role="radio"]')].find(el => (el.innerText || '').trim().toLowerCase() === sideLabel.toLowerCase());
    if (!side) throw new Error(`Padre ${sideLabel} control not found.`);
    if (side.getAttribute('aria-checked') !== 'true') side.click();
    let activeForm = document.querySelector('form[data-testid="order-form"]') || form;
    const formText = (activeForm.innerText || '').replace(/\s+/g, ' ').trim();
    if (/has no SOL for fees|trades will fail until/i.test(formText + ' ' + (document.body?.innerText || ''))) throw new Error('Padre reports this wallet has no SOL for fees; no order submitted.');
    const kind = activeForm.querySelector('input[aria-hidden="true"][value^="MARKET"]');
    if (!kind || kind.value !== `MARKET_${signal.side}`) throw new Error('Padre market order is not selected; no order submitted.');

    if (signal.side === 'BUY') {
      const amount = activeForm.querySelector('input[name="quantityValue"]');
      const unit = amount?.closest('[data-pseudotype="numberLike"]')?.querySelector('span[translate="no"]')?.textContent?.trim();
      if (!amount || unit !== 'SOL') throw new Error('Expected Padre Buy amount in SOL; no order submitted.');
      const solUsd = await getSolUsdPrice();
      const solAmount = Math.floor((1 / solUsd) * 1e9) / 1e9;
      if (!Number.isFinite(solAmount) || solAmount <= 0) throw new Error('Invalid $1-to-SOL conversion; no order submitted.');
      setNativeInputValue(amount, solAmount.toFixed(9));
      if (Math.abs(Number(amount.value) * solUsd - 1) > 0.005) throw new Error('Padre amount did not retain the $1 sizing; no order submitted.');
      activeForm = document.querySelector('form[data-testid="order-form"]') || activeForm;
      const verifiedAmount = n(activeForm.querySelector('input[name="quantityValue"]')?.value);
      if (verifiedAmount == null || Math.abs(verifiedAmount * solUsd - 1) > 0.005) throw new Error('Padre did not retain the verified $1 SOL amount; no order submitted.');
    } else {
      const fullAmount = [...activeForm.querySelectorAll('button')].find(el => (el.innerText || '').trim() === '100%');
      if (!fullAmount) throw new Error('Padre 100% Sell control not found; no order submitted.');
      fullAmount.click();
      activeForm = document.querySelector('form[data-testid="order-form"]') || activeForm;
      const percentInput = [...activeForm.querySelectorAll('input')].find(input => {
        const parent = input.closest('[data-pseudotype="numberLike"]');
        return parent && parent.querySelector('span[translate="no"]')?.textContent?.trim() === '%';
      });
      if (!percentInput || Number(percentInput.value) !== 100) throw new Error('Padre did not accept the 100% Sell amount; no order submitted.');
    }

    const submit = [...activeForm.querySelectorAll('button[type="submit"]')].find(el => {
      const text = (el.innerText || '').trim().toLowerCase();
      return !el.disabled && text.startsWith(sideLabel.toLowerCase());
    });
    if (!submit) throw new Error(`Padre ${sideLabel} submit button is unavailable; no order submitted.`);
    const beforeText = (activeForm.innerText || '').replace(/\s+/g, ' ').trim();
    if (tradePageContext()?.address !== signal.address) throw new Error('Token page changed before submission; no order submitted.');
    if (signal.side === 'BUY' && !/Buy\s/.test(beforeText)) throw new Error('Buy form verification failed; no order submitted.');
    if (signal.side === 'SELL' && !/Sell\s/.test(beforeText)) throw new Error('Sell form verification failed; no order submitted.');

    installNativeOrderObserver();
    const orderResponse = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Padre did not return an order ID; outcome unknown. Check Padre Orders before restarting.')), 20000);
      bot.liveOrderWaiter = { resolve: result => { clearTimeout(timeout); resolve(result); } };
    });
    bot.liveOrderInFlight = true;
    recordBotLog({ event: 'LIVE_ORDER_ATTEMPT', outcome: 'SUBMITTED_TO_PADRE', side: signal.side, price: signal.price, reason: signal.reason, details: signal.side === 'BUY' ? '$1 USD cap converted to SOL; native Padre signing required.' : 'Native Padre 100% market sell.' });
    submit.click();
    try {
      const orderInfo = await orderResponse;
      bot.liveOrderId = orderInfo.id;
      bot.liveOrderWaiter = null;
      const status = await waitForPadreOrderResult(orderInfo.id, orderInfo.origin);
      recordBotLog({ event: 'LIVE_ORDER_ATTEMPT', outcome: 'SUCCESS', side: signal.side, price: signal.price, reason: signal.reason, details: `Padre order ${orderInfo.id} · ${status.orderStatus}${status.txnStatus ? ` · ${status.txnStatus}` : ''}` });
      return status;
    } finally {
      bot.liveOrderWaiter = null;
      bot.liveOrderInFlight = false;
      bot.liveOrderId = '';
    }
  }
  async function executeLiveSignal(signal) {
    const bot = state.bot;
    if (!bot.running || bot.mode !== 'real' || bot.liveOrderInFlight) return;
    try {
      bot.lastSignal = `${signal.side} · waiting for Padre native order confirmation…`;
      renderBot();
      await prepareAndSubmitPadreOrder(signal);
      if (signal.side === 'BUY') {
        const cfg = bot.config;
        const entryPrice = signal.price;
        const stopPrice = signal.stopPrice && signal.stopPrice < entryPrice ? signal.stopPrice : entryPrice * (1 - cfg.stopPct / 100);
        bot.livePosition = {
          address: signal.address, symbol: signal.symbol, strategy: signal.strategy,
          entryPrice, entryCandleTime: Number(signal.candleTime || 0),
          stopPct: signal.stopPct ?? cfg.stopPct, stopPrice,
          targetPrice: signal.targetPrice || (signal.strategy === 'breakout'
            ? entryPrice + (entryPrice - stopPrice) * cfg.riskReward
            : entryPrice * (1 + cfg.lowHighTakeProfitPct / 100)),
        };
        bot.pendingLiveSignal = null;
        bot.lastSignal = `Padre confirmed the BUY. Monitoring for an automatic 100% SELL; entry uses chart signal price until Padre fill details are available.`;
      } else {
        bot.livePosition = null;
        bot.pendingLiveSignal = null;
        bot.lastSignal = 'Padre confirmed the 100% SELL. Watching for the next $1 entry until Stop.';
      }
    } catch (error) {
      bot.running = false;
      bot.lastSignal = `Auto-trading stopped: ${error.message || error}. Check Padre Orders/wallet before restarting; do not retry an uncertain order.`;
      recordBotLog({ event: 'LIVE_ORDER_ATTEMPT', outcome: 'FAILED_OR_UNCONFIRMED', side: signal.side, price: signal.price, reason: bot.lastSignal, details: 'Automation stopped to prevent duplicate orders.' });
    }
    renderBot();
  }
  function formatPadreOrderSummary(order) {
    if (!order) return 'Padre order form not detected on this page.';
    return `Padre form: ${order.side} · ${order.orderType} · amount ${order.amount || 'not set'} SOL · displayed gas settings ${order.gasText} · displayed slippage setting ${order.slippage}. Read-only snapshot; values can change.`;
  }
  function reviewLiveSignalInPadre() {
    const signal = state.bot.pendingLiveSignal;
    const route = tradePageContext();
    const order = readPadreOrderForm();
    if (!signal || !route || route.address !== signal.address) {
      state.bot.lastSignal = 'No current-token live signal to review.';
      renderBot();
      return;
    }
    if (!order) {
      state.bot.lastSignal = 'Could not find Padre’s native order form; no order was touched.';
      renderBot();
      return;
    }
    order.panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const amountInput = order.panel.querySelector('input[name="quantityValue"]');
    amountInput?.focus({ preventScroll: true });
    recordBotLog({ event: 'LIVE_SIGNAL_REVIEWED', outcome: 'REVIEW_ONLY', side: signal.side, price: signal.price, reason: signal.reason, details: formatPadreOrderSummary(order) });
    window.alert(`MANUAL LIVE SIGNAL REVIEW ONLY\n\n${signal.side} ${signal.symbol}\nReason: ${signal.reason}\nSignal price: ${fmtPrice(signal.price)}\n\n${formatPadreOrderSummary(order)}\n\nNo order was submitted. Verify the amount, token, side, gas/slippage, and risk in Padre, then use Padre’s native order button only if you choose to proceed. After a successful order, return here and mark the fill. Wallet approval remains separate.`);
  }
  function logLiveFailure() {
    const signal = state.bot.pendingLiveSignal;
    if (!signal) return;
    const reason = window.prompt('Why did this live order attempt fail or get skipped?');
    if (reason === null) return;
    const explanation = reason.trim() || 'Skipped by user; no reason provided.';
    recordBotLog({ event: 'LIVE_ORDER_ATTEMPT', outcome: 'FAILED', side: signal.side, price: signal.price, reason: explanation, details: `Signal: ${signal.reason}` });
    state.bot.pendingLiveSignal = null;
    state.bot.lastSignal = `Logged live ${signal.side} attempt as failed/skipped: ${explanation}`;
    renderBot();
  }
  function markLiveEntryFilled() {
    const signal = state.bot.pendingLiveSignal;
    const route = tradePageContext();
    if (!signal || signal.side !== 'BUY' || !route || route.address !== signal.address) return;
    const raw = window.prompt('After submitting and confirming the BUY in Padre, enter the actual average fill price. Cancel if the order did not fill.', String(signal.price));
    if (raw === null) return;
    const fillPrice = Number(raw);
    if (!Number.isFinite(fillPrice) || fillPrice <= 0) {
      state.bot.lastSignal = 'Fill price must be a positive number; live position was not marked.';
      recordBotLog({ event: 'LIVE_BUY_FILL', outcome: 'FAILED', side: 'BUY', price: raw, reason: state.bot.lastSignal });
      renderBot();
      return;
    }
    const cfg = state.bot.config;
    let entryCandleTime = Number(pageWindow._recentSnapshot?.candles?.slice(-1)[0]?.[5]);
    if (entryCandleTime > 1e12) entryCandleTime /= 1000;
    const strategy = signal.strategy || cfg.strategy;
    const stopPrice = signal.stopPrice && signal.stopPrice < fillPrice
      ? signal.stopPrice : fillPrice * (1 - (signal.stopPct ?? cfg.stopPct) / 100);
    const actualRiskPct = (fillPrice - stopPrice) / fillPrice * 100;
    if (actualRiskPct > (signal.stopPct ?? cfg.stopPct)) {
      state.bot.lastSignal = `Reported fill would put stop risk at ${actualRiskPct.toFixed(2)}%, above the signal’s ${(signal.stopPct ?? cfg.stopPct)}% maximum. Position was not marked; review your actual risk manually.`;
      recordBotLog({ event: 'LIVE_BUY_FILL', outcome: 'FAILED', side: 'BUY', price: fillPrice, reason: state.bot.lastSignal });
      renderBot();
      return;
    }
    const targetPrice = strategy === 'breakout'
      ? fillPrice + (fillPrice - stopPrice) * (signal.riskReward ?? cfg.riskReward)
      : fillPrice * (1 + (signal.lowHighTakeProfitPct ?? cfg.lowHighTakeProfitPct) / 100);
    state.bot.livePosition = {
      address: signal.address, symbol: signal.symbol, strategy,
      entryPrice: fillPrice, entryCandleTime: Number.isFinite(entryCandleTime) ? entryCandleTime : 0,
      stopPct: signal.stopPct ?? cfg.stopPct, stopPrice, targetPrice,
    };
    state.bot.pendingLiveSignal = null;
    state.bot.lastSignal = `BUY fill manually recorded at ${fmtPrice(fillPrice)}. Monitoring chart for a SELL/stop signal; actual holdings are not verified.`;
    recordBotLog({ event: 'LIVE_BUY_FILL', outcome: 'USER_REPORTED_FILLED', side: 'BUY', price: fillPrice, reason: signal.reason, details: 'User-reported fill; not chain-verified.' });
    renderBot();
  }
  function markLiveExitFilled() {
    const signal = state.bot.pendingLiveSignal;
    if (!signal || signal.side !== 'SELL' || !state.bot.livePosition) return;
    if (!window.confirm('Only confirm after the SELL order has filled in Padre. Clear the manually tracked position?')) return;
    state.bot.pendingLiveSignal = null;
    state.bot.livePosition = null;
    state.bot.lastSignal = 'SELL fill marked manually. No wallet or position verification was performed.';
    recordBotLog({ event: 'LIVE_SELL_FILL', outcome: 'USER_REPORTED_FILLED', side: 'SELL', price: signal.price, reason: signal.reason, details: 'User-reported fill; not chain-verified.' });
    renderBot();
  }
  function evaluateBotEntry(bars, current, cfg, bot) {
    if (bars.length < cfg.lookback + 1) return { wait: `Need ${cfg.lookback + 1} candles to evaluate; have ${bars.length}.` };
    const prior = bars.slice(-(cfg.lookback + 1), -1);
    const priorLow = Math.min(...prior.map(bar => bar.low));
    const priorHigh = Math.max(...prior.map(bar => bar.high));
    if (cfg.strategy === 'lowHigh') {
      if (bot) bot.breakoutSetup = null;
      if (priorHigh <= current.close) return { reason: 'Range high is not above current price; waiting for a new range.' };
      if (current.low <= priorLow && current.close > priorLow) {
        const stopPrice = current.close * (1 - cfg.lowHighStopPct / 100);
        const targetPrice = current.close * (1 + cfg.lowHighTakeProfitPct / 100);
        return {
          triggered: true, stopPrice, targetPrice, stopPct: cfg.lowHighStopPct,
          reason: `Touched prior ${cfg.lookback}-candle low and closed back above it; stop −${cfg.lowHighStopPct}% and take profit +${cfg.lowHighTakeProfitPct}% from entry`,
        };
      }
      return { reason: `Waiting for a touch of the prior ${cfg.lookback}-candle low and a close back above it.` };
    }
    const averageVolume = prior.reduce((sum, bar) => sum + bar.volume, 0) / prior.length;
    const trueRanges = prior.map((bar, i) => {
      const previousClose = bars[bars.length - prior.length + i - 1]?.close;
      return Number.isFinite(previousClose)
        ? Math.max(bar.high - bar.low, Math.abs(bar.high - previousClose), Math.abs(bar.low - previousClose))
        : bar.high - bar.low;
    });
    const averageTrueRange = trueRanges.reduce((sum, value) => sum + value, 0) / trueRanges.length;
    if (bot?.breakoutSetup) {
      const setup = bot.breakoutSetup;
      if (current.time !== setup.lastCandleTime) {
        setup.age += 1;
        setup.lastCandleTime = current.time;
      }
      if (setup.age > cfg.retestTimeout) {
        bot.breakoutSetup = null;
        return { reason: 'Breakout retest timed out; waiting for a new breakout.' };
      }
      const tolerance = setup.atr * 0.25;
      if (current.low < setup.level - setup.atr * 0.5) {
        bot.breakoutSetup = null;
        return { reason: 'Breakout level failed on the retest; setup cancelled.' };
      }
      if (setup.age > 0 && current.low <= setup.level + tolerance && current.close > setup.level && current.close > current.open) {
        const stopPrice = current.low - setup.atr * 0.2;
        const riskPct = (current.close - stopPrice) / current.close * 100;
        if (!(riskPct > 0) || riskPct > cfg.stopPct) {
          bot.breakoutSetup = null;
          return { reason: `Retest stop would risk ${riskPct.toFixed(2)}%, above the ${cfg.stopPct}% max; setup cancelled.` };
        }
        const targetPrice = current.close + (current.close - stopPrice) * cfg.riskReward;
        bot.breakoutSetup = null;
        return {
          triggered: true, stopPrice, targetPrice,
          reason: `Breakout retest held and closed back above ${fmtPrice(setup.level)}; stop below retest low, target ${cfg.riskReward}:1 R:R`,
        };
      }
      return { reason: `Breakout confirmed at ${fmtPrice(setup.level)}; waiting for a holding retest (${setup.age}/${cfg.retestTimeout} candles).` };
    }
    if (current.close > priorHigh && averageVolume > 0 && current.volume >= averageVolume * cfg.volumeMultiplier) {
      const extension = current.close - priorHigh;
      if (averageTrueRange > 0 && extension > averageTrueRange * cfg.maxExtensionAtr) {
        return { reason: `Breakout rejected as overextended (${(extension / averageTrueRange).toFixed(1)} ATR); wait for a pullback.` };
      }
      if (bot) bot.breakoutSetup = {
        level: priorHigh, atr: averageTrueRange, age: 0,
        candleTime: current.time, lastCandleTime: current.time,
      };
      recordBotLog({ event: 'BREAKOUT_SETUP', outcome: 'PENDING_RETEST', side: 'BUY', price: priorHigh, reason: `Volume-confirmed breakout; waiting up to ${cfg.retestTimeout} candles for a retest.` });
      return { reason: `Breakout confirmed above ${fmtPrice(priorHigh)} with volume; waiting for a retest.` };
    }
    return { reason: `Waiting for a close above prior ${cfg.lookback}-candle high with volume ≥ ${cfg.volumeMultiplier}× average.` };
  }
  function processDemoBot(rows, route) {
    const bot = state.bot;
    if (!bot.running || !route || !Array.isArray(rows) || !rows.length) return;
    const bars = rows.map(row => ({
      open: Number(row[0]), high: Number(row[1]), close: Number(row[2]), low: Number(row[3]), volume: Number(row[4]), time: Number(row[5]),
    })).filter(bar => [bar.open, bar.high, bar.close, bar.low, bar.volume, bar.time].every(Number.isFinite));
    if (!bars.length) return;
    const current = bars[bars.length - 1];
    if (bot.mode === 'real') {
      const lastTime = current.time > 1e12 ? current.time / 1000 : current.time;
      const recent = bars.slice(-7);
      const deltas = recent.slice(1).map((bar, i) => {
        const a = bar.time > 1e12 ? bar.time / 1000 : bar.time;
        const b = recent[i].time > 1e12 ? recent[i].time / 1000 : recent[i].time;
        return a - b;
      });
      const oneSecondFeed = deltas.length >= 4 && deltas.every(delta => delta >= 0.5 && delta <= 1.5);
      const feedAge = Date.now() / 1000 - lastTime;
      if (!oneSecondFeed || feedAge > 5 || feedAge < -2) {
        bot.running = false;
        bot.lastSignal = !oneSecondFeed
          ? 'Auto-trading stopped: Padre chart is not providing verified 1-second candles.'
          : 'Auto-trading stopped: chart feed is stale or has an invalid timestamp.';
        recordBotLog({ event: 'SAFETY_STOP', outcome: 'STOPPED', reason: bot.lastSignal });
        return;
      }
    }
    const signature = JSON.stringify(rows[rows.length - 1]);
    if (signature === bot.lastSignature) return;
    bot.lastSignature = signature;
    const cfg = bot.config;
    if (bot.mode === 'real') {
      if (bot.pendingLiveSignal) {
          bot.lastSignal = bot.liveOrderInFlight
            ? 'Native Padre order is in flight; waiting for its confirmed outcome.'
            : 'Live order outcome is unresolved. Check Padre Orders before taking further action.';
        return;
      }
      if (bot.livePosition) {
        if (current.time <= bot.livePosition.entryCandleTime) return;
        const stopHit = current.low <= bot.livePosition.stopPrice;
        const targetHit = current.high >= bot.livePosition.targetPrice;
        if (!stopHit && !targetHit) {
           bot.lastSignal = `Live position tracked; watching for ${bot.livePosition.strategy === 'lowHigh' ? 'configured take-profit' : 'risk/reward target'} or stop.`;
          return;
        }
       const reason = stopHit ? 'Stop loss hit' : 'Take profit hit';
        bot.pendingLiveSignal = {
          side: 'SELL', address: route.address, symbol: bot.livePosition.symbol,
          price: stopHit ? bot.livePosition.stopPrice : bot.livePosition.targetPrice,
          reason, at: Date.now(),
        };
        recordBotLog({ event: 'LIVE_ORDER_ATTEMPT', outcome: 'PENDING_REVIEW', side: 'SELL', price: bot.pendingLiveSignal.price, reason });
        bot.lastSignal = `${reason}; submitting native Padre 100% SELL and awaiting confirmation.`;
        executeLiveSignal(bot.pendingLiveSignal);
        return;
      }
      const entrySignal = evaluateBotEntry(bars, current, cfg, bot);
      if (entrySignal.triggered) {
        bot.pendingLiveSignal = {
          side: 'BUY', address: route.address,
          symbol: state.tradeRecord?.t?.symbol || addressShort(route.address),
          price: current.close, rangeHigh: cfg.strategy === 'lowHigh' ? entrySignal.targetPrice : null,
          stopPrice: entrySignal.stopPrice, targetPrice: entrySignal.targetPrice,
          reason: entrySignal.reason, strategy: cfg.strategy,
          stopPct: entrySignal.stopPct ?? cfg.stopPct,
           lowHighTakeProfitPct: cfg.lowHighTakeProfitPct, riskReward: cfg.riskReward, candleTime: current.time,
          at: Date.now(),
        };
        recordBotLog({ event: 'LIVE_ORDER_ATTEMPT', outcome: 'PENDING_REVIEW', side: 'BUY', price: current.close, reason: entrySignal.reason });
        bot.lastSignal = 'Submitting native Padre $1 BUY and awaiting order confirmation.';
        executeLiveSignal(bot.pendingLiveSignal);
      } else {
        logBotRejectionIfRelevant(entrySignal.reason, 'BUY');
        bot.lastSignal = entrySignal.wait || entrySignal.reason;
      }
      return;
    }
    if (bot.position) {
      if (current.time <= bot.position.entryCandleTime) {
        bot.lastSignal = 'Virtual position open; waiting for the next 1-second candle before checking exits.';
        return;
      }
      const stopHit = current.low <= bot.position.stopPrice;
      const targetHit = current.high >= bot.position.targetPrice;
      if (!stopHit && !targetHit) {
        bot.lastSignal = 'Virtual position open; waiting for stop or target.';
        return;
      }
      // If both levels fall inside one candle, use the stop first (conservative
      // assumption; 1-second OHLCV cannot reveal which level traded first).
      const reason = stopHit ? 'Stop loss' : 'Take profit';
      const rawExit = stopHit ? bot.position.stopPrice : bot.position.targetPrice;
      const exitPrice = rawExit * (1 - bot.position.slippagePct / 100);
      const exitValue = exitPrice * bot.position.quantity;
      const fees = bot.position.entryNotional * bot.position.feePct / 100 + exitValue * bot.position.feePct / 100;
      const pnl = (exitPrice - bot.position.entryPrice) * bot.position.quantity - fees;
      bot.realizedPnl += pnl;
      bot.trades.push({ symbol: bot.position.symbol, pnl, reason, entryPrice: bot.position.entryPrice, exitPrice, at: Date.now() });
      recordBotLog({ event: 'DEMO_ORDER_ATTEMPT', outcome: 'SUCCESS', side: 'SELL', price: exitPrice, reason, details: `Net PnL ${fmtBotUsd(pnl)}` });
      bot.trades = bot.trades.slice(-50);
      bot.position = null;
      bot.lastSignal = `${reason} hit; virtual trade closed for ${fmtUsd(pnl)} net of estimated fees.`;
      return;
    }
    const entrySignal = evaluateBotEntry(bars, current, cfg, bot);
    if (entrySignal.triggered) {
      const entryPrice = current.close * (1 + cfg.slippagePct / 100);
      const quantity = cfg.notionalUsd / entryPrice;
       bot.position = {
        symbol: state.tradeRecord?.t?.symbol || addressShort(route.address),
        entryPrice, entryNotional: cfg.notionalUsd, notionalUsd: cfg.notionalUsd, quantity,
        entryCandleTime: current.time,
        feePct: cfg.feePct, slippagePct: cfg.slippagePct,
         stopPrice: cfg.strategy === 'lowHigh'
           ? entryPrice * (1 - cfg.lowHighStopPct / 100)
           : entrySignal.stopPrice ? entrySignal.stopPrice * (1 - cfg.slippagePct / 100) : entryPrice * (1 - cfg.stopPct / 100),
        targetPrice: cfg.strategy === 'lowHigh'
          ? entryPrice * (1 + cfg.lowHighTakeProfitPct / 100)
          : entryPrice + (entryPrice - (entrySignal.stopPrice || entryPrice * (1 - cfg.stopPct / 100))) * cfg.riskReward,
      };
      recordBotLog({ event: 'DEMO_ORDER_ATTEMPT', outcome: 'SUCCESS', side: 'BUY', price: entryPrice, reason: entrySignal.reason, details: `Virtual notional ${fmtBotUsd(cfg.notionalUsd)}` });
      bot.lastSignal = `${entrySignal.reason}; opened $${cfg.notionalUsd} virtual position. No real order sent.`;
    } else {
      logBotRejectionIfRelevant(entrySignal.reason, 'BUY');
      bot.lastSignal = entrySignal.wait || entrySignal.reason;
    }
  }

  function chainSlug(chain) {
    return ({ SOLANA: 'solana', BASE: 'base', BSC: 'bsc', ETH: 'eth', ETH_MAINNET: 'eth' })[chain] || null;
  }
  function padreTradeUrl(chain, address) {
    const slug = chainSlug(String(chain || '').toUpperCase()) || String(chain || '').toLowerCase();
    return 'https://trade.padre.gg/trade/' + encodeURIComponent(slug) + '/' + encodeURIComponent(address || '');
  }
  function marketTokenAddress(rec) {
    if (!rec) return '';
    if (rec.mintAddress) return rec.mintAddress;
    // Trade routes may be market/pair IDs. Never send that ID to token APIs.
    return rec.routeAddress ? '' : rec.address || '';
  }
  async function fetchDexPairs(records, signal) {
    const addresses = [...new Set(records.map(marketTokenAddress).filter(Boolean))];
    if (!addresses.length) return [];
    const json = await requestJson(DEX_API + addresses.join(','), { cache: 'no-store', signal, timeoutMs: 12000 });
    return json.pairs || [];
  }
  function choosePair(rec, pairs) {
    const chain = chainSlug(rec.t.chain);
    const tokenAddress = marketTokenAddress(rec);
    if (!tokenAddress) return null;
    const candidates = pairs.filter(p =>
      ((p.baseToken && p.baseToken.address === tokenAddress) || (p.quoteToken && p.quoteToken.address === tokenAddress)) &&
      (!chain || p.chainId === chain));
    const pair = candidates.sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0))[0] || null;
    if (pair) rec.poolToken = pair.baseToken && pair.baseToken.address === tokenAddress ? 'base' : 'quote';
    return pair;
  }
  function analyzeBars(rows) {
    // GeckoTerminal OHLCV: [unix, open, high, low, close, volume], newest first.
    const bars = (rows || []).map(x => ({ time: Number(x[0]), o: Number(x[1]), h: Number(x[2]), l: Number(x[3]), c: Number(x[4]), v: Number(x[5]) }))
      .filter(x => [x.o, x.h, x.l, x.c, x.v].every(Number.isFinite)).sort((a, b) => a.time - b.time);
    if (bars.length < 8) return { bars, score: null, signals: [], note: 'Not enough candles yet (need at least 8).' };
    const sig = [];
    let score = 50;
    const add = (d, label, kind) => { score += d; sig.push({ d, label, kind }); };
    const last = bars[bars.length - 1];
    const lookback = bars[Math.max(0, bars.length - 11)];
    const move = lookback.c > 0 ? (last.c / lookback.c - 1) * 100 : 0;
    if (move >= 12) add(8, 'positive 10-candle momentum ' + move.toFixed(1) + '%', 'bull');
    else if (move >= 4) add(4, 'positive momentum ' + move.toFixed(1) + '%', 'bull');
    else if (move <= -20) add(-15, 'drawdown ' + move.toFixed(1) + '%', 'bear');
    else if (move <= -10) add(-9, 'weak momentum ' + move.toFixed(1) + '%', 'bear');
    const last5 = bars.slice(-5), prev5 = bars.slice(-10, -5);
    if (last5.length === 5) {
      let higherLows = 0;
      for (let i = 1; i < last5.length; i++) if (last5[i].l > last5[i - 1].l) higherLows++;
      if (higherLows >= 3) add(6, 'higher-low structure', 'bull');
      else if (higherLows <= 1) add(-4, 'lower-low structure', 'bear');
    }
    const avg = arr => arr.length ? arr.reduce((a, b) => a + b.v, 0) / arr.length : 0;
    const recentVol = avg(last5), priorVol = avg(prev5);
    if (priorVol > 0 && recentVol >= priorVol * 1.5 && move > 0) add(5, 'volume expanding with price', 'bull');
    if (priorVol > 0 && recentVol >= priorVol * 1.7 && move < -3) add(-9, 'volume spike on falling price', 'bear');
    const priorHigh = Math.max(...bars.slice(-21, -1).map(x => x.h));
    if (last.c > priorHigh && priorHigh > 0 && recentVol > priorVol * 1.1) add(7, 'close above recent range with volume', 'bull');
    const range = Math.max(0, last.h - last.l), body = Math.abs(last.c - last.o), upper = last.h - Math.max(last.o, last.c);
    if (range > 0 && upper / range > 0.55 && last.c < last.o) add(-6, 'upper-wick rejection', 'bear');
    const returns = [];
    for (let i = Math.max(1, bars.length - 12); i < bars.length; i++) if (bars[i - 1].c > 0) returns.push(Math.abs(bars[i].c / bars[i - 1].c - 1));
    const volatility = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
    if (volatility > 0.25) add(-7, 'extreme candle volatility', 'bear');
    if (!sig.length) sig.push({ d: 0, label: 'No strong pattern detected', kind: 'neutral' });
    const recent = bars.slice(-10);
    const atr = recent.reduce((sum, bar, i) => {
      const prevClose = i ? recent[i - 1].c : bar.o;
      return sum + Math.max(bar.h - bar.l, Math.abs(bar.h - prevClose), Math.abs(bar.l - prevClose));
    }, 0) / recent.length;
    const swingLow = Math.min(...bars.slice(-5).map(x => x.l));
    const atrPct = last.c > 0 ? atr / last.c * 100 : null;
    return { bars, score: Math.max(0, Math.min(100, Math.round(score))), signals: sig, move, lastClose: last.c, swingLow, atrPct, note: bars.length + ' candles · ' + bars.length + ' samples' };
  }

  function normalizeChartExport(value) {
    if (!value) return [];
    if (Array.isArray(value)) {
      if (!value.length) return [];
      const first = value[0];
      if (Array.isArray(first)) return value.filter(row => Array.isArray(row) && row.length >= 5 && Number.isFinite(Number(row[0]))).map(row => row.length >= 6 ? row : [...row.slice(0, 5), 0]);
      if (first && typeof first === 'object') return value.map(row => {
        const time = row.time ?? row.timestamp ?? row.t;
        const toSeconds = v => typeof v === 'string' && !/^\d+(?:\.\d+)?$/.test(v) ? Date.parse(v) / 1000 : Number(v);
        return [toSeconds(time), Number(row.open ?? row.o), Number(row.high ?? row.h), Number(row.low ?? row.l), Number(row.close ?? row.c), Number(row.volume ?? row.v ?? 0)];
      }).filter(row => row.every(Number.isFinite));
    }
    if (typeof value === 'object') {
      for (const key of ['ohlcv_list', 'bars', 'data', 'rows', 'values']) {
        const rows = normalizeChartExport(value[key]);
        if (rows.length) return rows;
      }
    }
    return [];
  }
  function readPadreCandleSnapshot(address) {
    // Padre's bundled candle feed (CandlesSmartFeed) exposes its latest snapshot
    // as window._recentSnapshot. Its compact rows are [open, high, close, low,
    // USD volume, unixSeconds]. The snapshot is global and has no mint metadata,
    // so only trust it on the matching single-token trade route.
    const snapshot = pageWindow._recentSnapshot;
    if (!snapshot || !Array.isArray(snapshot.candles) || !snapshot.candles.length) return [];
    const route = tradePageContext();
    if (!route || route.address !== address) return [];
    const marketId = String(snapshot.marketId || snapshot.symbol || snapshot.tokenAddress || '');
    if (marketId && !marketId.includes(address) && !marketId.includes(tradeTitleInfo()?.symbol || '\u0000')) return [];
    const rows = snapshot.candles.slice(-40).map(row => {
      if (!Array.isArray(row) || row.length < 6) return null;
      let time = Number(row[5]);
      if (time > 1e12) time /= 1000;
      return [time, Number(row[0]), Number(row[1]), Number(row[3]), Number(row[2]), Number(row[4] || 0)];
    }).filter(row => row && row.every(Number.isFinite));
    return rows;
  }
  function padreChartApiCandidates() {
    const frames = [...document.querySelectorAll('iframe[id^="tradingview_"],iframe[name^="tradingview_"],iframe[title*="Financial Chart"]')];
    const roots = [];
    const addRoot = value => { if (value && (typeof value === 'object' || typeof value === 'function')) roots.push(value); };
    for (const key of Object.keys(pageWindow)) {
      if (!/(tradingview|tvwidget|chartwidget|chartapi)/i.test(key)) continue;
      try { addRoot(pageWindow[key]); } catch (e) { /* ignore page getters */ }
    }
    for (const frame of frames) {
      try {
        const frameWindow = frame.contentWindow;
        for (const key of Object.keys(frameWindow || {})) {
          if (!/(tradingview|tvwidget|chartwidget|chartapi)/i.test(key)) continue;
          try { addRoot(frameWindow[key]); } catch (e) { /* ignore frame getters */ }
        }
      } catch (e) { /* cross-origin frame */ }
      let domNode = frame, domDepth = 0;
      while (domNode && domDepth++ < 5) {
        let fiber = getFiber(domNode), ancestors = 0;
        while (fiber && ancestors++ < 7) {
          addRoot(fiber.memoizedProps);
          addRoot(fiber.memoizedState);
          addRoot(fiber.stateNode);
          fiber = fiber.return;
        }
        domNode = domNode.parentElement;
      }
    }
    const candidates = [], stack = roots.map(value => ({ value, depth: 0 })), seen = new Set();
    let nodes = 0;
    while (stack.length && nodes++ < 500) {
      const { value, depth } = stack.pop();
      if (!value || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value) || depth > 5) continue;
      seen.add(value);
      try {
        if (typeof value.exportData === 'function' || typeof value.activeChart === 'function' || typeof value.chart === 'function') candidates.push(value);
        for (const key of Object.keys(value)) {
          if (!/(widget|chart|tradingview|api|ref|current|state|props)/i.test(key)) continue;
          let child;
          try { child = value[key]; } catch (e) { continue; }
          if (child && (typeof child === 'object' || typeof child === 'function')) stack.push({ value: child, depth: depth + 1 });
        }
      } catch (e) { /* ignore inaccessible internals */ }
    }
    return candidates;
  }
  async function readPadreTradingViewBars() {
    const hasFrame = () => document.querySelector('iframe[id^="tradingview_"],iframe[name^="tradingview_"],iframe[title*="Financial Chart"]');
    if (!hasFrame() && tradePageContext()) {
      await new Promise(resolve => {
        const observer = new MutationObserver(() => { if (hasFrame()) finish(); });
        const timeout = setTimeout(finish, 3000);
        function finish() { clearTimeout(timeout); observer.disconnect(); resolve(); }
        observer.observe(document.documentElement || document, { childList: true, subtree: true });
      });
    }
    for (const candidate of padreChartApiCandidates()) {
      const targets = [candidate];
      for (const method of ['activeChart', 'chart']) {
        if (typeof candidate[method] === 'function') {
          try { targets.unshift(candidate[method]()); } catch (e) { /* unsupported API shape */ }
        }
      }
      for (const target of targets) {
        if (!target || typeof target.exportData !== 'function') continue;
        try {
          const exported = await Promise.race([
            Promise.resolve(target.exportData({ includeTime: true, includeSeries: true })),
            new Promise(resolve => setTimeout(() => resolve(null), 2500)),
          ]);
          const bars = normalizeChartExport(exported);
          if (bars.length >= 8) return bars;
        } catch (e) { /* try the next embedded chart API */ }
      }
    }
    return [];
  }

  async function analyzeOne(rec, runId) {
    if (!rec || (state.patternRunning && runId !== state.patternRunId)) return;
    if (rec.chartRequest) return rec.chartRequest;
    const request = (async () => {
      const controller = new AbortController();
      state.currentChartAbort = controller;
      const timeoutId = setTimeout(() => controller.abort(), 18000);
      rec.chartState = 'loading'; rec.chartMessage = 'Reading Padre terminal chart…'; renderPatterns();
      try {
        let padreBars = readPadreCandleSnapshot(rec.address);
        if (padreBars.length < 8) padreBars = await readPadreTradingViewBars();
        if (controller.signal.aborted) throw new Error('Request timed out');
        if (padreBars.length >= 8) {
          rec.chart = analyzeBars(padreBars);
          rec.chart.source = 'Padre Terminal · 1s';
          rec.chartState = rec.chart.score === null ? 'missing' : 'ready';
          rec.chartMessage = rec.chart.note + ' · Padre Terminal · 1s';
          return;
        }
        if (tradePageContext()) {
          rec.chartState = 'missing';
          rec.chartMessage = 'Padre 1s chart data is not exposed yet. Keep the native chart on 1s and retry; external candles were not substituted.';
          return;
        }
        if (!marketTokenAddress(rec)) {
          rec.chartState = 'missing';
          rec.chartMessage = 'Padre route is a market/pair ID; token mint could not be resolved, so external token APIs were not called.';
          return;
        }
        rec.chartMessage = 'Terminal candle data unavailable to the userscript; checking indexed candles…';
        renderPatterns();
        if (!rec.pair) {
          const pairs = await fetchDexPairs([rec], controller.signal);
          if (controller.signal.aborted) throw new Error('Request timed out');
          rec.pair = choosePair(rec, pairs);
        }
        if (!rec.pair || !rec.pair.pairAddress) {
          rec.chartState = 'missing'; rec.chartMessage = 'No indexed DEX pool yet. This is common before bonding/migration.';
          return;
        }
        const network = rec.pair.chainId;
        const interval = 'minute';
        const limit = Math.max(20, Math.min(100, Number(state.settings.chartLimit) || 40));
        const url = GECKO_API + encodeURIComponent(network) + '/pools/' + encodeURIComponent(rec.pair.pairAddress) +
          '/ohlcv/' + interval + '?aggregate=1&limit=' + limit + '&currency=usd&token=' + (rec.poolToken || 'base');
        const geckoWait = Math.max(0, 7000 - (Date.now() - state.lastPatternAt));
        if (geckoWait) await new Promise(resolve => setTimeout(resolve, geckoWait));
        if (controller.signal.aborted) throw new Error('Request timed out');
        state.lastPatternAt = Date.now();
        rec.chartMessage = 'Fetching candles…'; renderPatterns();
        const json = await requestJson(url, { cache: 'no-store', signal: controller.signal, timeoutMs: 12000 });
        const rows = json && json.data && json.data.attributes && json.data.attributes.ohlcv_list;
        if (!rows || !rows.length) { rec.chartState = 'missing'; rec.chartMessage = 'No OHLCV candles returned for this pool.'; }
        else {
          rec.chart = analyzeBars(rows);
          rec.chart.source = 'Indexed DEX candles';
          rec.chartState = rec.chart.score === null ? 'missing' : 'ready';
          rec.chartMessage = rec.chart.note;
        }
      } catch (err) {
        const wasStopped = controller.padroStopped || (runId != null && runId !== state.patternRunId);
        rec.chartState = wasStopped ? 'cancelled' : 'error';
        rec.chartMessage = wasStopped ? 'Cancelled.' : controller.signal.aborted ? 'Request timed out (18s).' : String(err.message || err);
      } finally {
        clearTimeout(timeoutId);
        rec.chartAt = Date.now();
        if (state.currentChartAbort === controller) state.currentChartAbort = null;
        renderPatterns();
      }
    })();
    rec.chartRequest = request;
    try { await request; } finally { rec.chartRequest = null; }
  }
  async function analyzeVisible() {
    if (state.patternRunning) return;
    state.patternRunning = true;
    const runId = ++state.patternRunId;
    const records = patternRecords().sort((a, b) => b.score - a.score).slice(0, 5);
    state.patternQueue = records;
    state.patternProgress = { done: 0, total: records.length, label: 'Starting' };
    renderPatterns();
    try {
      while (state.patternQueue.length && runId === state.patternRunId) {
        const rec = state.patternQueue.shift();
        state.patternProgress.label = 'Analyzing';
        renderPatterns();
        await analyzeOne(rec, runId);
        if (runId !== state.patternRunId) return;
        state.patternProgress.done++;
      }
    } finally {
      if (runId === state.patternRunId) {
        state.patternQueue = [];
        state.patternRunning = false;
        state.patternProgress.label = 'Done ' + state.patternProgress.done + ' / ' + state.patternProgress.total;
        renderPatterns();
      }
    }
  }
  function stopPatternRun() {
    if (!state.patternRunning && !state.currentChartAbort) return;
    state.patternRunId++;
    state.patternRunning = false;
    state.patternQueue = [];
    state.patternProgress.label = 'Stopped';
    if (state.currentChartAbort) {
      state.currentChartAbort.padroStopped = true;
      state.currentChartAbort.abort();
    }
    renderPatterns();
  }
  function patternHtml(rec) {
    const t = rec.t;
    const chart = rec.chart;
    const selected = state.selectedPatternAddress === rec.address;
    const queued = state.patternQueue.includes(rec);
    const stateKind = rec.chartState === 'ready' ? 'ready' : rec.chartState === 'loading' ? 'loading' : rec.chartState === 'error' ? 'error' : rec.chartState === 'missing' ? 'missing' : 'idle';
    const stateLabel = rec.chartState === 'loading' ? 'Loading' : queued ? 'Queued' : rec.chartState === 'ready' ? 'Ready' : rec.chartState === 'missing' ? 'No chart' : rec.chartState === 'error' ? 'Error' : rec.chartState === 'cancelled' ? 'Cancelled' : 'Idle';
    const allSignals = chart && chart.signals ? chart.signals : [];
    const shownSignals = allSignals.slice(0, 6);
    const hiddenSignals = allSignals.length - shownSignals.length;
    const signalTitle = allSignals.slice(6).map(s => (s.d > 0 ? '+' : '') + s.d + ' ' + s.label).join('\n');
    const signals = shownSignals.map(s => `<span class="chip ${s.kind}">${s.d > 0 ? '+' : ''}${s.d} ${esc(s.label)}</span>`).join('') +
      (hiddenSignals > 0 ? `<span class="chip neutral" title="${esc(signalTitle)}">+${hiddenSignals}</span>` : '');
    const moveClass = chart && chart.move != null ? chart.move >= 0 ? 'pos' : 'neg' : '';
    const metrics = chart && chart.move != null
      ? `<div class="pat-metrics"><span class="${moveClass}">10c<b>${chart.move > 0 ? '+' : ''}${chart.move.toFixed(1)}%</b></span><span>Score<b>${chart.score}</b></span><span>Close<b>${fmtPrice(chart.lastClose)}</b></span><span>5L<b>${fmtPrice(chart.swingLow)}</b></span><span>ATR<b>${chart.atrPct == null ? '—' : chart.atrPct.toFixed(1) + '%'}</b></span></div>`
      : '';
    const errorHtml = rec.chartState === 'error' || rec.chartState === 'missing'
      ? `<div class="pat-error"${rec.chartState === 'missing' ? ' style="background:#171717;border-color:#333;color:#9a9a9a"' : ''}>${icon('warning', 12)}<span>${esc(rec.chartMessage || (rec.chartState === 'missing' ? 'No candles available yet.' : 'Chart request failed.'))}</span><button class="btn ghost" data-action="analyze-one" data-address="${esc(rec.address)}">Retry</button></div>`
      : '';
    const wallets = selected ? walletSignalsFor(rec).filter(walletRoleRank).slice(0, 20) : [];
    const walletHtml = selected
      ? `<div class="pat-detail"><div class="small" style="display:flex;align-items:center;gap:4px">Wallet identities ${infoBtn('Wallet roles come from Padre’s visible data. Verified 24h P/L needs transaction history, which this tool does not fetch.', 'About wallet identities')}</div>${wallets.length ? wallets.map(row => `<div class="pat-wallet">${row.profileUrl ? `<a href="${esc(row.profileUrl)}" target="_blank" rel="noopener" style="color:#9ae6b4">${esc(addressShort(row.address))}</a>` : `<span title="Padre did not expose a wallet profile URL">${esc(addressShort(row.address))}</span>`}<span>·</span><span>${[...row.roles].filter(role => ['buyer','trader','holder','insider','sniper','bundle-associated'].includes(role)).map(esc).join(', ')}</span></div>`).join('') : '<div class="meta">No identified buyer/trader/holder addresses exposed.</div>'}</div>`
      : '';
    const warnings = warningChecks(t);
    const warningColors = warningBadgeColors(warnings.length);
    const warningHtml = selected ? `<div class="pat-detail"><b style="color:${warnings.length ? warningColors.background : '#4ade80'};font:700 10px/1.3 ui-sans-serif,system-ui">${warnings.length ? warningColors.label : 'No listed caution checks detected'}</b>${warnings.length ? `<ul style="padding-left:16px;margin:4px 0 0;color:#fca5a5;font-size:9px;line-height:1.45">${warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : '<div class="meta">Not evidence that the token is safe.</div>'}</div>` : '';
    const barsLabel = chart && chart.bars && chart.bars.length ? chart.bars.length + ' bars · ' + (chart.source || 'OHLCV') : rec.chartState === 'loading' ? 'Fetching candles' : '';
    return `<div class="pattern${selected ? ' selected' : ''}" data-address="${esc(rec.address)}"><div class="pat-head"><div class="pat-title">${warnings.length ? '<span style="display:inline-flex;align-items:center;justify-content:center;width:13px;height:13px;flex:none;border-radius:50%;background:#ef4444;color:#fff;font:900 9px/13px system-ui">!</span>' : ''}<a class="token-trade-link" href="${esc(padreTradeUrl(t.chain, rec.address))}" title="Open token on Padre"><b>$${esc(t.symbol)}</b><span class="muted">${esc(t.name)} · ${esc(fmtAge(t.ageSec))}</span></a></div><span class="pat-status ${stateKind}">${esc(stateLabel)}</span></div>${metrics}${signals ? `<div class="signals">${signals}</div>` : ''}${errorHtml}<div class="pat-actions"><button class="btn ghost" data-action="analyze-one" data-address="${esc(rec.address)}">${icon('refresh', 11)}${rec.chartState === 'ready' ? 'Refresh' : 'Analyze'}</button><span class="muted">${esc(barsLabel)}</span></div>${warningHtml}${walletHtml}</div>`;
  }
  function renderPatterns() {
    if (!state.patterns) return;
    const progress = state.patternProgress || { done: 0, total: 0, label: 'Idle' };
    const total = progress.total || 0;
    const done = Math.min(progress.done || 0, total);
    const bar = state.root.querySelector('[data-pattern-bar]');
    if (bar) bar.style.width = (total ? Math.round(done / total * 100) : 0) + '%';
    if (state.patternProgressEl) state.patternProgressEl.textContent = total ? done + ' / ' + total : (progress.label || 'Idle');
    const records = patternRecords().sort((a, b) => b.score - a.score);
    const sig = records.map(r => r.address + ':' + r.score + ':' + (r.chartState || '') + ':' + (r.chartAt || 0) + ':' + (r.chart ? r.chart.score : '')).join('|') +
      '|' + state.patternQueue.map(r => r.address).join(',') + '|' + (state.selectedPatternAddress || '');
    if (sig === state.patternSignature) return;
    state.patternSignature = sig;
    state.patterns.innerHTML = records.length ? records.map(patternHtml).join('') : emptyState('chart', 'No visible token cards or trade-page token context.');
  }

  function boot() {
    stylePage(); buildUI(); watchWalletOverview(); listenForXResults();
    if (!tradePageContext() && state.ui.activeTab && state.ui.activeTab !== 'recommended') setTab(state.ui.activeTab);
    scanCards();
    if (tradePageContext()) primeTokenCaTooltip();
    updateStatusStrip();
    const scheduleScan = () => {
      if (state.scanTimer) return;
      state.scanTimer = setTimeout(() => {
        state.scanTimer = null;
        try { scanCards(); } catch (e) { state.errors++; }
      }, 650);
    };
    const obs = new MutationObserver((mutations) => {
      const relevant = mutations.some(m => {
        if (m.target && m.target.closest && m.target.closest('#padre-edge-host')) return false;
        const changed = [...m.addedNodes, ...m.removedNodes];
        return changed.some(node => !(node.nodeType === 1 && (node.matches('.pe-badge,.pe-warning-badge,#padre-edge-host') || node.closest('#padre-edge-host,.pe-badge,.pe-warning-badge'))));
      });
      if (relevant) scheduleScan();
    });
    try { obs.observe(document.body, { childList: true, subtree: true }); } catch (e) { /* ignore */ }
    setInterval(() => { try { scanCards(); } catch (e) { state.errors++; updateStatusStrip(); } }, SCAN_MS);
    setInterval(() => { if (state.activeTab === 'bot') renderBot(); }, 1000);
    console.info('[Padre Edge] v' + VERSION + ' ready; chart analysis is automatic for the open trade-page token and manual in Trenches');
  }
  window.__padreEdge = {
    version: VERSION,
    tradeContext: () => { const route = tradePageContext(); return route ? { routeAddress: route.address, mintAddress: currentTradeMintAddress(), rawMintAddress: mintAddressFromObject(state.tradeRecord && state.tradeRecord.raw, route.address) || mintAddressFromPage(route.address) || null } : null; },
    scan: scanCards,
    dump: () => visibleRecords().map(r => ({ symbol: r.t.symbol, address: r.address, score: r.score, coverage: r.coverage, metrics: r.t, reasons: r.reasons, chart: r.chart || null })),
    analyze: address => analyzeOne(findByAddress(address)),
    stopPatterns: stopPatternRun,
    patternStatus: () => ({ running: state.patternRunning, queued: state.patternQueue.length, progress: state.patternProgress.label }),
    analyzeBars,
    padreChartStatus: () => {
      const snapshot = pageWindow._recentSnapshot;
      const candles = snapshot && Array.isArray(snapshot.candles) ? snapshot.candles : [];
      return { available: candles.length > 0, candleCount: candles.length, latestTime: candles.length ? candles[candles.length - 1][5] : null, route: tradePageContext()?.address || null };
    },
    scoreToken,
  };
  if (location.hostname === 'x.com' || location.hostname === 'www.x.com' || location.hostname === 'twitter.com' || location.hostname === 'www.twitter.com') {
    runXSearchCollector();
  } else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
