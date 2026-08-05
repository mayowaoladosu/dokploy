import { db } from "@dokploy/server/db";
import {
	type ApiCredentialScope,
	environments,
	type ManagedDataKind,
	type ManagedDataResource,
	managedDataResources,
	projects,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { assertPublicHealthEndpoint } from "./runtime-scheduler";

export type ManagedDataProvisionRequest = {
	idempotencyKey: string;
	organizationId: string;
	projectId: string;
	environmentId: string;
	regionId?: string | null;
	kind: ManagedDataKind;
	name: string;
	plan: string;
	metadata?: Record<string, unknown>;
};

export type ManagedDataProviderResult = {
	providerResourceId: string;
	status: "provisioning" | "ready";
	connectionUri?: string;
	metadata?: Record<string, unknown>;
};

export interface ManagedDataProvider {
	readonly name: string;
	readonly kinds: ReadonlySet<ManagedDataKind>;
	provision(
		request: ManagedDataProvisionRequest,
	): Promise<ManagedDataProviderResult>;
	getStatus(providerResourceId: string): Promise<ManagedDataProviderResult>;
	rotateCredentials(
		providerResourceId: string,
	): Promise<{ connectionUri: string }>;
	createBackup(providerResourceId: string): Promise<{ backupId: string }>;
	delete(providerResourceId: string): Promise<void>;
}

const providers = new Map<string, ManagedDataProvider>();

export const registerManagedDataProvider = (provider: ManagedDataProvider) => {
	providers.set(provider.name, provider);
};

export const clearManagedDataProviders = () => providers.clear();

export const getManagedDataProvider = (name: string) => {
	const provider = providers.get(name);
	if (!provider) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: `Managed data provider ${name} is not configured`,
		});
	}
	return provider;
};

const providerResponse = z.object({
	providerResourceId: z.string().min(1),
	status: z.enum(["provisioning", "ready"]),
	connectionUri: z.string().min(1).optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
});

