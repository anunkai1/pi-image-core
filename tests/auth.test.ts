import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authFilePath, getOpenAICodexAuth } from "../src/auth.js";

let home: string | undefined;
const originalHome = process.env.HOME;

afterEach(async () => {
	vi.unstubAllGlobals();
	if (home) await rm(home, { recursive: true, force: true });
	home = undefined;
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
});

async function seedAuth(value: Record<string, unknown>): Promise<string> {
	home = await mkdtemp(join(tmpdir(), "pi-image-auth-"));
	process.env.HOME = home;
	const file = authFilePath();
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	return file;
}

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
