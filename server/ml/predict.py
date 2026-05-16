#!/usr/bin/env python3
"""
predict.py -- RandomForest Direct Multi-Step price-path predictor
AI Stock Dashboard V6.1

Input (stdin JSON):
  { "symbol", "market", "horizons": [1..20], "bars": [...], "analystFeatures": {...} }
  Backward compat: "horizon" int wraps as [horizon].

Output (stdout JSON):
  {
    "ok": true,
    "runAt": "...",
    "symbol": "...",
    "baseDate": "YYYY-MM-DD",   -- last bar date (T day)
    "basePrice": 905.0,         -- last bar close
    "horizons": {
      "1":  { "targetDate", "medianPrice", "lowerPrice", "upperPrice",
              "medianReturn", "upProbability", "topFeatures" },
      ...
      "20": { ... }
    },
    "meta": { "barsUsed", "trainSize", "oosSize", "modelVersion",
              "featuresUsed", "warning" }
  }

Band method: walk-forward OOS residuals, per-horizon.
  For each horizon h:
    residual[t] = actual_return[t+h] - predicted_return[t]   (on OOS period)
    p25, p75 = percentile(residuals, 25), percentile(residuals, 75)
    lower = medianPrice * (1 + p25)
    upper = medianPrice * (1 + p75)
    -- then clamp so lower <= medianPrice <= upper
  Fallback (< 5 OOS samples): +/- IQR of per-tree predictions.
"""

import sys
import json
import math
from datetime import date, timedelta, timezone, datetime

try:
    import numpy as np
    import pandas as pd
    from sklearn.ensemble import RandomForestRegressor
except ImportError as e:
    print(json.dumps({"ok": False, "error": f"Missing dependency: {e}"}))
    sys.exit(0)


# ---------------------------------------------------------------------------
# Feature engineering
# ---------------------------------------------------------------------------

def _rsi_wilder(series: pd.Series, period: int = 14) -> pd.Series:
    delta = series.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    return 100 - (100 / (1 + rs))


def _atr(high, low, close, period=14):
    prev_close = close.shift(1)
    tr = pd.concat([high - low, (high - prev_close).abs(), (low - prev_close).abs()], axis=1).max(axis=1)
    return tr.rolling(period, min_periods=period).mean()


def _build_features(df: pd.DataFrame, use_analyst: bool, analyst: dict) -> pd.DataFrame:
    c   = df["close"]
    vol = df["volume"]
    df  = df.copy()

    # Momentum / trend
    df["ret_1d"]         = c.pct_change(1)
    df["ret_3d"]         = c.pct_change(3)
    df["close_pct_5d"]   = c.pct_change(5)
    df["close_pct_20d"]  = c.pct_change(20)

    # Oscillators
    df["rsi_14"]         = _rsi_wilder(c, 14)

    # Volatility
    vol_ma20             = vol.rolling(20, min_periods=20).mean()
    df["vol_ratio_20d"]  = vol / vol_ma20.replace(0, np.nan)
    atr14                = _atr(df["high"], df["low"], c, 14)
    df["atr_14_pct"]     = atr14 / c.replace(0, np.nan)

    # Moving average distance
    ma20                 = c.rolling(20, min_periods=20).mean()
    ma60                 = c.rolling(60, min_periods=60).mean()
    df["ma20_dist_pct"]  = (c - ma20) / ma20.replace(0, np.nan)
    df["ma60_dist_pct"]  = (c - ma60) / ma60.replace(0, np.nan)

    # Bollinger band position (z-score within band)
    bb_std               = c.rolling(20, min_periods=20).std()
    df["bb_z"]           = (c - ma20) / bb_std.replace(0, np.nan)

    if use_analyst:
        df["upside_avg_ratio"] = analyst.get("upsideAvgRatio") or 0.0
        df["band_width"]       = analyst.get("bandWidth") or 0.0
        df["bullish_ratio"]    = analyst.get("bullishRatio") or 0.0
        df["avg_score"]        = analyst.get("avgScore") or 0.0

    return df


