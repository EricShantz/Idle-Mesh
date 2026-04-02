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
