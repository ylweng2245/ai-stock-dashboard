#!/usr/bin/env python3
"""
Daily fundamentals sync cron script.
Reads ngrok URL from GitHub Gist → fetches watchlist →
  - finance_earnings_history  → quarterlyIncome + epsHistory
POSTs to /api/internal/fundamentals-sync

Schedule: run daily at UTC 13:30 (CST 21:30)
"""

import json
import subprocess
import sys
import urllib.request
import urllib.error
import re
from datetime import datetime, timezone

# ── Config ────────────────────────────────────────────────────────────────────
GIST_RAW_URL = (
    "https://gist.githubusercontent.com/ylweng2245/"
    "cecf995babfbfd98b7e3cbd633549e6f/raw/server-config.json"
)
SYNC_SECRET = "9852b0916353d94bbe935965e85afe129b8452bfd31157d0313e2c4184648ab2"
FIXED_SERVER_URL = "https://angling-ashes-punctured.ngrok-free.dev"

# ETF/bond symbols with no meaningful quarterly earnings
SKIP_SYMBOLS = {"00981A", "00988A", "00403A", "00830", "00719B"}

# ── HTTP helpers ──────────────────────────────────────────────────────────────

def http_get_json(url: str) -> any:
    req = urllib.request.Request(url)
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
    params = json.dumps({"source_id": source_id, "tool_name": tool_name, "arguments": arguments})
    result = subprocess.run(["external-tool", "call", params], capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"external-tool error: {result.stderr}")
    return json.loads(result.stdout)

def now_utc() -> str:
    return datetime.now(timezone.utc).isoformat()

# ── Markdown table parser ─────────────────────────────────────────────────────

def parse_md_table(content: str) -> list[dict]:
    """Parse first markdown table found in content into list of dicts."""
    lines = [l.strip() for l in content.splitlines() if l.strip()]
    table_lines = [l for l in lines if l.startswith("|")]
    if len(table_lines) < 3:
        return []
    headers = [h.strip() for h in table_lines[0].strip("|").split("|")]
    rows = []
    for line in table_lines[2:]:  # skip header + separator
        vals = [v.strip() for v in line.strip("|").split("|")]
        if len(vals) == len(headers):
            rows.append(dict(zip(headers, vals)))
    return rows

def safe_float(val) -> float | None:
    if val is None or str(val).strip() in ("", "-", "N/A", "null"):
        return None
    try:
        return float(str(val).replace(",", "").replace("%", "").strip())
    except (ValueError, TypeError):
        return None

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

# ── Step 3: Fetch earnings history ───────────────────────────────────────────

def fetch_earnings_history(symbol: str) -> tuple[list[dict], list[dict]]:
    """
    Returns (quarterlyIncome, epsHistory) from finance_earnings_history.
    quarterlyIncome: [{quarter, revenue, eps, ...}]
    epsHistory:      [{date, eps, epsEstimate, surprise, surprisePct}]
    """
    result = call_tool("finance", "finance_earnings_history", {
        "ticker": symbol,
        "limit": 12,
    })
    content = result.get("content", "")
    if not content or "No " in content[:60]:
        return [], []

    rows = parse_md_table(content)
    if not rows:
        return [], []

    quarterly_income = []
    eps_history = []

    for row in rows:
        period  = row.get("period", "")       # e.g. "Q1 2026"
        date    = (row.get("date") or "")[:10]  # ISO date
        revenue = safe_float(row.get("actualRevenue"))
        eps_act = safe_float(row.get("actualEps"))
        eps_est = safe_float(row.get("estimatedEps"))
        rev_est = safe_float(row.get("estimatedRevenue"))
        eps_sur = safe_float(row.get("epsSurprise"))

        # Skip future quarters (no actual data)
        if revenue is None and eps_act is None:
            continue

        # quarterlyIncome row
        quarterly_income.append({
            "quarter":          period,
            "revenue":          revenue,
            "grossProfit":      None,
            "operatingIncome":  None,
            "netIncome":        None,
            "eps":              eps_act,
            "grossMargin":      None,
            "operatingMargin":  None,
            "netMargin":        None,
        })

        # epsHistory row
        surprise_pct = None
        if eps_sur is not None and eps_est and eps_est != 0:
            surprise_pct = round(eps_sur / abs(eps_est) * 100, 2)

        eps_history.append({
            "date":         date,
            "eps":          eps_act,
            "epsEstimate":  eps_est,
            "surprise":     eps_sur,
            "surprisePct":  surprise_pct,
        })

    return quarterly_income, eps_history

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
            q_income, eps_hist = fetch_earnings_history(symbol)
            if not q_income and not eps_hist:
                print(f"[fundamentals-cron] {symbol}: no data, skipping")
                skipped.append(symbol)
                continue
            payload.append({
                "symbol":         symbol,
                "market":         market,
                "quarterlyIncome": q_income,
                "epsHistory":      eps_hist,
            })
            print(f"[fundamentals-cron] {symbol}: {len(q_income)} quarters, {len(eps_hist)} EPS rows OK")
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
