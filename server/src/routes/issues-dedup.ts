import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, issueComments } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

/**
 * Prefixes that indicate a structured/repeating title pattern.
 * For these, we do an exact prefix match on the portion before any variable suffix
 * (e.g. "Deploy Review: costbench - 3 commits" matches "Deploy Review: costbench - 2 commits").
 */
const STRUCTURED_PREFIXES = ["Deploy Review:", "Review:", "Fix CI:"] as const;

/**
 * Common title prefixes stripped before extracting significant words for fuzzy matching.
 */
const STRIP_PREFIXES = [
  "Deploy Review:",
  "Review:",
  "Fix CI:",
  "Fix:",
  "Growth:",
  "Audit:",
  "Update:",
  "Add:",
  "Create:",
  "Implement:",
] as const;

const OPEN_STATUSES = ["todo", "in_progress", "blocked"];

/**
 * Stop words that don't carry meaning for dedup comparison.
 */
const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
  "has", "have", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "must",
  "not", "no", "nor", "so", "if", "then", "than", "that", "this",
  "it", "its", "as", "up", "new",
]);

export type DedupResult = {
  isDuplicate: true;
  existingIssue: { id: string; title: string; identifier: string | null; status: string };
} | {
  isDuplicate: false;
};

/**
 * Check if a title matches a structured prefix pattern.
 * Returns the stable prefix portion for matching, or null if not a structured title.
 *
 * Example: "Deploy Review: costbench - 3 commits" -> "deploy review: costbench"
 * The variable suffix (commit count, date, etc.) is stripped.
 */
function extractStructuredPrefix(title: string): string | null {
  const normalized = title.trim();
  for (const prefix of STRUCTURED_PREFIXES) {
    if (normalized.toLowerCase().startsWith(prefix.toLowerCase())) {
      const afterPrefix = normalized.slice(prefix.length).trim();
      // Take the first meaningful token after the prefix (e.g. project name)
      // and ignore variable suffixes like "- 3 commits" or "- 2026-03-10"
      const dashIndex = afterPrefix.indexOf(" - ");
      const stablePartRaw = dashIndex >= 0 ? afterPrefix.slice(0, dashIndex).trim() : afterPrefix;
      // For matching, we want at least the prefix + project/subject
      const stablePart = stablePartRaw.split(/\s+/).slice(0, 3).join(" ");
      if (stablePart.length > 0) {
        return `${prefix.toLowerCase()} ${stablePart.toLowerCase()}`;
      }
      return prefix.toLowerCase();
    }
  }
  return null;
}

/**
 * Extract significant words from a title for fuzzy matching.
 * Strips common prefixes and stop words, returns first N significant words.
 */
function extractSignificantWords(title: string, maxWords = 5): string[] {
  let cleaned = title.trim();
  // Strip known prefixes
  for (const prefix of STRIP_PREFIXES) {
    if (cleaned.toLowerCase().startsWith(prefix.toLowerCase())) {
      cleaned = cleaned.slice(prefix.length).trim();
      break;
    }
  }

  const words = cleaned
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ") // keep hyphens for compound words
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));

  return words.slice(0, maxWords);
}

/**
 * Check whether a new issue title is a duplicate of an existing open issue.
 *
 * Returns the existing issue if a match is found, or { isDuplicate: false } otherwise.
 */
export async function checkDuplicateIssue(
  db: Db,
  companyId: string,
  newTitle: string,
): Promise<DedupResult> {
  const structuredPrefix = extractStructuredPrefix(newTitle);

  if (structuredPrefix) {
    return checkStructuredDuplicate(db, companyId, newTitle, structuredPrefix);
  }

  return checkFuzzyDuplicate(db, companyId, newTitle);
}

/**
 * For structured titles (Deploy Review:, Review:, Fix CI:), match on the stable prefix portion.
 */
