import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
	isManagedTenantRoute,
	managedRequiredRoutes,
} from "../managed-surface.config.js";

const managedTarget =
	process.env.DOKPLOY_BUILD_TARGET === "managed" ||
	process.env.PLATFORM_MODE === "managed";

if (managedTarget) {
	const nextDirectory = path.resolve(".next");
	const pagesManifest = JSON.parse(
		await readFile(
			path.join(nextDirectory, "server", "pages-manifest.json"),
			"utf8",
		),
	) as Record<string, string>;
	const blockedRoutes = Object.keys(pagesManifest).filter(isManagedTenantRoute);
	if (blockedRoutes.length > 0) {
		throw new Error(
			`Managed build contains blocked routes: ${blockedRoutes.join(", ")}`,
		);
	}
	const missingRequiredRoutes = managedRequiredRoutes.filter(
		(route) => !(route in pagesManifest),
	);
	if (missingRequiredRoutes.length > 0) {
		throw new Error(
			`Managed build is missing required hosted routes: ${missingRequiredRoutes.join(", ")}`,
		);
	}

	const files = await readdir(path.join(nextDirectory, "server", "pages"), {
		recursive: true,
		withFileTypes: true,
	});
	const forbiddenArtifact = files.find((entry) => {
		if (!entry.isFile()) return false;
		const fullPath = path
			.join(entry.parentPath, entry.name)
			.replaceAll("\\", "/");
		return (
			/\/(docker|monitoring|networks|requests|schedules|swarm|traefik|certificates|cluster|destinations|license|registry|server|servers|ssh-keys)\.js(?:\.nft\.json)?$/.test(
				fullPath,
			) ||
			/\/services\/(compose|libsql|mariadb|mongo|mysql|postgres|redis)\//.test(
				fullPath,
			) ||
			/\/api\/deploy\/compose\//.test(fullPath)
		);
	});
	if (forbiddenArtifact) {
		throw new Error(
			`Managed build contains a BYOS artifact: ${path.join(forbiddenArtifact.parentPath, forbiddenArtifact.name)}`,
		);
	}

	const serverBundle = await readFile(path.resolve("dist/server.mjs"), "utf8");
	for (const symbol of [
		"docker-container-terminal",
		"docker-container-logs",
		"setupDockerStatsMonitoringSocketServer",
	]) {
		if (serverBundle.includes(symbol)) {
			throw new Error(
				`Managed server bundle contains forbidden WebSocket symbol ${symbol}`,
			);
		}
	}
	const secretCanary = process.env.MANAGED_BUILD_ARTIFACT_CANARY;
	if (secretCanary?.trim()) {
		const artifacts = [
			path.resolve("dist/server.mjs"),
			path.resolve("dist/server.mjs.map"),
		];
		for (const file of artifacts) {
			const content = await readFile(file, "utf8").catch(() => "");
			if (content.includes(secretCanary)) {
				throw new Error(
					`Managed build artifact contains secret canary: ${file}`,
				);
			}
		}
	}

	console.log(
		`Verified managed tenant build: ${Object.keys(pagesManifest).length} routes, Polar billing retained, no BYOS pages or host/container WebSockets`,
	);
}
