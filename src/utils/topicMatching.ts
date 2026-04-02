/**
 * Solace-style topic matching utilities.
 *
 * Topic format: segments separated by `/`
 * Wildcards (subscription patterns only):
 *   `*` — matches exactly one level
 *   `>` — matches one or more trailing levels (must be last segment)
 */

export function topicMatches(
  publishTopic: string,
  subscriptionPattern: string,
): boolean {
  const pubParts = publishTopic.split('/');
  const subParts = subscriptionPattern.split('/');

  for (let i = 0; i < subParts.length; i++) {
    const sub = subParts[i];

    if (sub === '>') {
      // `>` matches one or more remaining levels — must be last segment
      return i < pubParts.length;
    }

    if (i >= pubParts.length) return false;

    if (sub !== '*' && sub !== pubParts[i]) return false;
  }

  return pubParts.length === subParts.length;
}

const TOPIC_DOT_COLORS: Record<string, string> = {
  orders:    '#22d3ee', // bright cyan
  payments:  '#00aaff', // electric blue
  inventory: '#1d4ed8', // deep blue
  shipping:  '#ffffff', // white-blue
};

/** Returns the event dot color for a publisher's topic domain. */
export function getTopicDotColor(topic: string | undefined): string {
  if (!topic) return '#22d3ee';
  const domain = topic.split('/')[1];
  return TOPIC_DOT_COLORS[domain] ?? '#22d3ee';
}

const TOPIC_VALUE_BONUSES: Record<string, number> = {
  orders:    0.00, // base $0.50
  payments:  0.50, // base $1.00  (+$0.50)
  inventory: 1.50, // base $2.00  (+$1.00)
  shipping:  3.50, // base $4.00  (+$2.00)
};

/**
 * Returns a flat value bonus based on the domain segment of a topic.
 * e.g. acme/payments/... → +$0.25, acme/orders/... → +$0.10
 */
export function getTopicValueBonus(topic: string | undefined): number {
  if (!topic) return 0;
  const domain = topic.split('/')[1];
  return TOPIC_VALUE_BONUSES[domain] ?? 0;
}

/**
 * Returns a specificity bonus multiplier (1.0–1.5x) based on how precisely
 * the subscription matches the publisher topic. Exact match = 1.5x, broadest = 1.0x.
 *
 * Counts wildcard/collapsed segments in the subscription pattern:
 *   0 wildcards (exact) → 1.5x
 *   1 wildcard (*) → 1.4x
 *   > at position N from end → scales down to 1.0x at maximum broadening
 */
export function getSpecificityMultiplier(
  pubTopic: string | undefined,
  subscriptionTopic: string | undefined,
): number {
  if (!pubTopic || !subscriptionTopic) return 1.0;

  const pubSegments = pubTopic.split('/');
  const subParts = subscriptionTopic.split('/');

  // Count how many levels are wildcarded
  let wildcardedLevels = 0;
  const totalLevels = pubSegments.length;

  if (subParts[subParts.length - 1] === '>') {
    // `>` collapses (totalLevels - (subParts.length - 1)) levels
    wildcardedLevels = totalLevels - (subParts.length - 1);
  } else {
    wildcardedLevels = subParts.filter(s => s === '*').length;
  }

  // Map 0 wildcards → 1.5x, totalLevels wildcards → 1.0x
  const maxBonus = 0.5;
  const bonus = maxBonus * (1 - wildcardedLevels / totalLevels);
  return 1.0 + bonus;
}

/**
 * Compute a broadened subscription from the original full topic segments.
 *
 * Level 0: full specific topic (no wildcards)
 * Level 1: last segment → `*`
 * Level 2+: last N segments collapsed → `>`
 *
 * Example for `acme/orders/created/na/electronics/SKU001` (6 segments):
 *   0 → acme/orders/created/na/electronics/SKU001
 *   1 → acme/orders/created/na/electronics/*
 *   2 → acme/orders/created/na/>
 *   3 → acme/orders/created/>
 *   4 → acme/orders/>
 *   5 → acme/>
 */
export function computeBroadenedTopic(
  segments: string[],
  broadenLevel: number,
): string {
  if (broadenLevel <= 0 || segments.length <= 1) {
    return segments.join('/');
  }

  if (broadenLevel === 1) {
    return [...segments.slice(0, -1), '*'].join('/');
  }

  // Level 2+: keep first (segments.length - broadenLevel) segments, append `>`
  const keep = Math.max(1, segments.length - broadenLevel);
  return [...segments.slice(0, keep), '>'].join('/');
}
