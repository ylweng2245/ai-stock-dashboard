#!/usr/bin/env python3
"""
Daily news digest cron script.
Reads ngrok URL from GitHub Gist → fetches watchlist → calls
finance_ticker_sentiment for each US stock → POSTs to /api/internal/news-digest-sync

Schedule: run daily at UTC 13:00 (CST 21:00) — before US market open.
"""

import json
import re
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

# ── HTTP helpers ──────────────────────────────────────────────────────────────

def http_get_json(url: str, headers: dict = None) -> dict:
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode())

def http_post_json(url: str, data: list | dict, headers: dict = None) -> dict:
    body = json.dumps(data).encode()
    h = {"Content-Type": "application/json", **(headers or {})}
    req = urllib.request.Request(url, data=body, headers=h, method="POST")
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())

# ── external-tool helper ──────────────────────────────────────────────────────

def call_tool(source_id: str, tool_name: str, arguments: dict) -> dict:
    payload = json.dumps({"source_id": source_id, "tool_name": tool_name, "arguments": arguments})
    result = subprocess.run(
        ["external-tool", "call", payload],
        capture_output=True, text=True, timeout=60
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip())
    return json.loads(result.stdout)

# ── Step 1: Get ngrok URL ──────────────────────────────────────────────────────
# Fixed domain (ngrok free plan with reserved domain — never changes)
FIXED_SERVER_URL = "https://angling-ashes-punctured.ngrok-free.dev"

def get_ngrok_url() -> str:
    # Use fixed domain directly; Gist fallback kept for override only
    try:
        cfg = http_get_json(GIST_RAW_URL)
        override = (cfg.get("ngrok_url") or cfg.get("url") or "").rstrip("/")
        if override and override != FIXED_SERVER_URL:
            print(f"[news-cron] Using Gist override URL: {override}")
            return override
    except Exception:
        pass  # Gist unreachable — fall through to fixed URL
    return FIXED_SERVER_URL

# ── Step 2: Get watchlist ──────────────────────────────────────────────────────

def get_watchlist(base_url: str) -> list[dict]:
    data = http_get_json(f"{base_url}/api/watchlist")
    if not isinstance(data, list):
        raise RuntimeError(f"Unexpected watchlist response: {data}")
    return data

# ── Step 3a: Translate to Traditional Chinese (Google Translate free endpoint) ───

def translate_to_zh(text: str) -> str:
    """Translate text to zh-TW using the free Google Translate endpoint.
    Uses POST to avoid URL length limits. Splits on paragraphs to keep
    each request under 5000 chars (safe for the API)."""
    import time as _time

    def _translate_chunk(chunk: str) -> str:
        """POST-based translation — no URL length limit."""
        body = urllib.parse.urlencode({
            "client": "gtx", "sl": "en", "tl": "zh-TW", "dt": "t", "q": chunk
        }).encode()
        url = "https://translate.googleapis.com/translate_a/single"
        req = urllib.request.Request(url, data=body, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=15) as r:
            d = json.loads(r.read())
        return "".join(item[0] for item in d[0] if item[0])

    # Group paragraphs into chunks of <=5000 chars
    paras = text.split("\n\n")
    chunks, cur = [], ""
    for p in paras:
        if len(cur) + len(p) + 2 > 5000:
            if cur:
                chunks.append(cur)
            cur = p
        else:
            cur = cur + "\n\n" + p if cur else p
    if cur:
        chunks.append(cur)

    parts = []
    for i, chunk in enumerate(chunks):
        if i > 0:
            _time.sleep(0.3)
        parts.append(_translate_chunk(chunk))
    translated = "\n\n".join(parts)

    # Standardize terminology
    replacements = [
        # Bull variants
        ("牛市案例", "多頭觀點"), ("牛市情境", "多頭觀點"), ("牛市：", "多頭觀點："),
        ("牛市觀點", "多頭觀點"), ("看漲案例", "多頭觀點"),
        ("多頭市場案例", "多頭觀點"), ("看多案例", "多頭觀點"),
        # Bear variants
        ("熊市觀點", "空頭觀點"), ("熊市情境", "空頭觀點"), ("熊市案例", "空頭觀點"),
        ("熊市：", "空頭觀點："), ("看跌案例", "空頭觀點"),
        ("悲觀觀點", "空頭觀點"), ("悲觀假設", "空頭觀點"), ("悲觀案例", "空頭觀點"),
        ("看空案例", "空頭觀點"),
        # English fallbacks
        ("Bull Case", "多頭觀點"), ("Bear Case", "空頭觀點"),
        # Title
        ("多頭市場與熊市分析", "多空分析"), ("多頭與空頭分析", "多空分析"),
        ("Bulls vs Bears Analysis for", "多空分析："),
    ]
    for old, new in replacements:
        translated = translated.replace(old, new)
    return translated


