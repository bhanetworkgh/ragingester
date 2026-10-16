import { config } from '../config.js';

const GENIE_RSS_READY_WAIT_MS = 60 * 1000;
const GENIE_RSS_READY_RETRY_MS = 5 * 1000;
const RATE_LIMIT_INITIAL_RETRY_MS = 5 * 1000;
const RATE_LIMIT_MAX_RETRY_MS = 30 * 1000;
const MIN_BOOK_CONTENT_LENGTH = 10;

class RequestError extends Error {
  constructor(message, { status, retryAfterMs }) {
    super(message);
    this.name = 'RequestError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function trimTrailingSlash(value) {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function asIsoDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function pickParam(params, key, fallback) {
  const value = params?.[key];
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  return fallback;
}

function resolveIntegrationConfig(params = {}) {
  return {
    genieRssBaseUrl: trimTrailingSlash(pickParam(params, 'genie_rss_base_url', config.genieRssBaseUrl)),
    genieRssApiKey: pickParam(params, 'genie_rss_api_key', config.genieRssApiKey),
    bharagBaseUrl: trimTrailingSlash(pickParam(params, 'bharag_base_url', config.bharagBaseUrl)),
    workspaceId: pickParam(params, 'bharag_rss_workspace_id', config.bharagRssWorkspaceId),
    workspaceApiKey: config.bharagRssWorkspaceApiKey,
    ledgerSchema: pickParam(params, 'bharag_rss_ledger_schema', config.bharagRssLedgerSchema),
    cursor: asIsoDate(params.rss_cursor_pub_date),
    cursorItemGuids: Array.isArray(params.rss_cursor_item_guids)
      ? params.rss_cursor_item_guids.filter((guid) => typeof guid === 'string' && guid.trim()).map((guid) => guid.trim())
      : []
  };
}

function parseFeedItems(feed) {
  if (!feed || !Array.isArray(feed.items)) return [];
  return feed.items.map((item) => ({
    title: item.title || 'Untitled',
    content: item.content || item.contentSnippet || '',
    link: item.link || '',
    guid: item.guid || item.link || null,
    pubDate: asIsoDate(item.pubDate || item.isoDate)
  }));
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const contentType = response.headers.get('content-type') || '';
  const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
  const body = contentType.includes('application/json') ? await response.json() : await response.text();

  if (!response.ok) {
    throw new RequestError(`request failed (${response.status}) for ${url}: ${typeof body === 'string' ? body : JSON.stringify(body)}`, {
      status: response.status,
      retryAfterMs
    });
  }

  return body;
}

function parseRetryAfterMs(value) {
  if (!value) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const dateMs = new Date(value).getTime();
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTooManyRequestsError(error) {
  return error?.status === 429 || String(error instanceof Error ? error.message : error).includes('(429)');
}

async function fetchRssFeed({ sourceInput, cfg, since }) {
  if (!cfg.genieRssApiKey) {
    throw new Error('GENIE_RSS_API_KEY is required for rss_feed ingestion');
  }

  const payload = { url: sourceInput };
  if (since) payload.since = since;

  return fetchJson(`${cfg.genieRssBaseUrl}/api/rss/fetch`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.genieRssApiKey
    },
    body: JSON.stringify(payload)
  });
}

function getRateLimitRetryMs(error, attempt, { initialRetryMs, maxRetryMs }) {
  if (Number.isFinite(error?.retryAfterMs)) {
    return error.retryAfterMs;
  }

  return Math.min(maxRetryMs, initialRetryMs * (2 ** Math.max(0, attempt - 1)));
}

async function fetchRssFeedWithRateLimitBackoff({
  sourceInput,
  cfg,
  since,
  timeoutMs,
  initialRetryMs = RATE_LIMIT_INITIAL_RETRY_MS,
  maxRetryMs = RATE_LIMIT_MAX_RETRY_MS
}) {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  let lastError = null;

  while (Date.now() <= deadline) {
    try {
      return await fetchRssFeed({ sourceInput, cfg, since });
    } catch (error) {
      if (!isTooManyRequestsError(error)) {
        throw error;
      }
      lastError = error;
      attempt += 1;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      const retryMs = getRateLimitRetryMs(error, attempt, { initialRetryMs, maxRetryMs });
      await sleep(Math.min(retryMs, remainingMs));
    }
  }

  if (lastError) throw lastError;
  return fetchRssFeed({ sourceInput, cfg, since });
}

