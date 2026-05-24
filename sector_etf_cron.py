#!/usr/bin/env python3
"""
Daily sector ETF price sync cron script.
Reads ngrok URL from GitHub Gist → fetches 1y daily close prices for
12 sector ETFs via finance_historical_prices → POSTs to
/api/internal/historical-prices-sync
"""

import json
import subprocess
import sys
import urllib.request
import urllib.error
from datetime import datetime, timezone

# ── Config ────────────────────────────────────────────────────────────────────
GIST_RAW_URL = (
    "https://gist.githubusercontent.com/ylweng2245/"
    "cecf995babfbfd98b7e3cbd633549e6f/raw/server-config.json"
)
SYNC_SECRET = "9852b0916353d94bbe935965e85afe129b8452bfd31157d0313e2c4184648ab2"

# Fixed domain (ngrok free plan with reserved domain — never changes)
FIXED_SERVER_URL = "https://angling-ashes-punctured.ngrok-free.dev"

# 12 sector ETFs used by features_extra.py SECTOR_MAP
SECTOR_ETFS = [
    "SOXX", "CIBR", "XLU", "URNM", "XLI", "ARKX",
    "ARKQ", "XBI", "SMH", "HACK", "IBB", "SMH",
]
# Deduplicate (SMH appears twice in spec)
SECTOR_ETFS_UNIQUE = [
    "SOXX", "CIBR", "XLU", "URNM", "XLI", "ARKX",
    "ARKQ", "XBI", "SMH", "HACK", "IBB",
    # New: for trend analysis and macro features
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


def parse_md_table(content: str) -> list[dict]:
    """Parse a markdown table into a list of dicts."""
    lines = [l.strip() for l in content.strip().splitlines() if l.strip()]
    table_lines = [l for l in lines if l.startswith("|")]
    if len(table_lines) < 3:
        return []
    headers = [h.strip() for h in table_lines[0].strip("|").split("|")]
    rows = []
    for line in table_lines[2:]:
        vals = [v.strip() for v in line.strip("|").split("|")]
        if len(vals) == len(headers):
            rows.append(dict(zip(headers, vals)))
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


# ── Step 2: Fetch historical prices for an ETF ──────────────────────────────

def fetch_etf_prices(ticker: str) -> list[dict]:
    from datetime import date as _date, timedelta
    end_date = _date.today().isoformat()
    start_date = (_date.today() - timedelta(days=365)).isoformat()

    result = call_tool("finance", "finance_ohlcv_histories", {
        "ticker_symbols": [ticker],
        "query": f"{ticker} historical prices 1 year",
        "start_date_yyyy_mm_dd": start_date,
        "end_date_yyyy_mm_dd": end_date,
        "time_interval": "1day",
        "fields": ["open", "high", "low", "close", "volume"],
    })
    content = result.get("content", "")
    rows = parse_md_table(content)

    prices = []
    for row in rows:
        date_str = (row.get("date") or row.get("Date") or row.get("timestamp") or "")[:10]
        if not date_str or len(date_str) < 10:
            continue
        close = safe_float(row.get("close") or row.get("Close"))
        open_ = safe_float(row.get("open") or row.get("Open"))
        high = safe_float(row.get("high") or row.get("High"))
        low = safe_float(row.get("low") or row.get("Low"))
        volume = safe_float(row.get("volume") or row.get("Volume"))

        if close is None:
            continue

        prices.append({
            "date": date_str,
            "open": open_ or close,
            "high": high or close,
            "low": low or close,
            "close": close,
            "volume": int(volume) if volume else 0,
        })
    return prices


# ── Step 3: POST to server ──────────────────────────────────────────────────

def push_to_server(base_url: str, symbol: str, prices: list[dict]) -> None:
    resp = http_post_json(
        f"{base_url}/api/internal/historical-prices-sync",
        {"symbol": symbol, "market": "US", "prices": prices},
        headers={"X-Sync-Secret": SYNC_SECRET},
    )
    print(f"[sector-etf-cron] {symbol}: server response: {resp}")


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

        print(f"[sector-etf-cron] {etf}: {len(prices)} bars (latest: {prices[0]['date']})")

        try:
            push_to_server(base_url, etf, prices)
            synced += 1
        except Exception as e:
            print(f"[sector-etf-cron] {etf}: push failed: {e}")

    print(f"\n[sector-etf-cron] Done. Synced {synced}/{len(SECTOR_ETFS_UNIQUE)} ETFs.")


if __name__ == "__main__":
    main()
