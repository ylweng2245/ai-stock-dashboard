// server/mlPredictionService.ts
import { spawn } from "child_process";
import * as path from "path";
import { storage } from "./storage";
import { buildAnalystConsensusFeatures } from "./analystConsensusService";

export interface PredictionResult {
  ok: boolean;
  error?: string;
  modelName?: string;
  horizonDays?: number;
  runAt?: string;
  startDate?: string;
  endDate?: string;
  medianPath?: Array<{ date: string; price: number }>;
  lowerPath?: Array<{ date: string; price: number }>;
  upperPath?: Array<{ date: string; price: number }>;
  meta?: Record<string, any>;
}

export interface RunPredictionOptions {
  symbol: string;
  market: string;
  horizonDays: 5 | 20 | 60;
  currentPrice: number;
  saveToDb?: boolean;  // default true
}

/**
 * Returns today's date string (YYYY-MM-DD) in the appropriate market timezone.
 */
function getTodayInMarketTimezone(market: string): string {
  const tz = market === "US" ? "America/New_York" : "Asia/Taipei";
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // en-CA locale returns dates in YYYY-MM-DD format
  return formatter.format(new Date());
}

/**
 * Determines the Python executable name (platform-aware).
 */
function getPythonBin(): string {
  return process.platform === "win32" ? "python" : "python3";
}

export async function runPrediction(opts: RunPredictionOptions): Promise<PredictionResult> {
  const { symbol, market, horizonDays, currentPrice, saveToDb = true } = opts;

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

  // 2. Build analyst features for 20D and 60D horizons
  let analystFeatures: any = null;
  if (horizonDays === 20 || horizonDays === 60) {
    analystFeatures = await buildAnalystConsensusFeatures(symbol, market, currentPrice);
  }

  // 3. Build payload for Python script
  const payload = {
    symbol,
    market,
    horizon: horizonDays,
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

    // Timeout: 30 seconds
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        resolve({ ok: false, error: "Python 預測程序逾時 (30s)" });
      }
    }, 30_000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
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

    // Write payload to stdin
    child.stdin.write(JSON.stringify(payload), "utf8");
    child.stdin.end();
  });

  // 5. Persist to DB if requested and result is successful
  if (result.ok && saveToDb) {
    const todayStr = getTodayInMarketTimezone(market);
    try {
      await storage.insertModelPrediction({
        symbol,
        market,
        modelName: result.modelName ?? "RF_v1",
        horizonDays,
        runAt: todayStr,
        startDate: result.startDate ?? "",
        endDate: result.endDate ?? "",
        medianPathJson: JSON.stringify(result.medianPath ?? []),
        lowerPathJson: JSON.stringify(result.lowerPath ?? []),
        upperPathJson: JSON.stringify(result.upperPath ?? []),
        metaJson: JSON.stringify(result.meta ?? {}),
        createdAt: Date.now(),
      });
    } catch (dbErr: any) {
      // Non-fatal: log but don't override the prediction result
      console.error("[mlPredictionService] Failed to save prediction to DB:", dbErr?.message ?? dbErr);
    }
  }

  return {
    ...result,
    runAt: getTodayInMarketTimezone(market),
    horizonDays,
  };
}

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
