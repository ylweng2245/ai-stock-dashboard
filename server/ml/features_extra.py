# features_extra.py
# Reads analyst, fundamentals, and market indicator features from DB
# Returns a dict of extra features for a given symbol and as-of date

import sqlite3
import json
import os
import math
from datetime import datetime, date, timedelta

DB_PATH = os.environ.get("DB_PATH", "data.db")

def get_extra_features(symbol: str, market: str, as_of_date: date, db_path: str = DB_PATH) -> dict:
    """
    Returns dict of extra features for symbol on as_of_date.
    All values are floats or NaN if not available.
    Never raises — returns NaN for anything missing.
    """
    result = {}

    try:
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row

        # === Layer 1: Analyst Consensus Features ===
        # From analyst_targets table — get rows within last 4 months for this symbol
        cutoff = (as_of_date - timedelta(days=120)).isoformat()
        rows = conn.execute("""
            SELECT rating_category, target_price, analyst_date
            FROM analyst_targets
            WHERE symbol=? AND market=?
              AND analyst_date <= ?
              AND analyst_date >= ?
            ORDER BY analyst_date DESC
        """, (symbol, market, as_of_date.isoformat(), cutoff)).fetchall()

        if rows:
            bullish = sum(1 for r in rows if r["rating_category"] == "Bullish")
            bearish = sum(1 for r in rows if r["rating_category"] == "Bearish")
            total = len(rows)
            analyst_bullish_pct = bullish / total if total > 0 else float("nan")
            analyst_bearish_pct = bearish / total if total > 0 else float("nan")

            pts = [r["target_price"] for r in rows if r["target_price"] is not None]
            analyst_avg_pt = sum(pts) / len(pts) if pts else float("nan")
            analyst_pt_dispersion = (max(pts) - min(pts)) / (sum(pts)/len(pts)) if len(pts) >= 2 else float("nan")
        else:
            analyst_bullish_pct = float("nan")
            analyst_bearish_pct = float("nan")
            analyst_avg_pt = float("nan")
            analyst_pt_dispersion = float("nan")

        result["analyst_bullish_pct"] = analyst_bullish_pct
        result["analyst_bearish_pct"] = analyst_bearish_pct
        result["analyst_avg_pt"] = analyst_avg_pt
        result["analyst_pt_dispersion"] = analyst_pt_dispersion

        # analyst_pt_upside: (avg_pt - current_price) / current_price — needs current price
        # This will be filled in predict.py using the last known close price

        # analyst_upgrade_net: (upgrades - downgrades) in last 30d / total
        cutoff_30 = (as_of_date - timedelta(days=30)).isoformat()
        recent_rows = conn.execute("""
            SELECT rating_category
            FROM analyst_targets
            WHERE symbol=? AND market=?
              AND analyst_date <= ?
              AND analyst_date >= ?
        """, (symbol, market, as_of_date.isoformat(), cutoff_30)).fetchall()

        if recent_rows:
            upgrades = sum(1 for r in recent_rows if r["rating_category"] == "Bullish")
            downgrades = sum(1 for r in recent_rows if r["rating_category"] == "Bearish")
            n = len(recent_rows)
            result["analyst_upgrade_net"] = (upgrades - downgrades) / n
        else:
            result["analyst_upgrade_net"] = float("nan")

        # pt_change_30d_pct: % change in avg PT vs 30 days ago
        old_rows = conn.execute("""
            SELECT target_price FROM analyst_targets
            WHERE symbol=? AND market=?
              AND analyst_date <= ?
              AND analyst_date >= ?
        """, (symbol, market, cutoff_30, (as_of_date - timedelta(days=60)).isoformat())).fetchall()

        old_pts = [r["target_price"] for r in old_rows if r["target_price"] is not None]
        if old_pts and pts:
            old_avg = sum(old_pts) / len(old_pts)
            result["pt_change_30d_pct"] = (analyst_avg_pt - old_avg) / old_avg if old_avg != 0 else float("nan")
        else:
            result["pt_change_30d_pct"] = float("nan")

        # pt_revision_count: count of analyst updates in last 30 days
        result["pt_revision_count"] = float(len(recent_rows)) if recent_rows else float("nan")

        # === Layer 2: Fundamentals Features ===
        fund_row = conn.execute("""
            SELECT quarterly_income_json, eps_history_json
            FROM fundamental_data
            WHERE symbol=? AND market=?
            ORDER BY fetched_at DESC LIMIT 1
        """, (symbol, market)).fetchone()

        if fund_row:
            try:
                income_data = json.loads(fund_row["quarterly_income_json"] or "[]")
                eps_data = json.loads(fund_row["eps_history_json"] or "[]")

                # income_data: list of quarters sorted newest first (from existing fundamentals cron)
                # Each entry expected to have: date, revenue, gross_profit, net_income
                if len(income_data) >= 2:
                    q0 = income_data[0]
                    q1 = income_data[1]
                    q4 = income_data[4] if len(income_data) > 4 else None

                    rev0 = q0.get("revenue") or q0.get("totalRevenue")
                    rev1 = q1.get("revenue") or q1.get("totalRevenue")
                    rev4 = q4.get("revenue") or q4.get("totalRevenue") if q4 else None

                    result["revenue_qoq"] = (rev0 - rev1) / abs(rev1) if rev1 and rev0 else float("nan")
                    result["revenue_yoy"] = (rev0 - rev4) / abs(rev4) if rev4 and rev0 else float("nan")

                    gp0 = q0.get("grossProfit") or q0.get("gross_profit")
                    result["gross_margin"] = gp0 / rev0 if gp0 and rev0 else float("nan")

                    ni0 = q0.get("netIncome") or q0.get("net_income")
                    result["net_margin"] = ni0 / rev0 if ni0 and rev0 else float("nan")
                else:
                    result["revenue_qoq"] = float("nan")
                    result["revenue_yoy"] = float("nan")
                    result["gross_margin"] = float("nan")
                    result["net_margin"] = float("nan")

                # EPS QoQ
                if len(eps_data) >= 2:
                    eps0 = eps_data[0].get("epsActual") or eps_data[0].get("eps")
                    eps1 = eps_data[1].get("epsActual") or eps_data[1].get("eps")
                    result["eps_qoq"] = (eps0 - eps1) / abs(eps1) if eps0 is not None and eps1 else float("nan")
                else:
                    result["eps_qoq"] = float("nan")

                # days_since_earnings: days since most recent actual EPS report date
                # days_to_earnings: days until next expected earnings (estimated as ~91 days after last report)
                if eps_data:
                    last_date_str = eps_data[0].get("date") or eps_data[0].get("reportDate") or eps_data[0].get("period")
                    if last_date_str:
                        try:
                            last_date = datetime.strptime(last_date_str[:10], "%Y-%m-%d").date()
                            result["days_since_earnings"] = float((as_of_date - last_date).days)
                            # Estimate next earnings ~91 days (1 quarter) after last report
                            next_earnings = last_date + timedelta(days=91)
                            result["days_to_earnings"] = float((next_earnings - as_of_date).days)
                        except:
                            result["days_since_earnings"] = float("nan")
                            result["days_to_earnings"] = float("nan")
                    else:
                        result["days_since_earnings"] = float("nan")
                        result["days_to_earnings"] = float("nan")
                else:
                    result["days_since_earnings"] = float("nan")
                    result["days_to_earnings"] = float("nan")
            except Exception:
                for k in ["revenue_qoq", "revenue_yoy", "gross_margin", "net_margin", "eps_qoq", "days_since_earnings", "days_to_earnings"]:
                    result[k] = float("nan")
        else:
            for k in ["revenue_qoq", "revenue_yoy", "gross_margin", "net_margin", "eps_qoq", "days_since_earnings", "days_to_earnings"]:
                result[k] = float("nan")

        # === Layer 3a: Market Sentiment (from market_indicators table) ===
        fg_row = conn.execute("""
            SELECT value FROM market_indicators
            WHERE indicator_key='fear_greed' AND date <= ?
            ORDER BY date DESC LIMIT 1
        """, (as_of_date.isoformat(),)).fetchone()
        result["fear_greed"] = float(fg_row["value"]) if fg_row else float("nan")

        fg_7d_row = conn.execute("""
            SELECT value FROM market_indicators
            WHERE indicator_key='fear_greed' AND date <= ?
            ORDER BY date DESC LIMIT 1
        """, ((as_of_date - timedelta(days=7)).isoformat(),)).fetchone()

        if fg_row and fg_7d_row:
            result["fear_greed_delta_7d"] = float(fg_row["value"]) - float(fg_7d_row["value"])
        else:
            result["fear_greed_delta_7d"] = float("nan")

        vix_row = conn.execute("""
            SELECT value FROM market_indicators
            WHERE indicator_key='vix' AND date <= ?
            ORDER BY date DESC LIMIT 1
        """, (as_of_date.isoformat(),)).fetchone()
        result["vix_level"] = float(vix_row["value"]) if vix_row else float("nan")

        vix_5d_row = conn.execute("""
            SELECT value FROM market_indicators
            WHERE indicator_key='vix' AND date <= ?
            ORDER BY date DESC LIMIT 1
        """, ((as_of_date - timedelta(days=5)).isoformat(),)).fetchone()

        if vix_row and vix_5d_row:
            result["vix_5d_change"] = float(vix_row["value"]) - float(vix_5d_row["value"])
        else:
            result["vix_5d_change"] = float("nan")

        # === Layer 3b: Sector RS (from historical_prices table) ===
        # Get sector ETF for this symbol
        SECTOR_MAP = {
            "AMD": "SOXX", "INTC": "SOXX",
            "PANW": "CIBR", "CRWD": "CIBR",
            "VST": "XLU", "CEG": "XLU", "OKLO": "URNM", "BE": "XLU",
            "VRT": "XLI", "ETN": "XLI",
            "RKLB": "ARKX", "ASTS": "ARKX", "IONQ": "ARKQ", "QBTS": "ARKQ",
            "LLY": "XBI", "TEM": "XBI", "NTLA": "XBI",
            "LITE": "SMH",
        }
        sector_etf = SECTOR_MAP.get(symbol.upper())

        if sector_etf:
            # Get symbol close prices
            sym_prices = conn.execute("""
                SELECT date, close FROM historical_prices
                WHERE symbol=? AND market='US' AND date <= ?
                ORDER BY date DESC LIMIT 25
            """, (symbol, as_of_date.isoformat())).fetchall()

            # Get sector ETF close prices
            etf_prices = conn.execute("""
                SELECT date, close FROM historical_prices
                WHERE symbol=? AND market='US' AND date <= ?
                ORDER BY date DESC LIMIT 25
            """, (sector_etf, as_of_date.isoformat())).fetchall()

            if len(sym_prices) >= 6 and len(etf_prices) >= 6:
                sym_5d = sym_prices[0]["close"] / sym_prices[5]["close"] - 1 if sym_prices[5]["close"] else float("nan")
                etf_5d = etf_prices[0]["close"] / etf_prices[5]["close"] - 1 if etf_prices[5]["close"] else float("nan")
                result["sector_rs_5d"] = sym_5d - etf_5d if not math.isnan(sym_5d) and not math.isnan(etf_5d) else float("nan")
            else:
                result["sector_rs_5d"] = float("nan")

            if len(sym_prices) >= 21 and len(etf_prices) >= 21:
                sym_20d = sym_prices[0]["close"] / sym_prices[20]["close"] - 1 if sym_prices[20]["close"] else float("nan")
                etf_20d = etf_prices[0]["close"] / etf_prices[20]["close"] - 1 if etf_prices[20]["close"] else float("nan")
                result["sector_rs_20d"] = sym_20d - etf_20d if not math.isnan(sym_20d) and not math.isnan(etf_20d) else float("nan")
            else:
                result["sector_rs_20d"] = float("nan")
        else:
            result["sector_rs_5d"] = float("nan")
            result["sector_rs_20d"] = float("nan")

        # === Layer 4: News Sentiment (from finance digest, server-scored) ===
        # Use a 7-day lookback window so weekend/non-trading-day digests are included.
        # News sentiment is updated daily regardless of trading calendar.
        lookback_start = (as_of_date - timedelta(days=7)).isoformat()
        sent_rows = conn.execute("""
            SELECT date, sentiment_score, bullish_ratio, article_count
            FROM news_sentiment
            WHERE symbol=? AND market=?
              AND date >= ? AND date <= ?
            ORDER BY date DESC LIMIT 5
        """, (symbol, market, lookback_start, as_of_date.isoformat())).fetchall()

        # If no rows within 7d before as_of_date, try up to 3 days after (weekend update case)
        if not sent_rows:
            lookahead_end = (as_of_date + timedelta(days=3)).isoformat()
            sent_rows = conn.execute("""
                SELECT date, sentiment_score, bullish_ratio, article_count
                FROM news_sentiment
                WHERE symbol=? AND market=?
                  AND date <= ?
                ORDER BY date DESC LIMIT 5
            """, (symbol, market, lookahead_end)).fetchall()

        if sent_rows and sent_rows[0]["sentiment_score"] is not None:
            # Most recent day score
            result["news_sentiment_score"] = float(sent_rows[0]["sentiment_score"])
            result["news_bullish_ratio"] = float(sent_rows[0]["bullish_ratio"]) if sent_rows[0]["bullish_ratio"] is not None else float("nan")
            result["news_article_count"] = float(sent_rows[0]["article_count"]) if sent_rows[0]["article_count"] else float("nan")

            # 3-day rolling average sentiment
            recent_scores = [float(r["sentiment_score"]) for r in sent_rows[:3] if r["sentiment_score"] is not None]
            result["news_sentiment_3d_avg"] = sum(recent_scores) / len(recent_scores) if recent_scores else float("nan")
        else:
            result["news_sentiment_score"] = float("nan")
            result["news_bullish_ratio"] = float("nan")
            result["news_article_count"] = float("nan")
            result["news_sentiment_3d_avg"] = float("nan")

        conn.close()
    except Exception as e:
        # Never crash predict.py — log error to stderr for debugging
        import sys, traceback
        print(f"[features_extra] ERROR for {symbol}/{market}: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)

    return result
