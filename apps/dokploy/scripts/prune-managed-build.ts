import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	isManagedTenantRoute,
	managedTenantRoutes,
} from "../managed-surface.config.js";

const managedTarget =
	process.env.DOKPLOY_BUILD_TARGET === "managed" ||
	process.env.PLATFORM_MODE === "managed";

if (managedTarget) {
	const nextDirectory = path.resolve(".next");
	const readJson = async <T>(file: string): Promise<T | null> => {
		try {
			return JSON.parse(await readFile(file, "utf8")) as T;
		} catch (error) {
			if (
				error &&
				typeof error === "object" &&
				"code" in error &&
				error.code === "ENOENT"
			) {
				return null;
			}
			throw error;
		}
	};
	const writeJson = (file: string, value: unknown) =>
		writeFile(file, JSON.stringify(value, null, 2));

	const pagesManifestPath = path.join(
		nextDirectory,
		"server",
		"pages-manifest.json",
	);
	const pagesManifest =
		await readJson<Record<string, string>>(pagesManifestPath);
	if (pagesManifest) {
		for (const [route, output] of Object.entries(pagesManifest)) {
			if (!isManagedTenantRoute(route)) continue;
			delete pagesManifest[route];
			await rm(path.join(nextDirectory, "server", output), { force: true });
			await rm(path.join(nextDirectory, "server", `${output}.nft.json`), {
				force: true,
			});
			await rm(path.join(nextDirectory, "server", `${output}.map`), {
				force: true,
			});
		}
		await writeJson(pagesManifestPath, pagesManifest);
	}

	const buildManifestPath = path.join(nextDirectory, "build-manifest.json");
	type BuildManifest = {
		pages?: Record<string, string[]>;
		rootMainFiles?: string[];
		polyfillFiles?: string[];
	};
	const buildManifest = await readJson<BuildManifest>(buildManifestPath);
	if (buildManifest?.pages) {
		const removedFiles = new Set<string>();
		for (const [route, files] of Object.entries(buildManifest.pages)) {
			if (!isManagedTenantRoute(route)) continue;
			for (const file of files) removedFiles.add(file);
			delete buildManifest.pages[route];
		}
		const retainedFiles = new Set(Object.values(buildManifest.pages).flat());
		for (const file of removedFiles) {
			if (!retainedFiles.has(file)) {
				await rm(path.join(nextDirectory, file), { force: true });
			}
		}
		await writeJson(buildManifestPath, buildManifest);
	}

	const routesManifestPath = path.join(nextDirectory, "routes-manifest.json");
	type RoutesManifest = {
		staticRoutes?: Array<{ page: string }>;
		dynamicRoutes?: Array<{ page: string }>;
	};
	const routesManifest = await readJson<RoutesManifest>(routesManifestPath);
	if (routesManifest) {
		if (routesManifest.staticRoutes) {
			routesManifest.staticRoutes = routesManifest.staticRoutes.filter(
				(route) => !isManagedTenantRoute(route.page),
			);
		}
		if (routesManifest.dynamicRoutes) {
			routesManifest.dynamicRoutes = routesManifest.dynamicRoutes.filter(
				(route) => !isManagedTenantRoute(route.page),
			);
		}
		await writeJson(routesManifestPath, routesManifest);
	}

	const prerenderManifestPath = path.join(
		nextDirectory,
		"prerender-manifest.json",
	);
	type PrerenderManifest = {
		routes?: Record<string, unknown>;
		dynamicRoutes?: Record<string, unknown>;
		notFoundRoutes?: string[];
	};
	const prerenderManifest = await readJson<PrerenderManifest>(
		prerenderManifestPath,
	);
	if (prerenderManifest) {
		for (const routes of [
			prerenderManifest.routes,
			prerenderManifest.dynamicRoutes,
		]) {
			if (!routes) continue;
			for (const route of Object.keys(routes)) {
				if (isManagedTenantRoute(route)) delete routes[route];
			}
		}
		if (prerenderManifest.notFoundRoutes) {
			prerenderManifest.notFoundRoutes =
				prerenderManifest.notFoundRoutes.filter(
					(route) => !isManagedTenantRoute(route),
				);
		}
		await writeJson(prerenderManifestPath, prerenderManifest);
	}

	console.log(
		`Pruned ${managedTenantRoutes.length} static BYOS routes and all legacy service route patterns from the managed tenant build`,
	);
}
