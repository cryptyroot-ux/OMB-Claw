/**
 * Session Tree — Pi-style JSONL conversation tree.
 *
 * A thread is a linear chain of messages with an active leaf. Session Tree adds
 * branching: a thread can fork from a parent thread at a specific message,
 * creating a new timeline. Each thread records its parent_thread_id and the
 * branch_point_message_id where it diverged.
 *
 * This enables:
 * - Fork: create a child thread from a parent at any message
 * - Branch switch: change the active leaf within a thread
 * - Resume: load messages along the active branch path
 * - Ancestry: walk from any thread back to its root
 */

import * as mdb from "./message-db.ts";

/** Result of forking a thread. */
export interface ForkThreadResult {
  readonly newThreadId: string;
  readonly copiedMessageCount: number;
  readonly parentThreadId: string;
  readonly branchPointMessageId: string | null;
}

/** Branch information for a thread. */
export interface ThreadBranch {
  readonly threadId: string;
  readonly parentThreadId: string | null;
  readonly branchPointMessageId: string | null;
  readonly branchSummary: string | null;
  readonly activeLeafId: string | null;
}

/** Ancestry chain from root to the given thread. */
export type ThreadAncestry = string[];

/**
 * Fork a child thread from a parent.
 *
 * Copies all messages from the parent up to and including `fromMessageId`
 * (or all messages if `fromMessageId` is null) into a new thread, then
 * records the parent relationship so the tree can be walked later.
 */
export function forkThread(
  parentThreadId: string,
  fromMessageId: string | null,
  newThreadId: string,
): ForkThreadResult {
  return mdb.forkThread(parentThreadId, fromMessageId, newThreadId);
}

/** Get branch information for a thread. */
export function getThreadBranch(threadId: string): ThreadBranch | undefined {
  return mdb.getThreadBranch(threadId);
}

/** Update branch metadata on a thread (parent, branch point, summary). */
export function setThreadBranch(
  threadId: string,
  options: {
    readonly parentThreadId?: string | null;
    readonly branchPointMessageId?: string | null;
    readonly branchSummary?: string | null;
  },
): void {
  mdb.setThreadBranch(threadId, options);
}

/** List all direct child threads forked from a parent. */
export function listThreadChildren(parentThreadId: string): string[] {
  return mdb.listThreadChildren(parentThreadId);
}

/** Walk from a thread back to its root, returning the chain root-first. */
export function getThreadAncestry(threadId: string): ThreadAncestry {
  return mdb.getThreadAncestry(threadId);
}

/** Check whether a thread has a parent (i.e. is a fork/branch). */
export function isForkedThread(threadId: string): boolean {
  const branch = getThreadBranch(threadId);
  return Boolean(branch?.parentThreadId);
}

/** Get the root thread of a branch chain (the thread with no parent). */
export function getThreadRoot(threadId: string): string {
  let current = threadId;
  let depth = 0;
  while (depth < 100) {
    const branch = getThreadBranch(current);
    if (!branch || !branch.parentThreadId) return current;
    current = branch.parentThreadId;
    depth++;
  }
  return current;
}
