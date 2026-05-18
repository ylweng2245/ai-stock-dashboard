#!/usr/bin/env python3
"""
Daily fundamentals sync cron script.
Reads ngrok URL from GitHub Gist → fetches watchlist →
  - finance_earnings_history  → quarterly_income_json + eps_history_json
POSTs to /api/internal/fundamentals-sync

quarterlyIncome format expected by routes.ts:
  { fiscalYear, fiscalQuarter, revenue, grossProfit, netIncome, basicEPS, dilutedEPS }

epsHistory format (for future use):
  { date, epsActual, epsEstimate, epsSurprise }

Schedule: run daily at UTC 13:30 (CST 21:30)
"""

import json
import subprocess
import sys
import re
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
    lines = [l.strip() for l in content.splitlines() if l.strip()]
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

def safe_float(val) -> float | None:
    if val is None or str(val).strip() in ("", "-", "N/A", "null"):
        return None
    try:
        return float(str(val).replace(",", "").replace("%", "").strip())
    except (ValueError, TypeError):
        return None

def parse_fiscal_period(period: str) -> tuple[int | None, int | None]:
    """
    Parse "Q1 2026" or "FY2026 Q1" → (2026, 1)
    Returns (fiscalYear, fiscalQuarter) or (None, None) if unparseable.
    """
    m = re.search(r'Q(\d)\s+(\d{4})', period)
    if m:
        return int(m.group(2)), int(m.group(1))
    m = re.search(r'(\d{4})\s*Q(\d)', period)
    if m:
        return int(m.group(1)), int(m.group(2))
    return None, None

# ── Steps ─────────────────────────────────────────────────────────────────────

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

def get_watchlist(base_url: str) -> list[dict]:
    data = http_get_json(f"{base_url}/api/watchlist")
    if not isinstance(data, list):
        raise RuntimeError(f"Unexpected watchlist response: {data}")
    items = [w for w in data if w.get("market") in ("US", "TW")]
    print(f"[fundamentals-cron] {len(items)} symbols: {[w['symbol'] for w in items]}")
    return items

def fetch_earnings_history(symbol: str) -> tuple[list[dict], list[dict]]:
    """
    Returns:
      quarterlyIncome: [{ fiscalYear, fiscalQuarter, revenue, grossProfit, netIncome, basicEPS, dilutedEPS }]
      epsHistory:      [{ date, epsActual, epsEstimate, epsSurprise }]

    Format matches what routes.ts expects for buildStockContext() quarterly display.
    """
    result = call_tool("finance", "finance_earnings_history", {
        "ticker": symbol,
        "limit": 12,
    })
    content = result.get("content", "")
    if not content or content.strip().startswith("No "):
        return [], []

    rows = parse_md_table(content)
    if not rows:
        return [], []

    quarterly_income = []
    eps_history = []

    for row in rows:
        period   = row.get("period", "")
        date_raw = (row.get("date") or "")[:10]
        revenue  = safe_float(row.get("actualRevenue"))
        eps_act  = safe_float(row.get("actualEps"))
        eps_est  = safe_float(row.get("estimatedEps"))
        eps_sur  = safe_float(row.get("epsSurprise"))

        # Skip future quarters (no actual data yet)
        if revenue is None and eps_act is None:
            continue

        fy, fq = parse_fiscal_period(period)

        # quarterlyIncome — matches { fiscalYear, fiscalQuarter, revenue, grossProfit, netIncome, basicEPS, dilutedEPS }
        quarterly_income.append({
            "fiscalYear":    fy,
            "fiscalQuarter": fq,
            "revenue":       revenue,
            "grossProfit":   None,   # not available from earnings_history
            "netIncome":     None,   # not available from earnings_history
            "basicEPS":      eps_act,
            "dilutedEPS":    eps_act,
        })

        # epsHistory — matches { date, epsActual, epsEstimate, epsSurprise }
        eps_history.append({
            "date":        date_raw,
            "epsActual":   eps_act,
            "epsEstimate": eps_est,
            "epsSurprise": eps_sur,
        })

    return quarterly_income, eps_history

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
                "symbol":          symbol,
                "market":          market,
                "quarterlyIncome": q_income,
                "epsHistory":      eps_hist,
            })
            # Show first entry for verification
            first = q_income[0] if q_income else {}
            fy, fq = first.get("fiscalYear"), first.get("fiscalQuarter")
            label = f"{fy}Q{fq}" if fy else "?"
            print(f"[fundamentals-cron] {symbol}: latest={label} rev={first.get('revenue')} eps={first.get('basicEPS')} | {len(q_income)} quarters OK")
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