# ── Step 3b: Parse sources from finance_ticker_sentiment content ───────────────

def extract_domain(url: str) -> str:
    m = re.search(r"https?://(?:www\.)?([^/]+)", url)
    return m.group(1) if m else ""

DOMAIN_MAP = {
    "reuters.com":        "Reuters",
    "cnbc.com":           "CNBC",
    "bloomberg.com":      "Bloomberg",
    "wsj.com":            "WSJ",
    "ft.com":             "FT",
    "marketwatch.com":    "MarketWatch",
    "barrons.com":        "Barron's",
    "yahoo.com":          "Yahoo Finance",
    "finance.yahoo.com":  "Yahoo Finance",
    "seekingalpha.com":   "Seeking Alpha",
    "thestreet.com":      "TheStreet",
    "benzinga.com":       "Benzinga",
    "fool.com":           "Motley Fool",
    "simplywall.st":      "Simply Wall St",
    "marketbeat.com":     "MarketBeat",
    "marketscreener.com": "MarketScreener",
    "investors.com":      "Investor's Business Daily",
    "financhill.com":     "Financhill",
    "ainvest.com":        "AInvest",
}

def domain_to_name(domain: str) -> str:
    for key, val in DOMAIN_MAP.items():
        if key in domain:
            return val
    seg = domain.split(".")[0] if domain else "Unknown"
    return seg.capitalize()

def parse_sources(content: str) -> list[dict]:
    """Parse [N] Title (YYYY-MM-DD...) - https://... lines from content."""
    sources = []
    pattern = re.compile(
        r'^\[(\d+)\]\s+(.+?)\s+\((\d{4}-\d{2}-\d{2})[^)]*\)\s+-\s+(https?://\S+)',
        re.MULTILINE
    )
    for m in pattern.finditer(content):
        url    = m.group(4).strip()
        domain = extract_domain(url)
        sources.append({
            "sourceName":   domain_to_name(domain),
            "articleTitle": m.group(2).strip(),
            "articleUrl":   url,
            "publishedAt":  m.group(3),
            "sourceDomain": domain,
        })
    return sources

def derive_sentiment(content: str) -> str:
    bull = len(re.findall(r'🐂|Bull Case', content, re.IGNORECASE))
    bear = len(re.findall(r'🐻|Bear Case', content, re.IGNORECASE))
    if bull > bear:  return "positive"
    if bear > bull:  return "negative"
    return "neutral"


def extract_summary(content: str) -> str:
    """Keep the analysis body, cut before the Sources block."""
    m = re.search(r'\n\*?\*?Sources:\*?\*?\n|\n\[0\]', content)
    return content[:m.start()].strip() if m else content.strip()

def today_tw() -> str:
    """Return today's date in Asia/Taipei timezone (UTC+8)."""
    from datetime import timedelta
    now_utc = datetime.now(timezone.utc)
    tw_dt = now_utc + timedelta(hours=8)
    return tw_dt.strftime("%Y-%m-%d")

# ── Step 4: Fetch sentiment for one ticker ────────────────────────────────────