def _feature_cols(use_analyst: bool) -> list:
    cols = [
        "ret_1d", "ret_3d",
        "close_pct_5d", "close_pct_20d",
        "rsi_14",
        "vol_ratio_20d", "atr_14_pct",
        "ma20_dist_pct", "ma60_dist_pct",
        "bb_z",
    ]
    if use_analyst:
        cols += ["upside_avg_ratio", "band_width", "bullish_ratio", "avg_score"]
    return cols


FEATURE_LABELS = {
    "ret_1d":            "1\u65e5\u5831\u916c",
    "ret_3d":            "3\u65e5\u5831\u916c",
    "close_pct_5d":      "5\u65e5\u6f32\u8dcc\u5e45",
    "close_pct_20d":     "20\u65e5\u6f32\u8dcc\u5e45",
    "rsi_14":            "RSI(14)",
    "vol_ratio_20d":     "\u6210\u4ea4\u91cf\u6bd4\u7387",
    "atr_14_pct":        "ATR\u6ce2\u52d5\u7387",
    "ma20_dist_pct":     "MA20\u4e56\u96e2",
    "ma60_dist_pct":     "MA60\u4e56\u96e2",
    "bb_z":              "\u5e03\u6797Z\u5206",
    "upside_avg_ratio":  "\u5206\u6790\u5e2b\u4e0a\u884c\u7a7a\u9593",
    "band_width":        "\u5206\u6790\u5e2b\u76ee\u6a19\u5340\u9593",
    "bullish_ratio":     "\u6a02\u89c0\u8a55\u7d1a\u4f54\u6bd4",
    "avg_score":         "\u5206\u6790\u5e2b\u5e73\u5747\u8a55\u5206",
}


