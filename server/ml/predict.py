#!/usr/bin/env python3
"""
predict.py -- Ensemble Direct Multi-Step price-path predictor
AI Stock Dashboard V6.2  (model: Ensemble_v1)

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
    lower = medianPrice + basePrice * p25
    upper = medianPrice + basePrice * p75
    -- then clamp so lower <= medianPrice <= upper
  Fallback (< 5 OOS samples): +/- 1 ATR band.

Algorithm: Ensemble of 3 models (weighted average)
  1. HistGradientBoostingRegressor  (handles NaN natively)
  2. LightGBM (if available, else skip gracefully)
  3. RandomForestRegressor
  Ensemble weight: HGB=0.45, LGB=0.35, RF=0.20 (or equal if LGB missing)

upProbability: Platt-scaled probability via CalibratedClassifierCV
  Direction labels: 1 if h-day return > 0 else 0
  Calibrated on OOS fold for honest probability estimates
"""

import sys
import os
import json
import math
from datetime import date, timedelta, timezone, datetime

sys.path.insert(0, os.path.dirname(__file__))
from features_extra import get_extra_features

try:
    import numpy as np
    import pandas as pd
    from sklearn.ensemble import HistGradientBoostingRegressor, RandomForestRegressor
    from sklearn.calibration import CalibratedClassifierCV
    from sklearn.ensemble import GradientBoostingClassifier
except ImportError as e:
    print(json.dumps({"ok": False, "error": f"Missing dependency: {e}"}))
    sys.exit(0)

# LightGBM is optional — gracefully skip if not installed
try:
    import lightgbm as lgb
    HAS_LGB = True
except ImportError:
    HAS_LGB = False


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

    # ── v3 base features ────────────────────────────────────────────────────
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

    # ── v4 new features ──────────────────────────────────────────────────────
    # Lag returns (recent price memory)
    df["lag_ret_1"]      = c.pct_change(1).shift(1)
    df["lag_ret_2"]      = c.pct_change(1).shift(2)
    df["lag_ret_3"]      = c.pct_change(1).shift(3)
    df["lag_ret_5"]      = c.pct_change(1).shift(5)

    # MACD features (normalised by price)
    ema12                = c.ewm(span=12, adjust=False).mean()
    ema26                = c.ewm(span=26, adjust=False).mean()
    macd_line            = ema12 - ema26
    signal_line          = macd_line.ewm(span=9, adjust=False).mean()
    df["macd_norm"]      = macd_line / c.replace(0, np.nan)
    df["macd_hist_norm"] = (macd_line - signal_line) / c.replace(0, np.nan)

    # Time / seasonality features
    df_dates             = pd.to_datetime(df["date"])
    df["weekday"]        = df_dates.dt.dayofweek          # 0=Mon … 4=Fri
    df["month"]          = df_dates.dt.month              # 1–12

    # Intraday range (volatility proxy)
    df["hl_pct"]         = (df["high"] - df["low"]) / c.replace(0, np.nan)

    return df


FEATURES = [
    # Original 19 (keep exactly as-is)
    "ret_1d", "ret_3d", "close_pct_5d", "close_pct_20d",
    "rsi_14", "vol_ratio_20d", "atr_14_pct", "ma20_dist_pct",
    "ma60_dist_pct", "bb_z", "lag_ret_1", "lag_ret_2",
    "lag_ret_3", "lag_ret_5", "macd_norm", "macd_hist_norm",
    "weekday", "month", "hl_pct",
    # Layer 1: Analyst
    "analyst_bullish_pct", "analyst_bearish_pct", "analyst_pt_upside",
    "analyst_upgrade_net", "analyst_pt_dispersion",
    "pt_change_30d_pct", "pt_revision_count",
    # Layer 2: Fundamentals
    "revenue_qoq", "revenue_yoy", "gross_margin", "net_margin",
    "eps_qoq", "days_since_earnings", "days_to_earnings",
    # Layer 3: Market + Sector
    "fear_greed", "fear_greed_delta_7d", "vix_level", "vix_5d_change",
    "sector_rs_5d", "sector_rs_20d",
    # Layer 4: News Sentiment (Alpha Vantage)
    "news_sentiment_score", "news_bullish_ratio",
    "news_sentiment_3d_avg", "news_article_count",
]


