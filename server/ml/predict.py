#!/usr/bin/env python3
"""
predict.py — RandomForest Direct Multi-Step price-path predictor
AI Stock Dashboard V6.1

Reads JSON from stdin:
  {
    "symbol": "LLY",
    "market": "US",
    "horizons": [1, 2, 3, ..., 20],   // array of horizon ints
    "bars": [{"date":"YYYY-MM-DD","open":...,"high":...,"low":...,"close":...,"volume":...}],
    "analystFeatures": {...} | null
  }

  Backward compatible: if stdin contains "horizon" (int) instead of "horizons" (array),
  it is wrapped automatically as [horizon].

Writes JSON to stdout:
  {
    "runAt": "2026-05-17T00:00:00Z",
    "symbol": "LLY",
    "baseDate": "2026-05-15",
    "basePrice": 905.0,
    "horizons": {
      "1":  {"targetDate": "...", "medianPrice": ..., "lowerPrice": ..., "upperPrice": ...,
             "medianReturn": ..., "upProbability": ..., "topFeatures": [...]},
      ...
      "20": {...}
    },
    "meta": {
      "barsUsed": 504,
      "trainSize": 400,
      "oosSize": 104,
      "modelVersion": "RF_v2",
      "featuresUsed": [...],
      "warning": "less_than_2y_data"   // optional
    }
  }
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


# ─── Feature engineering helpers ─────────────────────────────────────────────

def _rsi_wilder(series: pd.Series, period: int = 14) -> pd.Series:
    delta = series.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    return 100 - (100 / (1 + rs))


def _atr(high: pd.Series, low: pd.Series, close: pd.Series, period: int = 14) -> pd.Series:
    prev_close = close.shift(1)
    tr = pd.concat(
        [high - low, (high - prev_close).abs(), (low - prev_close).abs()],
        axis=1,
    ).max(axis=1)
    return tr.rolling(period, min_periods=period).mean()


def _build_features(df: pd.DataFrame, use_analyst: bool, analyst: dict) -> pd.DataFrame:
    c = df["close"]
    vol = df["volume"]
    df = df.copy()
    df["close_pct_5d"]   = c.pct_change(5)
    df["close_pct_20d"]  = c.pct_change(20)
    df["rsi_14"]         = _rsi_wilder(c, 14)
    vol_ma20             = vol.rolling(20, min_periods=20).mean()
    df["vol_ratio_20d"]  = vol / vol_ma20.replace(0, np.nan)
    atr14                = _atr(df["high"], df["low"], c, 14)
    df["atr_14_pct"]     = atr14 / c.replace(0, np.nan)
    ma20                 = c.rolling(20, min_periods=20).mean()
    ma60                 = c.rolling(60, min_periods=60).mean()
    df["ma20_dist_pct"]  = (c - ma20) / ma20.replace(0, np.nan)
    df["ma60_dist_pct"]  = (c - ma60) / ma60.replace(0, np.nan)
    if use_analyst:
        df["upside_avg_ratio"] = analyst.get("upsideAvgRatio") or 0.0
        df["band_width"]       = analyst.get("bandWidth") or 0.0
        df["bullish_ratio"]    = analyst.get("bullishRatio") or 0.0
        df["avg_score"]        = analyst.get("avgScore") or 0.0
    return df


def _base_feature_cols(use_analyst: bool) -> list:
    cols = [
        "close_pct_5d", "close_pct_20d", "rsi_14",
        "vol_ratio_20d", "atr_14_pct", "ma20_dist_pct", "ma60_dist_pct",
    ]
    if use_analyst:
        cols += ["upside_avg_ratio", "band_width", "bullish_ratio", "avg_score"]
    return cols


FEATURE_LABELS = {
    "close_pct_5d":      "5日漲跌幅",
    "close_pct_20d":     "20日漲跌幅",
    "rsi_14":            "RSI(14)",
    "vol_ratio_20d":     "成交量比率",
    "atr_14_pct":        "ATR波動率",
    "ma20_dist_pct":     "20日均線乖離",
    "ma60_dist_pct":     "60日均線乖離",
    "upside_avg_ratio":  "分析師目標上行空間",
    "band_width":        "分析師目標區間寬度",
    "bullish_ratio":     "樂觀評級佔比",
    "avg_score":         "分析師平均評分",
}


def _next_trading_days(start: date, n: int) -> list:
    """Return n weekday dates starting from (but not including) start."""
    days = []
    d = start
    while len(days) < n:
        d += timedelta(days=1)
        if d.weekday() < 5:
            days.append(d)
    return days


# ─── Main prediction logic ────────────────────────────────────────────────────

def run():
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"JSON parse error: {e}"}))
        return

    symbol     = payload.get("symbol", "")
    market     = payload.get("market", "US")
    bars       = payload.get("bars", [])
    analyst_raw = payload.get("analystFeatures") or {}

    # Backward compatibility: "horizon" int → wrap as [horizon]
    if "horizons" in payload:
        horizons = [int(h) for h in payload["horizons"]]
    elif "horizon" in payload:
        horizons = [int(payload["horizon"])]
    else:
        horizons = list(range(1, 21))

    # Validate horizons
    if not horizons or any(h < 1 or h > 60 for h in horizons):
        print(json.dumps({"ok": False, "error": "horizons must be integers in [1, 60]"}))
        return

    max_horizon = max(horizons)

    # ── Validate bar count ────────────────────────────────────────────────────
    if len(bars) < 60:
        print(json.dumps({"ok": False, "error": "insufficient history"}))
        return

    warning = None
    if len(bars) < 504:
        warning = "less_than_2y_data"

    # ── Build DataFrame ───────────────────────────────────────────────────────
    df = pd.DataFrame(bars)
    df = df.sort_values("date").reset_index(drop=True)
    for col in ("open", "high", "low", "close", "volume"):
        df[col] = pd.to_numeric(df[col], errors="coerce")
    df = df.dropna(subset=["close"])

    use_analyst = analyst_raw.get("hasConsensus", False)
    df = _build_features(df, use_analyst=use_analyst, analyst=analyst_raw)
    feature_cols = _base_feature_cols(use_analyst)

    # Base date and price (last bar = T day)
    last_bar    = df.iloc[-1]
    base_date   = str(last_bar["date"])[:10]
    base_price  = float(last_bar["close"])
    base_date_obj = date.fromisoformat(base_date)

    # OOS split: last ~20% of data (at least 20 bars, capped by max_horizon headroom)
    n_total = len(df)
    oos_size = max(20, int(n_total * 0.2))
    # Ensure enough train rows for the largest horizon
    oos_size = min(oos_size, n_total - max_horizon - 30)
    if oos_size < 10:
        print(json.dumps({"ok": False, "error": "insufficient history for OOS split"}))
        return
    train_cutoff = n_total - oos_size   # index of first OOS row

    # Pre-compute seed features (from last bar)
    seed_features = []
    for col in feature_cols:
        val = last_bar.get(col, 0.0)
        seed_features.append(float(val) if pd.notna(val) else 0.0)
    X_seed = np.array([seed_features])

    # Pre-compute target trading dates
    # We need up to max_horizon trading days ahead
    all_future_dates = _next_trading_days(base_date_obj, max(horizons))
    future_date_map = {h: all_future_dates[h - 1] for h in horizons}

    # ── Per-horizon training ──────────────────────────────────────────────────
    horizon_results = {}

    for h in horizons:
        # Target: cumulative return at horizon h (shift back by h from each row)
        df_h = df.copy()
        df_h["target_h"] = df_h["close"].pct_change(h).shift(-h)

        # Train set: up to train_cutoff, drop rows lacking target or features
        train_df = df_h.iloc[:train_cutoff].dropna(subset=feature_cols + ["target_h"])

        if len(train_df) < 30:
            # Not enough training data for this horizon — skip
            continue

        X_train = train_df[feature_cols].values
        y_train = train_df["target_h"].values

        model = RandomForestRegressor(n_estimators=150, random_state=42, n_jobs=-1,
                                      min_samples_leaf=3)
        model.fit(X_train, y_train)

        # ── OOS residuals for uncertainty band ───────────────────────────────
        oos_df = df_h.iloc[train_cutoff:].dropna(subset=feature_cols + ["target_h"])
        oos_residuals = []
        if len(oos_df) >= 5:
            X_oos = oos_df[feature_cols].values
            y_oos = oos_df["target_h"].values
            y_pred_oos = model.predict(X_oos)
            oos_residuals = (y_oos - y_pred_oos).tolist()

        # ── Predict on seed (last bar) ────────────────────────────────────────
        # Per-tree distribution for uncertainty + probability
        tree_preds = np.array([t.predict(X_seed)[0] for t in model.estimators_])
        median_return = float(np.median(tree_preds))
        up_probability = float(np.mean(tree_preds > 0))

        # OOS residual band (25th / 75th pct of residuals)
        if len(oos_residuals) >= 5:
            res_arr = np.array(oos_residuals)
            band_lower_offset = float(np.percentile(res_arr, 25))
            band_upper_offset = float(np.percentile(res_arr, 75))
        else:
            # Fallback: ±std of tree predictions
            std_r = float(np.std(tree_preds))
            band_lower_offset = -std_r
            band_upper_offset =  std_r

        # Price predictions: P_T × (1 + r̂_h)
        median_price = round(base_price * (1 + median_return), 4)
        lower_price  = round(base_price * (1 + median_return + band_lower_offset), 4)
        upper_price  = round(base_price * (1 + median_return + band_upper_offset), 4)
        # Ensure lower <= upper
        if lower_price > upper_price:
            lower_price, upper_price = upper_price, lower_price

        # Feature importance (top 5)
        importances = model.feature_importances_
        fi_pairs = sorted(zip(feature_cols, importances), key=lambda x: x[1], reverse=True)[:5]
        top_features = [
            {"feature": k, "label": FEATURE_LABELS.get(k, k), "importance": round(float(v), 4)}
            for k, v in fi_pairs
        ]

        target_date = future_date_map[h]
        horizon_results[str(h)] = {
            "targetDate":    target_date.isoformat(),
            "medianPrice":   median_price,
            "lowerPrice":    lower_price,
            "upperPrice":    upper_price,
            "medianReturn":  round(median_return * 100, 4),   # % units
            "upProbability": round(up_probability, 4),
            "topFeatures":   top_features,
        }

    if not horizon_results:
        print(json.dumps({"ok": False, "error": "all horizons failed training"}))
        return

    # ── Build output ──────────────────────────────────────────────────────────
    run_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    meta: dict = {
        "barsUsed":     n_total,
        "trainSize":    train_cutoff,
        "oosSize":      oos_size,
        "modelVersion": "RF_v2",
        "featuresUsed": feature_cols,
        "useAnalyst":   use_analyst,
    }
    if warning:
        meta["warning"] = warning

    result = {
        "ok":        True,
        "runAt":     run_at,
        "symbol":    symbol,
        "baseDate":  base_date,
        "basePrice": base_price,
        "horizons":  horizon_results,
        "meta":      meta,
    }

    print(json.dumps(result))


if __name__ == "__main__":
    try:
        run()
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))