export const createHttpManagedDataProvider = ({
	name,
	baseUrl,
	token,
	kinds,
	fetcher = fetch,
	validateEndpoint = assertPublicHealthEndpoint,
}: {
	name: string;
	baseUrl: string;
	token: string;
	kinds: ManagedDataKind[];
	fetcher?: typeof fetch;
	validateEndpoint?: (endpoint: string) => Promise<void>;
}): ManagedDataProvider => {
	const providerUrl = new URL(baseUrl);
	if (providerUrl.protocol !== "https:") {
		throw new Error("Managed data provider URL must use HTTPS");
	}
	const request = async <T>(
		path: string,
		init: RequestInit,
		schema: z.ZodType<T>,
	) => {
		await validateEndpoint(providerUrl.toString());
		const response = await fetcher(new URL(path, baseUrl), {
			...init,
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${token}`,
				...init.headers,
			},
			signal: AbortSignal.timeout(30_000),
			redirect: "error",
		});
		if (!response.ok) {
			throw new Error(`Managed data provider returned HTTP ${response.status}`);
		}
		return schema.parse(await response.json());
	};

	return {
		name,
		kinds: new Set(kinds),
		provision: async (input) =>
			request(
				"/v1/resources",
				{ method: "POST", body: JSON.stringify(input) },
				providerResponse,
			),
		getStatus: async (providerResourceId) =>
			request(
				`/v1/resources/${encodeURIComponent(providerResourceId)}`,
				{ method: "GET" },
				providerResponse,
			),
		rotateCredentials: async (providerResourceId) =>
			request(
				`/v1/resources/${encodeURIComponent(providerResourceId)}/credentials/rotate`,
				{ method: "POST" },
				z.object({ connectionUri: z.string().min(1) }),
			),
		createBackup: async (providerResourceId) =>
			request(
				`/v1/resources/${encodeURIComponent(providerResourceId)}/backups`,
				{ method: "POST" },
				z.object({ backupId: z.string().min(1) }),
			),
		delete: async (providerResourceId) => {
			await validateEndpoint(providerUrl.toString());
			const response = await fetcher(
				new URL(
					`/v1/resources/${encodeURIComponent(providerResourceId)}`,
					baseUrl,
				),
				{
					method: "DELETE",
					headers: { authorization: `Bearer ${token}` },
					signal: AbortSignal.timeout(30_000),
					redirect: "error",
				},
			);
			if (!response.ok && response.status !== 404) {
				throw new Error(
					`Managed data provider returned HTTP ${response.status}`,
				);
			}
		},
	};
};

const validateOwnership = async (input: ManagedDataProvisionRequest) => {
	const [project, environment] = await Promise.all([
		db.query.projects.findFirst({
			where: and(
				eq(projects.projectId, input.projectId),
				eq(projects.organizationId, input.organizationId),
			),
		}),
		db.query.environments.findFirst({
			where: and(
				eq(environments.environmentId, input.environmentId),
				eq(environments.projectId, input.projectId),
			),
		}),
	]);
	if (!project || !environment) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Managed data project or environment was not found",
		});
	}
};

export const provisionManagedDataResource = async (
	providerName: string,
	input: ManagedDataProvisionRequest,
) => {
	await validateOwnership(input);
	const provider = getManagedDataProvider(providerName);
	if (!provider.kinds.has(input.kind)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `${providerName} does not support ${input.kind}`,
		});
	}
	const existing = await db.query.managedDataResources.findFirst({
		where: eq(managedDataResources.idempotencyKey, input.idempotencyKey),
	});
	if (existing) return redactManagedDataResource(existing);

	const [record] = await db
		.insert(managedDataResources)
		.values({ ...input, provider: providerName })
		.returning();
	if (!record) throw new Error("Failed to create managed data record");

	try {
		const provisioned = await provider.provision(input);
		const [updated] = await db
			.update(managedDataResources)
			.set({
				providerResourceId: provisioned.providerResourceId,
				status: provisioned.status,
				connectionUri: provisioned.connectionUri,
				metadata: { ...input.metadata, ...provisioned.metadata },
				updatedAt: new Date(),
			})
			.where(
				eq(
					managedDataResources.managedDataResourceId,
					record.managedDataResourceId,
				),
			)
			.returning();
		if (!updated) throw new Error("Failed to update managed data record");
		return redactManagedDataResource(updated);
	} catch (error) {
		await db
			.update(managedDataResources)
			.set({
				status: "error",
				errorMessage: error instanceof Error ? error.message : String(error),
				updatedAt: new Date(),
			})
			.where(
				eq(
					managedDataResources.managedDataResourceId,
					record.managedDataResourceId,
				),
			);
		throw error;
	}
};

export const refreshManagedDataResource = async (resourceId: string) => {
	const resource = await findManagedDataResource(resourceId);
	if (!resource.providerResourceId) return redactManagedDataResource(resource);
	const status = await getManagedDataProvider(resource.provider).getStatus(
		resource.providerResourceId,
	);
	const [updated] = await db
		.update(managedDataResources)
		.set({
			status: status.status,
			connectionUri: status.connectionUri ?? resource.connectionUri,
			metadata: { ...resource.metadata, ...status.metadata },
			updatedAt: new Date(),
		})
		.where(eq(managedDataResources.managedDataResourceId, resourceId))
		.returning();
	if (!updated) throw new Error("Failed to refresh managed data resource");
	return redactManagedDataResource(updated);
};

export const rotateManagedDataCredentials = async (resourceId: string) => {
	const resource = await findManagedDataResource(resourceId);
	if (!resource.providerResourceId) {
		throw new Error("Managed data resource is not provisioned");
	}
	const rotated = await getManagedDataProvider(
		resource.provider,
	).rotateCredentials(resource.providerResourceId);
	await db
		.update(managedDataResources)
		.set({ connectionUri: rotated.connectionUri, updatedAt: new Date() })
		.where(eq(managedDataResources.managedDataResourceId, resourceId));
	return true;
};

export const deleteManagedDataResource = async (resourceId: string) => {
	const resource = await findManagedDataResource(resourceId);
	await db
		.update(managedDataResources)
		.set({ status: "deleting", updatedAt: new Date() })
		.where(eq(managedDataResources.managedDataResourceId, resourceId));
	if (resource.providerResourceId) {
		await getManagedDataProvider(resource.provider).delete(
			resource.providerResourceId,
		);
	}
	await db
		.update(managedDataResources)
		.set({ status: "deleted", connectionUri: null, updatedAt: new Date() })
		.where(eq(managedDataResources.managedDataResourceId, resourceId));
	return true;
};

export const findManagedDataResource = async (resourceId: string) => {
	const resource = await db.query.managedDataResources.findFirst({
		where: eq(managedDataResources.managedDataResourceId, resourceId),
	});
	if (!resource) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Managed data resource not found",
		});
	}
	return resource;
};

export const listManagedDataResources = async (organizationId: string) =>
	(
		await db.query.managedDataResources.findMany({
			where: eq(managedDataResources.organizationId, organizationId),
		})
	).map(redactManagedDataResource);

export const filterManagedDataResourcesForScope = <
	T extends { projectId: string; environmentId: string },
>(
	resources: T[],
	scope: ApiCredentialScope | null | undefined,
) => {
	if (!scope) return resources;
	return resources.filter(
		(resource) =>
			(scope.projectIds.length === 0 ||
				scope.projectIds.includes(resource.projectId)) &&
			(scope.environmentIds.length === 0 ||
				scope.environmentIds.includes(resource.environmentId)),
	);
};

export const redactManagedDataResource = <T extends ManagedDataResource>(
	resource: T,
) => ({
	...resource,
	connectionUri: resource.connectionUri ? "[REDACTED]" : null,
});

export const configureManagedDataProviderFromEnvironment = () => {
	const baseUrl = process.env.MANAGED_DATA_PROVIDER_URL;
	const token = process.env.MANAGED_DATA_PROVIDER_TOKEN;
	if (!baseUrl || !token) return null;
	const provider = createHttpManagedDataProvider({
		name: process.env.MANAGED_DATA_PROVIDER_NAME || "default",
		baseUrl,
		token,
		kinds: ["postgres", "mysql", "mariadb", "mongo", "redis", "libsql"],
		validateEndpoint:
			process.env.MANAGED_DATA_PROVIDER_ALLOW_PRIVATE === "true"
				? async () => undefined
				: assertPublicHealthEndpoint,
	});
	registerManagedDataProvider(provider);
	return provider.name;
};
