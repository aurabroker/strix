/**
 * Strix report launcher.
 *
 * Serves the latest rendered scan report (pushed to the REPORTS R2 bucket by
 * .github/workflows/report-site.yml) and a form to launch a new scan against
 * a chosen target, gated behind the same Supabase project the main app
 * already uses for login. No route here trusts a bare API key: every
 * protected request must carry a live Supabase access token, which is
 * verified against Supabase's own /auth/v1/user endpoint on every call.
 */

const REPORT_KEY = "latest/index.html";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(renderShell(env), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (request.method === "GET" && url.pathname === "/api/report") {
      const authError = await requireUser(request, env);
      if (authError) return authError;

      const object = await env.REPORTS.get(REPORT_KEY);
      if (!object) {
        return json({ error: "No report published yet." }, 404);
      }
      return new Response(object.body, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (request.method === "POST" && url.pathname === "/api/scan") {
      const authError = await requireUser(request, env);
      if (authError) return authError;

      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Malformed request body." }, 400);
      }

      const target = typeof body.target === "string" ? body.target.trim() : "";
      if (!target || target.length > 500) {
        return json({ error: "Provide a non-empty target (max 500 chars)." }, 400);
      }

      return dispatchScan(target, env);
    }

    return new Response("Not found", { status: 404 });
  },
};

/** Validates the caller's Supabase access token; returns a Response on failure, null on success. */
async function requireUser(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) {
    return json({ error: "Sign in required." }, 401);
  }

  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: env.SUPABASE_ANON_KEY,
    },
  });

  if (!res.ok) {
    return json({ error: "Session expired or invalid, please sign in again." }, 401);
  }
  return null;
}

/** Triggers report-site.yml via workflow_dispatch, passing the chosen target. */
async function dispatchScan(target, env) {
  if (!env.GITHUB_TOKEN) {
    return json({ error: "Scan launcher is not configured (missing GITHUB_TOKEN)." }, 500);
  }

  const res = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${env.GITHUB_WORKFLOW_FILE}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "strix-report-launcher",
      },
      body: JSON.stringify({ ref: env.GITHUB_REF, inputs: { target } }),
    }
  );

  if (res.status !== 204) {
    const detail = await res.text();
    return json({ error: `GitHub rejected the scan request: ${detail}` }, 502);
  }

  return json({ ok: true, message: `Scan queued for "${target}".` });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderShell(env) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Strix Report Launcher</title>
<meta name="robots" content="noindex, nofollow">
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>
<style>
  :root { --bg:#0b0f14; --panel:#121821; --border:#232c38; --text:#e6edf3; --muted:#8b98a5; --accent:#22c55e; }
  * { box-sizing: border-box; }
  body { margin:0; padding:0 16px 64px; background:var(--bg); color:var(--text);
    font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  main { max-width:720px; margin:0 auto; }
  header { padding:40px 0 24px; }
  header h1 { margin:0 0 8px; font-size:1.5rem; }
  .panel { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:24px; margin-bottom:24px; }
  input, button { font:inherit; }
  input { width:100%; padding:10px 12px; margin:6px 0 14px; background:#0d1218; border:1px solid var(--border);
    border-radius:6px; color:var(--text); }
  button { padding:10px 18px; background:var(--accent); color:#0b0f14; font-weight:600; border:none;
    border-radius:6px; cursor:pointer; }
  button:disabled { opacity:0.5; cursor:not-allowed; }
  #status { margin-top:10px; font-size:0.9rem; color:var(--muted); white-space:pre-wrap; }
  #app { display:none; }
  #report-frame { width:100%; height:70vh; border:1px solid var(--border); border-radius:10px; background:#fff; }
  .row { display:flex; gap:10px; align-items:center; }
</style>
</head>
<body>
<main>
  <header><h1>Strix Report Launcher</h1></header>

  <section id="login" class="panel">
    <h2>Sign in</h2>
    <input id="email" type="email" placeholder="email" autocomplete="username">
    <input id="password" type="password" placeholder="password" autocomplete="current-password">
    <button id="signin">Sign in</button>
    <div id="login-status"></div>
  </section>

  <section id="app">
    <div class="panel">
      <h2>Launch a scan</h2>
      <p style="color:var(--muted)">Only scan targets you are authorized to test.</p>
      <input id="target" placeholder="Path, URL, domain, or IP to scan">
      <div class="row">
        <button id="launch">Launch scan</button>
        <button id="signout" style="background:transparent;color:var(--muted);border:1px solid var(--border)">Sign out</button>
      </div>
      <div id="status"></div>
    </div>
    <div class="panel">
      <h2>Latest report</h2>
      <iframe id="report-frame"></iframe>
    </div>
  </section>
</main>

<script>
  const supabase = window.supabase.createClient(
    "${env.SUPABASE_URL}",
    "${env.SUPABASE_ANON_KEY}"
  );

  const loginSection = document.getElementById("login");
  const appSection = document.getElementById("app");
  const loginStatus = document.getElementById("login-status");
  const status = document.getElementById("status");

  async function authHeaders() {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    return token ? { Authorization: "Bearer " + token } : {};
  }

  async function loadReport() {
    const res = await fetch("/api/report", { headers: await authHeaders() });
    if (res.ok) {
      document.getElementById("report-frame").srcdoc = await res.text();
    }
  }

  async function refreshView() {
    const { data } = await supabase.auth.getSession();
    if (data.session) {
      loginSection.style.display = "none";
      appSection.style.display = "block";
      loadReport();
    } else {
      loginSection.style.display = "block";
      appSection.style.display = "none";
    }
  }

  document.getElementById("signin").addEventListener("click", async () => {
    loginStatus.textContent = "Signing in…";
    const { error } = await supabase.auth.signInWithPassword({
      email: document.getElementById("email").value,
      password: document.getElementById("password").value,
    });
    loginStatus.textContent = error ? error.message : "";
    if (!error) refreshView();
  });

  document.getElementById("signout").addEventListener("click", async () => {
    await supabase.auth.signOut();
    refreshView();
  });

  document.getElementById("launch").addEventListener("click", async () => {
    const target = document.getElementById("target").value.trim();
    if (!target) return;
    status.textContent = "Launching…";
    const res = await fetch("/api/scan", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authHeaders()) },
      body: JSON.stringify({ target }),
    });
    const data = await res.json();
    status.textContent = res.ok ? data.message : "Error: " + data.error;
  });

  refreshView();
</script>
</body>
</html>`;
}
