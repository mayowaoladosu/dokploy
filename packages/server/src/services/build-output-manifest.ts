import { createHash } from "node:crypto";
import { z } from "zod";

const relativePathSchema = z
	.string()
	.min(1)
	.max(1_024)
	.refine(
		(value) =>
			!value.startsWith("/") &&
			!value.includes("\\") &&
			!value.includes("\0") &&
			!value.split("/").some((segment) => segment === "." || segment === ".."),
		"Expected a safe workspace-relative path",
	);

const routeSchema = z
	.string()
	.min(1)
	.max(2_048)
	.refine((value) => value.startsWith("/") && !value.includes("\0"), {
		message: "Expected an absolute URL path",
	});

const cachePolicySchema = z.enum(["immutable", "revalidate", "no-cache"]);

const staticDirectorySchema = z
	.object({
		directory: relativePathSchema,
		routePrefix: routeSchema,
		cachePolicy: cachePolicySchema,
	})
	.strict();

const functionSchema = z
	.object({
		name: z.string().min(1).max(200),
		kind: z.enum(["ssr", "api", "scheduled", "image-optimizer"]),
		route: routeSchema.optional(),
		entrypoint: relativePathSchema,
		runtime: z.enum(["nodejs", "bun", "deno", "container"]),
		timeoutSeconds: z.number().int().min(1).max(900).default(60),
		memoryMb: z.number().int().min(64).max(30_720).default(512),
		schedule: z.string().min(5).max(200).optional(),
	})
	.strict()
	.superRefine((value, context) => {
		if (value.kind === "scheduled" && !value.schedule) {
			context.addIssue({
				code: "custom",
				path: ["schedule"],
				message: "Scheduled functions require a cron schedule",
			});
		}
		if (value.kind !== "scheduled" && value.schedule) {
			context.addIssue({
				code: "custom",
				path: ["schedule"],
				message: "Only scheduled functions may define a cron schedule",
			});
		}
	});

const isrRouteSchema = z
	.object({
		route: routeSchema,
		revalidateSeconds: z.number().int().min(1).max(31_536_000),
		fallback: z.enum(["blocking", "static", "none"]).default("none"),
	})
	.strict();

const redirectSchema = z
	.object({
		source: routeSchema,
		destination: z.string().min(1).max(2_048),
		statusCode: z.union([
			z.literal(301),
			z.literal(302),
			z.literal(307),
			z.literal(308),
		]),
	})
	.strict();

const headerSchema = z
	.object({
		source: routeSchema,
		values: z
			.record(z.string().min(1).max(128), z.string().max(8_192))
			.refine((value) => Object.keys(value).length <= 100, "Too many headers"),
	})
	.strict();

const middlewareSchema = z
	.object({
		name: z.string().min(1).max(200),
		matcher: routeSchema,
		entrypoint: relativePathSchema,
		runtime: z.literal("edge"),
	})
	.strict();

