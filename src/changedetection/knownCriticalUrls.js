/**
 * Priority classification for watched URLs.
 *
 * HIGH   — Adda procurement portals and direct competitors with active pricing.
 * MEDIUM — Secondary competitors and supplier new-product pages.
 * LOW    — Peripheral competitors with low relevance to core product range.
 *
 * If a URL does not match any entry, it defaults to MEDIUM.
 */

/** @type {{ pattern: RegExp; priority: 'HIGH' | 'MEDIUM' | 'LOW' }[]} */
export const URL_PRIORITY_RULES = [
  // Adda/SKL Kommentus — critical procurement portals
  { pattern: /adda\.se.*lekmaterial/i, priority: 'HIGH' },
  { pattern: /adda\.se.*mobler.*forskola/i, priority: 'HIGH' },
  { pattern: /adda\.se/i, priority: 'HIGH' },

  // Direct high-priority competitors
  { pattern: /menoj\.se/i, priority: 'HIGH' },
  { pattern: /lekolar\.se/i, priority: 'HIGH' },
  { pattern: /abaskol\.se/i, priority: 'HIGH' },
  { pattern: /woodwork\.se/i, priority: 'HIGH' },
  { pattern: /mobitec\.se/i, priority: 'HIGH' },

  // Medium-priority competitors
  { pattern: /smartbaby\.se/i, priority: 'MEDIUM' },
  { pattern: /lekakademin\.se/i, priority: 'MEDIUM' },
  { pattern: /nordicadesign\.se/i, priority: 'MEDIUM' },

  // Supplier new-products page
  { pattern: /beleduc\.de.*neuheiten/i, priority: 'MEDIUM' },
  { pattern: /beleduc\.de/i, priority: 'MEDIUM' },

  // Low-priority competitors
  { pattern: /kulbansen\.se/i, priority: 'LOW' },
  { pattern: /lyreco\.se/i, priority: 'LOW' },
  { pattern: /tressport\.se/i, priority: 'LOW' },
  { pattern: /creativcompany\.se/i, priority: 'LOW' },
];

/**
 * Returns the priority for a given URL based on the rules above.
 * Defaults to 'MEDIUM' if no rule matches.
 *
 * @param {string} url
 * @returns {'HIGH' | 'MEDIUM' | 'LOW'}
 */
export function classifyPriority(url) {
  for (const rule of URL_PRIORITY_RULES) {
    if (rule.pattern.test(url)) {
      return rule.priority;
    }
  }
  return 'MEDIUM';
}
