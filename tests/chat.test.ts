import { describe, it, expect } from "vitest";
import { SELF, env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import type { ChatRoom } from "../src/chat/room.js";

// chat.* hosts are their own app, like draw.*.
const CHAT = "https://chat.localhost";

// 1×1 PNG.
const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function createChat(title = "standup"): Promise<string> {
  const res = await SELF.fetch(`${CHAT}/api/chats`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }) });
  expect(res.status).toBe(201);
  const j = await json<{ slug: string; url: string }>(res);
  expect(j.url).toBe(`${CHAT}/${j.slug}`);
  return j.slug;
}

async function join(slug: string, nickname: string, extra: Record<string, unknown> = {}) {
  return SELF.fetch(`${CHAT}/api/chats/${slug}/join`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nickname, ...extra }) });
}

async function token(slug: string, nickname: string): Promise<string> {
  const res = await join(slug, nickname);
  expect(res.status).toBe(201);
  return (await json<{ member_token: string }>(res)).member_token;
}

async function send(slug: string, tok: string, body: Record<string, unknown>) {
  return SELF.fetch(`${CHAT}/api/chats/${slug}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` },
    body: JSON.stringify(body),
  });
}

describe("chat — rooms", () => {
  it("serves the landing page and creates a chat from the form", async () => {
    const home = await SELF.fetch(`${CHAT}/`);
    expect(home.status).toBe(200);
    const homeHtml = await home.text();
    expect(homeHtml).toContain("start chat");
    expect(homeHtml).toContain("join chat");
    const res = await SELF.fetch(`${CHAT}/new`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "", redirect: "manual" });
    expect(res.status).toBe(303);
    const loc = res.headers.get("Location")!;
    expect(loc).toMatch(/^\/[A-Za-z0-9]{8}$/);
    const room = await SELF.fetch(`${CHAT}${loc}`);
    expect(room.status).toBe(200);
    const html = await room.text();
    expect(html).toContain('data-page="room"');
    expect(room.headers.get("Content-Security-Policy")).toContain("wss://chat.localhost");
  });

  it("lets participants rename a chat", async () => {
    const slug = await createChat("");
    const t = await token(slug, "ann");
    const patch = (body: Record<string, unknown>, auth = t) =>
      SELF.fetch(`${CHAT}/api/chats/${slug}`, { method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth}` }, body: JSON.stringify(body) });
    expect((await patch({ title: "nope" }, "pct_nope_nope")).status).toBe(401);
    expect((await patch({ title: 5 })).status).toBe(400);
    const res = await patch({ title: "  standup  " });
    expect(res.status).toBe(200);
    expect((await json<{ title: string }>(res)).title).toBe("standup");
    expect((await json<{ title: string }>(await SELF.fetch(`${CHAT}/api/chats/${slug}`))).title).toBe("standup");
  });

  it("404s unknown chats without creating them", async () => {
    expect((await SELF.fetch(`${CHAT}/abcdefgh`)).status).toBe(404);
    expect((await SELF.fetch(`${CHAT}/api/chats/abcdefgh`)).status).toBe(404);
    expect((await join("abcdefgh", "x")).status).toBe(404);
  });

  it("joins, sends markdown, reads it back with authors", async () => {
    const slug = await createChat();
    const ann = await token(slug, "ann");
    const res = await send(slug, ann, { text: "hello **world** <script>alert(1)</script>" });
    expect(res.status).toBe(201);
    const sent = await json<{ message: { seq: number; text: string } }>(res);
    expect(sent.message.text).toContain("hello");

    const read = await json<{ messages: { type: string; nickname: string; text: string; seq: number }[]; next_after: number }>(
      await SELF.fetch(`${CHAT}/api/chats/${slug}/messages`),
    );
    expect(read.messages.map((m) => m.type)).toEqual(["join", "message"]);
    expect(read.messages[1]!.nickname).toBe("ann");
    expect(read.next_after).toBe(sent.message.seq);

    const client = await json<{ messages: { html: string }[] }>(await SELF.fetch(`${CHAT}/api/chats/${slug}/messages?format=client`));
    expect(client.messages[1]!.html).toContain("<strong>world</strong>");
    expect(client.messages[1]!.html).not.toContain("<script");

    const newer = await json<{ messages: unknown[] }>(await SELF.fetch(`${CHAT}/api/chats/${slug}/messages?after=${sent.message.seq}`));
    expect(newer.messages).toEqual([]);
  });

  it("rejects writes without a valid member token", async () => {
    const slug = await createChat();
    expect((await send(slug, "pct_nope_nope_nope", { text: "hi" })).status).toBe(401);
    const me = await SELF.fetch(`${CHAT}/api/chats/${slug}/me`, { headers: { Authorization: "Bearer pct_nope_nope" } });
    expect(me.status).toBe(401);
  });

  it("validates nicknames and empty / oversize messages", async () => {
    const slug = await createChat();
    expect((await join(slug, "   ")).status).toBe(400);
    expect((await join(slug, "x".repeat(33))).status).toBe(400);
    const t = await token(slug, "bob");
    expect((await send(slug, t, { text: "   " })).status).toBe(400);
    expect((await send(slug, t, { text: "a".repeat(512 * 1024 + 1) })).status).toBe(413);
    expect((await send(slug, t, { text: "a".repeat(512 * 1024) })).status).toBe(201);
  });

  it("caps a chat at 100 participants", async () => {
    const slug = await createChat();
    const stub = env.CHAT.get(env.CHAT.idFromName(slug));
    for (let i = 0; i < 100; i++) {
      const r = await stub.join({ nickname: `p${i}` });
      expect(r.ok).toBe(true);
    }
    const res = await join(slug, "one-too-many");
    expect(res.status).toBe(403);
    expect((await json<{ error: string }>(res)).error).toMatch(/full/);
  });

  it("uploads images and attaches them to a message", async () => {
    const slug = await createChat();
    const t = await token(slug, "cam");
    const up = await SELF.fetch(`${CHAT}/api/chats/${slug}/images`, { method: "POST", headers: { "Content-Type": "image/png", Authorization: `Bearer ${t}` }, body: PNG });
    expect(up.status).toBe(201);
    const img = await json<{ id: string; url: string; width: number }>(up);
    expect(img.width).toBe(1);
    expect(img.url).toBe(`${CHAT}/${slug}/img/${img.id}`);

    const got = await SELF.fetch(img.url);
    expect(got.status).toBe(200);
    expect(got.headers.get("Content-Type")).toBe("image/png");
    await got.arrayBuffer();

    const res = await send(slug, t, { images: [img.id] });
    expect(res.status).toBe(201);
    const m = await json<{ message: { images: { id: string }[] } }>(res);
    expect(m.message.images[0]!.id).toBe(img.id);
    // An image can only be attached once, and only by its uploader.
    expect((await send(slug, t, { images: [img.id] })).status).toBe(400);

    const info = await json<{ bytes: number }>(await SELF.fetch(`${CHAT}/api/chats/${slug}`));
    expect(info.bytes).toBe(PNG.byteLength);
  });

  it("refuses uploads from strangers and non-images", async () => {
    const slug = await createChat();
    const bad = await SELF.fetch(`${CHAT}/api/chats/${slug}/images`, { method: "POST", headers: { "Content-Type": "image/png", Authorization: "Bearer pct_stranger_x" }, body: PNG });
    expect(bad.status).toBe(401);
    const t = await token(slug, "dee");
    const txt = await SELF.fetch(`${CHAT}/api/chats/${slug}/images`, { method: "POST", headers: { "Content-Type": "image/png", Authorization: `Bearer ${t}` }, body: "not an image at all" });
    expect(txt.status).toBe(400);
  });

  it("long-polls for the next message", async () => {
    const slug = await createChat();
    const t = await token(slug, "eve");
    const after = (await json<{ next_after: number }>(await SELF.fetch(`${CHAT}/api/chats/${slug}/messages`))).next_after;
    const waiting = SELF.fetch(`${CHAT}/api/chats/${slug}/messages?after=${after}&wait=10`);
    await new Promise((r) => setTimeout(r, 100));
    await send(slug, t, { text: "ping" });
    const got = await json<{ messages: { text: string }[] }>(await waiting);
    expect(got.messages.map((m) => m.text)).toEqual(["ping"]);
  });

  it("erases the oldest messages past 100 MB", async () => {
    const slug = await createChat();
    const t = await token(slug, "fay");
    const stub = env.CHAT.get(env.CHAT.idFromName(slug));
    const first = await json<{ message: { seq: number } }>(await send(slug, t, { text: "first" }));
    // Pretend the room is nearly full, then send one more.
    await runInDurableObject(stub, async (_obj: ChatRoom, state) => {
      state.storage.sql.exec("UPDATE room SET bytes = ? WHERE id = 1", 100 * 1024 * 1024 - 3);
      state.storage.sql.exec("UPDATE messages SET bytes = ? WHERE seq = ?", 100 * 1024 * 1024 - 3 - 5, first.message.seq);
    });
    // Drop the cached row so the object re-reads the doctored byte count.
    await runInDurableObject(stub, async (obj: ChatRoom) => {
      (obj as unknown as { room: unknown }).room = undefined;
    });
    expect((await send(slug, t, { text: "second" })).status).toBe(201);
    const after = await json<{ messages: { text: string; type: string }[]; chat: { older_messages_evicted: boolean; bytes: number } }>(
      await SELF.fetch(`${CHAT}/api/chats/${slug}/messages`),
    );
    expect(after.messages.filter((m) => m.type === "message").map((m) => m.text)).toEqual(["second"]);
    expect(after.chat.older_messages_evicted).toBe(true);
    expect(after.chat.bytes).toBeLessThan(100 * 1024 * 1024);
  });

  it("deletes everything 24 h after the last message", async () => {
    const slug = await createChat();
    const t = await token(slug, "gus");
    const up = await json<{ id: string }>(
      await SELF.fetch(`${CHAT}/api/chats/${slug}/images`, { method: "POST", headers: { "Content-Type": "image/png", Authorization: `Bearer ${t}` }, body: PNG }),
    );
    await send(slug, t, { text: "bye", images: [up.id] });
    const stub = env.CHAT.get(env.CHAT.idFromName(slug));

    // Not due yet: the alarm re-arms and nothing is deleted.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await SELF.fetch(`${CHAT}/api/chats/${slug}`)).status).toBe(200);

    await runInDurableObject(stub, async (obj: ChatRoom, state) => {
      state.storage.sql.exec("UPDATE room SET last_message_at = ? WHERE id = 1", Date.now() - 25 * 3600 * 1000);
      (obj as unknown as { room: unknown }).room = undefined;
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await SELF.fetch(`${CHAT}/api/chats/${slug}`)).status).toBe(404);
    expect((await SELF.fetch(`${CHAT}/${slug}/img/${up.id}`)).status).toBe(404);
    expect((await env.IMAGES.list({ prefix: `chat/${slug}/` })).objects).toEqual([]);
  });
});

describe("chat — MCP", () => {
  async function rpc(method: string, params: Record<string, unknown> = {}) {
    const res = await SELF.fetch(`${CHAT}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { result: Record<string, unknown> & { structuredContent?: Record<string, unknown>; isError?: boolean; content?: { text: string }[] } };
  }

  it("needs no auth and lists only the chat tools", async () => {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(String(init.result.instructions)).toContain("join_chat");
    const list = await rpc("tools/list");
    const names = (list.result.tools as { name: string }[]).map((t) => t.name).sort();
    expect(names).toEqual(["create_chat", "get_chat", "join_chat", "read_chat_messages", "send_chat_message", "upload_chat_image"]);
  });

  it("lets two agents talk", async () => {
    const created = await rpc("tools/call", { name: "create_chat", arguments: { title: "agents" } });
    const url = created.result.structuredContent!.url as string;
    const a = (await rpc("tools/call", { name: "join_chat", arguments: { chat: url, nickname: "alpha" } })).result.structuredContent!.member_token as string;
    const b = (await rpc("tools/call", { name: "join_chat", arguments: { chat: url, nickname: "beta" } })).result.structuredContent!.member_token as string;
    const sent = await rpc("tools/call", { name: "send_chat_message", arguments: { chat: url, member_token: a, text: "hi beta" } });
    expect(sent.result.isError).toBe(false);
    const read = await rpc("tools/call", { name: "read_chat_messages", arguments: { chat: url } });
    expect(read.result.content![0]!.text).toContain("alpha (agent): hi beta");
    const next = read.result.structuredContent!.next_after as number;
    await rpc("tools/call", { name: "send_chat_message", arguments: { chat: url, member_token: b, text: "hi alpha" } });
    const more = await rpc("tools/call", { name: "read_chat_messages", arguments: { chat: url, after: next } });
    expect((more.result.structuredContent!.messages as { text: string }[]).map((m) => m.text)).toEqual(["hi alpha"]);
    const bad = await rpc("tools/call", { name: "send_chat_message", arguments: { chat: url, member_token: "pct_wrong_token", text: "x" } });
    expect(bad.result.isError).toBe(true);
  });

  it("main pencil.md MCP still requires OAuth", async () => {
    const res = await SELF.fetch("https://localhost/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(res.status).toBe(401);
  });
});

describe("chat — about + footer", () => {
  it("describes chat on /about and links it in the footer", async () => {
    const html = await (await SELF.fetch("https://localhost/about")).text();
    expect(html).toContain('id="chat"');
    expect(html).toContain("24 hours");
    expect(html).toContain("http://chat.localhost");
  });
});
