import { Router } from 'express';
import pg from 'pg';
import { classifyPriority } from './knownCriticalUrls.js';

const router = Router();

// Lazy-initialised DB pool — created once on first request.
// Uses same env vars as the rest of the ops-app (DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASS).
let _pool = null;

function getPool() {
  if (!_pool) {
    _pool = new pg.Pool({
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || '10586', 10),
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      ssl: false,
      max: 5,
      idleTimeoutMillis: 30000,
    });
    _pool.on('error', (err) => {
      console.error('[cdWebhookRouter] Unexpected pool error:', err.message);
    });
  }
  return _pool;
}

/**
 * POST /ops/cd-webhook
 *
 * Receives a changedetection.io webhook payload and inserts a row into
 * the `cd_notifications` table in PostgreSQL.
 *
 * Auth: X-CD-SECRET header must match process.env.CD_WEBHOOK_SECRET
 *
 * Expected body (changedetection.io v0.45+ webhook format):
 * {
 *   uuid:             string  — watch UUID
 *   watch_url:        string  — monitored URL
 *   watch_title:      string  — label set in changedetection.io
 *   change_datetime:  string  — ISO 8601 timestamp of detected change
 *   diff_url?:        string  — link to diff view in changedetection.io UI
 *   preview_url?:     string  — link to current snapshot preview
 *   diff?:            string  — textual diff summary (may be long)
 * }
 */
router.post('/', async (req, res) => {
  const secret = req.headers['x-cd-secret'];
  const expectedSecret = process.env.CD_WEBHOOK_SECRET;

  // Log every inbound call for observability (no sensitive data in log)
  console.log(
    `[cdWebhook] Incoming POST — IP: ${req.ip}, hasSecret: ${!!secret}, ` +
      `url: ${req.body?.watch_url ?? '(missing)'}`,
  );

  // Auth check
  if (!expectedSecret) {
    console.error('[cdWebhook] CD_WEBHOOK_SECRET env var not set — rejecting all requests');
    return res.status(500).json({ error: 'Webhook secret not configured on server.' });
  }

  if (!secret || secret !== expectedSecret) {
    console.warn(`[cdWebhook] 401 — invalid or missing X-CD-SECRET from ${req.ip}`);
    return res.status(401).json({ error: 'Unauthorized: invalid or missing X-CD-SECRET header.' });
  }

  // Input validation
  const { uuid, watch_url, watch_title, change_datetime, diff_url, preview_url, diff } = req.body;

  const missingFields = [];
  if (!watch_url) missingFields.push('watch_url');
  if (!watch_title) missingFields.push('watch_title');
  if (!change_datetime) missingFields.push('change_datetime');

  if (missingFields.length > 0) {
    console.warn(`[cdWebhook] 400 — missing fields: ${missingFields.join(', ')}`);
    return res.status(400).json({
      error: `Missing required fields: ${missingFields.join(', ')}`,
    });
  }

  // Validate change_datetime is parseable
  const parsedDatetime = new Date(change_datetime);
  if (isNaN(parsedDatetime.getTime())) {
    console.warn(`[cdWebhook] 400 — invalid change_datetime: ${change_datetime}`);
    return res.status(400).json({ error: 'Invalid change_datetime — must be ISO 8601.' });
  }

  // Classify priority based on URL
  const priority = classifyPriority(watch_url);

  // Truncate diff_summary to 5000 chars to avoid storing huge diffs
  const diffSummary = typeof diff === 'string' ? diff.slice(0, 5000) : null;

  // Insert into PostgreSQL
  try {
    const pool = getPool();
    const result = await pool.query(
      `INSERT INTO cd_notifications
         (watch_uuid, watch_url, watch_title, change_datetime, diff_summary, diff_url, preview_url, priority)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        uuid ?? '',
        watch_url,
        watch_title,
        parsedDatetime.toISOString(),
        diffSummary,
        diff_url ?? null,
        preview_url ?? null,
        priority,
      ],
    );

    const insertedId = result.rows[0]?.id;
    console.log(
      `[cdWebhook] Inserted notification id=${insertedId}, priority=${priority}, url=${watch_url}`,
    );

    return res.status(200).json({
      received: true,
      id: insertedId,
      priority,
    });
  } catch (err) {
    console.error('[cdWebhook] DB insert failed:', err?.message || err);
    return res.status(500).json({ error: 'Internal server error — failed to store notification.' });
  }
});

export default router;
