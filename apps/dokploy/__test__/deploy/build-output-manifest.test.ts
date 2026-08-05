import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
	buildOutputDiscoveryProgram,
	buildOutputManifestDigest,
	parseBuildOutputArtifactMetadata,
	parseBuildOutputManifest,
	parseBuildOutputManifestJson,
	staticRoutePrefixes,
} from "@dokploy/server/services/build-output-manifest";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

const validManifest = () => ({
	version: 1 as const,
	framework: { name: "vite" as const, version: "6.0.0" },
	mode: "static" as const,
	staticDirectories: [
		{ directory: "dist", routePrefix: "/", cachePolicy: "revalidate" as const },
	],
	functions: [],
	isr: [],
	redirects: [],
	headers: [],
	edgeMiddleware: [],
	staticOutput: { fileCount: 1, totalBytes: 13 },
	metadata: { adapter: "static", generatedAt: "2026-08-05T00:00:00.000Z" },
});

const createTemporaryDirectory = async (prefix: string) => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
};

const runDiscovery = async (workspace: string, publishDirectory?: string) => {
	const artifacts = await createTemporaryDirectory("vlyv-output-artifacts-");
	const programPath = path.join(artifacts, "discover.mjs");
	await fs.writeFile(programPath, buildOutputDiscoveryProgram);
	await execFileAsync(process.execPath, [programPath], {
		env: {
			...process.env,
			VLYV_WORKSPACE: workspace,
			VLYV_ARTIFACTS: artifacts,
			VLYV_PUBLISH_DIRECTORY: publishDirectory,
		},
	});
	return {
		artifacts,
		manifest: parseBuildOutputManifestJson(
			await fs.readFile(path.join(artifacts, "output-manifest.json")),
		),
	};
};

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => fs.rm(directory, { recursive: true, force: true })),
	);
});

describe("framework build output manifest", () => {
	it("parses a versioned manifest and derives stable routing metadata", () => {
		const manifest = parseBuildOutputManifest(validManifest());
		const bytes = Buffer.from(JSON.stringify(manifest));

		expect(buildOutputManifestDigest(bytes)).toMatch(/^sha256:[a-f0-9]{64}$/);
		expect(staticRoutePrefixes(manifest)).toEqual(["/"]);
		expect(
			parseBuildOutputArtifactMetadata({
				output: {
					manifest,
					manifestDigest: buildOutputManifestDigest(bytes),
					publicBaseUrl: "https://assets.vlyv.dev/releases/opaque",
					objectPrefix: "releases/opaque",
				},
			}),
		).toMatchObject({ manifest, objectPrefix: "releases/opaque" });
	});

	it("uses an explicitly configured static publish directory", async () => {
		const workspace = await createTemporaryDirectory("vlyv-output-configured-");
		await fs.mkdir(path.join(workspace, "site-files"), { recursive: true });
		await fs.writeFile(
			path.join(workspace, "site-files", "index.html"),
			"configured",
		);

		const result = await runDiscovery(workspace, "site-files");

		expect(result.manifest).toMatchObject({
			framework: { name: "static" },
			mode: "static",
			staticDirectories: [{ directory: "site-files", routePrefix: "/" }],
		});
	});

	it("rejects traversal, duplicate functions, and mixed static function output", () => {
		expect(() =>
			parseBuildOutputManifest({
				...validManifest(),
				staticDirectories: [
					{
						directory: "../secrets",
						routePrefix: "/",
						cachePolicy: "revalidate",
					},
				],
			}),
		).toThrow("invalid vlyv output manifest");
		expect(() =>
			parseBuildOutputManifest({
				...validManifest(),
				mode: "hybrid",
				functions: [
					{
						name: "api",
						kind: "api",
						route: "/api",
						entrypoint: "server/api.js",
						runtime: "nodejs",
					},
					{
						name: "api",
						kind: "api",
						route: "/api/v2",
						entrypoint: "server/api-v2.js",
						runtime: "nodejs",
					},
				],
			}),
		).toThrow("invalid vlyv output manifest");
		expect(() =>
			parseBuildOutputManifest({
				...validManifest(),
				functions: [
					{
						name: "ssr",
						kind: "ssr",
						route: "/",
						entrypoint: "server.js",
						runtime: "nodejs",
					},
				],
			}),
		).toThrow("invalid vlyv output manifest");
	});

	it("rejects oversized JSON and unsafe publication URLs", () => {
		expect(() =>
			parseBuildOutputManifestJson("x".repeat(1024 * 1024 + 1)),
		).toThrow("exceeds");
		expect(() =>
			parseBuildOutputArtifactMetadata({
				output: {
					manifest: validManifest(),
					manifestDigest: `sha256:${"a".repeat(64)}`,
					publicBaseUrl: "http://assets.example.com/release",
					objectPrefix: "release",
				},
			}),
		).toThrow("invalid framework output metadata");
	});

	it("discovers Vite static output and copies a bounded inventory", async () => {
		const workspace = await createTemporaryDirectory("vlyv-output-workspace-");
		await fs.mkdir(path.join(workspace, "dist", "assets"), { recursive: true });
		await fs.writeFile(
			path.join(workspace, "package.json"),
			JSON.stringify({ devDependencies: { vite: "6.0.0" } }),
		);
		await fs.writeFile(
			path.join(workspace, "dist", "index.html"),
			"<h1>vlyv</h1>",
		);
		await fs.writeFile(
			path.join(workspace, "dist", "assets", "app.js"),
			"vlyv();",
		);

		const result = await runDiscovery(workspace);

		expect(result.manifest).toMatchObject({
			framework: { name: "vite", version: "6.0.0" },
			mode: "static",
			staticOutput: { fileCount: 2 },
		});
		await expect(
			fs.readFile(path.join(result.artifacts, "static", "index.html"), "utf8"),
		).resolves.toBe("<h1>vlyv</h1>");
	});

	it.skipIf(process.platform === "win32")(
		"rejects symbolic links in framework static output",
		async () => {
			const workspace = await createTemporaryDirectory("vlyv-output-symlink-");
			await fs.mkdir(path.join(workspace, "dist"), { recursive: true });
			await fs.writeFile(path.join(workspace, "outside.txt"), "secret");
			await fs.writeFile(
				path.join(workspace, "package.json"),
				JSON.stringify({ devDependencies: { vite: "6.0.0" } }),
			);
			await fs.symlink(
				path.join(workspace, "outside.txt"),
				path.join(workspace, "dist", "linked.txt"),
			);

			await expect(runDiscovery(workspace)).rejects.toThrow();
		},
	);
});
