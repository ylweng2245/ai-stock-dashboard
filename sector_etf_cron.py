#!/usr/bin/env python3
"""
Daily sector ETF price sync cron script.
Reads ngrok URL from GitHub Gist → fetches 1y daily prices for
sector ETFs via finance_ohlcv_histories → POSTs to
/api/internal/historical-prices-sync
"""

import csv
import io
import json
import subprocess
import sys
import urllib.request
import urllib.error
from datetime import datetime, timezone, date, timedelta

# ── Config ────────────────────────────────────────────────────────────────────
GIST_RAW_URL = (
    "https://gist.githubusercontent.com/ylweng2245/"
    "cecf995babfbfd98b7e3cbd633549e6f/raw/server-config.json"
)
SYNC_SECRET = "9852b0916353d94bbe935965e85afe129b8452bfd31157d0313e2c4184648ab2"
FIXED_SERVER_URL = "https://angling-ashes-punctured.ngrok-free.dev"

SECTOR_ETFS_UNIQUE = [
    "SOXX", "CIBR", "XLU", "URNM", "XLI", "ARKX",
    "ARKQ", "XBI", "SMH", "HACK", "IBB",
    # For trend analysis and macro features
    "SPY", "QQQ", "HYG", "LQD", "BIL",
]


# ── HTTP helpers ──────────────────────────────────────────────────────────────

def http_get_json(url: str, headers: dict = None) -> dict:
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())


