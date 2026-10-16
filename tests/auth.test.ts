import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authFilePath, getOpenAICodexAuth } from "../src/auth.js";

let home: string | undefined;
const originalHome = process.env.HOME;
const originalCodexHome = process.env.CODEX_HOME;

afterEach(async () => {
	vi.unstubAllGlobals();
	if (home) await rm(home, { recursive: true, force: true });
	home = undefined;
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
	else process.env.CODEX_HOME = originalCodexHome;
});

async function seedAuth(value: Record<string, unknown>): Promise<string> {
	home = await mkdtemp(join(tmpdir(), "pi-image-auth-"));
	process.env.HOME = home;
	delete process.env.CODEX_HOME;
	const file = authFilePath();
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	return file;
}

function jwt(expires = Date.now() + 3_600_000): string {
	return `header.${Buffer.from(JSON.stringify({ exp: Math.floor(expires / 1000) })).toString("base64url")}.signature`;
}

async function seedCodex(tokens: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<string> {
	const file = join(home!, ".codex", "auth.json");
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify({ tokens, ...extra }), { mode: 0o600 });
	return file;
}

describe("Codex CLI subscription login fallback", () => {
	it("uses the existing CLI login without copying credentials to pi", async () => {
		const piFile = await seedAuth({ openai: { type: "oauth", access: "direct-text-only" } });
		const access = jwt();
		await seedCodex({ access_token: access, refresh_token: "cli-refresh", account_id: "cli-account" });
		expect(await getOpenAICodexAuth()).toMatchObject({ access, refresh: "cli-refresh", accountId: "cli-account" });
		expect(JSON.parse(await readFile(piFile, "utf8"))).not.toHaveProperty("openai-codex");
	});

	it("prefers pi's own Codex login when both exist", async () => {
		await seedAuth({ "openai-codex": { access: "pi-access", expires: Date.now() + 3_600_000 } });
		await seedCodex({ access_token: jwt() });
		expect((await getOpenAICodexAuth())?.access).toBe("pi-access");
	});

	it("supports CODEX_HOME when the pi auth file is absent", async () => {
		await seedAuth({});
		await rm(authFilePath());
		const file = await seedCodex({ access_token: jwt() });
		process.env.CODEX_HOME = join(home!, "custom-codex-home");
		await rename(dirname(file), process.env.CODEX_HOME);
		expect(await getOpenAICodexAuth()).toBeDefined();
	});

	it("does not use the direct subscription token or a CLI API-key login", async () => {
		await seedAuth({ openai: { type: "oauth", access: "direct-text-only" } });
		expect(await getOpenAICodexAuth()).toBeUndefined();
		await seedCodex({ access_token: jwt() }, { auth_mode: "apikey" });
		expect(await getOpenAICodexAuth()).toBeUndefined();
	});

	it("rejects malformed tokens and expired logins without refresh tokens", async () => {
		await seedAuth({});
		await seedCodex({ access_token: "not-a-jwt" });
		expect(await getOpenAICodexAuth()).toBeUndefined();
		await seedCodex({ access_token: jwt(Date.now() - 1000) });
		await expect(getOpenAICodexAuth()).rejects.toThrow("Codex CLI login expired");
	});

	it("preserves a newer CLI login made during refresh", async () => {
		await seedAuth({});
		const file = await seedCodex({ access_token: jwt(Date.now() - 1000), refresh_token: "old-refresh" });
		const access = jwt();
		vi.stubGlobal("fetch", vi.fn(async () => {
			await writeFile(file, JSON.stringify({ tokens: { access_token: access, refresh_token: "new-login-refresh" } }));
			return new Response(JSON.stringify({ access_token: "outdated-refresh-result", refresh_token: "outdated-refresh", expires_in: 3600 }));
		}));
		expect((await getOpenAICodexAuth())?.access).toBe(access);
		expect(JSON.parse(await readFile(file, "utf8")).tokens.refresh_token).toBe("new-login-refresh");
	});

	it("refreshes once, preserving CLI fields, the central-store symlink and pi's auth", async () => {
		const piFile = await seedAuth({ openai: { type: "oauth", access: "direct-text-only" } });
		const file = await seedCodex({ access_token: jwt(Date.now() - 1000), refresh_token: "expired-refresh", account_id: "account-1", id_token: "preserved-id" });
		const target = join(home!, "canonical-auth.json");
		await writeFile(target, await readFile(file));
		await rm(file);
		await symlink(target, file);
		const access = jwt();
		const fetchMock = vi.fn(async () => {
			await new Promise((resolve) => setTimeout(resolve, 30));
			return new Response(JSON.stringify({ access_token: access, refresh_token: "rotated-refresh", expires_in: 3600 }));
		});
		vi.stubGlobal("fetch", fetchMock);
		const results = await Promise.all([getOpenAICodexAuth(), getOpenAICodexAuth()]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(results.every((auth) => auth?.access === access)).toBe(true);
		const persisted = JSON.parse(await readFile(target, "utf8"));
		expect(persisted.tokens).toMatchObject({ access_token: access, refresh_token: "rotated-refresh", account_id: "account-1", id_token: "preserved-id" });
		expect(persisted.last_refresh).toBeTypeOf("string");
		expect((await lstat(file)).isSymbolicLink()).toBe(true);
		expect((await lstat(target)).mode & 0o777).toBe(0o600);
		expect(JSON.parse(await readFile(piFile, "utf8"))).toEqual({ openai: { type: "oauth", access: "direct-text-only" } });
	});
});

describe("OpenAI Codex OAuth refresh persistence", () => {
	it("serializes concurrent refreshes and preserves unrelated provider updates", async () => {
		const file = await seedAuth({
			"openai-codex": {
				access: "expired-access",
				refresh: "rotating-refresh",
				expires: Date.now() - 1000,
				accountId: "account-1",
			},
			openrouter: { key: "existing-key" },
		});
		let refreshCalls = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				refreshCalls += 1;
				// Simulate another auth writer changing a different provider while
				// the token endpoint is in flight. The refresh merge must retain it.
				const current = JSON.parse(await readFile(file, "utf8"));
				current.venice = { key: "added-during-refresh" };
				await writeFile(file, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
				await new Promise((resolve) => setTimeout(resolve, 30));
				return new Response(
					JSON.stringify({
						access_token: "fresh-access",
						refresh_token: "fresh-refresh",
						expires_in: 3600,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}),
		);

		const [first, second] = await Promise.all([getOpenAICodexAuth(), getOpenAICodexAuth()]);
		expect(refreshCalls).toBe(1);
		expect(first?.access).toBe("fresh-access");
		expect(second?.access).toBe("fresh-access");
		const persisted = JSON.parse(await readFile(file, "utf8"));
		expect(persisted.openrouter.key).toBe("existing-key");
		expect(persisted.venice.key).toBe("added-during-refresh");
		expect(persisted["openai-codex"].refresh).toBe("fresh-refresh");
	});
});
