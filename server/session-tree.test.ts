import { afterEach, describe, expect, it } from "vitest";

import {
  forkThread,
  getThreadAncestry,
  getThreadBranch,
  getThreadRoot,
  isForkedThread,
  listThreadChildren,
  setThreadBranch,
} from "./session-tree.ts";
import { insertMessage, setActiveLeaf } from "./message-db.ts";
import type { Message } from "./store.ts";

function makeMessage(id: string, text: string, at: number): Message {
  return {
    id,
    kind: "text",
    role: "user",
    text,
    at,
  } as unknown as Message;
}

function setupThread(
  threadId: string,
  messages: Array<{ id: string; text: string; at: number }>,
): void {
  for (const msg of messages) {
    insertMessage(threadId, makeMessage(msg.id, msg.text, msg.at));
  }
  setActiveLeaf(threadId, messages.at(-1)?.id ?? null);
}

function tid(name: string): string {
  return `st-${name}`;
}

describe("session-tree", () => {
  afterEach(() => {});

  it("forkThread copies all messages when fromMessageId is null", () => {
    const parent = tid("parent-all");
    const child = tid("child-all");
    setupThread(parent, [
      { id: "m1", text: "first", at: 1000 },
      { id: "m2", text: "second", at: 2000 },
      { id: "m3", text: "third", at: 3000 },
    ]);

    const result = forkThread(parent, null, child);

    expect(result.newThreadId).toBe(child);
    expect(result.parentThreadId).toBe(parent);
    expect(result.branchPointMessageId).toBeNull();
    expect(result.copiedMessageCount).toBe(3);

    const branch = getThreadBranch(child);
    expect(branch?.parentThreadId).toBe(parent);
    expect(branch?.branchPointMessageId).toBeNull();
    expect(branch?.activeLeafId).toBe("m3");
  });

  it("forkThread copies messages up to and including fromMessageId", () => {
    const parent = tid("parent-partial");
    const child = tid("child-partial");
    setupThread(parent, [
      { id: "m1", text: "first", at: 1000 },
      { id: "m2", text: "second", at: 2000 },
      { id: "m3", text: "third", at: 3000 },
    ]);

    const result = forkThread(parent, "m2", child);

    expect(result.copiedMessageCount).toBe(2);
    expect(result.branchPointMessageId).toBe("m2");

    const branch = getThreadBranch(child);
    expect(branch?.activeLeafId).toBe("m2");
    expect(branch?.branchPointMessageId).toBe("m2");
  });

  it("forkThread throws when parent thread does not exist", () => {
    expect(() => forkThread("st-nonexistent-parent", null, tid("child"))).toThrow(
      /does not exist/,
    );
  });

  it("forkThread throws when child thread already exists", () => {
    const parent = tid("parent-exists");
    const child = tid("child-exists");
    setupThread(parent, [{ id: "m1", text: "first", at: 1000 }]);
    forkThread(parent, null, child);

    expect(() => forkThread(parent, null, child)).toThrow(/already exists/);
  });

  it("forkThread throws when fromMessageId is not in parent", () => {
    const parent = tid("parent-bad-msg");
    const child = tid("child-bad-msg");
    setupThread(parent, [{ id: "m1", text: "first", at: 1000 }]);

    expect(() => forkThread(parent, "nonexistent-msg", child)).toThrow(
      /not found/,
    );
  });

  it("getThreadBranch returns undefined for non-existent thread", () => {
    expect(getThreadBranch("st-no-such-thread")).toBeUndefined();
  });

  it("setThreadBranch updates branch metadata", () => {
    const parent = tid("parent-set-branch");
    const child = tid("child-set-branch");
    setupThread(parent, [{ id: "m1", text: "first", at: 1000 }]);
    forkThread(parent, "m1", child);

    setThreadBranch(child, {
      branchSummary: "Summary of parent up to m1",
    });

    const branch = getThreadBranch(child);
    expect(branch?.branchSummary).toBe("Summary of parent up to m1");
    expect(branch?.parentThreadId).toBe(parent);
    expect(branch?.branchPointMessageId).toBe("m1");
  });

  it("listThreadChildren returns children of a parent", () => {
    const parent = tid("parent-list");
    const child1 = tid("child-list-1");
    const child2 = tid("child-list-2");
    setupThread(parent, [{ id: "m1", text: "first", at: 1000 }]);
    forkThread(parent, null, child1);
    forkThread(parent, null, child2);

    const children = listThreadChildren(parent);
    expect(children).toContain(child1);
    expect(children).toContain(child2);
  });

  it("getThreadAncestry walks from child to root", () => {
    const parent = tid("parent-ancestry");
    const child = tid("child-ancestry");
    setupThread(parent, [{ id: "m1", text: "first", at: 1000 }]);
    forkThread(parent, null, child);

    const ancestry = getThreadAncestry(child);
    expect(ancestry).toEqual([parent, child]);
  });

  it("getThreadAncestry for root thread returns just itself", () => {
    const parent = tid("parent-root-ancestry");
    setupThread(parent, [{ id: "m1", text: "first", at: 1000 }]);

    const ancestry = getThreadAncestry(parent);
    expect(ancestry).toEqual([parent]);
  });

  it("isForkedThread returns true for forked thread", () => {
    const parent = tid("parent-forked");
    const child = tid("child-forked");
    setupThread(parent, [{ id: "m1", text: "first", at: 1000 }]);
    expect(isForkedThread(parent)).toBe(false);

    forkThread(parent, null, child);
    expect(isForkedThread(child)).toBe(true);
  });

  it("getThreadRoot returns the root of a chain", () => {
    const parent = tid("parent-root");
    const child = tid("child-root");
    const grandchild = tid("grandchild-root");
    setupThread(parent, [{ id: "m1", text: "first", at: 1000 }]);
    forkThread(parent, null, child);
    forkThread(child, null, grandchild);

    expect(getThreadRoot(grandchild)).toBe(parent);
    expect(getThreadRoot(child)).toBe(parent);
    expect(getThreadRoot(parent)).toBe(parent);
  });
});
