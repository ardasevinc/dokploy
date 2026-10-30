import { execFileSync } from "node:child_process";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "dotenv";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ root: "" }));
vi.mock("@dokploy/server/constants", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	paths: () => ({ COMPOSE_PATH: state.root }),
}));

import { getCreateEnvFileCommand } from "@dokploy/server/utils/builders/compose";

describe("private Compose environment files", () => {
	let file: string;
	let command: string;
	beforeEach(() => {
		state.root = mkdtempSync(join(tmpdir(), "dokploy-private-env-"));
		file = join(state.root, "fixture", "code", "nested folder", ".env");
		mkdirSync(dirname(file), { recursive: true });
		command = getCreateEnvFileCommand({
			appName: "fixture",
			composePath: "nested folder/compose.yaml",
			composeType: "docker-compose",
			env: "SECRET=fixture-secret\n",
			environment: { env: "", project: { env: "" } },
		} as Parameters<typeof getCreateEnvFileCommand>[0]);
	});
	afterEach(() => rmSync(state.root, { recursive: true, force: true }));

	const execute = (env = process.env) =>
		execFileSync("bash", ["-c", `umask 022; { ${command} } || exit 79;`], {
			env,
		});

	it("creates a private file despite a permissive caller umask", () => {
		execute();
		expect(lstatSync(file).mode & 0o777).toBe(0o600);
		expect(parse(readFileSync(file, "utf8")).SECRET).toBe("fixture-secret");
	});

	it("replaces an existing 0644 file and stays private on redeploy", () => {
		writeFileSync(file, "old", { mode: 0o644 });
		execute();
		execute();
		expect(lstatSync(file).mode & 0o777).toBe(0o600);
		expect(parse(readFileSync(file, "utf8")).SECRET).toBe("fixture-secret");
	});

	it("replaces a symlink without overwriting its target", () => {
		const target = join(state.root, "untouched");
		writeFileSync(target, "keep");
		symlinkSync(target, file);
		execute();
		expect(lstatSync(file).isSymbolicLink()).toBe(false);
		expect(readFileSync(target, "utf8")).toBe("keep");
	});

	it("replaces a directory symlink without writing inside its target", () => {
		const target = join(state.root, "untouched-directory");
		mkdirSync(target);
		symlinkSync(target, file);
		execute();
		expect(lstatSync(file).isFile()).toBe(true);
		expect(readdirSync(target)).toEqual([]);
	});

	it("rejects an actual directory without leaving a temporary file", () => {
		mkdirSync(file);
		expect(() => execute()).toThrow();
		expect(lstatSync(file).isDirectory()).toBe(true);
		expect(readdirSync(dirname(file))).toEqual([".env"]);
	});

	it("fails closed and preserves the old file when decoding fails", () => {
		writeFileSync(file, "old");
		const bin = join(state.root, "bin");
		mkdirSync(bin);
		writeFileSync(join(bin, "base64"), "#!/bin/sh\nprintf partial\nexit 1\n", {
			mode: 0o755,
		});
		expect(() =>
			execute({ ...process.env, PATH: `${bin}:${process.env.PATH}` }),
		).toThrow();
		expect(readFileSync(file, "utf8")).toBe("old");
		expect(readdirSync(dirname(file))).toEqual([".env"]);
	});
});
