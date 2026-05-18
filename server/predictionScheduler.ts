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

import { storage, sqlite } from "./storage";
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
 * Run a sweep over all watchlist symbols.
 * @param label  Log label for this sweep.
 * @param force  If true, re-predict even symbols that already have a today prediction.
 *               Each force-run deletes the existing same-day record (DB keeps only latest per day).
 */
async function runSweep(label = "sweep", force = false): Promise<void> {
  if (state.running) {
    console.log(`[predSched] ${label} skipped — already running`);
    return;
  }
  state.running     = true;
  state.lastSweepAt = new Date().toISOString();
  console.log(`[predSched] ${label} started (force=${force})`);

  try {
    const watchlist = await storage.getWatchlist();
    if (!watchlist.length) {
      console.log("[predSched] watchlist is empty, nothing to do");
      state.running = false;
      return;
    }

    // Build queue: skip symbols already done today (unless force=true)
    const newItems: QueueItem[] = watchlist
      .filter(w => force || !hasTodayPrediction(w.symbol, w.market))
      .map(w => ({ symbol: w.symbol, market: w.market, status: "pending" as QueueItemStatus }));

    if (!newItems.length) {
      console.log(`[predSched] ${label} — all ${watchlist.length} symbols already predicted today`);
      state.running = false;
      return;
    }

    if (force) {
      // Force: reset queue entirely so UI shows fresh progress
      state.queue = [...newItems];
      console.log(`[predSched] ${label} (force) — queued all ${newItems.length} symbols`);
    } else {
      // Normal: only add symbols not already pending/running
      const existingKeys = new Set(state.queue.filter(q => q.status === "pending" || q.status === "running").map(q => `${q.symbol}:${q.market}`));
      const toAdd = newItems.filter(i => !existingKeys.has(`${i.symbol}:${i.market}`));
      state.queue.push(...toAdd);
      console.log(`[predSched] ${label} — queued ${toAdd.length} symbols (${watchlist.length - newItems.length} already done today)`);
    }

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

// ─── Weekly actuals fill + weight recompute ─────────────────────────────────

let _weeklyTimer: ReturnType<typeof setTimeout> | null = null;

function msUntilNextSaturday(): number {
  const now = new Date();
  // Target: Saturday UTC 14:00
  const next = new Date(now);
  const day = next.getUTCDay(); // 0=Sun ... 6=Sat
  const daysUntilSat = ((6 - day) + 7) % 7;
  next.setUTCDate(next.getUTCDate() + daysUntilSat);
  next.setUTCHours(14, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 7);
  return next.getTime() - now.getTime();
}

export async function fillActualsAndRecomputeWeights(): Promise<void> {
  console.log("[predSched] fillActuals — start");

  // 1. Find unfilled prediction rows whose target date has already passed
  const unfilled = sqlite.prepare(`
    SELECT id, symbol, market, run_date, horizon, base_price, predicted_return
    FROM prediction_tracking
    WHERE actual_price IS NULL
      AND date(run_date, '+' || horizon || ' days') <= date('now')
  `).all() as Array<{
    id: number; symbol: string; market: string;
    run_date: string; horizon: number;
    base_price: number; predicted_return: number;
  }>;

  console.log(`[predSched] fillActuals — ${unfilled.length} rows to fill`);

  let filledCount = 0;
  for (const row of unfilled) {
    // Target date = run_date + horizon days
    const targetDate = new Date(row.run_date);
    targetDate.setUTCDate(targetDate.getUTCDate() + row.horizon);
    const targetStr = targetDate.toISOString().slice(0, 10);

    // Look up actual close within ±5 trading days
    let actualRow: { date: string; close: number } | undefined;
    for (let offset = 0; offset <= 5; offset++) {
      const tryDate = new Date(targetDate);
      tryDate.setUTCDate(tryDate.getUTCDate() + offset);
      const tryStr = tryDate.toISOString().slice(0, 10);
      const found = sqlite.prepare(
        `SELECT date, close FROM historical_prices WHERE symbol=? AND date=? LIMIT 1`
      ).get(row.symbol, tryStr) as { date: string; close: number } | undefined;
      if (found) { actualRow = found; break; }
    }
    if (!actualRow) continue;

    const actualReturn = (actualRow.close - row.base_price) / row.base_price;
    const error = actualReturn - row.predicted_return;
    const directionCorrect = Math.sign(actualReturn) === Math.sign(row.predicted_return) ? 1 : 0;

    sqlite.prepare(`
      UPDATE prediction_tracking
      SET actual_price=?, actual_return=?, error=?, direction_correct=?, filled_at=?
      WHERE id=?
    `).run(actualRow.close, actualReturn, error, directionCorrect, new Date().toISOString(), row.id);
    filledCount++;
  }
  console.log(`[predSched] fillActuals — filled ${filledCount} rows`);

  // 2. Recompute ensemble weights if we have enough data
  // Get all filled rows grouped by model component (we approximate using all filled rows)
  const filled = sqlite.prepare(`
    SELECT symbol, actual_return, predicted_return, error, direction_correct
    FROM prediction_tracking
    WHERE actual_return IS NOT NULL
  `).all() as Array<{
    symbol: string; actual_return: number;
    predicted_return: number; error: number; direction_correct: number;
  }>;

  const totalSamples = filled.length;
  const uniqueSymbols = new Set(filled.map(r => r.symbol)).size;
  const weeksOfData = Math.floor(totalSamples / Math.max(uniqueSymbols, 1));

  if (totalSamples < 14) {
    console.log(`[predSched] weights — not enough data yet (${totalSamples} samples, need 14)`);
    return;
  }

  // Compute aggregate direction accuracy and MAE from ensemble predictions
  // (We don't store per-model predictions separately, so we use ensemble totals
  //  and adjust weights heuristically based on overall direction accuracy)
  const dirAcc = filled.filter(r => r.direction_correct === 1).length / totalSamples;
  const mae    = filled.reduce((s, r) => s + Math.abs(r.error), 0) / totalSamples;

  // Heuristic weight adjustment based on direction accuracy
  let w_hgb: number, w_lgb: number, w_rf: number;
  if (dirAcc < 0.48) {
    // Below threshold — shift weight to HGB (most stable)
    w_hgb = 0.55; w_lgb = 0.30; w_rf = 0.15;
  } else if (dirAcc > 0.55) {
    // Above threshold — balance HGB and LGB
    w_hgb = 0.40; w_lgb = 0.40; w_rf = 0.20;
  } else {
    // Neutral — default weights
    w_hgb = 0.45; w_lgb = 0.35; w_rf = 0.20;
  }

  sqlite.prepare(`
    INSERT INTO ensemble_weights
      (computed_at, weeks_of_data, sample_count, w_hgb, w_lgb, w_rf,
       dir_acc_hgb, dir_acc_lgb, dir_acc_rf, mae_hgb, mae_lgb, mae_rf, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    new Date().toISOString(), weeksOfData, totalSamples,
    w_hgb, w_lgb, w_rf,
    dirAcc, dirAcc, dirAcc,  // per-model dir_acc approximated as ensemble
    mae, mae, mae,            // per-model MAE approximated as ensemble
    `auto: dirAcc=${dirAcc.toFixed(3)}, mae=${mae.toFixed(4)}, n=${totalSamples}`
  );
  console.log(`[predSched] weights updated — hgb=${w_hgb} lgb=${w_lgb} rf=${w_rf} (dirAcc=${dirAcc.toFixed(3)}, n=${totalSamples})`);
}

function scheduleWeeklyFill(): void {
  const ms = msUntilNextSaturday();
  console.log(`[predSched] next weekly fill in ${(ms / 3600_000).toFixed(1)}h`);
  if (_weeklyTimer) clearTimeout(_weeklyTimer);
  _weeklyTimer = setTimeout(async () => {
    await fillActualsAndRecomputeWeights();
    scheduleWeeklyFill(); // re-schedule for next week
  }, ms);
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

  // Schedule weekly Saturday fill + weight recompute
  scheduleWeeklyFill();
}

/**
 * Trigger an immediate sweep for symbols missing today's prediction.
 * Non-blocking — returns immediately.
 */
export function triggerSweepNow(): void {
  runSweep("manual").catch(e => console.error("[predSched] manual sweep error:", e));
}

/**
 * Force re-predict ALL watchlist symbols (ignoring today's existing predictions).
 * DB keeps only the latest per day (insertModelPrediction deletes same-day records).
 * Non-blocking — returns immediately.
 */
export function triggerForceAll(): void {
  runSweep("force-all", true).catch(e => console.error("[predSched] force-all error:", e));
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