function assertBharagRssConfig(cfg) {
  if (!cfg.workspaceId) throw new Error('BHARAG_RSS_WORKSPACE_ID is required for rss_feed ingestion');
  if (!cfg.workspaceApiKey) throw new Error('BHARAG_RSS_WORKSPACE_API_KEY is required for rss_feed ingestion');
  if (!cfg.ledgerSchema) throw new Error('BHARAG_RSS_LEDGER_SCHEMA is required for rss_feed ingestion');
}

function validateItem(item) {
  if (!item.guid) return 'missing stable item GUID';
  if (!item.pubDate) return 'missing valid publication date';
  if (item.content.trim().length < MIN_BOOK_CONTENT_LENGTH) {
    return `article content must contain at least ${MIN_BOOK_CONTENT_LENGTH} characters`;
  }
  return null;
}

function ingestHeaders(cfg, payloadType, payloadSchema) {
  return {
    'content-type': 'application/json',
    'x-api-key': cfg.workspaceApiKey,
    'payload-type': payloadType,
    ...(payloadSchema ? { 'payload-schema': payloadSchema } : {})
  };
}

async function ingestBookDocument({ cfg, item }) {
  return fetchJson(`${cfg.bharagBaseUrl}/api/v1/ingest`, {
    method: 'POST',
    headers: ingestHeaders(cfg, 'rag'),
    body: JSON.stringify({
      title: item.title,
      content: item.content.trim(),
      source_type: 'manual'
    })
  });
}

async function ingestLedgerEvent({ cfg, sourceInput, item }) {
  const sourceUrl = item.link || sourceInput;
  return fetchJson(`${cfg.bharagBaseUrl}/api/v1/ingest`, {
    method: 'POST',
    headers: ingestHeaders(cfg, 'ledger', cfg.ledgerSchema),
    body: JSON.stringify({
      occurred_at: item.pubDate,
      entity_type: 'document',
      entity_id: item.guid,
      source: sourceInput,
      summary: `RSS item: ${item.title}`,
      payload: {
        source_type: 'manual',
        content_type: 'doc',
        source_url: sourceUrl,
        project_tags: ['rss'],
        ingestion_type: 'rss_feed',
        feed_source: sourceInput,
        item_guid: item.guid,
        item_pub_date: item.pubDate
      }
    })
  });
}

async function ingestRssItem({ cfg, sourceInput, item }) {
  await ingestBookDocument({ cfg, item });
  await ingestLedgerEvent({ cfg, sourceInput, item });
}

export async function prewarmRssFeed({
  params = {},
  waitMs = GENIE_RSS_READY_WAIT_MS,
  retryMs = GENIE_RSS_READY_RETRY_MS
} = {}) {
  const cfg = resolveIntegrationConfig(params);
  if (!cfg.genieRssApiKey) {
    throw new Error('GENIE_RSS_API_KEY is required for rss_feed prewarm');
  }

  const deadline = Date.now() + waitMs;
  let lastError = null;

  while (Date.now() <= deadline) {
    try {
      await fetchJson(`${cfg.genieRssBaseUrl}/health`, {
        headers: {
          'x-api-key': cfg.genieRssApiKey
        }
      });
      return;
    } catch (error) {
      lastError = error;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await sleep(Math.min(retryMs, remainingMs));
    }
  }

  throw lastError || new Error('GENIE RSS service was not ready');
}

