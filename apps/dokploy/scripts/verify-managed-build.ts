import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { isManagedTenantRoute } from "../managed-surface.config.js";

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

	console.log(
		`Verified managed tenant build: ${Object.keys(pagesManifest).length} routes, no BYOS pages or host/container WebSockets`,
	);
}
