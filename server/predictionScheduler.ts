/**
 * predictionScheduler.ts
 *
 * Background prediction scheduler for AI Stock Dashboard.
 *
 * Behaviour:
 *  1. On server startup (after a short delay), runs predictions for all
 *     watchlist symbols that don't yet have a prediction for today.
 *  2. Schedules a daily re-run at a configurable time (default 21:00 Taipei /
 *     09:00 US-East = after market close for both markets).
 *  3. Exposes a real-time queue status that the front-end can poll.
 *  4. Concurrency-limited: runs at most MAX_CONCURRENT predictions at once
 *     to avoid overloading the server.
 *  5. Idempotent: calling start() multiple times is safe.
 */

import { storage } from "./storage";
import { runPrediction } from "./mlPredictionService";

// ─── Config ────────────────────────────────────────────────────────────────

const MAX_CONCURRENT   = 2;    // at most N Python processes simultaneously
const STARTUP_DELAY_MS = 90_000; // wait 90s after boot before first sweep
// Daily trigger: 21:00 Taipei (UTC+8) = 13:00 UTC
const DAILY_HOUR_UTC   = 13;
const DAILY_MIN_UTC    = 0;

// ─── Queue state ────────────────────────────────────────────────────────────

export type QueueItemStatus = "pending" | "running" | "done" | "error";

export interface QueueItem {
  symbol: string;
  market: string;
  status: QueueItemStatus;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
}

interface SchedulerState {
  running: boolean;
  lastSweepAt: string | null;
  nextSweepAt: string | null;
  queue: QueueItem[];
}

const state: SchedulerState = {
  running:     false,
  lastSweepAt: null,
  nextSweepAt: null,
  queue:       [],
};

let _started = false;
let _dailyTimer: ReturnType<typeof setTimeout> | null = null;

// ─── Helpers ────────────────────────────────────────────────────────────────

