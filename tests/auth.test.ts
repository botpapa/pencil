import { describe, it, expect } from "vitest";
import { signCookie, verifyCookie, constantTimeEqual } from "../src/lib/auth.js";
import { newSlug, newOwnerId, isValidSlug } from "../src/lib/slug.js";

describe("cookie sign/verify", () => {
  const SECRET = "test-cookie-secret";
  it("verifies its own signed cookie", async () => {
    const uid = "abc123-uid";
    const signed = await signCookie(uid, SECRET);
    expect(signed).toContain(".");
    expect(signed.startsWith(`${uid}.`)).toBe(true);
    const verified = await verifyCookie(signed, SECRET);
    expect(verified).toBe(uid);
  });

  it("rejects tampered signature", async () => {
    const signed = await signCookie("abc", SECRET);
    const tampered = signed.slice(0, -3) + "AAA";
    const verified = await verifyCookie(tampered, SECRET);
    expect(verified).toBeNull();
  });

  it("rejects tampered uid", async () => {
    const signed = await signCookie("abc", SECRET);
    const tampered = "xyz" + signed.slice(3);
    const verified = await verifyCookie(tampered, SECRET);
    expect(verified).toBeNull();
  });

  it("rejects malformed cookie", async () => {
    expect(await verifyCookie("nodot", SECRET)).toBeNull();
    expect(await verifyCookie("a.", SECRET)).toBeNull();
    expect(await verifyCookie(".b", SECRET)).toBeNull();
    expect(await verifyCookie("", SECRET)).toBeNull();
  });

  it("rejects cookie signed with different secret", async () => {
    const signed = await signCookie("abc", "secret-a");
    expect(await verifyCookie(signed, "secret-b")).toBeNull();
  });

  it("rejects oversize cookie value before doing any HMAC work", async () => {
    // 1 MB of garbage with a dot somewhere — should bail fast on the length
    // cap, not spend HMAC time signing the giant uid.
    const huge = "a".repeat(1_000_000) + ".sig";
    const start = performance.now();
    const result = await verifyCookie(huge, SECRET);
    const elapsed = performance.now() - start;
    expect(result).toBeNull();
    // Length cap should make this near-instant. HMAC on 1 MB would be far
    // slower than 50 ms even on the fastest machines; give plenty of room
    // for CI variance.
    expect(elapsed).toBeLessThan(50);
  });
});

describe("constantTimeEqual", () => {
  it("matches identical strings", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
  });
  it("rejects different strings", () => {
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "x")).toBe(false);
  });
});

describe("slug & owner id generators", () => {
  it("slug is 8 chars from unambiguous alphabet", () => {
    for (let i = 0; i < 50; i++) {
      const s = newSlug();
      expect(s).toHaveLength(8);
      expect(isValidSlug(s)).toBe(true);
      // No ambiguous chars.
      expect(s).not.toMatch(/[01OIl]/);
    }
  });

  it("newSlug always satisfies isValidSlug (regression: no 9-char fallback)", () => {
    // Sample broadly. The earlier `pickUniqueSlug` returned 9 chars on its
    // fallback path which would 404 every read. With the atomic-insert
    // refactor, every slug we generate must be exactly the canonical 8.
    for (let i = 0; i < 1000; i++) {
      const s = newSlug();
      expect(s).toHaveLength(8);
      expect(isValidSlug(s)).toBe(true);
    }
  });

  it("owner id is 24 chars", () => {
    expect(newOwnerId()).toHaveLength(24);
  });

  it("isValidSlug rejects bad inputs", () => {
    expect(isValidSlug("toolong00")).toBe(false);
    expect(isValidSlug("short")).toBe(false);
    expect(isValidSlug("hasOhere")).toBe(false); // 'O' not in alphabet
    expect(isValidSlug("hasl0her")).toBe(false); // '0' not in alphabet
    expect(isValidSlug("aaaaaaaa")).toBe(true);
  });
});
