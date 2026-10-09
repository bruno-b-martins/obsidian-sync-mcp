import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { deriveContent, applyIndexChange, pruneGhosts, type IndexTarget } from "./index-sync.js";

/**
 * Regression tests for zero-byte notes being dropped from the search index
 * (issues #5 cold-start and #6 list_notes). A deleted note must be removed; an
 * empty-but-present note must be indexed. The old `if (content)` truthiness
 * check conflated the two and dropped empty notes.
 */

// Minimal stand-in for SearchIndex.
class FakeIndex implements IndexTarget {
    private paths = new Set<string>();
    update(path: string) { this.paths.add(path); }
    remove(path: string) { this.paths.delete(path); }
    has(path: string) { return this.paths.has(path); }
    get size() { return this.paths.size; }
}

describe("deriveContent — delete vs empty", () => {
    it("returns null for a deleted note", () => {
        assert.equal(deriveContent({ deleted: true, data: [""] }), null);
    });
    it("returns '' for an existing empty note (data: [])", () => {
        assert.equal(deriveContent({ data: [] }), "");
    });
    it("returns '' for an existing note with no data array", () => {
        assert.equal(deriveContent({}), "");
    });
    it("returns the joined body for a normal note", () => {
        assert.equal(deriveContent({ data: ["# Title\n", "body"] }), "# Title\nbody");
    });
});

describe("applyIndexChange — routing", () => {
    let index: FakeIndex;
    beforeEach(() => { index = new FakeIndex(); });

    it("indexes an empty note instead of dropping it", () => {
        applyIndexChange(index, "empty.md", "");
        assert.ok(index.has("empty.md"), "empty note should be indexed");
    });

    it("removes a note on delete (null content)", () => {
        applyIndexChange(index, "gone.md", "seed"); // present first
        applyIndexChange(index, "gone.md", null);
        assert.ok(!index.has("gone.md"), "deleted note should be removed");
    });

    it("indexes a normal note", () => {
        applyIndexChange(index, "note.md", "text");
        assert.ok(index.has("note.md"));
    });

    it("reproduces issue #5: 1 content note + 3 empty notes all index", () => {
        // End-to-end of the cold-start routing over a mixed batch.
        const changes: Array<[string, string | null]> = [
            ["alpha.md", "# Alpha\ncontent"],
            ["beta.md", ""],
            ["gamma.md", ""],
            ["delta.md", ""],
        ];
        for (const [path, content] of changes) applyIndexChange(index, path, content);
        assert.equal(index.size, 4, `expected all 4 notes indexed, got ${index.size}`);
    });
});

describe("pruneGhosts — remove notes that vanished with no tombstone", () => {
    let index: FakeIndex;
    beforeEach(() => { index = new FakeIndex(); });

    it("removes a loaded path the from-zero pass did not re-deliver", () => {
        index.update("ghost.md"); // persisted, now gone from the DB (no tombstone)
        index.update("live.md");
        const preexisting = ["ghost.md", "live.md"];
        const seen = new Set(["live.md"]); // only live.md re-delivered
        const removed = pruneGhosts(index, preexisting, seen);
        assert.deepEqual(removed, ["ghost.md"]);
        assert.ok(!index.has("ghost.md"), "ghost should be pruned");
        assert.ok(index.has("live.md"), "re-delivered note should stay");
    });

    it("never prunes a note the watcher added mid-pass (not in preexisting)", () => {
        // The invariant that keeps the prune safe against the concurrent watcher.
        index.update("fresh.md"); // added by the watcher during the pass
        const preexisting: string[] = []; // it was not loaded from disk
        const seen = new Set<string>(); // nor re-delivered by this pass
        const removed = pruneGhosts(index, preexisting, seen);
        assert.deepEqual(removed, []);
        assert.ok(index.has("fresh.md"), "watcher-added note must not be pruned");
    });

    it("keeps everything when the pass re-delivered every loaded path", () => {
        index.update("a.md");
        index.update("b.md");
        const removed = pruneGhosts(index, ["a.md", "b.md"], new Set(["a.md", "b.md"]));
        assert.deepEqual(removed, []);
        assert.equal(index.size, 2);
    });
});
