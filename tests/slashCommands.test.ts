import { describe, it, expect } from "vitest";
import { slashContext, insertBlock } from "../src/client/lib/slashCommands.js";

describe("slashContext — token detection + matching", () => {
  it("opens on a bare slash at line start", () => {
    const ctx = slashContext("/", 1);
    expect(ctx).not.toBeNull();
    expect(ctx!.matches.map((m) => m.id)).toContain("add-image");
    expect(ctx!.start).toBe(0);
  });

  it("matches by full-name prefix (/a, /add, /add-im)", () => {
    for (const q of ["/a", "/add", "/add-im"]) {
      const ctx = slashContext(q, q.length);
      expect(ctx?.matches[0]?.id, q).toBe("add-image");
    }
  });

  it("matches by the word after the dash (/i, /ima, /image)", () => {
    for (const q of ["/i", "/ima", "/image"]) {
      const ctx = slashContext(q, q.length);
      expect(ctx?.matches[0]?.id, q).toBe("add-image");
    }
  });

  it("is case-insensitive", () => {
    expect(slashContext("/ADD", 4)?.matches[0]?.id).toBe("add-image");
  });

  it("dismisses on a space or a non-matching query", () => {
    expect(slashContext("/add ", 5)).toBeNull();
    expect(slashContext("/x", 2)).toBeNull();
    expect(slashContext("/adz", 4)).toBeNull();
  });

  it("opens after whitespace mid-line but not mid-word (URLs)", () => {
    const midLine = "see /ad";
    expect(slashContext(midLine, midLine.length)?.start).toBe(4);
    const url = "https://x";
    expect(slashContext(url, url.length)).toBeNull();
  });

  it("only considers the token ending at the caret", () => {
    const v = "/add more text";
    expect(slashContext(v, 4)?.query).toBe("add"); // caret right after /add
    expect(slashContext(v, v.length)).toBeNull(); // caret after other text
  });
});

describe("insertBlock — placement", () => {
  const BLOCK = "![img]";

  it("replaces the token in place when alone on its line", () => {
    const r = insertBlock("/add", 0, 4, BLOCK);
    expect(r.value).toBe("![img]");
    expect(r.value.slice(r.blockStart, r.blockEnd)).toBe(BLOCK);
  });

  it("keeps surrounding lines when replacing in place", () => {
    const v = "before\n/add\nafter";
    const r = insertBlock(v, 7, 11, BLOCK);
    expect(r.value).toBe("before\n![img]\nafter");
  });

  it("moves to the next line when typed after text", () => {
    const v = "some text /add";
    const r = insertBlock(v, 10, 14, BLOCK);
    expect(r.value).toBe("some text \n![img]");
    expect(r.value.slice(r.blockStart, r.blockEnd)).toBe(BLOCK);
  });

  it("inserts between lines when typed after text mid-document", () => {
    const v = "text /a\nnext line";
    const r = insertBlock(v, 5, 7, BLOCK);
    expect(r.value).toBe("text \n![img]\nnext line");
  });

  it("preserves text after the caret on the same line", () => {
    // caret between "/a" and " tail" — token is "/a", tail stays on its line
    const v = "head /a tail";
    const r = insertBlock(v, 5, 7, BLOCK);
    expect(r.value).toBe("head  tail\n![img]");
  });
});
