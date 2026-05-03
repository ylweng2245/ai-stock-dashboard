#!/usr/bin/env python3
"""
predict.py — RandomForest price-path predictor for AI Stock Dashboard V6.1

Reads JSON from stdin:
  {
    "symbol": "LLY",
    "market": "US",
    "horizon": 20,
    "bars": [{"date":"YYYY-MM-DD","open":...,"high":...,"low":...,"close":...,"volume":...}],
    "analystFeatures": {...}
  }

Writes JSON to stdout.
"""

import sys
import json
import math
from datetime import date, timedelta

try:
    import numpy as np
    import pandas as pd
    from sklearn.ensemble import RandomForestRegressor
except ImportError as e:
    print(json.dumps({"ok": False, "error": f"Missing dependency: {e}"}))
    sys.exit(0)


def _rsi_wilder(series: pd.Series, period: int = 14) -> pd.Series:
    """Wilder-smoothed RSI."""
    delta = series.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    rsi = 100 - (100 / (1 + rs))
    return rsi


def _atr(high: pd.Series, low: pd.Series, close: pd.Series, period: int = 14) -> pd.Series:
    """Average True Range over `period` periods."""
    prev_close = close.shift(1)
    tr = pd.concat(
        [
            high - low,
            (high - prev_close).abs(),
            (low - prev_close).abs(),
        ],
        axis=1,
    ).max(axis=1)
    return tr.rolling(period, min_periods=period).mean()


def _build_features(df: pd.DataFrame, use_analyst: bool, analyst: dict) -> pd.DataFrame:
    """Compute feature columns; rows with NaN are dropped by caller."""
    c = df["close"]
    vol = df["volume"]

    df = df.copy()
    df["close_pct_5d"] = c.pct_change(5)
    df["close_pct_20d"] = c.pct_change(20)
    df["rsi_14"] = _rsi_wilder(c, 14)
    vol_ma20 = vol.rolling(20, min_periods=20).mean()
    df["vol_ratio_20d"] = vol / vol_ma20.replace(0, np.nan)
    atr14 = _atr(df["high"], df["low"], c, 14)
    df["atr_14_pct"] = atr14 / c.replace(0, np.nan)
    ma20 = c.rolling(20, min_periods=20).mean()
    ma60 = c.rolling(60, min_periods=60).mean()
    df["ma20_dist_pct"] = (c - ma20) / ma20.replace(0, np.nan)
    df["ma60_dist_pct"] = (c - ma60) / ma60.replace(0, np.nan)

    if use_analyst:
        df["upside_avg_ratio"] = analyst.get("upsideAvgRatio") or 0.0
        df["band_width"] = analyst.get("bandWidth") or 0.0
        df["bullish_ratio"] = analyst.get("bullishRatio") or 0.0
        df["avg_score"] = analyst.get("avgScore") or 0.0

    return df