export const buildOutputManifestSchema = z
	.object({
		version: z.literal(1),
		framework: z
			.object({
				name: z.enum([
					"next",
					"nuxt",
					"astro",
					"sveltekit",
					"remix",
					"vite",
					"static",
					"container",
					"custom",
				]),
				version: z.string().max(100).optional(),
			})
			.strict(),
		mode: z.enum(["container", "static", "hybrid"]),
		staticDirectories: z.array(staticDirectorySchema).max(32).default([]),
		functions: z.array(functionSchema).max(500).default([]),
		isr: z.array(isrRouteSchema).max(1_000).default([]),
		redirects: z.array(redirectSchema).max(1_000).default([]),
		headers: z.array(headerSchema).max(1_000).default([]),
		edgeMiddleware: z.array(middlewareSchema).max(100).default([]),
		images: z
			.object({
				path: routeSchema,
				formats: z
					.array(
						z.enum(["image/avif", "image/webp", "image/jpeg", "image/png"]),
					)
					.max(10),
				widths: z.array(z.number().int().min(1).max(10_000)).max(100),
			})
			.strict()
			.optional(),
		staticOutput: z
			.object({
				fileCount: z.number().int().min(0).max(100_000),
				totalBytes: z
					.number()
					.int()
					.min(0)
					.max(10 * 1024 ** 3),
			})
			.strict(),
		metadata: z
			.object({
				adapter: z.string().min(1).max(100),
				generatedAt: z.string().datetime(),
			})
			.strict(),
	})
	.strict()
	.superRefine((manifest, context) => {
		if (manifest.mode === "static" && manifest.staticDirectories.length === 0) {
			context.addIssue({
				code: "custom",
				path: ["staticDirectories"],
				message: "Static output requires at least one static directory",
			});
		}
		if (
			(manifest.mode === "container" || manifest.mode === "static") &&
			(manifest.functions.length > 0 || manifest.edgeMiddleware.length > 0)
		) {
			context.addIssue({
				code: "custom",
				path: ["mode"],
				message: `${manifest.mode} output cannot declare function adapters`,
			});
		}
		for (const [field, values] of [
			["functions", manifest.functions.map((entry) => entry.name)],
			["edgeMiddleware", manifest.edgeMiddleware.map((entry) => entry.name)],
		] as const) {
			if (new Set(values).size !== values.length) {
				context.addIssue({
					code: "custom",
					path: [field],
					message: `Duplicate ${field} identities are not allowed`,
				});
			}
		}
	});

export type BuildOutputManifest = z.infer<typeof buildOutputManifestSchema>;

const outputArtifactMetadataSchema = z
	.object({
		manifest: buildOutputManifestSchema,
		manifestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
		publicBaseUrl: z.string().url(),
		objectPrefix: relativePathSchema,
	})
	.passthrough()
	.superRefine((output, context) => {
		const url = new URL(output.publicBaseUrl);
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		) {
			context.addIssue({
				code: "custom",
				path: ["publicBaseUrl"],
				message: "Output publication must use a clean HTTPS URL",
			});
		}
	});

export type BuildOutputArtifactMetadata = z.infer<
	typeof outputArtifactMetadataSchema
>;

export const parseBuildOutputManifest = (value: unknown) => {
	const parsed = buildOutputManifestSchema.safeParse(value);
	if (!parsed.success) {
		throw new Error("Build returned an invalid vlyv output manifest");
	}
	return parsed.data;
};

export const parseBuildOutputManifestJson = (value: string | Uint8Array) => {
	const bytes =
		typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
	if (bytes.byteLength > 1024 * 1024) {
		throw new Error("Build output manifest exceeds the 1 MiB limit");
	}
	try {
		return parseBuildOutputManifest(JSON.parse(bytes.toString("utf8")));
	} catch (error) {
		if (
			error instanceof Error &&
			error.message.includes("vlyv output manifest")
		) {
			throw error;
		}
		throw new Error("Build output manifest is not valid JSON");
	}
};

export const parseBuildOutputArtifactMetadata = (
	metadata: Record<string, unknown>,
): BuildOutputArtifactMetadata | null => {
	if (metadata.output === undefined) return null;
	const parsed = outputArtifactMetadataSchema.safeParse(metadata.output);
	if (!parsed.success) {
		throw new Error("Release artifact has invalid framework output metadata");
	}
	return parsed.data;
};

export const buildOutputManifestDigest = (value: string | Uint8Array) =>
	`sha256:${createHash("sha256").update(value).digest("hex")}`;

export const buildOutputManifestSummary = (manifest: BuildOutputManifest) => ({
	version: manifest.version,
	framework: manifest.framework.name,
	mode: manifest.mode,
	staticDirectoryCount: manifest.staticDirectories.length,
	functionCount: manifest.functions.length,
	isrRouteCount: manifest.isr.length,
	redirectCount: manifest.redirects.length,
	headerRuleCount: manifest.headers.length,
	edgeMiddlewareCount: manifest.edgeMiddleware.length,
	staticFileCount: manifest.staticOutput.fileCount,
	staticBytes: manifest.staticOutput.totalBytes,
});

