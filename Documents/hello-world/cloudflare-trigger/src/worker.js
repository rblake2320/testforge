// ── Config ──────────────────────────────────────────────────────────────────
const GH_OWNER    = 'rblake2320';
const GH_REPO     = 'testforge';
const GH_BRANCH   = 'master';
const FEATURES    = 'Documents/hello-world/src/test/resources/features';
const WORKFLOW    = 'testforge.yml';
const ACTIONS_URL = `https://github.com/${GH_OWNER}/${GH_REPO}/actions`;

// ── GitHub API helper ────────────────────────────────────────────────────────
async function gh(token, method, path, body) {
  const r = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization:  `Bearer ${token}`,
      Accept:         'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent':   'TestForge/2.0',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try { data = await r.json(); } catch { data = await r.text(); }
  return { status: r.status, data };
}

// ── Base64 (UTF-8 safe) ──────────────────────────────────────────────────────
function b64decode(s) {
  const raw = atob(s.replace(/\n/g, ''));
  try {
    return decodeURIComponent(raw.split('').map(c =>
      '%' + c.charCodeAt(0).toString(16).padStart(2,'0')).join(''));
  } catch { return raw; }
}
function b64encode(s) {
  const bytes = encodeURIComponent(s).replace(/%([0-9A-F]{2})/gi,
    (_, p) => String.fromCharCode(parseInt(p, 16)));
  return btoa(bytes);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

// ── Main handler ─────────────────────────────────────────────────────────────
export default {
  async fetch(req, env) {
    const url  = new URL(req.url);
    const path = url.pathname;
    const tok  = env.GITHUB_TOKEN;
    const authed = () => req.headers.get('X-Trigger-Secret') === env.TRIGGER_SECRET;

    // ── API: list tests ──────────────────────────────────────────────────────
    if (path === '/api/tests' && req.method === 'GET') {
      const { status, data } = await gh(tok, 'GET',
        `/repos/${GH_OWNER}/${GH_REPO}/contents/${FEATURES}`);
      if (status !== 200) return json({ error: 'GitHub error' }, 502);
      return json(data.filter(f => f.name.endsWith('.feature'))
        .map(f => ({ name: f.name, sha: f.sha })));
    }

    // ── API: get / save / delete a test file ─────────────────────────────────
    const tm = path.match(/^\/api\/tests\/(.+\.feature)$/);
    if (tm) {
      const name  = tm[1];
      const fpath = `/repos/${GH_OWNER}/${GH_REPO}/contents/${FEATURES}/${name}`;

      if (req.method === 'GET') {
        const { status, data } = await gh(tok, 'GET', fpath);
        if (status !== 200) return json({ error: 'Not found' }, 404);
        return json({ name: data.name, sha: data.sha, content: b64decode(data.content) });
      }

      if (req.method === 'POST') {
        if (!authed()) return json({ error: 'Unauthorized' }, 401);
        const body    = await req.json();
        const check   = await gh(tok, 'GET', fpath);
        const sha     = check.status === 200 ? check.data.sha : undefined;
        const payload = { message: sha ? `Update ${name}` : `Add ${name}`,
                          content: b64encode(body.content), branch: GH_BRANCH };
        if (sha) payload.sha = sha;
        const { status } = await gh(tok, 'PUT', fpath, payload);
        return (status === 200 || status === 201) ? json({ ok: true }) : json({ error: 'Save failed' }, 500);
      }

      if (req.method === 'DELETE') {
        if (!authed()) return json({ error: 'Unauthorized' }, 401);
        const { sha } = await req.json();
        await gh(tok, 'DELETE', fpath, { message: `Delete ${name}`, sha, branch: GH_BRANCH });
        return json({ ok: true });
      }
    }

    // ── API: list recent runs ────────────────────────────────────────────────
    if (path === '/api/runs' && req.method === 'GET') {
      const { status, data } = await gh(tok, 'GET',
        `/repos/${GH_OWNER}/${GH_REPO}/actions/runs?per_page=8`);
      if (status !== 200) return json({ error: 'Failed' }, 502);
      return json(data.workflow_runs.map(r => ({
        id: r.id, number: r.run_number, status: r.status,
        conclusion: r.conclusion, created: r.created_at, url: r.html_url,
      })));
    }

    // ── API: trigger run ─────────────────────────────────────────────────────
    if (path === '/api/run' && req.method === 'POST') {
      if (!authed()) return json({ error: 'Unauthorized' }, 401);
      const { tags, browser } = await req.json();
      const { status, data } = await gh(tok, 'POST',
        `/repos/${GH_OWNER}/${GH_REPO}/actions/workflows/${WORKFLOW}/dispatches`,
        { ref: GH_BRANCH, inputs: { tags: tags || '@smoke', browser: browser || 'chrome' } });
      if (status === 204) return json({ ok: true, url: ACTIONS_URL });
      return json({ error: 'Trigger failed', detail: data }, 500);
    }

    // ── Serve SPA ────────────────────────────────────────────────────────────
    return new Response(HTML.replace('__ORIGIN__', url.origin), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
  },
};

// ── Embedded SPA ─────────────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TestForge</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0d1117;color:#e6edf3;min-height:100vh;display:flex;flex-direction:column}

/* Header */
header{background:#161b22;border-bottom:1px solid #30363d;padding:0 1.5rem;height:58px;display:flex;align-items:center;gap:1rem;position:sticky;top:0;z-index:100}
.logo{font-size:1.1rem;font-weight:700;color:#58a6ff;white-space:nowrap;display:flex;align-items:center;gap:8px}
.logo svg{width:22px;height:22px}
.secret-wrap{display:flex;align-items:center;gap:6px;margin-left:auto}
.secret-wrap label{font-size:.8rem;color:#8b949e;white-space:nowrap}
.secret-wrap input{background:#0d1117;border:1px solid #30363d;color:#e6edf3;border-radius:6px;padding:.35rem .7rem;font-size:.85rem;width:180px;outline:none}
.secret-wrap input:focus{border-color:#58a6ff}
.secret-btn{background:#21262d;border:1px solid #30363d;color:#8b949e;border-radius:6px;padding:.35rem .65rem;cursor:pointer;font-size:.85rem;white-space:nowrap}
.secret-btn:hover{color:#e6edf3;border-color:#8b949e}
.secret-ok{color:#3fb950;font-size:1rem}
.hlinks{display:flex;gap:1rem;margin-left:.5rem}
.hlinks a{color:#8b949e;text-decoration:none;font-size:.85rem}
.hlinks a:hover{color:#e6edf3}

/* Tabs */
.tabs{background:#161b22;border-bottom:1px solid #30363d;display:flex;padding:0 1.5rem;gap:.25rem}
.tab{background:none;border:none;color:#8b949e;padding:.75rem 1.1rem;font-size:.9rem;cursor:pointer;border-bottom:2px solid transparent;transition:all .15s}
.tab:hover{color:#e6edf3}
.tab.active{color:#58a6ff;border-bottom-color:#58a6ff}

/* Tab panes */
.pane{display:none;flex:1}
.pane.active{display:flex;flex-direction:column}

/* ── Tests tab ── */
.split{display:flex;flex:1;height:calc(100vh - 110px);overflow:hidden}
.sidebar{width:230px;min-width:230px;background:#161b22;border-right:1px solid #30363d;display:flex;flex-direction:column;overflow:hidden}
.sb-head{display:flex;align-items:center;justify-content:space-between;padding:.75rem 1rem;border-bottom:1px solid #30363d;font-size:.8rem;color:#8b949e;text-transform:uppercase;letter-spacing:.05em}
.new-btn{background:#238636;border:1px solid #2ea043;color:#fff;border-radius:5px;padding:.25rem .6rem;font-size:.8rem;cursor:pointer}
.new-btn:hover{background:#2ea043}
.file-list{flex:1;overflow-y:auto;padding:.5rem}
.file-item{display:flex;align-items:center;justify-content:space-between;padding:.5rem .75rem;border-radius:6px;cursor:pointer;font-size:.875rem;color:#c9d1d9;transition:background .1s}
.file-item:hover{background:#21262d}
.file-item.active{background:#1f3a5f;color:#58a6ff}
.file-item .del{opacity:0;background:none;border:none;color:#f85149;cursor:pointer;font-size:1rem;padding:0 .25rem;line-height:1}
.file-item:hover .del{opacity:1}
.file-icon{margin-right:.5rem;font-size:.9rem}
.no-files{padding:1rem;color:#484f58;font-size:.875rem;text-align:center}

/* Editor area */
.editor-area{flex:1;display:flex;flex-direction:column;overflow:hidden}
.editor-placeholder{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#484f58;gap:.5rem}
.editor-placeholder h3{color:#8b949e;font-size:1rem}
.editor-placeholder p{font-size:.85rem}
.editor-wrap{flex:1;display:flex;flex-direction:column;overflow:hidden}
.editor-bar{display:flex;align-items:center;justify-content:space-between;padding:.6rem 1rem;background:#161b22;border-bottom:1px solid #30363d}
.editor-bar .fname{font-size:.9rem;font-weight:600;color:#e6edf3;font-family:monospace}
.editor-bar .btns{display:flex;gap:.5rem}
.editor-bar button{border-radius:6px;padding:.35rem .8rem;font-size:.8rem;cursor:pointer;border:1px solid transparent}
.btn-save{background:#1f6feb;border-color:#388bfd;color:#fff}
.btn-save:hover{background:#388bfd}
.btn-run{background:#238636;border-color:#2ea043;color:#fff}
.btn-run:hover{background:#2ea043}
.btn-del{background:#21262d;border-color:#30363d;color:#8b949e}
.btn-del:hover{background:#da3633;border-color:#da3633;color:#fff}
textarea#editor{flex:1;background:#0d1117;color:#c9d1d9;border:none;padding:1rem 1.25rem;font-family:'Courier New',Courier,monospace;font-size:.9rem;line-height:1.6;resize:none;outline:none;tab-size:2}
.save-status{padding:.5rem 1rem;font-size:.8rem;text-align:center;min-height:2rem}
.save-status.ok{color:#3fb950}
.save-status.err{color:#f85149}

/* ── Run tab ── */
.run-wrap{max-width:640px;margin:2.5rem auto;padding:0 1.5rem;width:100%}
.run-wrap h2{font-size:1.4rem;font-weight:700;margin-bottom:.4rem}
.run-wrap p{color:#8b949e;font-size:.9rem;margin-bottom:2rem}
.card{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:1.75rem;margin-bottom:1.25rem}
.card h3{font-size:.8rem;font-weight:600;color:#8b949e;text-transform:uppercase;letter-spacing:.06em;margin-bottom:1.1rem}
.field{margin-bottom:1.25rem}
.field label{display:block;font-size:.875rem;color:#8b949e;margin-bottom:.4rem}
.field input,.field select{width:100%;background:#0d1117;border:1px solid #30363d;color:#e6edf3;border-radius:8px;padding:.6rem 1rem;font-size:.9rem;outline:none}
.field input:focus,.field select:focus{border-color:#58a6ff}
.presets{display:flex;gap:.4rem;flex-wrap:wrap;margin-bottom:1.1rem}
.preset{background:#21262d;border:1px solid #30363d;color:#8b949e;border-radius:20px;padding:.3rem .9rem;font-size:.8rem;cursor:pointer;transition:all .15s}
.preset:hover,.preset.on{background:#1f6feb;border-color:#388bfd;color:#fff}
.run-big{width:100%;background:#238636;border:1px solid #2ea043;color:#fff;font-size:1rem;font-weight:600;padding:.9rem;border-radius:8px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:.5rem;transition:background .15s}
.run-big:hover{background:#2ea043}
.run-big:disabled{background:#21262d;border-color:#30363d;color:#484f58;cursor:not-allowed}
.spin{width:16px;height:16px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;display:none}
@keyframes spin{to{transform:rotate(360deg)}}
.banner{border-radius:8px;padding:1rem 1.25rem;font-size:.9rem;display:none;animation:fadein .25s ease;margin-top:1rem}
.banner.ok{background:#0f2b0f;border:1px solid #238636;color:#3fb950}
.banner.err{background:#2c0b0e;border:1px solid #da3633;color:#f85149}
.banner a{color:inherit;font-weight:600}
@keyframes fadein{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}

/* ── Results tab ── */
.results-wrap{max-width:760px;margin:0 auto;padding:2rem 1.5rem;width:100%}
.results-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:1.5rem}
.results-head h2{font-size:1.2rem;font-weight:700}
.refresh-btn{background:#21262d;border:1px solid #30363d;color:#8b949e;border-radius:6px;padding:.35rem .75rem;font-size:.8rem;cursor:pointer}
.refresh-btn:hover{color:#e6edf3}
.run-row{display:flex;align-items:center;gap:1rem;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:.9rem 1.1rem;margin-bottom:.6rem;text-decoration:none;color:inherit;transition:border-color .15s}
.run-row:hover{border-color:#58a6ff}
.run-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
.dot-pass{background:#3fb950}
.dot-fail{background:#f85149}
.dot-run{background:#e3b341;animation:pulse 1s ease infinite alternate}
.dot-pend{background:#8b949e}
@keyframes pulse{to{opacity:.4}}
.run-num{font-weight:700;color:#e6edf3;min-width:32px;font-size:.9rem}
.run-label{flex:1;font-size:.875rem;color:#8b949e}
.run-conclusion{font-size:.85rem;font-weight:600;min-width:70px;text-align:right}
.conclusion-success{color:#3fb950}
.conclusion-failure{color:#f85149}
.conclusion-progress{color:#e3b341}
.run-time{font-size:.78rem;color:#484f58;min-width:90px;text-align:right}
.no-runs{text-align:center;color:#484f58;padding:3rem;font-size:.9rem}

/* Scrollbar */
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:#30363d;border-radius:3px}
</style>
</head>
<body>

<header>
  <div class="logo">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
    </svg>
    TestForge
  </div>
  <div class="secret-wrap">
    <label>🔑</label>
    <input type="password" id="secretInput" placeholder="Secret key" autocomplete="off">
    <button class="secret-btn" onclick="saveSecret()">Save</button>
    <span class="secret-ok" id="secretOk" style="display:none" title="Secret saved">✓</span>
  </div>
  <nav class="hlinks">
    <a href="https://github.com/rblake2320/testforge" target="_blank">GitHub</a>
    <a href="https://github.com/rblake2320/testforge/actions" target="_blank">Actions</a>
  </nav>
</header>

<div class="tabs">
  <button class="tab active" onclick="showTab('tests')">📋 Tests</button>
  <button class="tab" onclick="showTab('run')">▶&nbsp; Run</button>
  <button class="tab" onclick="showTab('results')">📊 Results</button>
</div>

<!-- ── Tests pane ──────────────────────────────────────────────────────────── -->
<div id="pane-tests" class="pane active">
  <div class="split">
    <div class="sidebar">
      <div class="sb-head">
        <span>Test Files</span>
        <button class="new-btn" onclick="newTest()">+ New</button>
      </div>
      <div id="fileList"><div class="no-files">Loading…</div></div>
    </div>
    <div class="editor-area">
      <div class="editor-placeholder" id="editorPlaceholder">
        <h3>Select a test file</h3>
        <p>Choose a file on the left to view and edit it,<br>or click <strong>+ New</strong> to create one.</p>
      </div>
      <div class="editor-wrap" id="editorWrap" style="display:none">
        <div class="editor-bar">
          <span class="fname" id="editorFilename">untitled.feature</span>
          <div class="btns">
            <button class="btn-save" onclick="saveTest()">💾 Save</button>
            <button class="btn-run"  onclick="runThisFile()">▶ Run</button>
            <button class="btn-del"  onclick="deleteTest()">🗑</button>
          </div>
        </div>
        <textarea id="editor" spellcheck="false" placeholder="Loading…"></textarea>
        <div class="save-status" id="saveStatus"></div>
      </div>
    </div>
  </div>
</div>

<!-- ── Run pane ────────────────────────────────────────────────────────────── -->
<div id="pane-run" class="pane">
  <div class="run-wrap">
    <h2>Run Tests</h2>
    <p>Select which tests to run and click the button. Tests run in the cloud on GitHub Actions.</p>

    <div class="card">
      <h3>What to run</h3>
      <div class="field">
        <label>Tag Filter</label>
        <div class="presets">
          <button class="preset on" onclick="pickTag('@smoke',this)">@smoke</button>
          <button class="preset" onclick="pickTag('@regression',this)">@regression</button>
          <button class="preset" onclick="pickTag('not @ignore',this)">All Tests</button>
        </div>
        <input type="text" id="runTags" value="@smoke" placeholder="e.g. @smoke or @smoke and @regression">
      </div>
      <div class="field">
        <label>Browser</label>
        <select id="runBrowser">
          <option value="chrome">Chrome (recommended)</option>
          <option value="firefox">Firefox</option>
        </select>
      </div>
      <button class="run-big" id="runBtn" onclick="triggerRun()">
        <span id="runBtnText">▶ Run Tests</span>
        <div class="spin" id="runSpin"></div>
      </button>
      <div class="banner" id="runBanner"></div>
    </div>

    <div class="card">
      <h3>API / Webhook</h3>
      <p style="color:#8b949e;font-size:.85rem;margin-bottom:.75rem">Trigger from any script or external system:</p>
      <div style="background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:.9rem 1rem;font-family:monospace;font-size:.78rem;color:#8b949e;word-break:break-all">
        curl -X POST __ORIGIN__/api/run<br>
        &nbsp;&nbsp;-H "X-Trigger-Secret: YOUR_SECRET"<br>
        &nbsp;&nbsp;-H "Content-Type: application/json"<br>
        &nbsp;&nbsp;-d '{"tags":"@smoke","browser":"chrome"}'
      </div>
    </div>
  </div>
</div>

<!-- ── Results pane ────────────────────────────────────────────────────────── -->
<div id="pane-results" class="pane">
  <div class="results-wrap">
    <div class="results-head">
      <h2>Recent Runs</h2>
      <button class="refresh-btn" onclick="loadRuns()">↻ Refresh</button>
    </div>
    <div id="runsList"><div class="no-runs">Loading…</div></div>
  </div>
</div>

<script>
// ── State ───────────────────────────────────────────────────────────────────
let activeFile = null;
let activeSha  = null;

// ── Secret ──────────────────────────────────────────────────────────────────
function saveSecret() {
  const v = document.getElementById('secretInput').value.trim();
  if (!v) return;
  sessionStorage.setItem('tf_secret', v);
  document.getElementById('secretOk').style.display = 'inline';
  setTimeout(() => document.getElementById('secretOk').style.display = 'none', 2000);
}
function getSecret() { return sessionStorage.getItem('tf_secret') || document.getElementById('secretInput').value.trim(); }

// Restore on load
(function() {
  const s = sessionStorage.getItem('tf_secret');
  if (s) document.getElementById('secretInput').value = s;
  document.getElementById('secretInput').addEventListener('keydown', e => { if (e.key === 'Enter') saveSecret(); });
})();

// ── Tabs ────────────────────────────────────────────────────────────────────
function showTab(name) {
  document.querySelectorAll('.pane').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById('pane-' + name).classList.add('active');
  document.querySelectorAll('.tab').forEach(t => {
    if (t.textContent.toLowerCase().includes(name.slice(0,3))) t.classList.add('active');
  });
  if (name === 'results') loadRuns();
}

// ── Tests tab ───────────────────────────────────────────────────────────────
async function loadTests() {
  const fl = document.getElementById('fileList');
  fl.innerHTML = '<div class="no-files">Loading…</div>';
  try {
    const r = await fetch('/api/tests');
    const files = await r.json();
    if (!files.length) { fl.innerHTML = '<div class="no-files">No .feature files yet.<br>Click + New to create one.</div>'; return; }
    fl.innerHTML = '';
    files.forEach(f => {
      const div = document.createElement('div');
      div.className = 'file-item' + (f.name === activeFile ? ' active' : '');
      div.innerHTML = \`<span><span class="file-icon">📄</span>\${f.name}</span><button class="del" onclick="event.stopPropagation();confirmDelete('\${f.name}','\${f.sha}')" title="Delete">✕</button>\`;
      div.onclick = () => openFile(f.name);
      fl.appendChild(div);
    });
  } catch(e) {
    fl.innerHTML = '<div class="no-files">Failed to load files.</div>';
  }
}

async function openFile(name) {
  activeFile = name;
  activeSha  = null;
  document.querySelectorAll('.file-item').forEach(i => i.classList.toggle('active', i.textContent.trim().startsWith(name)));
  document.getElementById('editorPlaceholder').style.display = 'none';
  document.getElementById('editorWrap').style.display = 'flex';
  document.getElementById('editorFilename').textContent = name;
  document.getElementById('editor').value = 'Loading…';
  document.getElementById('saveStatus').textContent = '';
  document.getElementById('saveStatus').className = 'save-status';
  try {
    const r = await fetch(\`/api/tests/\${encodeURIComponent(name)}\`);
    const f = await r.json();
    document.getElementById('editor').value = f.content;
    activeSha = f.sha;
  } catch(e) {
    document.getElementById('editor').value = '# Error loading file';
  }
}

const TEMPLATE = \`Feature: My New Test
  As a user
  I want to test [describe what you are testing]
  So that I can verify [the expected outcome]

  @smoke
  Scenario: [Give your test a descriptive name]
    Given I open "https://example.com"
    Then the page title should contain "Example Domain"
    Then I should see "Example" on the page
    When I take a screenshot named "my-screenshot"

# ── Available Steps ──────────────────────────────────────────────────────────
# Given I open "{url}"
# When I click on "{visible text}"
# When I click element with id "{id}"
# When I click element with css "{css selector}"
# When I type "{value}" into the element with id "{id}"
# When I type "{value}" into element with css "{css selector}"
# When I search for "{search term}"
# When I wait {number} seconds
# When I scroll down
# When I take a screenshot named "{name}"
# When I navigate back
# When I refresh the page
# Then I should see "{text}" on the page
# Then I should not see "{text}" on the page
# Then the page title should contain "{text}"
# Then the URL should contain "{text}"
# Then the element with id "{id}" should contain "{text}"
\`;

function newTest() {
  const raw = prompt('Filename for new test (without .feature):');
  if (!raw) return;
  const name = raw.trim().replace(/\\s+/g,'-').replace(/\\.feature$/,'') + '.feature';
  activeFile = name;
  activeSha  = null;
  document.getElementById('editorPlaceholder').style.display = 'none';
  document.getElementById('editorWrap').style.display = 'flex';
  document.getElementById('editorFilename').textContent = name;
  document.getElementById('editor').value = TEMPLATE;
  document.getElementById('saveStatus').textContent = 'New file — click Save to create it on GitHub.';
  document.getElementById('saveStatus').className = 'save-status ok';
  document.querySelectorAll('.file-item').forEach(i => i.classList.remove('active'));
}

async function saveTest() {
  const secret = getSecret();
  if (!secret) { alert('Enter your secret key in the header first.'); return; }
  const content = document.getElementById('editor').value;
  const ss = document.getElementById('saveStatus');
  ss.textContent = 'Saving…'; ss.className = 'save-status ok';
  try {
    const r = await fetch(\`/api/tests/\${encodeURIComponent(activeFile)}\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Trigger-Secret': secret },
      body: JSON.stringify({ content }),
    });
    const d = await r.json();
    if (r.ok) {
      ss.textContent = '✓ Saved to GitHub'; ss.className = 'save-status ok';
      await loadTests();
      // re-open to get fresh SHA
      const fr = await fetch(\`/api/tests/\${encodeURIComponent(activeFile)}\`);
      const fd = await fr.json();
      activeSha = fd.sha;
    } else {
      ss.textContent = '✗ Save failed: ' + (d.error || JSON.stringify(d)); ss.className = 'save-status err';
    }
  } catch(e) {
    ss.textContent = '✗ Network error'; ss.className = 'save-status err';
  }
}

function confirmDelete(name, sha) {
  if (!confirm('Delete ' + name + '? This cannot be undone.')) return;
  deleteFile(name, sha);
}

async function deleteFile(name, sha) {
  const secret = getSecret();
  if (!secret) { alert('Enter your secret key first.'); return; }
  await fetch(\`/api/tests/\${encodeURIComponent(name)}\`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', 'X-Trigger-Secret': secret },
    body: JSON.stringify({ sha }),
  });
  if (activeFile === name) {
    activeFile = null; activeSha = null;
    document.getElementById('editorWrap').style.display = 'none';
    document.getElementById('editorPlaceholder').style.display = 'flex';
  }
  loadTests();
}

async function deleteTest() { if (activeFile && activeSha) confirmDelete(activeFile, activeSha); }

async function runThisFile() {
  // Tag by filename pattern — switch to Run tab with file name info
  showTab('run');
  document.getElementById('runTags').value = '@smoke';
  document.getElementById('runBanner').className = 'banner ok';
  document.getElementById('runBanner').style.display = 'block';
  document.getElementById('runBanner').innerHTML =
    'Running with tags from <strong>' + activeFile + '</strong>. Make sure your scenarios are tagged @smoke or adjust the tag filter.';
}

// ── Run tab ─────────────────────────────────────────────────────────────────
function pickTag(tag, btn) {
  document.getElementById('runTags').value = tag;
  document.querySelectorAll('.preset').forEach(b => b.classList.remove('on'));
  btn.classList.add('on');
}
document.getElementById('runTags').addEventListener('input', () => {
  document.querySelectorAll('.preset').forEach(b => b.classList.remove('on'));
});

async function triggerRun() {
  const secret = getSecret();
  if (!secret) { alert('Enter your secret key in the header first.'); return; }
  const tags    = document.getElementById('runTags').value.trim() || '@smoke';
  const browser = document.getElementById('runBrowser').value;
  const btn = document.getElementById('runBtn');
  const spin = document.getElementById('runSpin');
  const txt  = document.getElementById('runBtnText');
  const ban  = document.getElementById('runBanner');

  btn.disabled = true; spin.style.display = 'block'; txt.textContent = 'Triggering…'; ban.style.display = 'none';

  try {
    const r = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Trigger-Secret': secret },
      body: JSON.stringify({ tags, browser }),
    });
    const d = await r.json();
    if (r.ok) {
      ban.className = 'banner ok'; ban.style.display = 'block';
      ban.innerHTML = '✓ Tests triggered! Tags: <strong>' + tags + '</strong> · Browser: <strong>' + browser + '</strong><br><br>' +
        '<a href="https://github.com/rblake2320/testforge/actions" target="_blank">→ Watch live on GitHub Actions</a>';
      setTimeout(() => { showTab('results'); loadRuns(); }, 3000);
    } else if (r.status === 401) {
      ban.className = 'banner err'; ban.style.display = 'block'; ban.innerHTML = '✗ Wrong secret key.';
    } else {
      ban.className = 'banner err'; ban.style.display = 'block'; ban.innerHTML = '✗ ' + (d.error || 'Trigger failed');
    }
  } catch(e) {
    ban.className = 'banner err'; ban.style.display = 'block'; ban.innerHTML = '✗ Network error';
  } finally {
    btn.disabled = false; spin.style.display = 'none'; txt.textContent = '▶ Run Tests';
  }
}

// ── Results tab ─────────────────────────────────────────────────────────────
function timeAgo(iso) {
  const secs = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (secs < 60)  return secs + 's ago';
  if (secs < 3600) return Math.floor(secs/60) + 'm ago';
  if (secs < 86400) return Math.floor(secs/3600) + 'h ago';
  return Math.floor(secs/86400) + 'd ago';
}

async function loadRuns() {
  const el = document.getElementById('runsList');
  el.innerHTML = '<div class="no-runs">Loading…</div>';
  try {
    const r = await fetch('/api/runs');
    const runs = await r.json();
    if (!runs.length) { el.innerHTML = '<div class="no-runs">No runs yet. Go to the Run tab and trigger one.</div>'; return; }
    el.innerHTML = '';
    runs.forEach(run => {
      const inProgress = run.status === 'in_progress' || run.status === 'queued';
      const dotClass = inProgress ? 'dot-run'
        : run.conclusion === 'success' ? 'dot-pass'
        : run.conclusion === 'failure' ? 'dot-fail' : 'dot-pend';
      const labelClass = inProgress ? 'conclusion-progress'
        : run.conclusion === 'success' ? 'conclusion-success'
        : run.conclusion === 'failure' ? 'conclusion-failure' : '';
      const label = inProgress ? '⟳ Running…'
        : run.conclusion === 'success' ? '✓ Passed'
        : run.conclusion === 'failure' ? '✗ Failed'
        : run.conclusion || run.status;
      const a = document.createElement('a');
      a.className = 'run-row';
      a.href = run.url;
      a.target = '_blank';
      a.innerHTML = \`
        <div class="run-dot \${dotClass}"></div>
        <div class="run-num">#\${run.number}</div>
        <div class="run-label">TestForge · workflow_dispatch</div>
        <div class="run-conclusion \${labelClass}">\${label}</div>
        <div class="run-time">\${timeAgo(run.created)}</div>
      \`;
      el.appendChild(a);
    });
  } catch(e) {
    el.innerHTML = '<div class="no-runs">Failed to load runs.</div>';
  }
}

// ── Boot ─────────────────────────────────────────────────────────────────────
loadTests();
</script>
</body>
</html>`;
