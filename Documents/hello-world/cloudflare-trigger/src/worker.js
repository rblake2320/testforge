const GITHUB_REPO = 'rblake2320/testforge';
const RUNS_URL    = `https://github.com/${GITHUB_REPO}/actions`;

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TestForge</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0d1117;
      color: #e6edf3;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }

    /* ── Header ─────────────────────────────── */
    header {
      background: #161b22;
      border-bottom: 1px solid #30363d;
      padding: 0 2rem;
      height: 60px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      position: sticky;
      top: 0;
      z-index: 10;
    }
    .logo {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 1.2rem;
      font-weight: 700;
      color: #58a6ff;
      text-decoration: none;
    }
    .logo svg { width: 28px; height: 28px; }
    .header-links a {
      color: #8b949e;
      text-decoration: none;
      font-size: 0.875rem;
      margin-left: 1.5rem;
      transition: color .2s;
    }
    .header-links a:hover { color: #e6edf3; }

    /* ── Main layout ─────────────────────────── */
    main {
      flex: 1;
      max-width: 860px;
      width: 100%;
      margin: 2.5rem auto;
      padding: 0 1.5rem;
    }

    .hero {
      text-align: center;
      margin-bottom: 2.5rem;
    }
    .hero h1 { font-size: 2rem; font-weight: 700; }
    .hero p  { color: #8b949e; margin-top: .5rem; font-size: 1rem; }

    /* ── Card ────────────────────────────────── */
    .card {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 12px;
      padding: 2rem;
      margin-bottom: 1.5rem;
    }
    .card h2 {
      font-size: 1rem;
      font-weight: 600;
      color: #8b949e;
      text-transform: uppercase;
      letter-spacing: .05em;
      margin-bottom: 1.25rem;
    }

    /* ── Form elements ───────────────────────── */
    label {
      display: block;
      font-size: .875rem;
      color: #8b949e;
      margin-bottom: .4rem;
    }
    input, select {
      width: 100%;
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 8px;
      color: #e6edf3;
      padding: .65rem 1rem;
      font-size: .95rem;
      outline: none;
      transition: border-color .2s;
      margin-bottom: 1.25rem;
    }
    input:focus, select:focus { border-color: #58a6ff; }
    input[type="password"] { letter-spacing: .1em; }

    .tag-presets {
      display: flex;
      gap: .5rem;
      flex-wrap: wrap;
      margin-bottom: 1.25rem;
    }
    .tag-btn {
      background: #21262d;
      border: 1px solid #30363d;
      color: #8b949e;
      border-radius: 20px;
      padding: .3rem .9rem;
      font-size: .8rem;
      cursor: pointer;
      transition: all .2s;
    }
    .tag-btn:hover, .tag-btn.active {
      background: #1f6feb;
      border-color: #388bfd;
      color: #fff;
    }

    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }

    /* ── Run button ──────────────────────────── */
    .run-btn {
      width: 100%;
      background: #238636;
      border: 1px solid #2ea043;
      color: #fff;
      font-size: 1rem;
      font-weight: 600;
      padding: .85rem;
      border-radius: 8px;
      cursor: pointer;
      transition: background .2s, transform .1s;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: .5rem;
    }
    .run-btn:hover  { background: #2ea043; }
    .run-btn:active { transform: scale(.98); }
    .run-btn:disabled { background: #21262d; border-color: #30363d; color: #484f58; cursor: not-allowed; }

    /* Spinner */
    .spinner {
      width: 18px; height: 18px;
      border: 2px solid rgba(255,255,255,.3);
      border-top-color: #fff;
      border-radius: 50%;
      animation: spin .7s linear infinite;
      display: none;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ── Status banner ───────────────────────── */
    .status {
      border-radius: 10px;
      padding: 1.25rem 1.5rem;
      margin-top: 1.25rem;
      display: none;
      animation: fadeIn .3s ease;
      font-size: .95rem;
    }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
    .status.success {
      background: #0f2b0f;
      border: 1px solid #238636;
      color: #3fb950;
    }
    .status.error {
      background: #2c0b0e;
      border: 1px solid #da3633;
      color: #f85149;
    }
    .status a { color: inherit; font-weight: 600; }
    .status .status-icon { font-size: 1.4rem; margin-bottom: .4rem; display: block; }

    /* ── Info grid ───────────────────────────── */
    .info-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 1rem;
    }
    .info-tile {
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 10px;
      padding: 1.25rem;
      text-align: center;
    }
    .info-tile .val { font-size: 1.6rem; font-weight: 700; color: #58a6ff; }
    .info-tile .lbl { font-size: .8rem; color: #8b949e; margin-top: .25rem; }

    /* ── Quick-copy curl box ─────────────────── */
    .curl-box {
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 1rem 1.25rem;
      font-family: 'Courier New', monospace;
      font-size: .8rem;
      color: #8b949e;
      word-break: break-all;
      position: relative;
    }
    .copy-btn {
      position: absolute;
      top: .5rem; right: .5rem;
      background: #21262d;
      border: 1px solid #30363d;
      color: #8b949e;
      border-radius: 6px;
      padding: .2rem .6rem;
      font-size: .75rem;
      cursor: pointer;
      transition: all .2s;
    }
    .copy-btn:hover { background: #30363d; color: #e6edf3; }

    /* ── Footer ──────────────────────────────── */
    footer {
      text-align: center;
      padding: 1.5rem;
      font-size: .8rem;
      color: #484f58;
      border-top: 1px solid #21262d;
    }
    footer a { color: #8b949e; text-decoration: none; }

    @media (max-width: 600px) {
      .row { grid-template-columns: 1fr; }
      .info-grid { grid-template-columns: 1fr 1fr; }
      .hero h1 { font-size: 1.5rem; }
    }
  </style>
</head>
<body>

<header>
  <a class="logo" href="/">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
    </svg>
    TestForge
  </a>
  <nav class="header-links">
    <a href="https://github.com/rblake2320/testforge" target="_blank">GitHub</a>
    <a href="https://github.com/rblake2320/testforge/actions" target="_blank">Actions</a>
  </nav>
</header>

<main>
  <div class="hero">
    <h1>Run Your Tests</h1>
    <p>Trigger a TestForge run on GitHub Actions — no terminal needed.</p>
  </div>

  <!-- Stats -->
  <div class="info-grid" style="margin-bottom:1.5rem;">
    <div class="info-tile">
      <div class="val">3</div>
      <div class="lbl">Smoke Tests</div>
    </div>
    <div class="info-tile">
      <div class="val">Chrome</div>
      <div class="lbl">Default Browser</div>
    </div>
    <div class="info-tile">
      <div class="val">Headless</div>
      <div class="lbl">Mode</div>
    </div>
  </div>

  <!-- Trigger form -->
  <div class="card">
    <h2>Trigger a Test Run</h2>

    <label>Secret Key</label>
    <input type="password" id="secret" placeholder="Enter your trigger secret" autocomplete="off">

    <label>Test Tags</label>
    <div class="tag-presets">
      <button class="tag-btn active" onclick="setTag('@smoke', this)">@smoke</button>
      <button class="tag-btn" onclick="setTag('@regression', this)">@regression</button>
      <button class="tag-btn" onclick="setTag('not @ignore', this)">All</button>
    </div>
    <input type="text" id="tags" value="@smoke" placeholder="e.g. @smoke or @smoke and @regression">

    <div class="row">
      <div>
        <label>Browser</label>
        <select id="browser">
          <option value="chrome">Chrome</option>
          <option value="firefox">Firefox</option>
        </select>
      </div>
      <div style="display:flex; align-items:flex-end;">
        <button class="run-btn" id="runBtn" onclick="triggerRun()">
          <span id="btnText">&#9654; Run Tests</span>
          <div class="spinner" id="spinner"></div>
        </button>
      </div>
    </div>

    <div class="status" id="status"></div>
  </div>

  <!-- API usage -->
  <div class="card">
    <h2>API / Automation</h2>
    <p style="color:#8b949e; font-size:.875rem; margin-bottom:1rem;">
      Trigger from any script, webhook, or CI pipeline using a simple HTTP call.
    </p>
    <div class="curl-box" id="curlBox">
      curl -X POST https://testforge-trigger.workers.dev/run-tests \<br>
      &nbsp;&nbsp;-H "X-Trigger-Secret: YOUR_SECRET" \<br>
      &nbsp;&nbsp;-H "Content-Type: application/json" \<br>
      &nbsp;&nbsp;-d '{"tags": "@smoke", "browser": "chrome"}'
      <button class="copy-btn" onclick="copyCurl()">Copy</button>
    </div>
  </div>
</main>

<footer>
  Built with TestForge &mdash;
  <a href="https://github.com/rblake2320/testforge" target="_blank">github.com/rblake2320/testforge</a>
</footer>

<script>
  // Restore secret from sessionStorage
  const stored = sessionStorage.getItem('tf_secret');
  if (stored) document.getElementById('secret').value = stored;

  function setTag(tag, btn) {
    document.getElementById('tags').value = tag;
    document.querySelectorAll('.tag-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  }

  // Clear active preset when user types manually
  document.getElementById('tags').addEventListener('input', () => {
    document.querySelectorAll('.tag-btn').forEach(b => b.classList.remove('active'));
  });

  async function triggerRun() {
    const secret  = document.getElementById('secret').value.trim();
    const tags    = document.getElementById('tags').value.trim() || '@smoke';
    const browser = document.getElementById('browser').value;
    const btn     = document.getElementById('runBtn');
    const spinner = document.getElementById('spinner');
    const btnText = document.getElementById('btnText');
    const status  = document.getElementById('status');

    if (!secret) {
      showStatus('error', '&#128274; Please enter your trigger secret.');
      return;
    }

    // Save secret in session
    sessionStorage.setItem('tf_secret', secret);

    // Loading state
    btn.disabled = true;
    spinner.style.display = 'block';
    btnText.textContent = 'Triggering\u2026';
    status.style.display = 'none';

    try {
      const resp = await fetch('/run-tests', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trigger-Secret': secret,
        },
        body: JSON.stringify({ tags, browser }),
      });

      const data = await resp.json();

      if (resp.ok) {
        showStatus('success',
          '<span class="status-icon">&#10003; Tests triggered!</span>' +
          'A GitHub Actions run has started with tags <strong>' + tags + '</strong> on <strong>' + browser + '</strong>.<br><br>' +
          '<a href="${RUNS_URL}" target="_blank">&#128279; View live results on GitHub Actions &rarr;</a>'
        );
      } else if (resp.status === 401) {
        showStatus('error', '&#128274; Wrong secret. Check your trigger secret and try again.');
      } else {
        showStatus('error', '&#10060; Error: ' + (data.detail || JSON.stringify(data)));
      }
    } catch (err) {
      showStatus('error', '&#10060; Network error: ' + err.message);
    } finally {
      btn.disabled = false;
      spinner.style.display = 'none';
      btnText.textContent = '\u25B6 Run Tests';
    }
  }

  function showStatus(type, html) {
    const el = document.getElementById('status');
    el.className = 'status ' + type;
    el.innerHTML = html;
    el.style.display = 'block';
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function copyCurl() {
    const text = \`curl -X POST \${location.origin}/run-tests \\\\\\n  -H "X-Trigger-Secret: YOUR_SECRET" \\\\\\n  -H "Content-Type: application/json" \\\\\\n  -d '{"tags": "@smoke", "browser": "chrome"}'\`;
    navigator.clipboard.writeText(text).then(() => {
      const btn = document.querySelector('.copy-btn');
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = 'Copy', 2000);
    });
  }
</script>
</body>
</html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Serve the UI
    if (request.method === 'GET') {
      const page = HTML.replace('${RUNS_URL}', RUNS_URL);
      return new Response(page, {
        headers: { 'Content-Type': 'text/html;charset=UTF-8' },
      });
    }

    // API: POST /run-tests
    if (request.method !== 'POST' || url.pathname !== '/run-tests') {
      return json({ error: 'POST /run-tests only' }, 404);
    }

    // Auth
    const secret = request.headers.get('X-Trigger-Secret');
    if (!secret || secret !== env.TRIGGER_SECRET) {
      return json({ error: 'Unauthorized' }, 401);
    }

    // Parse body
    let body = {};
    try {
      const text = await request.text();
      if (text) body = JSON.parse(text);
    } catch { /* optional body */ }

    const tags    = body.tags    || '@smoke';
    const browser = body.browser || 'chrome';

    // Trigger GitHub Actions workflow_dispatch
    const ghResp = await fetch(
      `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${env.WORKFLOW_FILE}/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization:  `Bearer ${env.GITHUB_TOKEN}`,
          Accept:         'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
          'User-Agent':   'TestForge-Trigger/1.0',
        },
        body: JSON.stringify({
          ref:    env.GITHUB_BRANCH || 'master',
          inputs: { tags, browser },
        }),
      }
    );

    if (ghResp.status === 204) {
      return json({ status: 'triggered', tags, browser, runs_url: RUNS_URL });
    }

    const detail = await ghResp.text();
    return json({ status: 'error', github_status: ghResp.status, detail }, 500);
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
