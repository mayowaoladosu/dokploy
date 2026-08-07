/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	managedTenantPageSourceFragments,
	selfHostedOnlyPageSourceFragments,
} from "./managed-surface.config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isManagedTarget =
	process.env.DOKPLOY_BUILD_TARGET === "managed" ||
	process.env.PLATFORM_MODE === "managed";

/** @type {import("next").NextConfig} */
const nextConfig = {
	reactStrictMode: true,
	outputFileTracingRoot: path.resolve(__dirname, "../.."),
	typescript: {
		ignoreBuildErrors: true,
	},
	transpilePackages: ["@dokploy/server"],
	webpack(config, { webpack }) {
		const replacement = path.resolve(
			__dirname,
			"components/managed/managed-not-found-page.tsx",
		);
		if (!isManagedTarget) {
			config.plugins.push(
				new webpack.NormalModuleReplacementPlugin(
					/./,
					/** @param {{ context?: string, request: string }} resource */ (
						resource,
					) => {
						const candidate = path
							.resolve(resource.context || __dirname, resource.request)
							.replaceAll("\\", "/");
						if (
							selfHostedOnlyPageSourceFragments.some(
								(fragment) =>
									candidate ===
										path.resolve(__dirname, fragment).replaceAll("\\", "/") ||
									candidate.endsWith(`/${fragment}`),
							)
						) {
							resource.request = replacement;
						}
					},
				),
			);
			return config;
		}
		config.resolve.alias = {
			...config.resolve.alias,
			"@/server/api/root": path.resolve(
				__dirname,
				"server/api/managed-root-alias.ts",
			),
			"@/server/api/runtime-root": path.resolve(
				__dirname,
				"server/api/managed-runtime-root.ts",
			),
		};
		config.plugins.push(
			new webpack.NormalModuleReplacementPlugin(
				/./,
				/** @param {{ context?: string, request: string }} resource */ (
					resource,
				) => {
					const candidate = path
						.resolve(resource.context || __dirname, resource.request)
						.replaceAll("\\", "/");
					if (
						managedTenantPageSourceFragments.some(
							(fragment) =>
								candidate ===
									path.resolve(__dirname, fragment).replaceAll("\\", "/") ||
								candidate.endsWith(`/${fragment}`),
						)
					) {
						resource.request = replacement;
					}
				},
			),
		);
		return config;
	},
	async headers() {
		return [
			{
				// Apply security headers to all routes
				source: "/:path*",
				headers: [
					{
						key: "X-Frame-Options",
						value: "DENY",
					},
					{
						key: "Content-Security-Policy",
						value: "frame-ancestors 'none'",
					},
					{
						key: "X-Content-Type-Options",
						value: "nosniff",
					},
					{
						key: "Referrer-Policy",
						value: "strict-origin-when-cross-origin",
					},
				],
			},
		];
	},
};

export default nextConfig;
