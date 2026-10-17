import { createHash } from 'node:crypto';
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rssFeedCollector } from '../src/collectors/rss-feed.js';
import { config } from '../src/config.js';

function fingerprintSecret(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 12)}:len=${value.length}`;
}

function headerValue(headers, name) {
  if (!headers) return undefined;
  const match = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
  return match == null ? undefined : headers[match];
}

function jsonResponse(body, ok = true, status = 200) {
  return {
    ok,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

const originalRssConfig = {
  bharagRssWorkspaceId: config.bharagRssWorkspaceId,
  bharagRssWorkspaceApiKey: config.bharagRssWorkspaceApiKey,
  bharagRssLedgerSchema: config.bharagRssLedgerSchema
};

beforeEach(() => {
  Object.assign(config, {
    bharagRssWorkspaceId: 'ws-rss',
    bharagRssWorkspaceApiKey: 'rss-workspace-key',
    bharagRssLedgerSchema: 'ingest.rss'
  });
});

afterEach(() => {
  Object.assign(config, originalRssConfig);
});

test('rssFeedCollector dual-writes clean Book prose and strict RSS Ledger metadata', async () => {
  const calls = [];
  const originalFetch = global.fetch;

  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });

    if (url.endsWith('/health')) {
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ status: 'ok' })
      };
    }

    if (url.endsWith('/api/rss/fetch')) {
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          source: 'discovered',
          feedUrl: 'https://example.com/feed.xml',
          feed: {
            items: [
              {
                title: 'old post',
                link: 'https://example.com/old',
                content: 'old content',
                pubDate: '2026-04-20T00:00:00Z'
              },
              {
                title: 'new post',
                link: 'https://example.com/new',
                content: 'new content',
                pubDate: '2026-04-22T09:00:00Z'
              }
            ]
          }
        })
      };
    }

    if (url.includes('/api/v1/workspaces?')) {
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          success: true,
          workspaces: [],
          pagination: { hasMore: false, limit: 100 }
        })
      };
    }

    if (url.endsWith('/api/v1/workspaces')) {
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          success: true,
          workspace: { id: 'ws-rss' }
        })
      };
    }

    if (url.endsWith('/api/v1/workspaces/ws-rss/members')) {
      if ((options.method || 'GET') === 'GET') {
        return {
          ok: true,
          headers: { get: () => 'application/json' },
          json: async () => ({
            success: true,
            members: []
          })
        };
      }

      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          success: true
        })
      };
    }

    if (url.includes('/api/v1/builders?')) {
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          success: true,
          builders: [],
          pagination: { limit: 20, offset: 0, count: 0 }
        })
      };
    }

    if (url.endsWith('/api/v1/builders')) {
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          success: true,
          builder: { id: 'builder-owner' }
        })
      };
    }

    if (url.endsWith('/api/v1/ingest')) {
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          success: true
        })
      };
    }

    throw new Error(`Unexpected fetch call: ${url}`);
  };

  try {
    const result = await rssFeedCollector.collect({
      source_input: 'https://example.com/feed.xml',
      params: {
        rss_cursor_pub_date: '2026-04-21T00:00:00Z',
        genie_rss_base_url: 'https://genie.example',
        genie_rss_api_key: 'genie-key',
        bharag_base_url: 'https://bharag.example'
      },
      context: {
        triggerMode: 'scheduled'
      }
    });

    assert.equal(result.metrics.fetched, 2);
    assert.equal(result.metrics.selected, 1);
    assert.equal(result.metrics.ingested, 1);
    assert.equal(result.metrics.book_ingested, 1);
    assert.equal(result.metrics.ledger_ingested, 1);
    assert.equal(result.card_updates.params.rss_workspace_id, 'ws-rss');
    assert.equal(result.card_updates.params.rss_cursor_pub_date, '2026-04-22T09:00:00.000Z');
    assert.deepEqual(result.card_updates.params.rss_cursor_item_guids, ['https://example.com/new']);

    const healthCall = calls.find((call) => call.url.endsWith('/health'));
    assert.ok(healthCall, 'genie rss health should be checked before fetching');

    const feedCallIndex = calls.findIndex((call) => call.url.endsWith('/api/rss/fetch'));
    const healthCallIndex = calls.findIndex((call) => call.url.endsWith('/health'));
    assert.ok(healthCallIndex > -1 && feedCallIndex > healthCallIndex);

    const ingestCalls = calls.filter((call) => call.url.endsWith('/api/v1/ingest'));
    assert.equal(ingestCalls.length, 2, 'one Book and one Ledger write expected');
    for (const ingestCall of ingestCalls) {
      assert.equal(headerValue(ingestCall.options.headers, 'x-workspace-id'), undefined);
      assert.equal(headerValue(ingestCall.options.headers, 'x-api-key'), 'rss-workspace-key');
    }

    const bookCall = ingestCalls[0];
    const bookBody = JSON.parse(bookCall.options.body);
    assert.equal(bookCall.options.headers['payload-type'], 'rag');
    assert.equal(bookCall.options.headers['x-api-key'], 'rss-workspace-key');
    assert.equal(bookCall.options.headers['x-workspace-id'], undefined);
    assert.deepEqual(bookBody, {
      title: 'new post',
      content: 'new content',
      source_type: 'manual'
    });

    const ledgerCall = ingestCalls[1];
    const ledgerBody = JSON.parse(ledgerCall.options.body);
    assert.equal(ledgerCall.options.headers['payload-type'], 'ledger');
    assert.equal(ledgerCall.options.headers['payload-schema'], 'ingest.rss');
    assert.equal(ledgerCall.options.headers['x-workspace-id'], undefined);

    const completionLog = result.logs.find((entry) => entry.message.startsWith('rss ingestion completed'));
    assert.equal(completionLog.data.workspaceId, 'ws-rss');
    assert.equal(completionLog.data.xWorkspaceIdHeader, null);
    assert.equal(completionLog.data.workspaceKeyFingerprint, fingerprintSecret('rss-workspace-key'));
    assert.equal(JSON.stringify(result.logs).includes('rss-workspace-key'), false);
    assert.deepEqual(ledgerBody, {
      occurred_at: '2026-04-22T09:00:00.000Z',
      entity_type: 'document',
      entity_id: 'https://example.com/new',
      source: 'https://example.com/feed.xml',
      summary: 'RSS item: new post',
      payload: {
        source_type: 'manual',
        content_type: 'doc',
        source_url: 'https://example.com/new',
        project_tags: ['rss'],
        ingestion_type: 'rss_feed',
        feed_source: 'https://example.com/feed.xml',
        item_guid: 'https://example.com/new',
        item_pub_date: '2026-04-22T09:00:00.000Z'
      }
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('rssFeedCollector omits X-Workspace-ID and routes Book/Ledger by the workspace-scoped key', async () => {
  const calls = [];
  const routedWorkspaces = [];
  const originalFetch = global.fetch;
  const scopedKey = 'rss-workspace-key';
  const boundWorkspaceId = 'ws-rss-bound-to-key';

  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });

    if (url.endsWith('/health')) return jsonResponse({ status: 'ok' });
    if (url.endsWith('/api/rss/fetch')) {
      return jsonResponse({
        feed: {
          items: [{
            title: 'scoped-key post',
            guid: 'scoped-key-guid',
            link: 'https://example.com/scoped',
            content: 'enough article prose',
            pubDate: '2026-04-22T09:00:00Z'
          }]
        }
      });
    }

    if (url.endsWith('/api/v1/ingest')) {
      const workspaceHeader = headerValue(options.headers, 'x-workspace-id');
      const apiKey = headerValue(options.headers, 'x-api-key');
      if (workspaceHeader != null && String(workspaceHeader).trim() !== '') {
        return jsonResponse({
          error: {
            message: 'X-Workspace-ID does not match the workspace key. Either omit the header or use the workspace id/slug bound to the key.',
            code: 'WORKSPACE_KEY_HEADER_MISMATCH'
          }
        }, false, 400);
      }
      if (apiKey !== scopedKey) {
        return jsonResponse({ error: { code: 'UNAUTHORIZED' } }, false, 401);
      }
      routedWorkspaces.push({
        payloadType: headerValue(options.headers, 'payload-type'),
        workspaceId: boundWorkspaceId
      });
      return jsonResponse({ success: true, workspace_id: boundWorkspaceId }, true, 201);
    }

    throw new Error(`Unexpected fetch call: ${url}`);
  };

  try {
    const result = await rssFeedCollector.collect({
      source_input: 'https://example.com/feed.xml',
      params: {
        bharag_rss_workspace_id: 'conflicting-card-workspace-id',
        genie_rss_base_url: 'https://genie.example',
        genie_rss_api_key: 'genie-key',
        bharag_base_url: 'https://bharag.example'
      }
    });

    assert.equal(result.metrics.ingested, 1);
    assert.equal(result.metrics.book_ingested, 1);
    assert.equal(result.metrics.ledger_ingested, 1);
    assert.equal(result.card_updates.params.rss_workspace_id, 'conflicting-card-workspace-id');

    const ingestCalls = calls.filter((call) => call.url.endsWith('/api/v1/ingest'));
    assert.equal(ingestCalls.length, 2);
    for (const ingestCall of ingestCalls) {
      assert.equal(headerValue(ingestCall.options.headers, 'x-workspace-id'), undefined);
      assert.equal(
        Object.keys(ingestCall.options.headers).some((key) => key.toLowerCase() === 'x-workspace-id'),
        false
      );
      assert.equal(headerValue(ingestCall.options.headers, 'x-api-key'), scopedKey);
    }

    assert.deepEqual(routedWorkspaces, [
      { payloadType: 'rag', workspaceId: boundWorkspaceId },
      { payloadType: 'ledger', workspaceId: boundWorkspaceId }
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('rssFeedCollector retries Genie RSS 429 responses with backoff until fetch succeeds', async () => {
  const calls = [];
  const originalFetch = global.fetch;
  let feedAttempts = 0;

  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });

    if (url.endsWith('/health')) {
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ status: 'ok' })
      };
    }

    if (url.endsWith('/api/rss/fetch')) {
      feedAttempts += 1;
      if (feedAttempts < 3) {
        return {
          ok: false,
          status: 429,
          headers: {
            get: (name) => {
              if (name === 'content-type') return 'text/plain';
              if (name === 'retry-after') return '0.001';
              return '';
            }
          },
          text: async () => 'Too Many Requests'
        };
      }

      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          source: 'discovered',
          feedUrl: 'https://example.com/feed.xml',
          feed: { items: [] }
        })
      };
    }

    if (url.includes('/api/v1/workspaces?')) {
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          success: true,
          workspaces: [{ id: 'ws-rss', slug: 'rss-feed' }],
          pagination: { hasMore: false, limit: 100 }
        })
      };
    }

    if (url.endsWith('/api/v1/workspaces/ws-rss/members')) {
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          success: true,
          members: [{ role: 'owner' }]
        })
      };
    }

    throw new Error(`Unexpected fetch call: ${url}`);
  };

  try {
    const result = await rssFeedCollector.collect({
      source_input: 'https://example.com/feed.xml',
      params: {
        genie_rss_base_url: 'https://genie.example',
        genie_rss_api_key: 'genie-key',
        bharag_base_url: 'https://bharag.example',
        bharag_master_api_key: 'bharag-key'
      },
      context: {
        triggerMode: 'scheduled',
        timeoutMs: 100,
        rateLimitInitialRetryMs: 1,
        rateLimitMaxRetryMs: 2
      }
    });

    assert.equal(result.metrics.fetched, 0);
    assert.equal(feedAttempts, 3);

    const fetchCalls = calls.filter((call) => call.url.endsWith('/api/rss/fetch'));
    assert.equal(fetchCalls.length, 3);
  } finally {
    global.fetch = originalFetch;
  }
});

test('rssFeedCollector stops at a Ledger failure and preserves a same-timestamp GUID checkpoint', async () => {
  const calls = [];
  const originalFetch = global.fetch;
  const response = (body, ok = true, status = 200) => ({
    ok,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body)
  });

  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/health')) return response({ status: 'ok' });
    if (url.endsWith('/api/rss/fetch')) {
      return response({
        feed: {
          items: [
            {
              title: 'first post',
              guid: 'first-guid',
              link: 'https://example.com/first',
              content: 'first article prose',
              pubDate: '2026-04-22T09:00:00Z'
            },
            {
              title: 'second post',
              guid: 'second-guid',
              link: 'https://example.com/second',
              content: 'second article prose',
              pubDate: '2026-04-22T09:00:00Z'
            },
            {
              title: 'later post',
              guid: 'later-guid',
              link: 'https://example.com/later',
              content: 'later article prose',
              pubDate: '2026-04-23T09:00:00Z'
            }
          ]
        }
      });
    }

    if (url.endsWith('/api/v1/ingest') && options.headers['payload-type'] === 'ledger' && calls.filter((call) => (
      call.url.endsWith('/api/v1/ingest') && call.options.headers['payload-type'] === 'ledger'
    )).length === 2) {
      return response({ error: 'ledger unavailable' }, false, 503);
    }
    if (url.endsWith('/api/v1/ingest')) return response({ success: true }, true, 201);
    throw new Error(`Unexpected fetch call: ${url}`);
  };

  try {
    const result = await rssFeedCollector.collect({
      source_input: 'https://example.com/feed.xml',
      params: {
        genie_rss_base_url: 'https://genie.example',
        genie_rss_api_key: 'genie-key',
        bharag_base_url: 'https://bharag.example'
      }
    });

    assert.equal(result.metrics.ingested, 1);
    assert.equal(result.metrics.book_ingested, 2);
    assert.equal(result.metrics.ledger_ingested, 1);
    assert.equal(result.metrics.failed, 1);
    assert.equal(result.card_updates.params.rss_cursor_pub_date, '2026-04-22T09:00:00.000Z');
    assert.deepEqual(result.card_updates.params.rss_cursor_item_guids, ['first-guid']);
    assert.equal(calls.filter((call) => call.url.endsWith('/api/v1/ingest')).length, 4);
    assert.equal(result.logs.at(-1).data.lane, 'ledger');
    assert.equal(result.logs.at(-1).data.bharagAuth.workspaceId, 'ws-rss');
    assert.equal(result.logs.at(-1).data.bharagAuth.xWorkspaceIdHeader, null);
    assert.equal(result.logs.at(-1).data.bharagAuth.workspaceKeyFingerprint, fingerprintSecret('rss-workspace-key'));
  } finally {
    global.fetch = originalFetch;
  }
});

test('rssFeedCollector does not call Ledger when the Book write fails', async () => {
  const originalFetch = global.fetch;
  const response = (body, ok = true, status = 200) => ({
    ok,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body)
  });
  let ingestCalls = 0;

  global.fetch = async (url, options = {}) => {
    if (url.endsWith('/health')) return response({ status: 'ok' });
    if (url.endsWith('/api/rss/fetch')) {
      return response({
        feed: {
          items: [{
            title: 'book failure',
            guid: 'book-failure-guid',
            content: 'enough article prose',
            pubDate: '2026-04-22T09:00:00Z'
          }]
        }
      });
    }
    if (url.endsWith('/api/v1/ingest')) {
      ingestCalls += 1;
      assert.equal(options.headers['payload-type'], 'rag');
      return response({ error: 'Book unavailable' }, false, 503);
    }
    throw new Error(`Unexpected fetch call: ${url}`);
  };

  const authLogs = [];
  const originalInfo = console.info;
  console.info = (...args) => {
    if (args[0] === 'rss.bharag_ingest_auth') authLogs.push(args[1]);
  };

  try {
    await assert.rejects(
      rssFeedCollector.collect({
        source_input: 'https://example.com/feed.xml',
        params: {
          genie_rss_base_url: 'https://genie.example',
          genie_rss_api_key: 'genie-key',
          bharag_base_url: 'https://bharag.example'
        }
      }),
      (error) => {
        assert.match(error.message, /failed to ingest RSS items:/);
        assert.match(error.message, /workspaceId=ws-rss/);
        assert.match(error.message, /xWorkspaceIdHeader=omitted/);
        assert.match(error.message, new RegExp(fingerprintSecret('rss-workspace-key')));
        assert.equal(error.message.includes('rss-workspace-key'), false);
        return true;
      }
    );
    assert.equal(ingestCalls, 1);
    assert.equal(authLogs.length, 1);
    assert.equal(authLogs[0].workspaceId, 'ws-rss');
    assert.equal(authLogs[0].xWorkspaceIdHeader, null);
    assert.equal(authLogs[0].workspaceKeyFingerprint, fingerprintSecret('rss-workspace-key'));
    assert.equal(JSON.stringify(authLogs).includes('rss-workspace-key'), false);
  } finally {
    console.info = originalInfo;
    global.fetch = originalFetch;
  }
});

test('rssFeedCollector resumes unseen GUIDs at the existing cursor timestamp', async () => {
  const originalFetch = global.fetch;
  const response = (body, ok = true, status = 200) => ({
    ok,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body)
  });
  const ingestedGuids = [];

  global.fetch = async (url, options = {}) => {
    if (url.endsWith('/health')) return response({ status: 'ok' });
    if (url.endsWith('/api/rss/fetch')) {
      return response({
        feed: {
          items: [
            {
              title: 'already checkpointed',
              guid: 'first-guid',
              content: 'first article prose',
              pubDate: '2026-04-22T09:00:00Z'
            },
            {
              title: 'resume this item',
              guid: 'second-guid',
              content: 'second article prose',
              pubDate: '2026-04-22T09:00:00Z'
            }
          ]
        }
      });
    }
    if (url.endsWith('/api/v1/ingest')) {
      if (options.headers['payload-type'] === 'ledger') {
        ingestedGuids.push(JSON.parse(options.body).entity_id);
      }
      return response({ success: true }, true, 201);
    }
    throw new Error(`Unexpected fetch call: ${url}`);
  };

  try {
    const result = await rssFeedCollector.collect({
      source_input: 'https://example.com/feed.xml',
      params: {
        rss_cursor_pub_date: '2026-04-22T09:00:00Z',
        rss_cursor_item_guids: ['first-guid'],
        genie_rss_base_url: 'https://genie.example',
        genie_rss_api_key: 'genie-key',
        bharag_base_url: 'https://bharag.example'
      }
    });

    assert.equal(result.metrics.selected, 1);
    assert.equal(result.metrics.ingested, 1);
    assert.deepEqual(ingestedGuids, ['second-guid']);
    assert.deepEqual(result.card_updates.params.rss_cursor_item_guids, ['first-guid', 'second-guid']);
  } finally {
    global.fetch = originalFetch;
  }
});
