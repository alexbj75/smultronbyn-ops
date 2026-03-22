/**
 * StockMonitor — Automatisk lagerbevakning hos leverantörer.
 *
 * Körs dagligen kl 05:00 UTC via cron i ops-appen.
 * Hämtar aktiva leverantörer + deras produkter från PostgreSQL,
 * kontrollerar lagerstatus via respektive adapter,
 * uppdaterar products.stock_quantity vid statusändring,
 * och invaliderar Valkey-cache.
 *
 * Feature flag: STOCK_CHECK_ENABLED=true (env var)
 */

import pg from 'pg';
import { createClient } from 'redis';
import { JsonLdScraperAdapter } from './JsonLdScraperAdapter.js';

const { Pool } = pg;

// Adapter registry — add new adapter types here
const ADAPTERS = {
  'json-ld-scraper': JsonLdScraperAdapter,
};

/**
 * Build a pg Pool from individual DB env vars (same pattern as ops backup job).
 */
function createDbPool() {
  return new Pool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: false,
  });
}

/**
 * Create a Valkey/Redis client for cache invalidation.
 * Returns null if VALKEY_URL is not configured (non-fatal).
 */
async function createCacheClient() {
  const url = process.env.VALKEY_URL || process.env.REDIS_URL;
  if (!url) {
    console.warn('[StockMonitor] VALKEY_URL not set — cache invalidation will be skipped');
    return null;
  }
  try {
    const client = createClient({ url });
    client.on('error', (err) => {
      console.error('[StockMonitor] Valkey error:', err.message);
    });
    await client.connect();
    return client;
  } catch (err) {
    console.warn('[StockMonitor] Could not connect to Valkey:', err.message);
    return null;
  }
}

/**
 * Invalidate Valkey cache keys for a product.
 * Deletes: smb:product:{slug}, smb:products:* (glob)
 * @param {object} client  - Redis/Valkey client (or null)
 * @param {string} slug
 */
async function invalidateProductCache(client, slug) {
  if (!client) return;
  try {
    // Delete individual product cache
    await client.del(`smb:product:${slug}`);

    // Delete all product list caches (glob pattern)
    const keys = await client.keys('smb:products:*');
    if (keys.length > 0) {
      await client.del(keys);
    }
    console.log(`[StockMonitor] Cache invalidated for product slug: ${slug}`);
  } catch (err) {
    // Cache invalidation failure is non-fatal — product will update on TTL expiry
    console.warn(`[StockMonitor] Cache invalidation failed for ${slug}:`, err.message);
  }
}

/**
 * Send a plain-text email notification using the existing SMTP setup.
 * Falls back to console.warn if SMTP vars are not set.
 * @param {string} subject
 * @param {string} body
 */
async function sendEmail(subject, body) {
  const notifyEmail = process.env.STOCK_NOTIFY_EMAIL || 'info@smultronbyn.se';

  // Use nodemailer if available (optional dep), otherwise log
  try {
    const { createTransport } = await import('nodemailer');
    const transport = createTransport({
      host: process.env.SMTP_HOST || 'send.one.com',
      port: parseInt(process.env.SMTP_PORT || '465', 10),
      secure: true,
      auth: {
        user: process.env.SMTP_USER || 'butik@smultronbyn.se',
        pass: process.env.SMTP_PASS,
      },
    });
    await transport.sendMail({
      from: `"Smultronbyn Ops" <${process.env.SMTP_USER || 'butik@smultronbyn.se'}>`,
      to: notifyEmail,
      subject,
      text: body,
    });
    console.log(`[StockMonitor] Email sent to ${notifyEmail}: ${subject}`);
  } catch {
    // nodemailer not available or SMTP misconfigured — log instead
    console.warn(`[StockMonitor] EMAIL (not sent — SMTP unavailable):\nSubject: ${subject}\n${body}`);
  }
}

/**
 * Write a summary entry to the sync_log table.
 * @param {pg.PoolClient} db
 * @param {string} status  - 'success' | 'partial' | 'failed'
 * @param {string} message
 * @param {object} counts  - { checked, changes, errors }
 */
