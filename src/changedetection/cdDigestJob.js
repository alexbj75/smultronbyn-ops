import nodemailer from 'nodemailer';
import pg from 'pg';

// Lazy-initialised DB pool
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
      max: 3,
      idleTimeoutMillis: 30000,
    });
    _pool.on('error', (err) => {
      console.error('[cdDigestJob] Unexpected pool error:', err.message);
    });
  }
  return _pool;
}

/**
 * Fetches notifications from the last 24 hours and sends a digest email.
 * If there are no notifications, logs and returns without sending.
 *
 * Called by cron schedule `0 7 * * *` (07:00 UTC daily) in index.js.
 * Can also be triggered manually via process.env.RUN_CD_DIGEST_NOW = 'true'.
 */
export async function runCdDigest() {
  const toEmail = process.env.CD_AGGREGATE_EMAIL || 'alexbj75@hotmail.com';
  const fromEmail = process.env.SMTP_FROM || 'butik@smultronbyn.se';
  const smtpHost = process.env.SMTP_HOST || 'send.one.com';
  const smtpPort = parseInt(process.env.SMTP_PORT || '465', 10);
  const smtpUser = process.env.SMTP_USER || 'butik@smultronbyn.se';
  const smtpPass = process.env.SMTP_PASS;

  console.log(`[cdDigestJob] Running daily digest at ${new Date().toISOString()}`);

  // Fetch notifications from last 24 hours
  let rows;
  try {
    const pool = getPool();
    const result = await pool.query(
      `SELECT
        id,
        watch_uuid,
        watch_url,
        watch_title,
        change_datetime,
        diff_summary,
        diff_url,
        preview_url,
        priority,
        created_at
       FROM cd_notifications
       WHERE created_at > NOW() - INTERVAL '24 hours'
       ORDER BY
         CASE priority WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 WHEN 'LOW' THEN 3 END,
         created_at DESC`,
    );
    rows = result.rows;
  } catch (err) {
    console.error('[cdDigestJob] DB query failed:', err?.message || err);
    return;
  }

  if (rows.length === 0) {
    console.log('[cdDigestJob] Inga ändringar senaste 24h — inget mail skickas.');
    return;
  }

  console.log(`[cdDigestJob] Hittade ${rows.length} notis(er) — bygger digest-mail...`);

  // Group by priority
  const grouped = { HIGH: [], MEDIUM: [], LOW: [] };
  for (const row of rows) {
    const group = grouped[row.priority] ?? grouped.MEDIUM;
    group.push(row);
  }

  // Build email body (plain text)
  const lines = [
    `Changedetection.io — daglig sammanfattning`,
    `Datum: ${new Date().toISOString().split('T')[0]}`,
    `Totalt: ${rows.length} ändring(ar) under senaste 24h`,
    '',
  ];

  const priorityLabels = {
    HIGH: 'HOG PRIORITET',
    MEDIUM: 'MEDEL PRIORITET',
    LOW: 'LAG PRIORITET',
  };

  for (const [priority, label] of Object.entries(priorityLabels)) {
    const items = grouped[priority];
    if (items.length === 0) continue;

    lines.push(`=== ${label} (${items.length} ändring(ar)) ===`);
    for (const item of items) {
      lines.push('');
      lines.push(`  Titel:    ${item.watch_title}`);
      lines.push(`  URL:      ${item.watch_url}`);
      lines.push(`  Tid:      ${new Date(item.change_datetime).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' })}`);
      if (item.diff_url) {
        lines.push(`  Diff:     ${item.diff_url}`);
      }
      if (item.diff_summary) {
        const summary = item.diff_summary.slice(0, 300).replace(/\n/g, ' ');
        lines.push(`  Ändring:  ${summary}${item.diff_summary.length > 300 ? '...' : ''}`);
      }
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('Smultronbyn Väntrumsmöbler — Automatisk omvärldsbevakning');
  lines.push('Hanteras via changedetection.io på OSC');

  const subject = `[Changedetection] ${rows.length} ändring(ar) senaste 24h`;
  const textBody = lines.join('\n');

  // Send email via SMTP
  if (!smtpPass) {
    console.warn('[cdDigestJob] SMTP_PASS saknas — hoppar över e-postutskick');
    console.log('[cdDigestJob] Digest-innehåll (skulle ha skickats):\n', textBody);
    return;
  }

  try {
    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: {
        user: smtpUser,
        pass: smtpPass,
      },
    });

    await transporter.sendMail({
      from: `"Smultronbyn Omvärldsbevakning" <${fromEmail}>`,
      to: toEmail,
      subject,
      text: textBody,
    });

    console.log(`[cdDigestJob] Digest-mail skickat till ${toEmail}: "${subject}"`);
  } catch (err) {
    // Email failure must not crash the cron — log and continue
    console.error('[cdDigestJob] Misslyckades skicka e-post:', err?.message || err);
  }
}
