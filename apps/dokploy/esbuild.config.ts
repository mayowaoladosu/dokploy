import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { bundleWorkflowCode } from "@temporalio/worker";
import dotenv, { type DotenvParseOutput } from "dotenv";
import esbuild from "esbuild";

const result = dotenv.config({ path: ".env.production" });

function prepareDefine(config: DotenvParseOutput | undefined) {
	const define = {};
	// @ts-ignore
	for (const [key, value] of Object.entries(config)) {
		// Infrastructure endpoints and credentials must remain runtime-only.
		if (key === "DATABASE_URL" || key.startsWith("TEMPORAL_")) {
			continue;
		}
		// @ts-ignore
		define[`process.env.${key}`] = JSON.stringify(value);
	}
	return define;
}

const define = prepareDefine(result.parsed);

try {
	await mkdir(path.resolve("dist"), { recursive: true });
	await Promise.all([
		esbuild.build({
			entryPoints: {
				server: "server/server.ts",
				migration: "migration.ts",
				"wait-for-postgres": "wait-for-postgres.ts",
				"reset-password": "reset-password.ts",
				"reset-2fa": "reset-2fa.ts",
				"migrate-auth-secret": "scripts/migrate-auth-secret.ts",
			},
			bundle: true,
			platform: "node",
			format: "esm",
			target: "node18",
			outExtension: { ".js": ".mjs" },
			minify: true,
			sourcemap: true,
			outdir: "dist",
			tsconfig: "tsconfig.server.json",
			define,
			packages: "external",
		}),
		bundleWorkflowCode({
			workflowsPath: path.resolve("server/temporal/workflows.ts"),
			workflowInterceptorModules: [
				path.resolve("server/temporal/otel-workflow-interceptors.ts"),
			],
		}).then((bundle) =>
			writeFile(path.resolve("dist/temporal-workflows.js"), bundle.code),
		),
	]);
} catch (error) {
	console.error(error);
	process.exitCode = 1;
}
