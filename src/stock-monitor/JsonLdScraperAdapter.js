/**
 * JsonLdScraperAdapter — Supplier adapter for sites that expose JSON-LD
 * structured data (schema.org/Product) with an "availability" field.
 *
 * Works with Magento 2-based sites such as CCHobby.se.
 *
 * Implements the SupplierAdapter contract:
 *   { id: string, name: string, checkStock(skus): Promise<StockCheckResult[]> }
 *
 * StockCheckResult:
 *   { sku: string, in_stock: boolean, source_url: string, error: string|null }
 */

const SCHEMA_IN_STOCK = 'http://schema.org/InStock';
const SCHEMA_IN_STOCK_SHORT = 'InStock';

/**
 * Sleep helper — rate limiting between requests.
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse the first Product JSON-LD block from an HTML string.
 * Returns the parsed object or null if none found.
 * @param {string} html
 * @returns {object|null}
 */
function parseProductJsonLd(html) {
  // Match all <script type="application/ld+json"> blocks
  const scriptRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;

  while ((match = scriptRegex.exec(html)) !== null) {
    try {
      const raw = match[1].trim();
      const data = JSON.parse(raw);

      // Handle both single object and @graph array
      const candidates = Array.isArray(data['@graph'])
        ? data['@graph']
        : [data];

      for (const candidate of candidates) {
        const type = candidate['@type'];
        if (type === 'Product' || (Array.isArray(type) && type.includes('Product'))) {
          return candidate;
        }
      }
    } catch {
      // Malformed JSON — try next block
    }
  }

  return null;
}

/**
 * Determine in_stock status from a schema.org Product object.
 * Returns true (in stock), false (out of stock), or null (unknown).
 * @param {object} product
 * @returns {boolean|null}
 */
function extractAvailability(product) {
  let availability = null;

  if (product.offers) {
    const offers = Array.isArray(product.offers) ? product.offers : [product.offers];
    // Use the first offer with an availability field
    for (const offer of offers) {
      if (offer.availability) {
        availability = offer.availability;
        break;
      }
    }
  } else if (product.availability) {
    availability = product.availability;
  }

  if (!availability) return null;

  // Normalize: may be full URL or short form
  if (
    availability === SCHEMA_IN_STOCK ||
    availability === SCHEMA_IN_STOCK_SHORT ||
    availability.endsWith('InStock')
  ) {
    return true;
  }
  if (availability.includes('OutOfStock') || availability.includes('Discontinued')) {
    return false;
  }

  return null;
}

export class JsonLdScraperAdapter {
  /**
   * @param {object} supplier  - Row from the suppliers table
   * @param {object} supplier.config - JSON config with url_template, rate_limit_ms, user_agent
   * @param {string} supplier.code
   * @param {string} supplier.name
   */
  constructor(supplier) {
    this.id = supplier.code;
    this.name = supplier.name;
    this._config = supplier.config || {};
    this._urlTemplate = this._config.url_template || '';
    this._rateLimitMs = this._config.rate_limit_ms ?? 2000;
    this._userAgent = this._config.user_agent || 'SmultronbynStockBot/1.0 (+https://vantrumsmobler.se)';
  }

  /**
   * Build the URL for a given SKU.
   * @param {string} sku
   * @returns {string}
   */
  _buildUrl(sku) {
    return this._urlTemplate.replace('{sku}', encodeURIComponent(sku));
  }

  /**
   * Fetch stock status for one SKU.
   * Never throws — errors are returned as StockCheckResult with error field set.
   * @param {string} sku
   * @returns {Promise<{sku: string, in_stock: boolean, source_url: string, error: string|null}>}
   */
  async _checkSingle(sku) {
    const url = this._buildUrl(sku);

    let html;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);

      const response = await fetch(url, {
        headers: { 'User-Agent': this._userAgent },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        return {
          sku,
          in_stock: false,
          source_url: url,
          error: `HTTP ${response.status} from ${url}`,
          http_error: true,
        };
      }

      html = await response.text();
    } catch (err) {
      const msg = err.name === 'AbortError'
        ? `Timeout after 10s fetching ${url}`
        : `Network error fetching ${url}: ${err.message}`;
      return { sku, in_stock: false, source_url: url, error: msg, http_error: true };
    }

    const product = parseProductJsonLd(html);
    if (!product) {
      return {
        sku,
        in_stock: false,
        source_url: url,
        error: `No JSON-LD Product found at ${url}`,
        http_error: false,
      };
    }

    const inStock = extractAvailability(product);
    if (inStock === null) {
      return {
        sku,
        in_stock: false,
        source_url: url,
        error: `No availability field in JSON-LD Product at ${url}`,
        http_error: false,
      };
    }

    return { sku, in_stock: inStock, source_url: url, error: null, http_error: false };
  }

  /**
   * Check stock for a list of SKUs with rate limiting between requests.
   * @param {string[]} skus
   * @returns {Promise<Array<{sku: string, in_stock: boolean, source_url: string, error: string|null}>>}
   */
  async checkStock(skus) {
    const results = [];

    for (let i = 0; i < skus.length; i++) {
      const sku = skus[i];
      const result = await this._checkSingle(sku);
      results.push(result);

      // Rate limit between requests, but not after the last one
      if (i < skus.length - 1) {
        await sleep(this._rateLimitMs);
      }
    }

    return results;
  }
}
