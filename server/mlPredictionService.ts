// server/mlPredictionService.ts
import { spawn } from "child_process";
import * as path from "path";
import { randomUUID } from "crypto";
import { storage, sqlite } from "./storage";
import { buildAnalystConsensusFeatures } from "./analystConsensusService";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface HorizonPoint {
  targetDate: string;
  medianPrice: number;
  lowerPrice: number;
  upperPrice: number;
  medianReturn: number;   // % units
  upProbability: number;
  topFeatures: Array<{ feature: string; label: string; importance: number }>;
  rawPredictions?: { hgb: number | null; lgb: number | null; rf: number | null };
}

export interface PredictionResult {
  ok: boolean;
  error?: string;
  runAt?: string;
  runId?: string;
  symbol?: string;
  baseDate?: string;
  basePrice?: number;
  /** New format: keyed by horizon string e.g. "1".."20" */
  horizons?: Record<string, HorizonPoint>;
  meta?: Record<string, any>;

  // Legacy fields — kept for backward compat with existing routes
  modelName?: string;
  horizonDays?: number;
  startDate?: string;
  endDate?: string;
  medianPath?: Array<{ date: string; price: number }>;
  lowerPath?: Array<{ date: string; price: number }>;
  upperPath?: Array<{ date: string; price: number }>;
}

export interface RunPredictionOptions {
  symbol: string;
  market: string;
  horizonDays?: 5 | 20 | 60;    // kept for legacy callers; ignored when horizons array is given
  horizons?: number[];            // new: array like [1..20]
  currentPrice: number;
  saveToDb?: boolean;             // default true
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getTodayInMarketTimezone(market: string): string {
  const tz = market === "US" ? "America/New_York" : "Asia/Taipei";
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(new Date());
}

function getPythonBin(): string {
  return process.platform === "win32" ? "python" : "python3";
}

/**
 * Convert new horizons output to legacy medianPath / lowerPath / upperPath arrays
 * for backward compatibility (personal-advice, prediction-history pages).
 * Uses horizons 1..N sorted, one point per horizon.
 */
function horizonsToLegacyPaths(
  horizons: Record<string, HorizonPoint>,
): { medianPath: Array<{date:string;price:number}>; lowerPath: Array<{date:string;price:number}>; upperPath: Array<{date:string;price:number}> } {
  const keys = Object.keys(horizons).map(Number).sort((a, b) => a - b);
  const medianPath = keys.map(k => ({ date: horizons[String(k)].targetDate, price: horizons[String(k)].medianPrice }));
  const lowerPath  = keys.map(k => ({ date: horizons[String(k)].targetDate, price: horizons[String(k)].lowerPrice  }));
  const upperPath  = keys.map(k => ({ date: horizons[String(k)].targetDate, price: horizons[String(k)].upperPrice  }));
  return { medianPath, lowerPath, upperPath };
}

// ─── Core prediction runner ───────────────────────────────────────────────────

export async function runPrediction(opts: RunPredictionOptions): Promise<PredictionResult> {
  const { symbol, market, currentPrice, saveToDb = true } = opts;

  // Decide horizons array
  const horizonsArr: number[] = opts.horizons
    ? opts.horizons
    : opts.horizonDays
      ? [opts.horizonDays]
      : Array.from({ length: 20 }, (_, i) => i + 1);

  // 1. Fetch historical price bars
  const rawBars = await storage.getHistoricalPrices(symbol, market);
  if (!rawBars || rawBars.length < 60) {
    return { ok: false, error: "歷史資料不足，無法執行預測" };
  }

  const bars = rawBars.map((b: any) => ({
    date: b.date,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
  }));

  // 2. Build analyst features
  let analystFeatures: any = null;
  const maxH = Math.max(...horizonsArr);
  if (maxH >= 20) {
    analystFeatures = await buildAnalystConsensusFeatures(symbol, market, currentPrice);
  }

  // 3. Build stdin payload
  const payload = {
    symbol,
    market,
    horizons: horizonsArr,
    bars,
    analystFeatures: analystFeatures ?? {},
  };

  // 4. Spawn Python
  const scriptPath = path.join(__dirname, "ml", "predict.py");
  const pythonBin = getPythonBin();

  const result = await new Promise<PredictionResult>((resolve) => {
    let stdoutBuf = "";
    let stderrBuf = "";
    let settled = false;

    const child = spawn(pythonBin, [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        resolve({ ok: false, error: "Python 預測程序逾時 (120s)" });
      }
    }, 120_000);

    child.stdout.on("data", (chunk: Buffer) => { stdoutBuf += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderrBuf += text;
      if (text.trim()) console.warn("[predict.py stderr]", text.trim().slice(0, 500));
    });

    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (!stdoutBuf.trim()) {
        resolve({
          ok: false,
          error: `Python 程序無輸出 (exit ${code})${stderrBuf ? ": " + stderrBuf.slice(0, 200) : ""}`,
        });
        return;
      }

      try {
        const parsed = JSON.parse(stdoutBuf.trim());
        resolve(parsed as PredictionResult);
      } catch (e) {
        resolve({ ok: false, error: `JSON 解析失敗: ${String(e)}` });
      }
    });

