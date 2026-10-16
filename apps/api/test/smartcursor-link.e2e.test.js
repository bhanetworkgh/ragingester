import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { createMemoryRepository } from '../src/repository/memory-repository.js';
import { resetRepositoryForTests, setRepositoryForTests } from '../src/repository/index.js';

const SMARTCURSOR_BASE_URL = 'https://smartcursorbrowser.onrender.com/app/';
const SMARTCURSOR_API_KEY = 'testing';
const runEnabled = ['1', 'true', 'yes', 'on'].includes(String(process.env.RUN_SMARTCURSOR_E2E || '').toLowerCase());
const skipReason = runEnabled ? false : 'RUN_SMARTCURSOR_E2E is not enabled';

function jsonResponse(res, statusCode, payload) {
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  };
}

async function startBharagMock() {
  const state = {
    workspace: null,
    ownerBuilder: null,
    membersByWorkspaceId: {},
    ingests: []
  };

  const server = await startServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const { pathname } = url;

    if (req.method === 'GET' && pathname === '/api/v1/workspaces') {
      return jsonResponse(res, 200, {
        success: true,
        workspaces: state.workspace ? [state.workspace] : [],
        pagination: { hasMore: false, limit: Number(url.searchParams.get('limit') || 100) }
      });
    }

    if (req.method === 'POST' && pathname === '/api/v1/workspaces') {
      const payload = await readJsonBody(req);
      state.workspace = { id: 'ws-smart-e2e', slug: payload.slug, name: payload.name };
      state.membersByWorkspaceId[state.workspace.id] = [];
      return jsonResponse(res, 200, { success: true, workspace: state.workspace });
    }

    const workspaceMembersMatch = pathname.match(/^\/api\/v1\/workspaces\/([^/]+)\/members$/);
    if (workspaceMembersMatch) {
      const workspaceId = workspaceMembersMatch[1];
      if (req.method === 'GET') {
        return jsonResponse(res, 200, {
          success: true,
          members: state.membersByWorkspaceId[workspaceId] || []
        });
      }
      if (req.method === 'POST') {
        const payload = await readJsonBody(req);
        const members = state.membersByWorkspaceId[workspaceId] || [];
        members.push({ builder_id: payload.builder_id, role: payload.role });
        state.membersByWorkspaceId[workspaceId] = members;
        return jsonResponse(res, 200, { success: true });
      }
    }

    if (req.method === 'GET' && pathname === '/api/v1/builders') {
      return jsonResponse(res, 200, {
        success: true,
        builders: state.ownerBuilder ? [state.ownerBuilder] : [],
        pagination: { limit: Number(url.searchParams.get('limit') || 20), offset: Number(url.searchParams.get('offset') || 0), count: state.ownerBuilder ? 1 : 0 }
      });
    }

    if (req.method === 'POST' && pathname === '/api/v1/builders') {
      const payload = await readJsonBody(req);
      state.ownerBuilder = {
        id: 'builder-smart-e2e',
        name: payload.name,
        email: payload.email || null
      };
      return jsonResponse(res, 200, { success: true, builder: state.ownerBuilder });
    }

    if (req.method === 'POST' && pathname === '/api/v1/ingest') {
      const payload = await readJsonBody(req);
      state.ingests.push({ headers: req.headers, payload });
      return jsonResponse(res, 200, { success: true });
    }

    jsonResponse(res, 404, { error: 'not found' });
  });

  return { ...server, state };
}

function authHeaders(userId) {
  return {
    'content-type': 'application/json',
    'x-user-id': userId
  };
}

test('smartcursor_link true e2e across API + SmartCursor Browser + Bharag mock', { timeout: 240000, skip: skipReason }, async () => {
  setRepositoryForTests(createMemoryRepository());
  const originalConfig = {
    bharagSmartcursorWorkspaceId: config.bharagSmartcursorWorkspaceId,
    bharagSmartcursorWorkspaceApiKey: config.bharagSmartcursorWorkspaceApiKey,
    bharagSmartcursorLedgerSchema: config.bharagSmartcursorLedgerSchema
  };
  Object.assign(config, {
    bharagSmartcursorWorkspaceId: 'ws-smart-e2e',
    bharagSmartcursorWorkspaceApiKey: 'smartcursor-e2e-key',
    bharagSmartcursorLedgerSchema: 'ingest.smartcursor'
  });

  const bharag = await startBharagMock();
  const appServer = await startServer(createApp());

  try {
    const createCardRes = await fetch(`${appServer.baseUrl}/cards`, {
      method: 'POST',
      headers: authHeaders('user-smart-e2e'),
      body: JSON.stringify({
        source_type: 'smartcursor_link',
        source_input: 'https://example.com',
        params: {
          smartcursor_base_url: SMARTCURSOR_BASE_URL,
          smartcursor_api_key: SMARTCURSOR_API_KEY,
          bharag_base_url: bharag.baseUrl,
          bharag_master_api_key: 'bharag-e2e-key',
          goal: 'Open the page and extract visible content',
          max_steps: 8
        },
        run_timeout_ms: 240000,
        run_max_retries: 0,
        schedule_enabled: false,
        active: true
      })
    });

    assert.equal(createCardRes.status, 201);
    const card = await createCardRes.json();
    assert.ok(card.id);

    const runRes = await fetch(`${appServer.baseUrl}/cards/${card.id}/run`, {
      method: 'POST',
      headers: authHeaders('user-smart-e2e')
    });

    assert.equal(runRes.status, 202);
    const run = await runRes.json();
    assert.equal(run.status, 'success', run.error || 'run failed without error text');
    assert.equal(run.trigger_mode, 'manual');

    const cardAfterRunRes = await fetch(`${appServer.baseUrl}/cards/${card.id}`, {
      headers: authHeaders('user-smart-e2e')
    });
    assert.equal(cardAfterRunRes.status, 200);
    const cardAfterRun = await cardAfterRunRes.json();
    assert.equal(cardAfterRun.params.smartcursor_workspace_id, 'ws-smart-e2e');

    assert.equal(bharag.state.ingests.length, 2);
    assert.equal(bharag.state.ingests[0].headers['x-workspace-id'], 'ws-smart-e2e');
    assert.equal(bharag.state.ingests[0].headers['payload-type'], 'rag');
    assert.equal(bharag.state.ingests[1].headers['payload-type'], 'ledger');
    assert.equal(bharag.state.ingests[1].headers['payload-schema'], 'ingest.smartcursor');
    assert.equal(bharag.state.ingests[0].payload.source_type, 'manual');
    assert.ok(typeof bharag.state.ingests[0].payload.content === 'string');
    assert.ok(bharag.state.ingests[0].payload.content.length > 0);
  } finally {
    await appServer.close();
    await bharag.close();
    resetRepositoryForTests();
    Object.assign(config, originalConfig);
  }
});
