#!/usr/bin/env python3
"""
Daily Alpha Vantage news sentiment sync cron.
For each US stock in watchlist:
  - Calls AV NEWS_SENTIMENT for today's articles (or a specific date if AV_DATE env is set)
  - Computes weighted sentiment score, bullish ratio, article count
  - POSTs to /api/internal/news-sentiment-sync
"""

import json
import os
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone, timedelta, date

# ── Config ────────────────────────────────────────────────────────────────────
GIST_RAW_URL = (
    "https://gist.githubusercontent.com/ylweng2245/"
    "cecf995babfbfd98b7e3cbd633549e6f/raw/server-config.json"
)
SYNC_SECRET = "9852b0916353d94bbe935965e85afe129b8452bfd31157d0313e2c4184648ab2"
FIXED_SERVER_URL = "https://angling-ashes-punctured.ngrok-free.dev"
AV_API_KEY = "5XD9CYTYVEU5CFG3"
AV_BASE_URL = "https://www.alphavantage.co/query"


# ── Helpers ───────────────────────────────────────────────────────────────────

def http_get_json(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=20) as resp:
        return json.loads(resp.read())


def http_post_json(url: str, payload, headers: dict = None) -> dict:
    data = json.dumps(payload).encode()
    h = {"Content-Type": "application/json", **(headers or {})}
    req = urllib.request.Request(url, data=data, headers=h, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        raise RuntimeError(f"HTTP {e.code}: {body}") from e


def get_ngrok_url() -> str:
    try:
        cfg = http_get_json(GIST_RAW_URL)
        override = (cfg.get("ngrok_url") or cfg.get("url") or "").rstrip("/")
        if override and override != FIXED_SERVER_URL:
            return override
    except Exception:
        pass
    return FIXED_SERVER_URL


def get_watchlist(base_url: str) -> list:
    data = http_get_json(f"{base_url}/api/watchlist?market=US")
    if not isinstance(data, list):
        raise RuntimeError(f"Unexpected watchlist response")
    return [w for w in data if (w.get("market") or "US") == "US"]


def fetch_av_sentiment(ticker: str, target_date: date) -> dict | None:
    """
    Returns { sentiment_score, bullish_ratio, article_count } for ticker on target_date.
    sentiment_score = relevance-weighted average of ticker_sentiment_score
    bullish_ratio = fraction of articles with ticker_sentiment_label in (Somewhat_Bullish, Bullish)
    article_count = number of articles mentioning the ticker on that day
    """
    date_str = target_date.strftime("%Y%m%d")
    url = (
        f"{AV_BASE_URL}?function=NEWS_SENTIMENT"
        f"&tickers={ticker}"
        f"&limit=50"
        f"&time_from={date_str}T0000"
        f"&time_to={date_str}T2359"
        f"&apikey={AV_API_KEY}"
    )
    try:
        data = http_get_json(url)
    except Exception as e:
        print(f"  [{ticker}] AV fetch error: {e}")
        return None

    # Check for rate limit message
    if "Note" in data or "Information" in data:
        msg = data.get("Note") or data.get("Information", "")
        print(f"  [{ticker}] AV warning: {msg[:120]}")
        return None

    feed = data.get("feed", [])
    if not feed:
        # No articles that day — return zero-count record
        return {"sentiment_score": None, "bullish_ratio": None, "article_count": 0}

    scores = []
    weights = []
    bullish_labels = {"Somewhat_Bullish", "Bullish"}

    bullish_count = 0
    total_ticker_articles = 0

    for article in feed:
        for ts in article.get("ticker_sentiment", []):
            if ts.get("ticker") != ticker:
                continue
            try:
                score = float(ts["ticker_sentiment_score"])
                relevance = float(ts["relevance_score"])
                label = ts.get("ticker_sentiment_label", "")
                scores.append(score)
                weights.append(relevance)
                if label in bullish_labels:
                    bullish_count += 1
                total_ticker_articles += 1
            except (KeyError, ValueError):
                continue

    if total_ticker_articles == 0:
        return {"sentiment_score": None, "bullish_ratio": None, "article_count": 0}

    # Weighted average sentiment score
    total_weight = sum(weights)
    if total_weight > 0:
        weighted_score = sum(s * w for s, w in zip(scores, weights)) / total_weight
    else:
        weighted_score = sum(scores) / len(scores)

    bullish_ratio = bullish_count / total_ticker_articles

    return {
        "sentiment_score": round(weighted_score, 6),
        "bullish_ratio": round(bullish_ratio, 4),
        "article_count": total_ticker_articles,
    }


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    # Allow override via env (for backfill): AV_DATE=2026-04-15
    av_date_str = os.environ.get("AV_DATE", "")
    if av_date_str:
        try:
            target_date = date.fromisoformat(av_date_str)
        except ValueError:
            print(f"[news-sentiment-cron] Bad AV_DATE: {av_date_str}")
            sys.exit(1)
    else:
        # Default: yesterday in US market time (UTC-5 approx)
        # Run after market close Taipei time (13:00 UTC) = same trading day
        target_date = datetime.now(timezone.utc).date()

    print(f"[news-sentiment-cron] Target date: {target_date}")

    try:
        base_url = get_ngrok_url()
    except Exception as e:
        print(f"[news-sentiment-cron] FATAL ngrok: {e}")
        sys.exit(1)

    try:
        watchlist = get_watchlist(base_url)
    except Exception as e:
        print(f"[news-sentiment-cron] FATAL watchlist: {e}")
        sys.exit(0)

    if not watchlist:
        print("[news-sentiment-cron] Watchlist empty.")
        sys.exit(0)

    all_rows = []
    for i, item in enumerate(watchlist):
        symbol = (item.get("symbol") or "").strip().upper()
        if not symbol:
            continue

        # AV free tier: 25 calls/day, ~1 req/sec sustained → add delay between calls
        if i > 0:
            time.sleep(13)  # ~4-5 calls/min, well within 25/day

        print(f"\n[news-sentiment-cron] {symbol}...", end=" ", flush=True)
        result = fetch_av_sentiment(symbol, target_date)

        if result is None:
            print("SKIP (fetch failed)")
            continue

        print(f"score={result['sentiment_score']} bullish={result['bullish_ratio']} n={result['article_count']}")
        # Only store rows with actual articles (article_count=0 = no news that day, skip)
        if result.get("article_count", 0) > 0:
            all_rows.append({
                "symbol": symbol,
                "market": "US",
                "date": target_date.isoformat(),
                **result,
            })

    if not all_rows:
        print("\n[news-sentiment-cron] No rows to push.")
        sys.exit(0)

    try:
        resp = http_post_json(
            f"{base_url}/api/internal/news-sentiment-sync",
            all_rows,
            headers={"X-Sync-Secret": SYNC_SECRET},
        )
        print(f"\n[news-sentiment-cron] Done. Server synced: {resp}")
    except Exception as e:
        print(f"\n[news-sentiment-cron] Push failed: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