function getTodayStr(market: string): string {
  const tz = market === "US" ? "America/New_York" : "Asia/Taipei";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function msUntilNextDaily(): number {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(DAILY_HOUR_UTC, DAILY_MIN_UTC, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

function nextDailyIsoString(): string {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(DAILY_HOUR_UTC, DAILY_MIN_UTC, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}

/**
 * Check whether a prediction already exists for today for a given symbol.
 * "Today" is determined by the market's local timezone.
 */
function hasTodayPrediction(symbol: string, market: string): boolean {
  const todayStr = getTodayStr(market);
  const row = (storage as any).hasTodayPrediction(symbol, market, todayStr);
  return !!row;
}

// ─── Core sweep ─────────────────────────────────────────────────────────────

/**
 * Run a single prediction for one symbol.
 * Marks the queue item as running → done/error.
 */
async function runOne(item: QueueItem): Promise<void> {
  item.status    = "running";
  item.startedAt = Date.now();

  try {
    // Get latest close price
    const recentBars = await storage.getHistoricalPricesByRange(
      item.symbol,
      item.market,
      new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10),
      new Date().toISOString().slice(0, 10),
    );
    const currentPrice = recentBars.length > 0
      ? recentBars.sort((a: any, b: any) => b.date.localeCompare(a.date))[0].close
      : 0;

    const result = await runPrediction({
      symbol:   item.symbol,
      market:   item.market,
      horizons: Array.from({ length: 20 }, (_, i) => i + 1),
      currentPrice,
      saveToDb: true,
    });

    item.status     = result.ok ? "done" : "error";
    item.error      = result.ok ? undefined : (result.error ?? "unknown error");
    item.finishedAt = Date.now();

    if (result.ok) {
      console.log(`[predSched] ✓ ${item.symbol} (${item.market}) done in ${((item.finishedAt - item.startedAt!) / 1000).toFixed(1)}s`);
    } else {
      console.warn(`[predSched] ✗ ${item.symbol} error: ${item.error}`);
    }
  } catch (e: any) {
    item.status     = "error";
    item.error      = e?.message ?? String(e);
    item.finishedAt = Date.now();
    console.error(`[predSched] ✗ ${item.symbol} exception:`, item.error);
  }
}

/**
 * Run a sweep over all watchlist symbols, skipping those already done today.
 * Respects MAX_CONCURRENT concurrency limit.
 */
async function runSweep(label = "sweep"): Promise<void> {
  if (state.running) {
    console.log(`[predSched] ${label} skipped — already running`);
    return;
  }
  state.running     = true;
  state.lastSweepAt = new Date().toISOString();
  console.log(`[predSched] ${label} started`);

  try {
    const watchlist = await storage.getWatchlist();
    if (!watchlist.length) {
      console.log("[predSched] watchlist is empty, nothing to do");
      state.running = false;
      return;
    }

    // Build queue: only items without a today prediction
    const newItems: QueueItem[] = watchlist
      .filter(w => !hasTodayPrediction(w.symbol, w.market))
      .map(w => ({ symbol: w.symbol, market: w.market, status: "pending" as QueueItemStatus }));

    if (!newItems.length) {
      console.log(`[predSched] ${label} — all ${watchlist.length} symbols already predicted today`);
      state.running = false;
      return;
    }

    // Merge into global queue (avoid duplicating items already queued/running)
    const existingKeys = new Set(state.queue.filter(q => q.status === "pending" || q.status === "running").map(q => `${q.symbol}:${q.market}`));
    const toAdd = newItems.filter(i => !existingKeys.has(`${i.symbol}:${i.market}`));
    state.queue.push(...toAdd);

    console.log(`[predSched] ${label} — queued ${toAdd.length} symbols (${watchlist.length - newItems.length} already done today)`);

    // Process queue with concurrency limit
    const pending = () => state.queue.filter(q => q.status === "pending");

    const worker = async (): Promise<void> => {
      while (true) {
        const next = pending()[0];
        if (!next) break;
        next.status = "running"; // claim before await
        await runOne(next);
      }
    };

    const workers = Array.from({ length: MAX_CONCURRENT }, () => worker());
    await Promise.all(workers);

  } catch (e: any) {
    console.error("[predSched] sweep error:", e?.message ?? e);
  } finally {
    state.running = false;
    console.log(`[predSched] ${label} finished`);
  }
}

// ─── Daily scheduler ────────────────────────────────────────────────────────

function scheduleDailyRun(): void {
  const ms = msUntilNextDaily();
  state.nextSweepAt = nextDailyIsoString();
  console.log(`[predSched] next daily sweep in ${(ms / 3600_000).toFixed(1)}h (${state.nextSweepAt})`);

  if (_dailyTimer) clearTimeout(_dailyTimer);
  _dailyTimer = setTimeout(async () => {
    await runSweep("daily");
    scheduleDailyRun(); // re-schedule for next day
  }, ms);
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Start the scheduler. Safe to call multiple times — only initialises once.
 */
export function startPredictionScheduler(): void {
  if (_started) return;
  _started = true;

  console.log(`[predSched] starting (startup delay: ${STARTUP_DELAY_MS / 1000}s)`);

  // Startup sweep after a short delay (let DB/routes finish initialising)
  setTimeout(() => runSweep("startup"), STARTUP_DELAY_MS);

  // Schedule daily repeat
  scheduleDailyRun();
}

/**
 * Trigger an immediate sweep (e.g. called from an API route).
 * Non-blocking — returns immediately.
 */
export function triggerSweepNow(): void {
  runSweep("manual").catch(e => console.error("[predSched] manual sweep error:", e));
}

/**
 * Trigger a single symbol prediction if not already queued/running today.
 * Returns true if queued, false if already done today or already in queue.
 */
export async function ensurePrediction(symbol: string, market: string): Promise<boolean> {
  if (hasTodayPrediction(symbol, market)) return false;

  const key = `${symbol}:${market}`;
  const already = state.queue.find(q => q.symbol === symbol && q.market === market && (q.status === "pending" || q.status === "running"));
  if (already) return false;

  const item: QueueItem = { symbol, market, status: "pending" };
  state.queue.push(item);

  // Run immediately (in background, no await)
  runOne(item).catch(e => console.error(`[predSched] ensurePrediction ${key}:`, e));
  return true;
}

/**
 * Returns current queue status for the status API endpoint.
 */
export function getSchedulerStatus() {
  const total    = state.queue.length;
  const done     = state.queue.filter(q => q.status === "done").length;
  const running  = state.queue.filter(q => q.status === "running").length;
  const pending  = state.queue.filter(q => q.status === "pending").length;
  const errored  = state.queue.filter(q => q.status === "error").length;

  return {
    isRunning:   state.running,
    lastSweepAt: state.lastSweepAt,
    nextSweepAt: state.nextSweepAt,
    queue: {
      total,
      done,
      running,
      pending,
      errored,
    },
    // Per-symbol detail (last 50 entries to keep payload small)
    items: state.queue.slice(-50).map(q => ({
      symbol:     q.symbol,
      market:     q.market,
      status:     q.status,
      error:      q.error ?? null,
      durationMs: q.startedAt && q.finishedAt ? q.finishedAt - q.startedAt : null,
    })),
  };
}