def _base_feature_cols(use_analyst: bool) -> list:
    cols = [
        "close_pct_5d",
        "close_pct_20d",
        "rsi_14",
        "vol_ratio_20d",
        "atr_14_pct",
        "ma20_dist_pct",
        "ma60_dist_pct",
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
        if d.weekday() < 5:  # Mon-Fri
            days.append(d)
    return days


def run():
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"JSON parse error: {e}"}))
        return

    symbol = payload.get("symbol", "")
    market = payload.get("market", "US")
    horizon = int(payload.get("horizon", 20))
    bars = payload.get("bars", [])
    analyst_raw = payload.get("analystFeatures") or {}

    # ── Validate input ────────────────────────────────────────────────────────
    if len(bars) < 60:
        print(json.dumps({"ok": False, "error": "insufficient history"}))
        return

    # ── Build DataFrame ───────────────────────────────────────────────────────
    df = pd.DataFrame(bars)
    df = df.sort_values("date").reset_index(drop=True)
    for col in ("open", "high", "low", "close", "volume"):
        df[col] = pd.to_numeric(df[col], errors="coerce")
    df = df.dropna(subset=["close"])

    use_analyst = horizon in (20, 60) and analyst_raw.get("hasConsensus", False)
    df = _build_features(df, use_analyst=use_analyst, analyst=analyst_raw)

    feature_cols = _base_feature_cols(use_analyst)

    # Target: future return at horizon (shifted by -horizon)
    df["target"] = df["close"].pct_change(horizon).shift(-horizon)

    # ── Train / predict split ─────────────────────────────────────────────────
    train_df = df.iloc[: -horizon].dropna(subset=feature_cols + ["target"])

    if len(train_df) < 30:
        print(json.dumps({"ok": False, "error": "insufficient history after feature computation"}))
        return

    X_train = train_df[feature_cols].values
    y_train = train_df["target"].values

    model = RandomForestRegressor(n_estimators=200, random_state=42, n_jobs=-1)
    model.fit(X_train, y_train)

    # ── Seed bar for forward simulation ──────────────────────────────────────
    seed_row = df.iloc[-1]
    last_close = float(seed_row["close"])
    last_date = date.fromisoformat(str(seed_row["date"])[:10])

    seed_features = []
    for col in feature_cols:
        val = seed_row.get(col, 0.0)
        seed_features.append(float(val) if pd.notna(val) else 0.0)

    X_seed = np.array([seed_features])

    # Collect per-tree predictions for uncertainty + probability
    tree_preds = np.array([tree.predict(X_seed)[0] for tree in model.estimators_])
    median_total_return = float(np.median(tree_preds))
    std_total_return = float(np.std(tree_preds))

    # Up probability: fraction of trees predicting positive return
    up_probability = float(np.mean(tree_preds > 0))

    # Scenario probabilities using percentile bins
    p25 = float(np.percentile(tree_preds, 25))
    p75 = float(np.percentile(tree_preds, 75))
    bull_prob = float(np.mean(tree_preds > p75))
    bear_prob = float(np.mean(tree_preds < p25))
    base_prob = 1.0 - bull_prob - bear_prob

    # Model confidence: inverse of coefficient of variation (capped 0-100)
    cv = abs(std_total_return / median_total_return) if abs(median_total_return) > 1e-6 else 2.0
    confidence_score = int(max(0, min(100, round(100 * (1 - min(cv, 1))))))

    # Feature importance top 5
    importances = model.feature_importances_
    fi_pairs = sorted(zip(feature_cols, importances), key=lambda x: x[1], reverse=True)[:5]
    top_features = [
        {"feature": k, "label": FEATURE_LABELS.get(k, k), "importance": round(float(v), 4)}
        for k, v in fi_pairs
    ]

    # Expected return range (p10, p90)
    p10_ret = float(np.percentile(tree_preds, 10))
    p90_ret = float(np.percentile(tree_preds, 90))

    # ── Build price paths ─────────────────────────────────────────────────────
    future_dates = _next_trading_days(last_date, horizon)

    def build_path(total_return: float) -> list:
        daily_factor = (1 + total_return) ** (1 / horizon) if horizon > 0 else 1.0
        path = []
        price = last_close
        for d in future_dates:
            price = price * daily_factor
            path.append({"date": d.isoformat(), "price": round(price, 4)})
        return path

    median_path = build_path(median_total_return)
    upper_path = build_path(median_total_return + std_total_return)
    lower_path = build_path(median_total_return - std_total_return)
    # p25 / p75 paths for the shaded band
    p25_path = build_path(p25)
    p75_path = build_path(p75)

    # ── Meta ──────────────────────────────────────────────────────────────────
    train_window_years = round(len(train_df) / 252, 1)

    result = {
        "ok": True,
        "modelName": "RF_v1",
        "horizonDays": horizon,
        "startDate": future_dates[0].isoformat() if future_dates else "",
        "endDate": future_dates[-1].isoformat() if future_dates else "",
        "medianPath": median_path,
        "lowerPath": lower_path,
        "upperPath": upper_path,
        "p25Path": p25_path,
        "p75Path": p75_path,
        # Probability & scenario
        "upProbability": up_probability,
        "bullProb": round(bull_prob, 3),
        "baseProb": round(base_prob, 3),
        "bearProb": round(bear_prob, 3),
        # Confidence & range
        "confidenceScore": confidence_score,
        "expectedReturnPct": round(median_total_return * 100, 2),
        "rangeReturnLow": round(p10_ret * 100, 2),
        "rangeReturnHigh": round(p90_ret * 100, 2),
        # Feature importance
        "topFeatures": top_features,
        "meta": {
            "trainSamples": len(train_df),
            "featureVersion": "v1",
            "trainWindowYears": train_window_years,
            "useAnalyst": use_analyst,
        },
    }

    print(json.dumps(result))


if __name__ == "__main__":
    try:
        run()
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))