def _feature_cols(use_analyst: bool) -> list:
    return FEATURES


FEATURE_LABELS = {
    "ret_1d":            "1日報酬",
    "ret_3d":            "3日報酬",
    "close_pct_5d":      "5日漲跌幅",
    "close_pct_20d":     "20日漲跌幅",
    "rsi_14":            "RSI(14)",
    "vol_ratio_20d":     "成交量比率",
    "atr_14_pct":        "ATR波動率",
    "ma20_dist_pct":     "MA20乖離",
    "ma60_dist_pct":     "MA60乖離",
    "bb_z":              "布林Z分",
    "lag_ret_1":         "前1日報酬",
    "lag_ret_2":         "前2日報酬",
    "lag_ret_3":         "前3日報酬",
    "lag_ret_5":         "前5日報酬",
    "macd_norm":         "MACD強度",
    "macd_hist_norm":    "MACD柱狀",
    "weekday":           "星期幾",
    "month":             "月份",
    "hl_pct":            "日內振幅",
    # Layer 1: Analyst
    "analyst_bullish_pct":  "分析師樂觀占比",
    "analyst_bearish_pct":  "分析師悲觀占比",
    "analyst_pt_upside":    "目標價上行空間",
    "analyst_upgrade_net":  "評級淨升級",
    "analyst_pt_dispersion":"目標價離散度",
    "pt_change_30d_pct":    "目標價30日變化",
    "pt_revision_count":    "目標價修訂次數",
    # Layer 2: Fundamentals
    "revenue_qoq":          "營收季增率",
    "revenue_yoy":          "營收年增率",
    "gross_margin":         "毛利率",
    "net_margin":           "淨利率",
    "eps_qoq":              "EPS季增率",
    "days_since_earnings":  "距財報天數",
    "days_to_earnings":     "距下次財報天數",
    # Layer 3: Market + Sector
    "fear_greed":           "恐懼貪婪指數",
    "fear_greed_delta_7d":  "恐貪7日變化",
    "vix_level":            "VIX水準",
    "vix_5d_change":        "VIX5日變化",
    "sector_rs_5d":         "板塊5日RS",
    "sector_rs_20d":        "板塊20日RS",
    # Layer 4: News Sentiment
    "news_sentiment_score":   "新聞情緒分",
    "news_bullish_ratio":     "新聞看多比率",
    "news_sentiment_3d_avg":  "情緒3日均值",
    "news_article_count":     "新聞熱度",
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

    # ── Layer 1+2+3 extra features from DB ───────────────────────────────────
    db_path = os.environ.get("DB_PATH", "data.db")
    extra_cache = {}
    for idx, row in df.iterrows():
        d = row["date"]
        if d not in extra_cache:
            try:
                d_obj = pd.Timestamp(d).date() if not isinstance(d, date) else d
                extra_cache[d] = get_extra_features(symbol, market, d_obj, db_path=db_path)
            except Exception:
                extra_cache[d] = {}

    # Merge extra features into DataFrame columns
    extra_keys = [
        "analyst_bullish_pct", "analyst_bearish_pct", "analyst_pt_dispersion",
        "analyst_upgrade_net", "pt_change_30d_pct", "pt_revision_count",
        "revenue_qoq", "revenue_yoy", "gross_margin", "net_margin",
        "eps_qoq", "days_since_earnings", "days_to_earnings",
        "fear_greed", "fear_greed_delta_7d", "vix_level", "vix_5d_change",
        "sector_rs_5d", "sector_rs_20d",
        "news_sentiment_score", "news_bullish_ratio",
        "news_sentiment_3d_avg", "news_article_count",
    ]
    for key in extra_keys:
        df[key] = df["date"].map(lambda d, k=key: extra_cache.get(d, {}).get(k, float("nan")))

    # analyst_pt_upside: (avg_pt / close - 1) — requires close price per row
    def _calc_pt_upside(row):
        extra = extra_cache.get(row["date"], {})
        avg_pt = extra.get("analyst_avg_pt", float("nan"))
        close_price = row["close"]
        if close_price and not math.isnan(avg_pt):
            return avg_pt / close_price - 1
        return float("nan")
    df["analyst_pt_upside"] = df.apply(_calc_pt_upside, axis=1)

    # Base date / price
    last_bar    = df.iloc[-1]
    base_date   = str(last_bar["date"])[:10]
    base_price  = float(last_bar["close"])

    # Feature coverage: check last bar for NaN values in extra features
    _TECHNICAL_FEATURES = {
        "ret_1d","ret_3d","close_pct_5d","close_pct_20d",
        "rsi_14","vol_ratio_20d","atr_14_pct","ma20_dist_pct",
        "ma60_dist_pct","bb_z","lag_ret_1","lag_ret_2",
        "lag_ret_3","lag_ret_5","macd_norm","macd_hist_norm",
        "weekday","month","hl_pct",
    }
    missing_features = [
        c for c in feature_cols
        if c not in _TECHNICAL_FEATURES
        and (
            last_bar.get(c) is None
            or (isinstance(last_bar.get(c), float) and math.isnan(last_bar.get(c)))
            or pd.isna(last_bar.get(c))
        )
    ]
    feature_coverage = {
        "total":     len(feature_cols),
        "available": len(feature_cols) - len(missing_features),
        "missing":   missing_features,
    }

    # OOS split -- time-ordered, no shuffle
    n_total      = len(df)
    oos_size     = max(20, int(n_total * 0.2))
    oos_size     = min(oos_size, n_total - max_horizon - 30)
    if oos_size < 5:
        print(json.dumps({"ok": False, "error": "insufficient history for OOS split"}))
        return
    train_cutoff = n_total - oos_size

    # Seed features (last bar) — HGB handles NaN natively, use nan for missing
    seed_features = [
        float(last_bar.get(c)) if pd.notna(last_bar.get(c)) else float("nan")
        for c in feature_cols
    ]
    X_seed = np.array([seed_features])

    # Future trading dates
    base_date_obj   = date.fromisoformat(base_date)
    all_future      = _next_trading_days(base_date_obj, max_horizon)
    future_date_map = {h: all_future[h - 1] for h in horizons}

    # ---------------------------------------------------------------------------
    # Per-horizon training + walk-forward OOS band
    # Ensemble: HGB (0.45) + LightGBM (0.35, if available) + RandomForest (0.20)
    # upProbability: Platt-scaled via CalibratedClassifierCV on direction labels
    # ---------------------------------------------------------------------------
    horizon_results = {}

    # Ensemble weights
    if HAS_LGB:
        W_HGB, W_LGB, W_RF = 0.45, 0.35, 0.20
    else:
        W_HGB, W_LGB, W_RF = 0.60, 0.00, 0.40

    for h in horizons:
        df_h           = df.copy()
        # Target: h-day cumulative return, labelled at the START bar (no lookahead)
        df_h["target"] = df_h["close"].shift(-h) / df_h["close"] - 1

        train_df = df_h.iloc[:train_cutoff].dropna(subset=["target"])
        if len(train_df) < 30:
            continue

        X_train = train_df[feature_cols].values
        y_train = train_df["target"].values

        # ── Model 1: HistGradientBoosting (handles NaN natively) ──────────────
        hgb = HistGradientBoostingRegressor(
            max_iter=200, learning_rate=0.05, max_depth=4, random_state=42,
        )
        hgb.fit(X_train, y_train)

        # ── Model 2: LightGBM ─────────────────────────────────────────────────
        if HAS_LGB:
            lgb_model = lgb.LGBMRegressor(
                n_estimators=200, learning_rate=0.05, max_depth=4,
                random_state=42, verbosity=-1,
            )
            # LightGBM doesn't handle NaN: fill with 0 for training (HGB is primary)
            X_train_lgb = np.nan_to_num(X_train, nan=0.0)
            lgb_model.fit(X_train_lgb, y_train)

        # ── Model 3: RandomForest ─────────────────────────────────────────────
        rf = RandomForestRegressor(
            n_estimators=100, max_depth=6, random_state=42, n_jobs=-1,
        )
        X_train_rf = np.nan_to_num(X_train, nan=0.0)
        rf.fit(X_train_rf, y_train)

        # ── Ensemble predict helper ───────────────────────────────────────────
        def ensemble_predict(X: np.ndarray) -> np.ndarray:
            X_filled = np.nan_to_num(X, nan=0.0)
            pred_hgb = hgb.predict(X)
            pred_rf  = rf.predict(X_filled)
            if HAS_LGB:
                pred_lgb = lgb_model.predict(X_filled)
                return W_HGB * pred_hgb + W_LGB * pred_lgb + W_RF * pred_rf
            else:
                return W_HGB * pred_hgb + W_RF * pred_rf

        # Walk-forward OOS residuals
        oos_df    = df_h.iloc[train_cutoff : n_total - h].dropna(subset=["target"])
        residuals = np.array([])
        if len(oos_df) >= 5:
            y_pred    = ensemble_predict(oos_df[feature_cols].values)
            y_true    = oos_df["target"].values
            residuals = y_true - y_pred

        # Ensemble prediction on seed (last bar)
        median_return = float(ensemble_predict(X_seed)[0])
        median_price  = round(base_price * (1 + median_return), 4)

        # ── upProbability: Platt scaling via CalibratedClassifierCV ──────────
        # Direction labels: 1 = positive return, 0 = negative
        up_probability = float(median_return > 0)  # default fallback
        if len(train_df) >= 50:
            try:
                y_dir_train = (y_train > 0).astype(int)
                # Need at least some positives and negatives
                if y_dir_train.sum() >= 5 and (1 - y_dir_train).sum() >= 5:
                    from sklearn.ensemble import GradientBoostingClassifier
                    base_clf = GradientBoostingClassifier(
                        n_estimators=100, learning_rate=0.05, max_depth=3, random_state=42
                    )
                    n_cv = min(3, len(train_df) // 20)
                    if n_cv >= 2:
                        cal_clf = CalibratedClassifierCV(base_clf, cv=n_cv, method="sigmoid")
                        cal_clf.fit(X_train_rf, y_dir_train)
                        prob = cal_clf.predict_proba(np.nan_to_num(X_seed, nan=0.0))[0]
                        up_probability = float(prob[1])  # P(up)
            except Exception:
                pass  # keep fallback

        # Band: residual percentiles
        if len(residuals) >= 5:
            p25 = float(np.percentile(residuals, 25))
            p75 = float(np.percentile(residuals, 75))
            lower_price = round(median_price + base_price * p25, 4)
            upper_price = round(median_price + base_price * p75, 4)
        else:
            atr_val     = float(last_bar.get("atr_14_pct") or 0.02) * base_price
            lower_price = round(median_price - atr_val, 4)
            upper_price = round(median_price + atr_val, 4)

        lower_price = min(lower_price, median_price)
        upper_price = max(upper_price, median_price)

        # Feature importance: HGB permutation importance (computed once, h=1)
        if "_global_importances" not in horizon_results:
            try:
                from sklearn.inspection import permutation_importance
                pi_oos = df_h.iloc[train_cutoff : n_total - h].dropna(subset=["target"])
                if len(pi_oos) >= 10:
                    pi = permutation_importance(
                        hgb, pi_oos[feature_cols].values, pi_oos["target"].values,
                        n_repeats=5, random_state=42,
                        scoring="neg_mean_absolute_error",
                    )
                    horizon_results["_global_importances"] = pi.importances_mean.tolist()
                else:
                    raise ValueError("too small")
            except Exception:
                horizon_results["_global_importances"] = [1.0 / len(feature_cols)] * len(feature_cols)

        importances = horizon_results["_global_importances"]
        fi = sorted(
            zip(feature_cols, importances),
            key=lambda x: -x[1]
        )[:5]
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

    # Remove internal key before output
    horizon_results.pop("_global_importances", None)

    if not horizon_results:
        print(json.dumps({"ok": False, "error": "all horizons failed training"}))
        return

    run_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    meta   = {
        "barsUsed":         n_total,
        "trainSize":        train_cutoff,
        "oosSize":          oos_size,
        "modelVersion":     "Ensemble_v1",
        "ensembleWeights":  {"hgb": W_HGB, "lgb": W_LGB if HAS_LGB else 0, "rf": W_RF},
        "hasLightGBM":      HAS_LGB,
        "featuresUsed":     feature_cols,
        "useAnalyst":       use_analyst,
        "featureCoverage":  feature_coverage,
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