export const rssFeedCollector = {
  id: 'rss_feed',
  async collect({ source_input, params = {}, context = {} }) {
    const cfg = resolveIntegrationConfig(params);
    const previousRun = cfg.cursor;
    assertBharagRssConfig(cfg);

    await prewarmRssFeed({ params });

    const feedResponse = await fetchRssFeedWithRateLimitBackoff({
      sourceInput: source_input,
      cfg,
      since: previousRun,
      timeoutMs: context.timeoutMs || config.runTimeoutMs,
      initialRetryMs: context.rateLimitInitialRetryMs || RATE_LIMIT_INITIAL_RETRY_MS,
      maxRetryMs: context.rateLimitMaxRetryMs || RATE_LIMIT_MAX_RETRY_MS
    });

    const parsedItems = parseFeedItems(feedResponse.feed);
    const cursorItemGuids = new Set(cfg.cursorItemGuids);
    const newItems = previousRun
      ? parsedItems.filter((item) => (
        item.pubDate
        && (item.pubDate > previousRun || (item.pubDate === previousRun && !cursorItemGuids.has(item.guid)))
      ))
      : parsedItems;
    newItems.sort((left, right) => (
      (left.pubDate || '').localeCompare(right.pubDate || '')
      || (left.guid || '').localeCompare(right.guid || '')
    ));

    const failedItems = [];
    const ingestedItems = [];
    let bookIngestedCount = 0;
    let ledgerIngestedCount = 0;
    let nextCursor = previousRun;
    let nextCursorItemGuids = new Set(previousRun ? cfg.cursorItemGuids : []);

    for (const item of newItems) {
      const validationError = validateItem(item);
      if (validationError) {
        failedItems.push({
          title: item.title,
          link: item.link,
          guid: item.guid,
          lane: 'validation',
          error: validationError
        });
        break;
      }

      try {
        await ingestBookDocument({ cfg, item });
        bookIngestedCount += 1;
      } catch (error) {
        failedItems.push({
          title: item.title,
          link: item.link,
          guid: item.guid,
          lane: 'book',
          error: error instanceof Error ? error.message : String(error)
        });
        break;
      }

      try {
        await ingestLedgerEvent({
          cfg,
          sourceInput: source_input,
          item
        });
        ledgerIngestedCount += 1;
        ingestedItems.push(item);
      } catch (error) {
        failedItems.push({
          title: item.title,
          link: item.link,
          guid: item.guid,
          lane: 'ledger',
          error: error instanceof Error ? error.message : String(error)
        });
        break;
      }

      if (!nextCursor || item.pubDate > nextCursor) {
        nextCursor = item.pubDate;
        nextCursorItemGuids = new Set([item.guid]);
      } else if (item.pubDate === nextCursor) {
        nextCursorItemGuids.add(item.guid);
      }
    }

    if (failedItems.length > 0 && ingestedItems.length === 0 && newItems.length > 0) {
      throw new Error(`failed to ingest RSS items: ${failedItems[0].error}`);
    }

    return {
      raw: {
        source: feedResponse.source || 'discovered',
        feedUrl: feedResponse.feedUrl || source_input,
        fetched: parsedItems.length,
        selected: newItems.length
      },
      normalized: {
        source_type: 'rss_feed',
        trigger_mode: context.triggerMode || null,
        workspace_id: cfg.workspaceId,
        ledger_schema: cfg.ledgerSchema,
        fetched_count: parsedItems.length,
        ingested_count: ingestedItems.length,
        book_ingested_count: bookIngestedCount,
        ledger_ingested_count: ledgerIngestedCount,
        skipped_count: parsedItems.length - newItems.length,
        failed_count: failedItems.length,
        previous_cursor: previousRun,
        next_cursor: nextCursor,
        next_cursor_item_guids: [...nextCursorItemGuids]
      },
      metrics: {
        fetched: parsedItems.length,
        selected: newItems.length,
        ingested: ingestedItems.length,
        failed: failedItems.length,
        book_ingested: bookIngestedCount,
        ledger_ingested: ledgerIngestedCount
      },
      card_updates: {
        params: {
          rss_cursor_pub_date: nextCursor,
          rss_cursor_item_guids: [...nextCursorItemGuids],
          rss_workspace_id: cfg.workspaceId
        }
      },
      logs: [
        {
          level: 'info',
          message: `rss ingestion completed for ${source_input}`,
          data: {
            fetched: parsedItems.length,
            selected: newItems.length,
            ingested: ingestedItems.length,
            failed: failedItems.length,
            bookIngested: bookIngestedCount,
            ledgerIngested: ledgerIngestedCount,
            workspaceId: cfg.workspaceId,
            ledgerSchema: cfg.ledgerSchema
          }
        },
        ...failedItems.map((item) => ({
          level: 'warn',
          message: `rss item ingestion failed: ${item.title}`,
          data: item
        }))
      ]
    };
  }
};
