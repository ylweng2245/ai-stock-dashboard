/**
 * gistSync.ts
 *
 * On server startup (when ngrok is running), reads the current ngrok public URL
 * and writes it to a GitHub Gist so Perplexity cron tasks can always find the server.
 *
 * Gist URL: https://gist.github.com/ylweng2245/cecf995babfbfd98b7e3cbd633549e6f
 */

const GIST_ID = "cecf995babfbfd98b7e3cbd633549e6f";
const GIST_FILENAME = "server-config.json";

/**
 * Fetch current ngrok public URL from the local ngrok API.
 * Returns null if ngrok is not running.
 */
async function getNgrokUrl(): Promise<string | null> {
  try {
    const res = await fetch("http://localhost:4040/api/tunnels");
    if (!res.ok) return null;
    const data = await res.json() as any;
    const tunnel = (data.tunnels as any[]).find(
      (t: any) => t.proto === "https" || t.proto === "http"
    );
    if (!tunnel) return null;
    // Prefer https
    const https = (data.tunnels as any[]).find((t: any) => t.proto === "https");
    return https ? https.public_url : tunnel.public_url;
  } catch {
    return null;
  }
}

/**
 * Update the GitHub Gist with the current ngrok URL.
 */
async function updateGist(url: string, githubToken: string): Promise<void> {
  const payload = {
    files: {
      [GIST_FILENAME]: {
        content: JSON.stringify({ url, updatedAt: new Date().toISOString() }, null, 2),
      },
    },
  };

  const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${githubToken}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API error ${res.status}: ${text}`);
  }
}

/**
 * Call this on server startup.
 * Polls for ngrok URL (up to 30s) then updates the Gist.
 */
export async function syncNgrokUrlToGist(): Promise<void> {
  const githubToken = process.env.GITHUB_TOKEN;
  if (!githubToken) {
    console.log("[gistSync] GITHUB_TOKEN not set — skipping Gist update");
    return;
  }

  // Poll for ngrok URL (ngrok may start after the server)
  let url: string | null = null;
  for (let i = 0; i < 6; i++) {
    url = await getNgrokUrl();
    if (url) break;
    await new Promise((r) => setTimeout(r, 5000)); // wait 5s between attempts
  }

  if (!url) {
    console.log("[gistSync] ngrok not detected — skipping Gist update");
    return;
  }

  try {
    await updateGist(url, githubToken);
    console.log(`[gistSync] Updated Gist with URL: ${url}`);
  } catch (e: any) {
    console.error("[gistSync] Failed to update Gist:", e.message);
  }
}