def fetch_ticker_digest(ticker: str, company_name: str) -> dict | None:
    try:
        result  = call_tool("finance", "finance_ticker_sentiment", {
            "ticker_symbol": ticker,
            "query":         f"{ticker} {company_name} latest news and analysis",
            "action":        f"Fetching daily news sentiment for {ticker}",
        })
        content = result.get("content", "")
        if not content:
            print(f"[news-cron] {ticker}: empty response")
            return None

        summary_en = extract_summary(content)
        sentiment  = derive_sentiment(content)
        sources    = parse_sources(content)

        # Translate summary to Traditional Chinese
        try:
            summary = translate_to_zh(summary_en)
            print(f"[news-cron] {ticker}: sentiment={sentiment}, {len(sources)} sources, translated OK")
        except Exception as te:
            summary = summary_en  # fallback to English if translation fails
            print(f"[news-cron] {ticker}: sentiment={sentiment}, {len(sources)} sources, translation FAILED ({te}) — keeping English")

        return {
            "ticker":           ticker,
            "digestDate":       today_tw(),
            "generatedAt":      int(datetime.now(timezone.utc).timestamp() * 1000),
            "priceClose":       None,
            "priceChangePct":   None,
            "summaryText":      summary,       # zh-TW translated, for UI display
            "summaryRaw":       summary_en,    # English original, for server-side sentiment scoring
            "sentimentLabel":   sentiment,
            "sources":          sources,
        }
    except Exception as e:
        print(f"[news-cron] {ticker} ERROR: {e}")
        return None

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    print(f"[news-cron] Starting at {datetime.now(timezone.utc).isoformat()}")

    # Step 1: ngrok URL
    try:
        base_url = get_ngrok_url()
        print(f"[news-cron] Server: {base_url}")
    except Exception as e:
        print(f"[news-cron] Cannot reach server: {e}")
        sys.exit(0)  # exit silently — server offline

    # Step 2: watchlist (US only)
    try:
        watchlist = get_watchlist(base_url)
    except Exception as e:
        print(f"[news-cron] Cannot fetch watchlist: {e}")
        sys.exit(0)

    us_stocks = [w for w in watchlist if w.get("market") == "US"]
    print(f"[news-cron] {len(us_stocks)} US stocks: {[w['symbol'] for w in us_stocks]}")

    # Step 3: fetch digest for each US stock
    digests = []
    for stock in us_stocks:
        ticker = stock["symbol"]
        name   = stock.get("name", ticker)
        item   = fetch_ticker_digest(ticker, name)
        if item:
            digests.append(item)
        # 2s gap between calls
        import time
        time.sleep(2)

    if not digests:
        print("[news-cron] No digests generated, nothing to POST")
        sys.exit(0)

    # Step 4: POST to server in batches of 3 (summaries can be large)
    BATCH_SIZE = 3
    total_saved = 0
    for i in range(0, len(digests), BATCH_SIZE):
        batch = digests[i:i + BATCH_SIZE]
        try:
            resp = http_post_json(
                f"{base_url}/api/internal/news-digest-sync",
                batch,
                headers={"X-Sync-Secret": SYNC_SECRET},
            )
            saved = resp.get('saved', 0)
            total_saved += saved
            tickers = [d['ticker'] for d in batch]
            print(f"[news-cron] Batch {i//BATCH_SIZE + 1}: {tickers} → saved {saved}/{len(batch)}")
        except Exception as e:
            tickers = [d['ticker'] for d in batch]
            print(f"[news-cron] Batch {i//BATCH_SIZE + 1} POST failed {tickers}: {e}")
    print(f"[news-cron] Done. Synced {total_saved}/{len(digests)} stocks.")

    # Step 5: Fetch macro sentiment (SPY + QQQ) for market-wide news
    # SPY covers S&P500 / macro economy; QQQ covers tech/growth sector
    print("[news-cron] Fetching macro sentiment (SPY + QQQ)...")
    macro_items = []
    for ticker, name in [("SPY", "S&P 500 ETF macro economy"), ("QQQ", "NASDAQ 100 ETF tech growth")]:
        item = fetch_ticker_digest(ticker, name)
        if item:
            macro_items.append({"ticker": ticker, "summaryRaw": item["summaryRaw"]})
        import time
        time.sleep(2)

    if macro_items:
        try:
            resp = http_post_json(
                f"{base_url}/api/internal/macro-sentiment-sync",
                macro_items,
                headers={"X-Sync-Secret": SYNC_SECRET},
            )
            print(f"[news-cron] Macro sentiment synced: {resp}")
        except Exception as e:
            print(f"[news-cron] Macro sentiment POST failed: {e}")

if __name__ == "__main__":
    main()
