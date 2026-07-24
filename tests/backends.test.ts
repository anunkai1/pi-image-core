import { afterEach, describe, expect, it, vi } from "vitest";
import {
	callVeniceImage,
	callOpenRouterImage,
	callOpenAICodexImage,
	extractOpenRouterError,
	extractOpenAICodexError,
} from "../src/index.js";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
	vi.restoreAllMocks();
});

describe("callVeniceImage", () => {
	it("returns parsed JSON on 200", async () => {
		globalThis.fetch = vi.fn(
			async () => new Response(JSON.stringify({ images: ["aGVsbG8="] }), { status: 200 }),
		) as unknown as typeof fetch;
		const res = await callVeniceImage("k", { prompt: "p" }, undefined);
		expect(res.images).toEqual(["aGVsbG8="]);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});
	it("does not retry a 400", async () => {
		globalThis.fetch = vi.fn(async () => new Response("bad", { status: 400 })) as unknown as typeof fetch;
		await expect(callVeniceImage("k", {}, undefined)).rejects.toThrow(/Venice image API 400/);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});
	it("retries 429 then succeeds", async () => {
		let n = 0;
		globalThis.fetch = vi.fn(
			async () =>
				++n < 3
					? new Response("rate", { status: 429 })
					: new Response(JSON.stringify({ images: ["b"] }), { status: 200 }),
		) as unknown as typeof fetch;
		const res = await callVeniceImage("k", {}, undefined);
		expect(res.images).toEqual(["b"]);
		expect(n).toBe(3);
	});
});

describe("callOpenRouterImage", () => {
	it("returns parsed JSON on 200", async () => {
		globalThis.fetch = vi.fn(
			async () => new Response(JSON.stringify({ data: [{ b64_json: "x" }] }), { status: 200 }),
		) as unknown as typeof fetch;
		const res = await callOpenRouterImage("k", {}, undefined);
		expect(res.data?.[0]?.b64_json).toBe("x");
	});
	it("formats an {error:{message}} body", async () => {
		globalThis.fetch = vi.fn(
			async () => new Response(JSON.stringify({ error: { message: "bad model" } }), { status: 400 }),
		) as unknown as typeof fetch;
		await expect(callOpenRouterImage("k", {}, undefined)).rejects.toThrow(/OpenRouter 400: bad model/);
	});
});

describe("callOpenAICodexImage", () => {
	it("posts to /codex/images/generations with bearer + account id", async () => {
		globalThis.fetch = vi.fn(async (url, init) => {
			expect(String(url)).toContain("/codex/images/generations");
			const h = (init?.headers as Record<string, string>) ?? {};
			expect(h.Authorization).toBe("Bearer tok");
			expect(h["ChatGPT-Account-ID"]).toBe("acct");
			return new Response(JSON.stringify({ data: [{ b64_json: "abc" }] }), { status: 200 });
		}) as unknown as typeof fetch;
		const r = await callOpenAICodexImage(
			{ access: "tok", accountId: "acct" },
			"generate",
			{},
			undefined,
		);
		expect(r.data?.[0]?.b64_json).toBe("abc");
	});
	it("posts to /codex/images/edits for kind='edit'", async () => {
		globalThis.fetch = vi.fn(async (url) => {
			expect(String(url)).toContain("/codex/images/edits");
			return new Response(JSON.stringify({ data: [] }), { status: 200 });
		}) as unknown as typeof fetch;
		await callOpenAICodexImage({ access: "tok" }, "edit", {}, undefined);
	});
	it("does not retry 400", async () => {
		globalThis.fetch = vi.fn(
			async () => new Response(JSON.stringify({ error: { message: "bad" } }), { status: 400 }),
		) as unknown as typeof fetch;
		await expect(
			callOpenAICodexImage({ access: "tok" }, "generate", {}, undefined),
		).rejects.toThrow(/bad/);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});
});

describe("error extractors", () => {
	it("extractOpenRouterError handles each shape", () => {
		expect(extractOpenRouterError({ error: { message: "x" } }, 400)).toBe("OpenRouter 400: x");
		expect(extractOpenRouterError({ error: "y" }, 500)).toBe("OpenRouter 500: y");
		expect(extractOpenRouterError("plain", 429)).toBe("OpenRouter 429: plain");
		expect(extractOpenRouterError(null, 502)).toBe("OpenRouter 502");
	});
	it("extractOpenAICodexError handles each shape", () => {
		expect(extractOpenAICodexError({ error: { message: "x" } }, 400)).toBe(
			"OpenAI Codex image API 400: x",
		);
		expect(extractOpenAICodexError({ message: "z" }, 500)).toBe("OpenAI Codex image API 500: z");
		expect(extractOpenAICodexError("plain", 429)).toBe("OpenAI Codex image API 429: plain");
	});
});