export const staticRoutePrefixes = (manifest: BuildOutputManifest) =>
	Array.from(
		new Set(
			manifest.staticDirectories.map((entry) => entry.routePrefix).sort(),
		),
	);

const discoveryProgram = String.raw`
import fs from "node:fs";
import path from "node:path";

const workspace = path.resolve(process.env.VLYV_WORKSPACE || ".");
const artifacts = path.resolve(process.env.VLYV_ARTIFACTS || "/artifacts");
const staticRoot = path.join(artifacts, "static");
const exists = (value) => fs.existsSync(path.join(workspace, value));
const readJson = (value) => {
  try { return JSON.parse(fs.readFileSync(path.join(workspace, value), "utf8")); }
  catch { return null; }
};
const safeRelative = (value) => {
  if (typeof value !== "string" || !value || path.isAbsolute(value) || value.includes("\\") || value.includes("\0")) throw new Error("Unsafe output path");
  if (value.split("/").some((part) => part === "." || part === "..")) throw new Error("Unsafe output path");
  return value.replace(/^\/+|\/+$/g, "");
};
const route = (value) => {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\0")) throw new Error("Unsafe route");
  return value;
};
const packageJson = readJson("package.json") || {};
const dependencies = { ...(packageJson.dependencies || {}), ...(packageJson.devDependencies || {}) };
const versionOf = (name) => typeof dependencies[name] === "string" ? dependencies[name] : undefined;
const generatedAt = new Date().toISOString();
const base = (name, mode, adapter) => ({
  version: 1,
  framework: { name, ...(versionOf(name) ? { version: versionOf(name) } : {}) },
  mode,
  staticDirectories: [], functions: [], isr: [], redirects: [], headers: [], edgeMiddleware: [],
  metadata: { adapter, generatedAt },
});
let manifest;
const configuredStaticDirectory = process.env.VLYV_PUBLISH_DIRECTORY ? safeRelative(process.env.VLYV_PUBLISH_DIRECTORY) : undefined;
if (exists(".vlyv/output.json")) {
  manifest = readJson(".vlyv/output.json");
  if (!manifest || typeof manifest !== "object") throw new Error("Invalid custom output manifest");
  manifest = { ...manifest, version: 1, framework: { ...(manifest.framework || {}), name: "custom" }, metadata: { adapter: "custom", generatedAt } };
} else if (configuredStaticDirectory && exists(configuredStaticDirectory)) {
	manifest = base("static", "static", "configured-static");
	manifest.staticDirectories.push({ directory: configuredStaticDirectory, routePrefix: "/", cachePolicy: "revalidate" });
} else if (versionOf("next") || exists(".next")) {
  manifest = base("next", "hybrid", "next");
  if (exists(".next/static")) manifest.staticDirectories.push({ directory: ".next/static", routePrefix: "/_next/static", cachePolicy: "immutable" });
  if (exists("public")) manifest.staticDirectories.push({ directory: "public", routePrefix: "/", cachePolicy: "revalidate" });
  const pages = readJson(".next/server/pages-manifest.json") || {};
  for (const [pageRoute, entrypoint] of Object.entries(pages).slice(0, 500)) {
    if (["/_app", "/_document", "/_error"].includes(pageRoute)) continue;
    manifest.functions.push({ name: pageRoute, kind: pageRoute.startsWith("/api/") ? "api" : "ssr", route: route(pageRoute), entrypoint: safeRelative(".next/server/" + entrypoint), runtime: "nodejs", timeoutSeconds: 60, memoryMb: 512 });
  }
  const appPaths = readJson(".next/server/app-paths-manifest.json") || {};
  for (const [appRoute, entrypoint] of Object.entries(appPaths).slice(0, Math.max(500 - manifest.functions.length, 0))) {
    const normalized = "/" + appRoute.replace(/\/page$/, "").replace(/\/route$/, "").replace(/^\/+/, "");
    manifest.functions.push({ name: normalized, kind: appRoute.endsWith("/route") ? "api" : "ssr", route: route(normalized), entrypoint: safeRelative(".next/server/" + entrypoint), runtime: "nodejs", timeoutSeconds: 60, memoryMb: 512 });
  }
  const prerender = readJson(".next/prerender-manifest.json") || {};
  for (const [pathname, value] of Object.entries(prerender.routes || {}).slice(0, 1000)) {
    if (typeof value?.initialRevalidateSeconds === "number" && value.initialRevalidateSeconds > 0) manifest.isr.push({ route: route(pathname), revalidateSeconds: value.initialRevalidateSeconds, fallback: "static" });
  }
  const routes = readJson(".next/routes-manifest.json") || {};
  for (const value of (routes.redirects || []).slice(0, 1000)) manifest.redirects.push({ source: route(value.source), destination: value.destination, statusCode: value.statusCode || (value.permanent ? 308 : 307) });
  for (const value of (routes.headers || []).slice(0, 1000)) manifest.headers.push({ source: route(value.source), values: Object.fromEntries((value.headers || []).map((entry) => [entry.key, entry.value])) });
  const middleware = readJson(".next/server/middleware-manifest.json") || {};
  for (const [matcher, value] of Object.entries(middleware.middleware || {}).slice(0, 100)) {
    const file = Array.isArray(value.files) ? value.files[0] : undefined;
    if (file) manifest.edgeMiddleware.push({ name: matcher, matcher: route(matcher), entrypoint: safeRelative(".next/server/" + file), runtime: "edge" });
  }
  if (exists(".next/images-manifest.json")) manifest.images = { path: "/_next/image", formats: ["image/avif", "image/webp"], widths: [16,32,48,64,96,128,256,384,640,750,828,1080,1200,1920,2048,3840] };
} else if (versionOf("nuxt") || exists(".output")) {
  const server = exists(".output/server/index.mjs");
  manifest = base("nuxt", server ? "hybrid" : "static", "nuxt");
  if (exists(".output/public")) manifest.staticDirectories.push({ directory: ".output/public", routePrefix: "/", cachePolicy: "revalidate" });
  if (server) manifest.functions.push({ name: "nuxt-ssr", kind: "ssr", route: "/", entrypoint: ".output/server/index.mjs", runtime: "nodejs", timeoutSeconds: 60, memoryMb: 512 });
} else if (versionOf("astro") || exists(".astro")) {
  const server = exists("dist/server/entry.mjs");
  manifest = base("astro", server ? "hybrid" : "static", "astro");
  if (exists(server ? "dist/client" : "dist")) manifest.staticDirectories.push({ directory: server ? "dist/client" : "dist", routePrefix: "/", cachePolicy: "revalidate" });
  if (server) manifest.functions.push({ name: "astro-ssr", kind: "ssr", route: "/", entrypoint: "dist/server/entry.mjs", runtime: "nodejs", timeoutSeconds: 60, memoryMb: 512 });
} else if (versionOf("@sveltejs/kit") || exists(".svelte-kit")) {
  const server = exists("build/index.js") || exists(".svelte-kit/output/server/index.js");
  manifest = base("sveltekit", server ? "hybrid" : "static", "sveltekit");
  const client = exists("build/client") ? "build/client" : ".svelte-kit/output/client";
  if (exists(client)) manifest.staticDirectories.push({ directory: client, routePrefix: "/", cachePolicy: "revalidate" });
  if (server) manifest.functions.push({ name: "sveltekit-ssr", kind: "ssr", route: "/", entrypoint: exists("build/index.js") ? "build/index.js" : ".svelte-kit/output/server/index.js", runtime: "nodejs", timeoutSeconds: 60, memoryMb: 512 });
} else if (versionOf("@remix-run/node") || exists("build/server")) {
  manifest = base("remix", "hybrid", "remix");
  if (exists("public/build")) manifest.staticDirectories.push({ directory: "public/build", routePrefix: "/build", cachePolicy: "immutable" });
  const entrypoint = exists("build/server/index.js") ? "build/server/index.js" : "build/index.js";
  if (exists(entrypoint)) manifest.functions.push({ name: "remix-ssr", kind: "ssr", route: "/", entrypoint, runtime: "nodejs", timeoutSeconds: 60, memoryMb: 512 });
} else {
  const directory = ["dist", "build", "out", "public"].find(exists);
  manifest = base(directory ? (versionOf("vite") ? "vite" : "static") : "container", directory ? "static" : "container", directory ? "static" : "container");
  if (directory) manifest.staticDirectories.push({ directory, routePrefix: "/", cachePolicy: "revalidate" });
}
const vercel = readJson("vercel.json") || {};
for (const cron of (vercel.crons || []).slice(0, 100)) {
  if (typeof cron.path === "string" && typeof cron.schedule === "string") manifest.functions.push({ name: "cron:" + cron.path, kind: "scheduled", entrypoint: "package.json", runtime: "container", timeoutSeconds: 300, memoryMb: 512, schedule: cron.schedule });
}
fs.rmSync(staticRoot, { recursive: true, force: true });
fs.mkdirSync(staticRoot, { recursive: true });
let fileCount = 0;
let totalBytes = 0;
const copyDirectory = (entry) => {
  const relative = safeRelative(entry.directory);
  const source = path.resolve(workspace, relative);
  if (!(source === workspace || source.startsWith(workspace + path.sep))) throw new Error("Output directory escapes workspace");
	if (!fs.existsSync(source) || fs.lstatSync(source).isSymbolicLink() || !fs.statSync(source).isDirectory()) throw new Error("Output directory is unavailable: " + relative);
  const prefix = route(entry.routePrefix).replace(/^\/+|\/+$/g, "");
  const visit = (directory, child = "") => {
    for (const name of fs.readdirSync(directory).sort()) {
      const sourcePath = path.join(directory, name);
      const relativeFile = path.posix.join(child.replace(/\\/g, "/"), name);
	if (!/^[a-zA-Z0-9._~!$&'()+,;=:@/-]{1,1024}$/.test(relativeFile)) throw new Error("Static output contains an unsafe filename");
      const stat = fs.lstatSync(sourcePath);
      if (stat.isSymbolicLink()) throw new Error("Static output may not contain symlinks");
      if (stat.isDirectory()) visit(sourcePath, relativeFile);
      else if (stat.isFile()) {
        fileCount += 1; totalBytes += stat.size;
        if (fileCount > 100000 || totalBytes > 10 * 1024 * 1024 * 1024) throw new Error("Static output exceeds platform limits");
        const destination = path.join(staticRoot, prefix, relativeFile);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        if (fs.existsSync(destination)) throw new Error("Static output path collision: " + relativeFile);
        fs.copyFileSync(sourcePath, destination);
      }
    }
  };
  visit(source);
};
for (const entry of manifest.staticDirectories || []) copyDirectory(entry);
manifest.staticOutput = { fileCount, totalBytes };
fs.writeFileSync(path.join(artifacts, "output-manifest.json"), JSON.stringify(manifest));
`;

export const buildOutputDiscoveryProgram = discoveryProgram;

export const buildOutputDiscoveryShell = ({
	workspace,
	publishDirectory,
}: {
	workspace: string;
	publishDirectory?: string | null;
}) => {
	const encoded = Buffer.from(discoveryProgram, "utf8").toString("base64");
	const quotedWorkspace = `'${workspace.replace(/'/g, `'"'"'`)}'`;
	const quotedPublishDirectory = publishDirectory
		? `'${publishDirectory.replace(/'/g, `'"'"'`)}'`
		: "''";
	return `
printf '%s' '${encoded}' | base64 -d >/tmp/vlyv-output-discovery.mjs
VLYV_WORKSPACE=${quotedWorkspace} VLYV_PUBLISH_DIRECTORY=${quotedPublishDirectory} VLYV_ARTIFACTS=/artifacts node /tmp/vlyv-output-discovery.mjs
`;
};
