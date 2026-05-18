#!/usr/bin/env python3
"""
Daily fundamentals sync cron script.
Reads ngrok URL from GitHub Gist → fetches watchlist → calls
finance_company_financials per symbol → POSTs to /api/internal/fundamentals-sync

Schedule: run daily at UTC 13:30 (CST 21:30) — after US market close.
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
FIXED_SERVER_URL = "https://angling-ashes-punctured.ngrok-free.dev"

# Symbols that don't have meaningful quarterly financials (ETFs, bonds, etc.)
SKIP_SYMBOLS = {"00981A", "00988A", "00403A", "00830", "00719B"}

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


# ── Step 1: Get ngrok URL ─────────────────────────────────────────────────────

def get_ngrok_url() -> str:
    try:
        cfg = http_get_json(GIST_RAW_URL)
        override = (cfg.get("ngrok_url") or cfg.get("url") or "").rstrip("/")
        if override and override != FIXED_SERVER_URL:
            print(f"[fundamentals-cron] Using Gist override URL: {override}")
            return override
    except Exception:
        pass
    return FIXED_SERVER_URL


# ── Step 2: Get watchlist ─────────────────────────────────────────────────────

def get_watchlist(base_url: str) -> list[dict]:
    data = http_get_json(f"{base_url}/api/watchlist")
    if not isinstance(data, list):
        raise RuntimeError(f"Unexpected watchlist response: {data}")
    items = [w for w in data if w.get("market") in ("US", "TW")]
    print(f"[fundamentals-cron] {len(items)} symbols: {[w['symbol'] for w in items]}")
    return items


# ── Step 3: Fetch financials via finance connector ────────────────────────────

def safe_float(val) -> float | None:
    if val is None:
        return None
    try:
        return float(str(val).replace(",", "").replace("%", "").strip())
    except (ValueError, TypeError):
        return None


def parse_financials(content: str) -> tuple[list[dict], list[dict]]:
    """
    Parse finance_company_financials markdown content.
    Returns (quarterlyIncome, epsHistory) in the format expected by
    POST /api/internal/fundamentals-sync → storage.updateCronData()
    """
    quarterly_income = []
    eps_history = []

    lines = content.splitlines()
    current_table = None
    headers = []

    for line in lines:
        line = line.strip()
        if not line:
            current_table = None
            headers = []
            continue

        # Detect table section by nearby heading
        lower = line.lower()
        if "quarterly" in lower and "income" in lower:
            current_table = "quarterly_income"
            continue
        if "eps" in lower and ("history" in lower or "quarterly" in lower):
            current_table = "eps"
            continue

        if line.startswith("|"):
            cols = [c.strip() for c in line.strip("|").split("|")]
            if not headers:
                headers = [h.lower().replace(" ", "_") for h in cols]
                continue
            if set(cols) == {"-", "---", "--", "----"} or all(c.replace("-", "") == "" for c in cols):
                continue
            if len(cols) != len(headers):
                continue

            row = dict(zip(headers, cols))

            if current_table == "quarterly_income":
                quarterly_income.append({
                    "quarter": row.get("quarter") or row.get("period") or "",
                    "revenue": safe_float(row.get("revenue") or row.get("total_revenue")),
                    "grossProfit": safe_float(row.get("gross_profit") or row.get("gross_income")),
                    "operatingIncome": safe_float(row.get("operating_income") or row.get("ebit")),
                    "netIncome": safe_float(row.get("net_income")),
                    "eps": safe_float(row.get("eps") or row.get("diluted_eps")),
                    "grossMargin": safe_float(row.get("gross_margin")),
                    "operatingMargin": safe_float(row.get("operating_margin")),
                    "netMargin": safe_float(row.get("net_margin")),
                })
            elif current_table == "eps":
                eps_history.append({
                    "date": row.get("date") or row.get("period") or row.get("quarter") or "",
                    "eps": safe_float(row.get("eps") or row.get("actual_eps") or row.get("reported_eps")),
                    "epsEstimate": safe_float(row.get("estimate") or row.get("eps_estimate")),
                    "surprise": safe_float(row.get("surprise") or row.get("eps_surprise")),
                    "surprisePct": safe_float(row.get("surprise_pct") or row.get("surprise_%")),
                })

    return quarterly_income, eps_history


def fetch_fundamentals(symbol: str) -> tuple[list[dict], list[dict]]:
    result = call_tool("finance", "finance_company_financials", {
        "ticker": symbol,
        "period": "quarterly",
        "limit": 12,
    })
    content = result.get("content", "")
    if not content:
        raise RuntimeError("Empty response from finance_company_financials")
    return parse_financials(content)


# ── Step 4: POST to server ────────────────────────────────────────────────────

def push_to_server(base_url: str, items: list[dict]) -> dict:
    resp = http_post_json(
        f"{base_url}/api/internal/fundamentals-sync",
        items,
        headers={"X-Sync-Secret": SYNC_SECRET},
    )
    return resp


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    print(f"[fundamentals-cron] Starting at {now_utc()}\n")

    try:
        base_url = get_ngrok_url()
    except Exception as e:
        print(f"[fundamentals-cron] FATAL: cannot get server URL: {e}")
        sys.exit(1)

    # Check server is reachable
    try:
        http_get_json(f"{base_url}/api/health")
    except Exception:
        print(f"[fundamentals-cron] Server unreachable at {base_url}, exiting silently.")
        sys.exit(0)

    try:
        watchlist = get_watchlist(base_url)
    except Exception as e:
        print(f"[fundamentals-cron] FATAL: watchlist fetch failed: {e}")
        sys.exit(1)

    payload = []
    skipped = []

    for item in watchlist:
        symbol = (item.get("symbol") or "").strip().upper()
        market = (item.get("market") or "US").strip().upper()

        if not symbol:
            continue
        if symbol in SKIP_SYMBOLS:
            print(f"[fundamentals-cron] {symbol}: skipped (ETF/bond)")
            skipped.append(symbol)
            continue

        try:
            q_income, eps_hist = fetch_fundamentals(symbol)
            if not q_income and not eps_hist:
                print(f"[fundamentals-cron] {symbol}: no data returned, skipping")
                skipped.append(symbol)
                continue
            payload.append({
                "symbol": symbol,
                "market": market,
                "quarterlyIncome": q_income,
                "epsHistory": eps_hist,
            })
            print(f"[fundamentals-cron] {symbol}: {len(q_income)} quarters, {len(eps_hist)} EPS rows")
        except Exception as e:
            print(f"[fundamentals-cron] {symbol}: ERROR: {e}")
            skipped.append(symbol)

    if not payload:
        print("\n[fundamentals-cron] No data to push.")
        sys.exit(0)

    try:
        resp = push_to_server(base_url, payload)
        saved = resp.get("saved", "?")
        print(f"\n[fundamentals-cron] Done. Synced {saved}/{len(payload)} symbols.")
        if skipped:
            print(f"[fundamentals-cron] Skipped: {skipped}")
    except Exception as e:
        print(f"[fundamentals-cron] ERROR pushing to server: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