    child.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: `無法啟動 Python: ${err.message}` });
    });

    child.stdin.write(JSON.stringify(payload), "utf8");
    child.stdin.end();
  });

  if (!result.ok) return result;

  // 5. Generate run_id and build legacy paths
  const runId = randomUUID();
  const todayStr = getTodayInMarketTimezone(market);
  const runAt = result.runAt ?? new Date().toISOString();
  const baseDate  = result.baseDate ?? todayStr;
  const basePrice = result.basePrice ?? currentPrice;

  // Build legacy paths from horizons output
  const legacyPaths = result.horizons
    ? horizonsToLegacyPaths(result.horizons)
    : { medianPath: [], lowerPath: [], upperPath: [] };

  // Determine startDate / endDate from horizon keys
  const hKeys = result.horizons ? Object.keys(result.horizons).map(Number).sort((a, b) => a - b) : [];
  const startDate = hKeys.length > 0 ? result.horizons![String(hKeys[0])].targetDate : "";
  const endDate   = hKeys.length > 0 ? result.horizons![String(hKeys[hKeys.length - 1])].targetDate : "";

  // 6. Persist to DB
  if (saveToDb) {
    const horizonDays = hKeys.length > 0 ? hKeys[hKeys.length - 1] : (opts.horizonDays ?? 20);

    // 6a. Write prediction_tracking rows (one per horizon)
    if (result.horizons) {
      try {
        const stmt = sqlite.prepare(`
          INSERT OR IGNORE INTO prediction_tracking
            (run_id, symbol, market, run_date, horizon, base_price, predicted_return, predicted_price, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const insertMany = sqlite.transaction(() => {
          for (const h of hKeys) {
            const hp = result.horizons![String(h)];
            if (!hp) continue;
            stmt.run(runId, symbol, market, todayStr, h, basePrice,
              hp.medianReturn, hp.medianPrice, new Date().toISOString());
          }
        });
        insertMany();
        console.log(`[mlPrediction] tracking: wrote ${hKeys.length} rows for ${symbol} run_id=${runId}`);
      } catch (trackErr: any) {
        console.warn("[mlPrediction] prediction_tracking write failed:", trackErr?.message);
      }
    }

    // Extract raw per-model predictions across all horizons
    const h1 = result.horizons?.["1"];
    const rfRaw = h1 ? JSON.stringify(
      Object.fromEntries(Object.keys(result.horizons!).map(k => [k, result.horizons![k].rawPredictions?.rf ?? null]))
    ) : null;
    const gbRaw = h1 ? JSON.stringify(
      Object.fromEntries(Object.keys(result.horizons!).map(k => [k, result.horizons![k].rawPredictions?.hgb ?? null]))
    ) : null;
    const lrRaw = h1 ? JSON.stringify(
      Object.fromEntries(Object.keys(result.horizons!).map(k => [k, result.horizons![k].rawPredictions?.lgb ?? null]))
    ) : null;
    const weightsRaw = result.meta?.ensembleWeights ? JSON.stringify(result.meta.ensembleWeights) : null;

    try {
      await (storage as any).insertModelPrediction({
        symbol,
        market,
        modelName:      result.meta?.modelVersion ?? "RF_v2",
        horizonDays,
        runAt:          todayStr,          // date string for query range
        startDate,
        endDate,
        medianPathJson: JSON.stringify(legacyPaths.medianPath),
        lowerPathJson:  JSON.stringify(legacyPaths.lowerPath),
        upperPathJson:  JSON.stringify(legacyPaths.upperPath),
        metaJson:       JSON.stringify({ ...result.meta, horizonsJson: JSON.stringify(result.horizons) }),
        createdAt:      Date.now(),
        runId,
        baseDate,
        basePrice,
        rfJson:         rfRaw,
        gbJson:         gbRaw,
        lrJson:         lrRaw,
        weightsJson:    weightsRaw,
      });
    } catch (dbErr: any) {
      console.error("[mlPredictionService] Failed to save prediction to DB:", dbErr?.message ?? dbErr);
    }
  }

  return {
    ...result,
    runAt,
    runId,
    horizonDays: opts.horizonDays,
    startDate,
    endDate,
    medianPath: legacyPaths.medianPath,
    lowerPath:  legacyPaths.lowerPath,
    upperPath:  legacyPaths.upperPath,
    modelName:  result.meta?.modelVersion ?? "RF_v2",
  };
}

// ─── Legacy multi-horizon runner (personal-advice page) ───────────────────────

export async function runAllHorizons(
  symbol: string,
  market: string,
  currentPrice: number,
): Promise<PredictionResult[]> {
  const horizons: Array<5 | 20 | 60> = [5, 20, 60];
  const results = await Promise.all(
    horizons.map((horizonDays) =>
      runPrediction({ symbol, market, horizonDays, currentPrice }),
    ),
  );
  return results;
}
