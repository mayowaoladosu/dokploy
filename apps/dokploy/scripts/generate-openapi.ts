#!/usr/bin/env tsx

/**
 * Script to generate OpenAPI specification locally
 * This runs in CI/CD to generate the openapi.json file
 * which can then be consumed by the documentation website
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateOpenApiDocument } from "@dokploy/trpc-openapi";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function generateOpenAPI() {
	try {
		console.log("🔄 Generating OpenAPI specification...");
		const outputPath = resolve(__dirname, "../../../openapi.json");
		const managedTarget =
			process.env.DOKPLOY_BUILD_TARGET === "managed" ||
			process.env.PLATFORM_MODE === "managed";
		if (managedTarget) {
			const document = JSON.parse(readFileSync(outputPath, "utf8")) as {
				info: Record<string, unknown>;
				tags?: Array<{ name?: string }>;
				paths?: Record<string, unknown>;
				servers?: Array<{ url: string }>;
			};
			const forbiddenNamespaces = new Set([
				"admin",
				"backup",
				"certificates",
				"cluster",
				"compose",
				"destination",
				"docker",
				"libsql",
				"licenseKey",
				"mariadb",
				"mongo",
				"mysql",
				"network",
				"platformEdge",
				"platformInfrastructure",
				"postgres",
				"redis",
				"registry",
				"schedule",
				"server",
				"sshKey",
				"sshRouter",
				"swarm",
				"volumeBackups",
			]);
			const safeSettings = new Set([
				"getDokployVersion",
				"getIp",
				"getOpenApiDocument",
				"getWebServerSettings",
				"health",
				"isCloud",
				"isUserSubscribed",
				"platformCapabilities",
			]);
			for (const route of Object.keys(document.paths ?? {})) {
				const procedure = route.replace(/^\//, "");
				const [namespace, name] = procedure.split(".");
				if (
					(namespace && forbiddenNamespaces.has(namespace)) ||
					(namespace === "settings" && (!name || !safeSettings.has(name)))
				) {
					delete document.paths?.[route];
				}
			}
			document.tags = document.tags?.filter(
				(tag) => !tag.name || !forbiddenNamespaces.has(tag.name),
			);
			document.info = {
				...document.info,
				title: "vlyv API",
				description:
					"Managed vlyv tenant API for applications, deployments, domains, Git delivery, managed data, observability, usage, billing, and organization resources.",
				contact: { name: "vlyv", url: "https://vlyv.dev" },
				license: {
					name: "Apache 2.0",
					url: "https://github.com/mayowaoladosu/dokploy/blob/main/LICENSE.MD",
				},
			};
			document.servers = [{ url: "https://vlyv.dev/api" }];
			(
				document as { externalDocs?: { description: string; url: string } }
			).externalDocs = {
				description: "vlyv documentation",
				url: "https://vlyv.dev",
			};
			writeFileSync(outputPath, JSON.stringify(document, null, 2), "utf-8");
			console.log("✅ Managed tenant OpenAPI specification generated");
			console.log(`📊 Endpoints: ${Object.keys(document.paths ?? {}).length}`);
			return;
		}

		const documentRouter = (await import("../server/api/root")).appRouter;
		const openApiDocument = generateOpenApiDocument(documentRouter, {
			title: "Dokploy API",
			version: "1.0.0",
			baseUrl: "https://your-dokploy-instance.com/api",
			docsUrl: "https://docs.dokploy.com/api",
			tags: [
				"admin",
				"docker",
				"compose",
				"registry",
				"cluster",
				"user",
				"domain",
				"destination",
				"backup",
				"deployment",
				"mounts",
				"certificates",
				"settings",
				"security",
				"redirects",
				"port",
				"project",
				"application",
				"mysql",
				"postgres",
				"redis",
				"mongo",
				"mariadb",
				"sshRouter",
				"gitProvider",
				"bitbucket",
				"github",
				"gitlab",
				"gitea",
				"server",
				"swarm",
				"ai",
				"organization",
				"schedule",
				"rollback",
				"volumeBackups",
				"environment",
			],
		});

		// Enhance metadata
		openApiDocument.info = {
			title: "Dokploy API",
			description:
				"Complete API documentation for Dokploy - Deploy applications, manage databases, and orchestrate your infrastructure. This API allows you to programmatically manage all aspects of your Dokploy instance.",
			version: "1.0.0",
			contact: {
				name: "Dokploy Team",
				url: "https://dokploy.com",
			},
			license: {
				name: "Apache 2.0",
				url: "https://github.com/dokploy/dokploy/blob/canary/LICENSE",
			},
		};

		// Add security schemes
		openApiDocument.components = {
			...openApiDocument.components,
			securitySchemes: {
				apiKey: {
					type: "apiKey",
					in: "header",
					name: "x-api-key",
					description:
						"API key authentication. Generate an API key from your Dokploy dashboard under Settings > API Keys.",
				},
			},
		};

		// Apply global security
		openApiDocument.security = [
			{
				apiKey: [],
			},
		];

		// Add external docs
		openApiDocument.externalDocs = {
			description: "Full documentation",
			url: "https://docs.dokploy.com",
		};

		// Write to root of repo
		writeFileSync(
			outputPath,
			JSON.stringify(openApiDocument, null, 2),
			"utf-8",
		);

		console.log("✅ OpenAPI specification generated successfully!");
		console.log(`📄 Output: ${outputPath}`);
		console.log(
			`📊 Endpoints: ${Object.keys(openApiDocument.paths || {}).length}`,
		);
	} catch (error) {
		console.error("❌ Error generating OpenAPI specification:", error);
		process.exit(1);
	} finally {
		process.exit(0);
	}
}

generateOpenAPI();
