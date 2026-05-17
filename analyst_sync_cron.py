#!/usr/bin/env python3
"""
Daily analyst research sync cron script.
Reads ngrok URL from GitHub Gist → fetches US watchlist → calls
finance_analyst_research per symbol → POSTs to /api/internal/analyst-sync
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

# Rating string → category mapping (same logic as server-side normalizeAnalystRating)
BULLISH_RATINGS = {
    "buy", "strong buy", "overweight", "outperform",
    "accumulate", "sector outperform", "positive",
}
BEARISH_RATINGS = {
    "sell", "underweight", "underperform",
    "reduce", "negative",
}


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
        with urllib.request.urlopen(req, timeout=30) as resp:
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


def categorize_rating(rating_str: str) -> str:
    lower = rating_str.lower().strip()
    if lower in BULLISH_RATINGS:
        return "Bullish"
    if lower in BEARISH_RATINGS:
        return "Bearish"
    return "Neutral"


def safe_float(val) -> float | None:
    if val is None:
        return None
    try:
        return float(str(val).replace(",", "").replace("$", "").strip())
    except (ValueError, TypeError):
        return None


def parse_md_table(content: str) -> list[dict]:
    """Parse the analyst ratings table (the one with 'firm' column) from markdown."""
    lines = [l.strip() for l in content.strip().splitlines() if l.strip()]
    table_lines = [l for l in lines if l.startswith("|")]
    if len(table_lines) < 3:
        return []

    # Find the table that contains analyst ratings (has 'firm' column)
    header_idx = None
    for i, line in enumerate(table_lines):
        cols = [h.strip().lower() for h in line.strip("|").split("|")]
        if "firm" in cols and "date" in cols:
            header_idx = i
            break

    if header_idx is None:
        return []

    headers = [h.strip() for h in table_lines[header_idx].strip("|").split("|")]
    rows = []
    # Skip header + separator line
    for line in table_lines[header_idx + 2:]:
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
            print(f"[analyst-cron] Using Gist override URL: {override}")
            return override
    except Exception:
        pass
    return FIXED_SERVER_URL


# ── Step 2: Get US watchlist ─────────────────────────────────────────────────

def get_watchlist(base_url: str) -> list[dict]:
    data = http_get_json(f"{base_url}/api/watchlist?market=US")
    if not isinstance(data, list):
        # Watchlist endpoint may return all markets; filter to US
        raise RuntimeError(f"Unexpected watchlist response: {data}")
    us_items = [w for w in data if (w.get("market") or "US") == "US"]
    print(f"[analyst-cron] {len(us_items)} US symbols: {[w['symbol'] for w in us_items]}")
    return us_items


# ── Step 3: Fetch analyst research ──────────────────────────────────────────

def fetch_analyst_research(ticker: str) -> list[dict]:
    result = call_tool("finance", "finance_analyst_research", {
        "ticker": ticker,
        "period": "3m",
    })
    content = result.get("content", "")
    rows = parse_md_table(content)
    return rows


# ── Step 4: Transform rows to POST body ─────────────────────────────────────

def transform_analyst_rows(symbol: str, raw_rows: list[dict]) -> list[dict]:
    """Convert raw finance_analyst_research rows to analyst-sync POST body format."""
    result = []
    for row in raw_rows:
        rating_current = row.get("rating_current") or row.get("rating") or ""
        # sentiment field from finance_analyst_research = 'bullish'/'neutral'/'bearish'
        raw_sentiment = row.get("sentiment", "").strip().lower()
        if raw_sentiment == "bullish":
            category = "Bullish"
        elif raw_sentiment == "bearish":
            category = "Bearish"
        else:
            category = categorize_rating(rating_current)  # fallback
        target_price = safe_float(row.get("price_target_current") or row.get("target_price"))
        prev_target = safe_float(row.get("price_target_prior") or row.get("previous_target"))
        analyst_date = (row.get("date") or "")[:10]
        institution = row.get("firm") or row.get("institution") or ""

        if not institution or not analyst_date:
            continue

        result.append({
            "symbol": symbol,
            "market": "US",
            "institution": institution,
            "rating": rating_current,
            "rating_category": category,
            "score": None,
            "target_price": target_price,
            "previous_target_price": prev_target,
            "analyst_date": analyst_date,
            "source_sheet": "auto-sync",
        })
    return result


# ── Step 5: POST to server ──────────────────────────────────────────────────

def push_to_server(base_url: str, payload: list[dict]) -> None:
    print(f"\n[analyst-cron] Pushing {len(payload)} analyst rows to server...")
    resp = http_post_json(
        f"{base_url}/api/internal/analyst-sync",
        payload,
        headers={"X-Sync-Secret": SYNC_SECRET},
    )
    print(f"[analyst-cron] Server response: {resp}")


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    print(f"[analyst-cron] Starting analyst sync at {now_utc()}\n")

    try:
        base_url = get_ngrok_url()
    except Exception as e:
        print(f"[analyst-cron] FATAL: {e}")
        sys.exit(1)

    try:
        watchlist = get_watchlist(base_url)
    except Exception as e:
        print(f"[analyst-cron] FATAL: watchlist fetch failed: {e}")
        sys.exit(1)

    if not watchlist:
        print("[analyst-cron] Watchlist empty.")
        sys.exit(0)

    all_rows = []
    for item in watchlist:
        symbol = (item.get("symbol") or "").strip().upper()
        if not symbol:
            continue

        print(f"\n[analyst-cron] === {symbol} ===")

        try:
            raw_rows = fetch_analyst_research(symbol)
        except Exception as e:
            print(f"[analyst-cron] {symbol}: fetch failed: {e}")
            continue

        if not raw_rows:
            print(f"[analyst-cron] {symbol}: no analyst data, skipping")
            continue

        transformed = transform_analyst_rows(symbol, raw_rows)
        print(f"[analyst-cron] {symbol}: {len(transformed)} analyst rows")
        all_rows.extend(transformed)

    if not all_rows:
        print("\n[analyst-cron] No data to push.")
        sys.exit(0)

    try:
        push_to_server(base_url, all_rows)
        print(f"\n[analyst-cron] Done. Synced {len(all_rows)} rows for {len(watchlist)} symbols.")
    except Exception as e:
        print(f"[analyst-cron] ERROR pushing: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
