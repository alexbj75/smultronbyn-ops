/**
 * JsonLdScraperAdapter — Supplier adapter that checks stock status
 * by fetching product pages and parsing visible stock text + JSON-LD.
 *
 * Works with Magento 2-based sites such as CCHobby.se.
 *
 * Strategy (CCHobby-specific learning 2026-03-22):
 *   1. Parse visible stock text first ("I lager", "Slut i lager", "Tillfälligt slut")
 *      — this is the most reliable source on CCHobby.
 *   2. Fall back to JSON-LD schema.org availability if no visible text found.
 *      — CCHobby's JSON-LD can be WRONG (shows InStock when page says "Tillfälligt slut").
 *
 * Each product must have a supplier_url pointing to the product page on the supplier's site.
 * SKU-based URL construction (search pages) does NOT work because CCHobby renders
 * search results with JavaScript (Vue/Relewise) — no usable data in server-rendered HTML.
 *
 * Implements the SupplierAdapter contract:
 *   { id, name, checkStock(products): Promise<StockCheckResult[]> }
 *
 * StockCheckResult:
 *   { sku, in_stock, source_url, error }
 */

/**
 * Sleep helper — rate limiting between requests.
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Visible text parsing (PRIMARY source) ---

/**
 * Swedish stock status patterns found on CCHobby.se product pages.
 * Ordered from most specific to least specific.
 */
const STOCK_PATTERNS = [
  // Out of stock patterns (check first — "Tillfälligt slut i lager" contains "i lager")
  { pattern: /slutsåld/i, inStock: false },
  { pattern: /tillfälligt\s+slut/i, inStock: false },
  { pattern: /slut\s+i\s+lager/i, inStock: false },
  // In stock patterns
  { pattern: /i\s+lager/i, inStock: true },
];

/**
 * Extract stock status from visible page text.
 *
 * CCHobby-specific patterns (Magento 2):
 * - "Slutsåld" → definitively out of stock
 * - "Tillfälligt slut i lager" → out of stock (with future delivery date)
 * - These are the ONLY out-of-stock patterns we trust from visible text.
 * - If neither pattern is found, we fall through to JSON-LD.
 *
 * We do NOT use "I lager" as a positive signal because it can appear
 * in unrelated page elements (navigation, other products, footer).
 *
 * Returns true (in stock), false (out of stock), or null (no pattern matched).
 * @param {string} html
 * @returns {boolean|null}
 */
function extractVisibleStockStatus(html) {
  // Only check for definitive out-of-stock patterns.
  // These are specific enough to not produce false positives.
  if (/slutsåld/i.test(html)) {
    return false;
  }
  if (/tillfälligt\s+slut/i.test(html)) {
    return false;
  }

  // Don't return true based on "I lager" text — too many false positives.
  // Return null to let JSON-LD decide.
  return null;
}

// --- JSON-LD parsing (FALLBACK source) ---

/**
 * Parse the first Product JSON-LD block from an HTML string.
 * @param {string} html
 * @returns {object|null}
 */
function parseProductJsonLd(html) {
  const scriptRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;

  while ((match = scriptRegex.exec(html)) !== null) {
    try {
      const raw = match[1].trim();
      const data = JSON.parse(raw);

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
 * Extract availability from JSON-LD Product object.
 * @param {object} product
 * @returns {boolean|null}
 */
function extractJsonLdAvailability(product) {
  let availability = null;

  if (product.offers) {
    const offers = Array.isArray(product.offers) ? product.offers : [product.offers];
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

  if (availability.includes('OutOfStock') || availability.includes('Discontinued')) {
    return false;
  }
  if (availability.endsWith('InStock')) {
    return true;
  }

  return null;
}

export class JsonLdScraperAdapter {
  /**
   * @param {object} supplier  - Row from the suppliers table
   * @param {object} supplier.config - JSON config with rate_limit_ms, user_agent
   * @param {string} supplier.code
   * @param {string} supplier.name
   */
  constructor(supplier) {
    this.id = supplier.code;
    this.name = supplier.name;
    this._config = supplier.config || {};
    this._rateLimitMs = this._config.rate_limit_ms ?? 2000;
    this._userAgent = this._config.user_agent || 'SmultronbynStockBot/1.0 (+https://vantrumsmobler.se)';
  }

  /**
   * Fetch stock status for one product.
   * Never throws — errors are returned in the result object.
   * @param {{ sku: string, supplier_url: string }} product
   * @returns {Promise<{sku: string, in_stock: boolean, source_url: string, error: string|null}>}
   */
  async _checkSingle(product) {
    const { sku, supplier_url: url } = product;

    if (!url) {
      return {
        sku,
        in_stock: false,
        source_url: '',
        error: `No supplier_url set for SKU ${sku}`,
      };
    }

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
        };
      }

      html = await response.text();
    } catch (err) {
      const msg = err.name === 'AbortError'
        ? `Timeout after 10s fetching ${url}`
        : `Network error fetching ${url}: ${err.message}`;
      return { sku, in_stock: false, source_url: url, error: msg };
    }

    // Strategy: visible text first, JSON-LD as fallback
    const visibleStatus = extractVisibleStockStatus(html);
    if (visibleStatus !== null) {
      return { sku, in_stock: visibleStatus, source_url: url, error: null };
    }

    // Fallback: JSON-LD
    const jsonLdProduct = parseProductJsonLd(html);
    if (jsonLdProduct) {
      const jsonLdStatus = extractJsonLdAvailability(jsonLdProduct);
      if (jsonLdStatus !== null) {
        return { sku, in_stock: jsonLdStatus, source_url: url, error: null };
      }
    }

    return {
      sku,
      in_stock: false,
      source_url: url,
      error: `No stock status found (neither visible text nor JSON-LD) at ${url}`,
    };
  }

  /**
   * Check stock for a list of products with rate limiting between requests.
   * @param {Array<{sku: string, supplier_url: string}>} products
   * @returns {Promise<Array<{sku: string, in_stock: boolean, source_url: string, error: string|null}>>}
   */
  async checkStock(products) {
    const results = [];

    for (let i = 0; i < products.length; i++) {
      const result = await this._checkSingle(products[i]);
      results.push(result);

      // Rate limit between requests, but not after the last one
      if (i < products.length - 1) {
        await sleep(this._rateLimitMs);
      }
    }

    return results;
  }
}