async function checkStructuredDuplicate(
  db: Db,
  companyId: string,
  _newTitle: string,
  structuredPrefix: string,
): Promise<DedupResult> {
  // Query all open issues for this company and filter in-app for the structured prefix match
  const candidates = await db
    .select({
      id: issues.id,
      title: issues.title,
      identifier: issues.identifier,
      status: issues.status,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        inArray(issues.status, OPEN_STATUSES),
      ),
    );

  for (const candidate of candidates) {
    const candidatePrefix = extractStructuredPrefix(candidate.title);
    if (candidatePrefix === structuredPrefix) {
      logger.info(
        {
          newTitle: _newTitle,
          existingTitle: candidate.title,
          existingId: candidate.id,
          existingIdentifier: candidate.identifier,
          matchType: "structured_prefix",
          structuredPrefix,
        },
        "duplicate issue detected (structured prefix match)",
      );
      return {
        isDuplicate: true,
        existingIssue: candidate,
      };
    }
  }

  return { isDuplicate: false };
}

/**
 * For generic titles, extract significant words and check if any open issue shares them.
 */
async function checkFuzzyDuplicate(
  db: Db,
  companyId: string,
  newTitle: string,
): Promise<DedupResult> {
  const significantWords = extractSignificantWords(newTitle);
  if (significantWords.length === 0) {
    return { isDuplicate: false };
  }

  // Build ILIKE conditions for each significant word
  // An existing issue matches if its title contains ALL significant words
  const wordConditions = significantWords.map(
    (word) => sql`${issues.title} ILIKE ${"%" + word + "%"}`,
  );

  const candidates = await db
    .select({
      id: issues.id,
      title: issues.title,
      identifier: issues.identifier,
      status: issues.status,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        inArray(issues.status, OPEN_STATUSES),
        ...wordConditions,
      ),
    );

  if (candidates.length === 0) {
    return { isDuplicate: false };
  }

  // Score candidates: how many of the new title's significant words appear in the candidate?
  // We already filtered to those containing ALL words, so any match is strong.
  // Pick the best match (prefer exact title match, then most recent).
  const normalizedNew = newTitle.trim().toLowerCase();

  // Prefer exact match first
  const exactMatch = candidates.find((c) => c.title.trim().toLowerCase() === normalizedNew);
  if (exactMatch) {
    logger.info(
      {
        newTitle,
        existingTitle: exactMatch.title,
        existingId: exactMatch.id,
        existingIdentifier: exactMatch.identifier,
        matchType: "exact",
      },
      "duplicate issue detected (exact title match)",
    );
    return { isDuplicate: true, existingIssue: exactMatch };
  }

  // For fuzzy matches, also verify the reverse direction: the candidate's significant words
  // should substantially overlap with the new title's words to avoid false positives.
  for (const candidate of candidates) {
    const candidateWords = extractSignificantWords(candidate.title);
    const newWordsSet = new Set(significantWords);
    const candidateWordsSet = new Set(candidateWords);

    // Both directions: new words in candidate AND candidate words in new
    const forwardOverlap = significantWords.filter((w) => candidateWordsSet.has(w)).length;
    const reverseOverlap = candidateWords.filter((w) => newWordsSet.has(w)).length;

    // Require strong bidirectional overlap
    const forwardRatio = forwardOverlap / significantWords.length;
    const reverseRatio = candidateWords.length > 0 ? reverseOverlap / candidateWords.length : 0;

    if (forwardRatio >= 0.8 && reverseRatio >= 0.8) {
      logger.info(
        {
          newTitle,
          existingTitle: candidate.title,
          existingId: candidate.id,
          existingIdentifier: candidate.identifier,
          matchType: "fuzzy",
          forwardRatio,
          reverseRatio,
          significantWords,
          candidateWords,
        },
        "duplicate issue detected (fuzzy word match)",
      );
      return { isDuplicate: true, existingIssue: candidate };
    }
  }

  return { isDuplicate: false };
}

/**
 * Add a dedup comment to an existing issue, noting that a duplicate creation was attempted.
 */
export async function addDedupComment(
  db: Db,
  issueId: string,
  companyId: string,
  actor: { agentId?: string | null; userId?: string | null },
): Promise<void> {
  await db
    .insert(issueComments)
    .values({
      companyId,
      issueId,
      authorAgentId: actor.agentId ?? null,
      authorUserId: actor.userId ?? null,
      body: "Duplicate creation attempted. Original request context preserved.",
    });

  // Update issue's updatedAt so the dedup activity is reflected
  await db
    .update(issues)
    .set({ updatedAt: new Date() })
    .where(eq(issues.id, issueId));
}