async function writeSyncLog(db, status, message, counts) {
  try {
    // Check if sync_log table exists before attempting to write
    const { rows } = await db.query(
      "SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'sync_log' LIMIT 1"
    );
    if (rows.length === 0) return; // Table doesn't exist yet — skip silently

    await db.query(
      `INSERT INTO sync_log (source, status, message_subject, rows_created, rows_updated, rows_failed)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        'stock_monitor',
        status,
        message,
        0,
        counts.changes ?? 0,
        counts.errors ?? 0,
      ]
    );
  } catch (err) {
    // Non-fatal — log and continue
    console.warn('[StockMonitor] sync_log write skipped:', err.message);
  }
}

/**
 * Main stock monitoring run.
 * Exported for manual triggering from admin endpoint.
 */
export async function runStockCheck() {
  if (process.env.STOCK_CHECK_ENABLED !== 'true') {
    console.log('[StockMonitor] STOCK_CHECK_ENABLED is not "true" — skipping run');
    return { skipped: true };
  }

  console.log(`[StockMonitor] Starting run at ${new Date().toISOString()}`);

  const pool = createDbPool();
  const cache = await createCacheClient();
  let db;

  const summary = {
    totalChecked: 0,
    totalChanges: 0,
    totalErrors: 0,
    statusChanges: [],
    supplierResults: [],
  };

  try {
    db = await pool.connect();

    // Fetch all active suppliers
    const { rows: suppliers } = await db.query(
      `SELECT id, code, name, base_url, adapter, config
       FROM suppliers
       WHERE is_active = true`
    );

    if (suppliers.length === 0) {
      console.log('[StockMonitor] No active suppliers found — nothing to do');
      await writeSyncLog(db, 'success', 'No active suppliers', { changes: 0, errors: 0 });
      return summary;
    }

    for (const supplier of suppliers) {
      const AdapterClass = ADAPTERS[supplier.adapter];
      if (!AdapterClass) {
        console.error(`[StockMonitor] Unknown adapter type: ${supplier.adapter} for supplier ${supplier.code}`);
        continue;
      }

      const adapter = new AdapterClass(supplier);
      console.log(`[StockMonitor] Processing supplier: ${supplier.name} (${supplier.code})`);

      // Fetch products linked to this supplier (include supplier_url for direct page scraping)
      const { rows: products } = await db.query(
        `SELECT p.id, p.sku, p.slug, p.stock_quantity, p.name, p.supplier_url
         FROM products p
         WHERE p.supplier_id = $1
           AND p.is_active = true
           AND p.sku IS NOT NULL`,
        [supplier.id]
      );

      if (products.length === 0) {
        console.log(`[StockMonitor] No active products with SKU for supplier ${supplier.code}`);
        continue;
      }

      // Filter to products that have a supplier_url set
      const productsWithUrl = products.filter((p) => p.supplier_url);
      const productsWithoutUrl = products.filter((p) => !p.supplier_url);

      if (productsWithoutUrl.length > 0) {
        console.warn(
          `[StockMonitor] ${productsWithoutUrl.length} products missing supplier_url for ${supplier.code}: ` +
          productsWithoutUrl.map((p) => p.sku).join(', ')
        );
      }

      if (productsWithUrl.length === 0) {
        console.log(`[StockMonitor] No products with supplier_url for ${supplier.code} — skipping`);
        continue;
      }

      console.log(`[StockMonitor] Checking ${productsWithUrl.length} products for ${supplier.code}`);

      // Run adapter — pass products with { sku, supplier_url }
      let results;
      try {
        results = await adapter.checkStock(
          productsWithUrl.map((p) => ({ sku: p.sku, supplier_url: p.supplier_url }))
        );
      } catch (err) {
        console.error(`[StockMonitor] Adapter ${supplier.code} threw unexpectedly:`, err.message);
        summary.totalErrors += products.length;
        continue;
      }

      // Map results by SKU
      const resultBySku = new Map(results.map((r) => [r.sku, r]));

      let supplierChecked = 0;
      let supplierErrors = 0;
      let supplierChanges = 0;

      // Only iterate products that have a URL (and thus were checked)
      for (const product of productsWithUrl) {
        const result = resultBySku.get(product.sku);
        if (!result) {
          console.warn(`[StockMonitor] No result for SKU ${product.sku} — skipping`);
          supplierErrors++;
          continue;
        }

        const previousStatus = product.stock_quantity > 0; // true = was in stock
        supplierChecked++;

        if (result.error) {
          // ADR principle: NEVER change stock status on error
          supplierErrors++;
          console.warn(`[StockMonitor] Error for SKU ${product.sku}: ${result.error}`);
        }

        // Log this check (always, even on error)
        await db.query(
          `INSERT INTO supplier_stock_checks
             (supplier_id, product_id, sku, in_stock, previous_status, source_url, error)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            supplier.id,
            product.id,
            product.sku,
            result.error ? previousStatus : result.in_stock,
            previousStatus,
            result.source_url,
            result.error ?? null,
          ]
        );

        // Only update DB on successful check with changed status
        if (!result.error && result.in_stock !== previousStatus) {
          const newQuantity = result.in_stock ? 1 : 0;

          await db.query(
            `UPDATE products SET stock_quantity = $1, updated_at = NOW() WHERE id = $2`,
            [newQuantity, product.id]
          );

          // Invalidate Valkey cache for this product
          await invalidateProductCache(cache, product.slug);

          supplierChanges++;
          const changeDesc = `${product.name} (SKU ${product.sku}): ${previousStatus ? 'InStock' : 'OutOfStock'} → ${result.in_stock ? 'InStock' : 'OutOfStock'}`;
          console.log(`[StockMonitor] STATUS CHANGE: ${changeDesc}`);
          summary.statusChanges.push(changeDesc);
        }
      }

      summary.totalChecked += supplierChecked;
      summary.totalErrors += supplierErrors;
      summary.totalChanges += supplierChanges;

      summary.supplierResults.push({
        supplier: supplier.code,
        checked: supplierChecked,
        errors: supplierErrors,
        changes: supplierChanges,
      });

      // Warn if >50% errors for this supplier
      if (supplierChecked > 0 && supplierErrors / supplierChecked > 0.5) {
        const warningMsg = `[StockMonitor] WARNING: >50% errors for ${supplier.name} (${supplierErrors}/${supplierChecked}). Possible site change.`;
        console.warn(warningMsg);
        await sendEmail(
          `[Smultronbyn] Varning: Lagerkoll ${supplier.name} — ${supplierErrors}/${supplierChecked} fel`,
          `${warningMsg}\n\nDetta kan bero på att ${supplier.name} ändrat sin sidstruktur.\nKontrollera adaptern manuellt.`
        );
      }
    }

    // Summary log
    const logMsg = `Checked ${summary.totalChecked} products, ${summary.totalChanges} changes, ${summary.totalErrors} errors`;
    console.log(`[StockMonitor] Run complete. ${logMsg}`);

    const overallStatus = summary.totalErrors === 0
      ? 'success'
      : summary.totalErrors < summary.totalChecked
        ? 'partial'
        : 'failed';

    await writeSyncLog(db, overallStatus, logMsg, {
      changes: summary.totalChanges,
      errors: summary.totalErrors,
    });

    // Send notification if any status changes occurred
    if (summary.statusChanges.length > 0) {
      const emailBody = [
        `Lagerstatusändringar detekterades vid ${new Date().toISOString()}:`,
        '',
        ...summary.statusChanges.map((c) => `• ${c}`),
        '',
        `Totalt kontrollerade: ${summary.totalChecked}`,
        `Ändringar: ${summary.totalChanges}`,
        `Fel: ${summary.totalErrors}`,
      ].join('\n');

      await sendEmail(
        `[Smultronbyn] Lagerstatusändring — ${summary.statusChanges.length} produkter`,
        emailBody
      );
    }

    return summary;
  } catch (err) {
    console.error('[StockMonitor] Fatal error:', err.message);
    if (db) {
      await writeSyncLog(db, 'failed', `Fatal: ${err.message}`, {
        changes: summary.totalChanges,
        errors: summary.totalErrors + 1,
      }).catch(() => {});
    }
    await sendEmail(
      '[Smultronbyn] KRITISKT: Lagerkoll misslyckades',
      `StockMonitor körning misslyckades med ett fatalt fel:\n${err.message}\n\nKontrollera ops-loggar.`
    );
    throw err;
  } finally {
    if (db) db.release();
    if (cache) await cache.quit().catch(() => {});
    await pool.end().catch(() => {});
  }
}