def _next_trading_days(start: date, n: int) -> list:
    days, d = [], start
    while len(days) < n:
        d += timedelta(days=1)
        if d.weekday() < 5:
            days.append(d)
    return days


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def run():
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"JSON parse error: {e}"}))
        return

    symbol       = payload.get("symbol", "")
    market       = payload.get("market", "US")
    bars         = payload.get("bars", [])
    analyst_raw  = payload.get("analystFeatures") or {}

    # Backward compatibility
    if "horizons" in payload:
        horizons = [int(h) for h in payload["horizons"]]
    elif "horizon" in payload:
        horizons = [int(payload["horizon"])]
    else:
        horizons = list(range(1, 21))

    if not horizons or any(h < 1 or h > 60 for h in horizons):
        print(json.dumps({"ok": False, "error": "horizons must be in [1,60]"}))
        return

    if len(bars) < 60:
        print(json.dumps({"ok": False, "error": "insufficient history"}))
        return

    warning     = "less_than_2y_data" if len(bars) < 504 else None
    max_horizon = max(horizons)

    # Build DataFrame
    df = pd.DataFrame(bars).sort_values("date").reset_index(drop=True)
    for col in ("open", "high", "low", "close", "volume"):
        df[col] = pd.to_numeric(df[col], errors="coerce")
    df = df.dropna(subset=["close"])

    use_analyst  = analyst_raw.get("hasConsensus", False)
    df           = _build_features(df, use_analyst, analyst_raw)
    feature_cols = _feature_cols(use_analyst)

    # Base date / price
    last_bar    = df.iloc[-1]
    base_date   = str(last_bar["date"])[:10]
    base_price  = float(last_bar["close"])

    # OOS split -- time-ordered, no shuffle
    n_total      = len(df)
    oos_size     = max(20, int(n_total * 0.2))
    oos_size     = min(oos_size, n_total - max_horizon - 30)
    if oos_size < 5:
        print(json.dumps({"ok": False, "error": "insufficient history for OOS split"}))
        return
    train_cutoff = n_total - oos_size

    # Seed features (last bar)
    seed_features = [
        float(last_bar.get(c, 0.0)) if pd.notna(last_bar.get(c)) else 0.0
        for c in feature_cols
    ]
    X_seed = np.array([seed_features])

    # Future trading dates
    base_date_obj   = date.fromisoformat(base_date)
    all_future      = _next_trading_days(base_date_obj, max_horizon)
    future_date_map = {h: all_future[h - 1] for h in horizons}

    # ---------------------------------------------------------------------------
    # Per-horizon training + walk-forward OOS band
    # ---------------------------------------------------------------------------
    horizon_results = {}

    for h in horizons:
        df_h           = df.copy()
        # Target: h-day cumulative return, labelled at the START bar (no lookahead)
        df_h["target"] = df_h["close"].shift(-h) / df_h["close"] - 1

        train_df = df_h.iloc[:train_cutoff].dropna(subset=feature_cols + ["target"])
        if len(train_df) < 30:
            continue

        model = RandomForestRegressor(
            n_estimators=150, random_state=42, n_jobs=-1, min_samples_leaf=3
        )
        model.fit(train_df[feature_cols].values, train_df["target"].values)

        # Walk-forward OOS residuals (actual_return - predicted_return)
        oos_df = df_h.iloc[train_cutoff : n_total - h].dropna(subset=feature_cols + ["target"])
        residuals = np.array([])
        if len(oos_df) >= 5:
            y_pred = model.predict(oos_df[feature_cols].values)
            y_true = oos_df["target"].values
            residuals = y_true - y_pred   # positive = model underestimated

        # Predict on seed (last bar)
        tree_preds     = np.array([t.predict(X_seed)[0] for t in model.estimators_])
        median_return  = float(np.median(tree_preds))
        up_probability = float(np.mean(tree_preds > 0))
        median_price   = round(base_price * (1 + median_return), 4)

        # Band: add residual percentiles onto median_price
        # residual is in return-space; multiply by base_price to get price delta
        if len(residuals) >= 5:
            p25 = float(np.percentile(residuals, 25))
            p75 = float(np.percentile(residuals, 75))
            lower_price = round(median_price + base_price * p25, 4)
            upper_price = round(median_price + base_price * p75, 4)
        else:
            # Fallback: IQR of per-tree predictions
            tree_p25 = float(np.percentile(tree_preds, 25))
            tree_p75 = float(np.percentile(tree_preds, 75))
            lower_price = round(base_price * (1 + tree_p25), 4)
            upper_price = round(base_price * (1 + tree_p75), 4)

        # Guarantee: lower <= median <= upper (clamp, not swap)
        lower_price = min(lower_price, median_price)
        upper_price = max(upper_price, median_price)

        # Feature importance (top 5)
        fi = sorted(zip(feature_cols, model.feature_importances_), key=lambda x: -x[1])[:5]
        top_features = [
            {"feature": k, "label": FEATURE_LABELS.get(k, k), "importance": round(float(v), 4)}
            for k, v in fi
        ]

        horizon_results[str(h)] = {
            "targetDate":    future_date_map[h].isoformat(),
            "medianPrice":   median_price,
            "lowerPrice":    lower_price,
            "upperPrice":    upper_price,
            "medianReturn":  round(median_return * 100, 4),
            "upProbability": round(up_probability, 4),
            "topFeatures":   top_features,
        }

    if not horizon_results:
        print(json.dumps({"ok": False, "error": "all horizons failed training"}))
        return

    run_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    meta   = {
        "barsUsed":     n_total,
        "trainSize":    train_cutoff,
        "oosSize":      oos_size,
        "modelVersion": "RF_v3",
        "featuresUsed": feature_cols,
        "useAnalyst":   use_analyst,
    }
    if warning:
        meta["warning"] = warning

    print(json.dumps({
        "ok":        True,
        "runAt":     run_at,
        "symbol":    symbol,
        "baseDate":  base_date,
        "basePrice": base_price,
        "horizons":  horizon_results,
        "meta":      meta,
    }))


if __name__ == "__main__":
    try:
        run()
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))
