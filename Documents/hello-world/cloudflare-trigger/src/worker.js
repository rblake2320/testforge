/**
 * TestForge Trigger Worker
 *
 * Exposes a simple HTTP endpoint that fires a GitHub Actions workflow_dispatch
 * event, kicking off a TestForge test run without needing direct GitHub access.
 *
 * Endpoints:
 *   GET  /           → health check
 *   POST /run-tests  → trigger a test run
 *
 * Required header: X-Trigger-Secret: <your secret>
 *
 * Optional JSON body:
 *   { "tags": "@smoke", "browser": "chrome" }
 *
 * Example:
 *   curl -X POST https://testforge-trigger.<your-subdomain>.workers.dev/run-tests \
 *     -H "X-Trigger-Secret: your-secret" \
 *     -H "Content-Type: application/json" \
 *     -d '{"tags": "@regression", "browser": "chrome"}'
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health check
    if (request.method === 'GET' && url.pathname === '/') {
      return json({ status: 'TestForge trigger ready', repo: env.GITHUB_REPO });
    }

    // Only POST /run-tests accepted
    if (request.method !== 'POST' || url.pathname !== '/run-tests') {
      return json({ error: 'Send POST /run-tests' }, 404);
    }

    // Authenticate
    const secret = request.headers.get('X-Trigger-Secret');
    if (!secret || secret !== env.TRIGGER_SECRET) {
      return json({ error: 'Unauthorized — provide X-Trigger-Secret header' }, 401);
    }

    // Parse optional body
    let body = {};
    try {
      const text = await request.text();
      if (text) body = JSON.parse(text);
    } catch {
      // body is optional — ignore parse errors
    }

    const tags    = body.tags    || '@smoke';
    const browser = body.browser || 'chrome';

    // Fire workflow_dispatch on GitHub Actions
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
      return json({
        status:   'triggered',
        tags,
        browser,
        runs_url: `https://github.com/${env.GITHUB_REPO}/actions`,
      });
    }

    const detail = await ghResp.text();
    return json({
      status:        'error',
      github_status: ghResp.status,
      detail,
    }, 500);
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