def http_post_json(url: str, payload, headers: dict = None) -> dict:
    data = json.dumps(payload).encode()
    h = {"Content-Type": "application/json", **(headers or {})}
    req = urllib.request.Request(url, data=data, headers=h, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        raise RuntimeError(f"HTTP {e.code}: {body}") from e


def call_tool(source_id: str, tool_name: str, arguments: dict) -> dict:
    params = json.dumps({
        "source_id": source_id,
        "tool_name": tool_name,
        "arguments": arguments
    })
    result = subprocess.run(
        ["external-tool", "call", params],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        raise RuntimeError(f"external-tool error: {result.stderr}")
    return json.loads(result.stdout)


def now_utc() -> str:
    return datetime.now(timezone.utc).isoformat()


def safe_float(val) -> float | None:
    if val is None:
        return None
    try:
        return float(str(val).replace(",", "").strip())
    except (ValueError, TypeError):
        return None


def download_csv(url: str) -> list[dict]:
    """Download a CSV file from URL and parse it."""
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=30) as resp:
        content = resp.read().decode("utf-8")
    reader = csv.DictReader(io.StringIO(content))
    rows = []
    for row in reader:
        date_str = (row.get("date") or row.get("Date") or "")[:10]
        if not date_str or len(date_str) < 10:
            continue
        close = safe_float(row.get("close") or row.get("Close"))
        if close is None:
            continue
        rows.append({
            "date": date_str,
            "open": safe_float(row.get("open") or row.get("Open")) or close,
            "high": safe_float(row.get("high") or row.get("High")) or close,
            "low": safe_float(row.get("low") or row.get("Low")) or close,
            "close": close,
            "volume": int(safe_float(row.get("volume") or row.get("Volume")) or 0),
        })
    return rows


# ── Step 1: Get ngrok URL from Gist ──────────────────────────────────────────

def get_ngrok_url() -> str:
    try:
        cfg = http_get_json(GIST_RAW_URL)
        override = (cfg.get("ngrok_url") or cfg.get("url") or "").rstrip("/")
        if override and override != FIXED_SERVER_URL:
            print(f"[sector-etf-cron] Using Gist override URL: {override}")
            return override
    except Exception:
        pass
    return FIXED_SERVER_URL


# ── Step 2: Fetch historical prices for an ETF ───────────────────────────────

def fetch_etf_prices(ticker: str) -> list[dict]:
    end_date = date.today().isoformat()
    start_date = (date.today() - timedelta(days=730)).isoformat()  # 2 years

    result = call_tool("finance", "finance_ohlcv_histories", {
        "ticker_symbols": [ticker],
        "query": f"{ticker} historical prices 2 years daily",
        "start_date_yyyy_mm_dd": start_date,
        "end_date_yyyy_mm_dd": end_date,
        "time_interval": "1day",
        "fields": ["open", "high", "low", "close", "volume"],
    })

    # Prefer csv_files (full data) over markdown content (sample only)
    csv_files = result.get("csv_files", [])
    if csv_files:
        csv_url = csv_files[0].get("url", "")
        if csv_url:
            try:
                rows = download_csv(csv_url)
                if rows:
                    return rows
                print(f"[sector-etf-cron] {ticker}: CSV empty, falling back to content parse")
            except Exception as e:
                print(f"[sector-etf-cron] {ticker}: CSV download failed ({e}), falling back")

    # Fallback: parse markdown table from content (sample rows only)
    content = result.get("content", "")
    lines = [l.strip() for l in content.strip().splitlines() if l.strip()]
    table_lines = [l for l in lines if l.startswith("|")]
    if len(table_lines) < 3:
        return []
    headers = [h.strip() for h in table_lines[0].strip("|").split("|")]
    rows = []
    for line in table_lines[2:]:
        vals = [v.strip() for v in line.strip("|").split("|")]
        if len(vals) != len(headers):
            continue
        row = dict(zip(headers, vals))
        date_str = (row.get("date") or row.get("Date") or "")[:10]
        if not date_str or len(date_str) < 10:
            continue
        close = safe_float(row.get("close") or row.get("Close"))
        if close is None:
            continue
        rows.append({
            "date": date_str,
            "open": safe_float(row.get("open") or row.get("Open")) or close,
            "high": safe_float(row.get("high") or row.get("High")) or close,
            "low": safe_float(row.get("low") or row.get("Low")) or close,
            "close": close,
            "volume": int(safe_float(row.get("volume") or row.get("Volume")) or 0),
        })
    return rows


# ── Step 3: POST to server ────────────────────────────────────────────────────

def push_to_server(base_url: str, symbol: str, prices: list[dict]) -> None:
    resp = http_post_json(
        f"{base_url}/api/internal/historical-prices-sync",
        {"symbol": symbol, "market": "US", "prices": prices},
        headers={"X-Sync-Secret": SYNC_SECRET},
    )
    print(f"[sector-etf-cron] {symbol}: server response: {resp}")


def push_indicator_to_server(base_url: str, indicator_key: str, rows: list[dict]) -> None:
    """Push time-series rows to /api/internal/market-indicator-sync."""
    resp = http_post_json(
        f"{base_url}/api/internal/market-indicator-sync",
        {"indicatorKey": indicator_key, "market": "US", "rows": rows},
        headers={"X-Sync-Secret": SYNC_SECRET},
    )
    print(f"[sector-etf-cron] indicator {indicator_key}: server response: {resp}")


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    print(f"[sector-etf-cron] Starting sector ETF sync at {now_utc()}\n")

    try:
        base_url = get_ngrok_url()
    except Exception as e:
        print(f"[sector-etf-cron] FATAL: {e}")
        sys.exit(1)

    synced = 0
    for etf in SECTOR_ETFS_UNIQUE:
        print(f"\n[sector-etf-cron] === {etf} ===")

        try:
            prices = fetch_etf_prices(etf)
        except Exception as e:
            print(f"[sector-etf-cron] {etf}: fetch failed: {e}")
            continue

        if not prices:
            print(f"[sector-etf-cron] {etf}: no price data, skipping")
            continue

        latest = sorted(prices, key=lambda x: x["date"])[-1]["date"]
        print(f"[sector-etf-cron] {etf}: {len(prices)} bars (latest: {latest})")

        try:
            push_to_server(base_url, etf, prices)
            synced += 1
        except Exception as e:
            print(f"[sector-etf-cron] {etf}: push failed: {e}")

    # ── Sync market indicators (10y_yield via ^TNX) ───────────────────────
    ind_synced = 0
    for ind_key, ticker in INDICATOR_TICKERS.items():
        print(f"\n[sector-etf-cron] === indicator: {ind_key} ({ticker}) ===")
        try:
            prices = fetch_etf_prices(ticker)
        except Exception as e:
            print(f"[sector-etf-cron] {ticker}: fetch failed: {e}")
            continue
        if not prices:
            print(f"[sector-etf-cron] {ticker}: no data, skipping")
            continue
        # ^TNX close is already in percent (e.g. 4.35 = 4.35%)
        rows = [{"date": p["date"], "value": p["close"]} for p in prices]
        latest = sorted(rows, key=lambda x: x["date"])[-1]["date"]
        print(f"[sector-etf-cron] {ticker}: {len(rows)} bars (latest: {latest})")
        try:
            push_indicator_to_server(base_url, ind_key, rows)
            ind_synced += 1
        except Exception as e:
            print(f"[sector-etf-cron] indicator {ind_key}: push failed: {e}")

    print(f"\n[sector-etf-cron] Done. Synced {synced}/{len(SECTOR_ETFS_UNIQUE)} ETFs, {ind_synced}/{len(INDICATOR_TICKERS)} indicators.")


if __name__ == "__main__":
    main()
