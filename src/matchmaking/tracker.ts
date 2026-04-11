/**
 * Task 08: Multiple Matchmaking Comments - Track and prevent duplicate matches
 *
 * Issue: https://github.com/ubiquity-os-marketplace/text-vector-embeddings/issues/94
 *
 * System to track matchmaking comments and prevent duplicate processing.
 */

// ============================================
// Types
// ============================================

interface MatchComment {
  id: string;
  issueId: string;
  commentId: string;
  matchedAt: Date;
  matchedBy: string;
  matchType: 'skill' | 'availability' | 'interest';
  confidence: number;
  metadata?: Record<string, unknown>;
}

interface IssueMatchSummary {
  issueId: string;
  totalMatches: number;
  firstMatchAt: Date | null;
  lastMatchAt: Date | null;
  matchedBy: string[];
}

// ============================================
// Matchmaking Tracker
// ============================================

export class MatchmakingTracker {
  private matches: Map<string, MatchComment[]> = new Map();

  /**
   * Record a new match
   */
  recordMatch(
    issueId: string,
    matchData: Omit<MatchComment, 'id' | 'matchedAt'>
  ): string {
    const matchId = this.generateId();

    const match: MatchComment = {
      id: matchId,
      issueId,
      matchedAt: new Date(),
      ...matchData,
    };

    if (!this.matches.has(issueId)) {
      this.matches.set(issueId, []);
    }

    this.matches.get(issueId)!.push(match);

    console.log(`[Matchmaking] Recorded match ${matchId} for issue ${issueId}`);

    return matchId;
  }

  /**
   * Get match count for an issue
   */
  getMatchCount(issueId: string): number {
    return this.matches.get(issueId)?.length ?? 0;
  }

  /**
   * Get latest match for an issue
   */
  getLatestMatch(issueId: string): MatchComment | null {
    const matches = this.matches.get(issueId);
    if (!matches || matches.length === 0) return null;
    return matches[matches.length - 1];
  }

  /**
   * Get all matches for an issue
   */
  getMatches(issueId: string): MatchComment[] {
    return this.matches.get(issueId) ?? [];
  }

  /**
   * Check if issue should be processed
   * Returns false if already matched threshold times
   */
  shouldProcess(issueId: string, threshold: number = 1): boolean {
    return this.getMatchCount(issueId) < threshold;
  }

  /**
   * Check if a specific comment was already processed
   */
  isCommentProcessed(commentId: string): boolean {
    for (const matches of this.matches.values()) {
      if (matches.some(m => m.commentId === commentId)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get summary for an issue
   */
  getSummary(issueId: string): IssueMatchSummary {
    const matches = this.matches.get(issueId) ?? [];

    return {
      issueId,
      totalMatches: matches.length,
      firstMatchAt: matches.length > 0 ? matches[0].matchedAt : null,
      lastMatchAt: matches.length > 0 ? matches[matches.length - 1].matchedAt : null,
      matchedBy: [...new Set(matches.map(m => m.matchedBy))],
    };
  }

  /**
   * Remove duplicate matches (same user, similar confidence)
   */
  dedupeMatches(issueId: string): number {
    const matches = this.matches.get(issueId);
    if (!matches) return 0;

    const seen = new Map<string, MatchComment>();

    for (const match of matches) {
      const key = `${match.matchedBy}-${match.matchType}`;

      if (!seen.has(key)) {
        seen.set(key, match);
      } else {
        // Keep the match with higher confidence
        const existing = seen.get(key)!;
        if (match.confidence > existing.confidence) {
          seen.set(key, match);
        }
      }
    }

    const deduped = Array.from(seen.values());
    const removed = matches.length - deduped.length;

    if (removed > 0) {
      this.matches.set(issueId, deduped);
      console.log(`[Matchmaking] Removed ${removed} duplicate matches from issue ${issueId}`);
    }

    return removed;
  }

  /**
   * Clear matches for an issue
   */
  clearMatches(issueId: string): boolean {
    return this.matches.delete(issueId);
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalIssues: number;
    totalMatches: number;
    avgMatchesPerIssue: number;
  } {
    const totalIssues = this.matches.size;
    const totalMatches = Array.from(this.matches.values())
      .reduce((sum, m) => sum + m.length, 0);
    const avgMatchesPerIssue = totalIssues > 0 ? totalMatches / totalIssues : 0;

    return { totalIssues, totalMatches, avgMatchesPerIssue };
  }

  /**
   * Generate unique ID
   */
  private generateId(): string {
    return `match-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}

// ============================================
// Match Processing Queue
// ============================================

interface QueuedMatch {
  issueId: string;
  commentId: string;
  userId: string;
  priority: number;
  addedAt: Date;
}

export class MatchProcessingQueue {
  private queue: QueuedMatch[] = [];
  private processed: Set<string> = new Set();
  private tracker: MatchmakingTracker;

  constructor(tracker: MatchmakingTracker) {
    this.tracker = tracker;
  }

  /**
   * Add match to processing queue
   */
  enqueue(issueId: string, commentId: string, userId: string, priority: number = 0): void {
    // Check if already processed
    if (this.processed.has(commentId)) {
      console.log(`[Queue] Comment ${commentId} already processed, skipping`);
      return;
    }

    // Check if issue has enough matches
    if (!this.tracker.shouldProcess(issueId)) {
      console.log(`[Queue] Issue ${issueId} already has enough matches`);
      return;
    }

    this.queue.push({
      issueId,
      commentId,
      userId,
      priority,
      addedAt: new Date(),
    });

    // Sort by priority (higher first)
    this.queue.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Get next match to process
   */
  dequeue(): QueuedMatch | null {
    return this.queue.shift() ?? null;
  }

  /**
   * Mark comment as processed
   */
  markProcessed(commentId: string): void {
    this.processed.add(commentId);
  }

  /**
   * Get queue length
   */
  get length(): number {
    return this.queue.length;
  }

  /**
   * Check if queue is empty
   */
  isEmpty(): boolean {
    return this.queue.length === 0;
  }
}

// ============================================
// Usage examples
// ============================================

const tracker = new MatchmakingTracker();

// Example 1: Record matches
tracker.recordMatch('issue-123', {
  commentId: 'comment-456',
  matchedBy: 'user-alice',
  matchType: 'skill',
  confidence: 0.85,
});

tracker.recordMatch('issue-123', {
  commentId: 'comment-789',
  matchedBy: 'user-bob',
  matchType: 'availability',
  confidence: 0.92,
});

// Example 2: Check match count
const count = tracker.getMatchCount('issue-123');
console.log(`Issue 123 has ${count} matches`);

// Example 3: Get latest match
const latest = tracker.getLatestMatch('issue-123');
console.log('Latest match:', latest);

// Example 4: Check if should process
if (tracker.shouldProcess('issue-123', 3)) {
  console.log('Issue needs more matches');
}

// Example 5: Dedupe matches
const removed = tracker.dedupeMatches('issue-123');
console.log(`Removed ${removed} duplicates`);

// Example 6: Get summary
const summary = tracker.getSummary('issue-123');
console.log('Summary:', summary);

// Example 7: Use processing queue
const queue = new MatchProcessingQueue(tracker);
queue.enqueue('issue-456', 'comment-111', 'user-charlie', 1);
queue.enqueue('issue-456', 'comment-112', 'user-dave', 2);

while (!queue.isEmpty()) {
  const match = queue.dequeue()!;
  console.log(`Processing: ${match.commentId}`);
  queue.markProcessed(match.commentId);
}

// ============================================
// Export
// ============================================

export { type MatchComment, type IssueMatchSummary };
