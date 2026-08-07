import { Buffer } from "node:buffer";
import { IS_MANAGED_PAAS } from "@dokploy/server/constants";
import { db } from "@dokploy/server/db";
import {
	type PlatformBuildPoolMetadata,
	type PlatformClusterMetadata,
	type PlatformNodeTaint,
	platformBuildPools,
	platformClusters,
	platformEdgeProviders,
	platformNodePools,
	platformObjectStorages,
	platformObservabilityBackends,
	platformRegions,
	platformRuntimeTargets,
} from "@dokploy/server/db/schema";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
	activatePlatformObservabilityBackend,
	createPlatformObservabilityBackend,
	updatePlatformObservabilityBackend,
} from "./observability";
import {
	createPlatformEdgeProvider,
	createPlatformObjectStorage,
	updatePlatformEdgeProvider,
	updatePlatformObjectStorage,
} from "./platform-edge";
import {
	createPlatformBuildPool,
	createPlatformCluster,
	createPlatformRuntimeTarget,
	updatePlatformBuildPool,
	updatePlatformCluster,
	updatePlatformRuntimeTarget,
} from "./platform-infrastructure";

const DIGEST_IMAGE = /^[^\s@]+@sha256:[a-f0-9]{64}$/;
const HEADER_NAME = /^[a-zA-Z0-9!#$%&'*+.^_`|~-]{1,128}$/;

const required = (name: string) => {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required for managed bootstrap`);
	return value;
};

const optional = (name: string) => process.env[name]?.trim() || undefined;

const booleanValue = (name: string, fallback: boolean) => {
	const value = optional(name)?.toLowerCase();
	if (!value) return fallback;
	if (value === "true") return true;
	if (value === "false") return false;
	throw new Error(`${name} must be true or false`);
};

const integerValue = (
	name: string,
	fallback: number,
	minimum: number,
	maximum: number,
) => {
	const value = optional(name);
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
		throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
	}
	return parsed;
};

const stringRecord = (name: string, fallback: Record<string, string> = {}) => {
	const value = optional(name);
	if (!value) return fallback;
	return z.record(z.string().min(1), z.string()).parse(JSON.parse(value));
};

const taints = (name: string): PlatformNodeTaint[] => {
	const value = optional(name);
	if (!value) return [];
	return z
		.array(
			z.object({
				key: z.string().min(1),
				value: z.string().optional(),
				effect: z.enum(["NoSchedule", "PreferNoSchedule", "NoExecute"]),
			}),
		)
		.parse(JSON.parse(value));
};

const stringArray = (name: string) => {
	const value = optional(name);
	return value ? z.array(z.string().min(1)).parse(JSON.parse(value)) : [];
};

const digestImage = (name: string) => {
	const value = required(name);
	if (!DIGEST_IMAGE.test(value)) {
		throw new Error(`${name} must use an immutable sha256 image digest`);
	}
	return value;
};

const kubeconfig = () => {
	if (booleanValue("PLATFORM_KUBERNETES_IN_CLUSTER", false)) return null;
	const encoded = required("PLATFORM_KUBERNETES_KUBECONFIG_BASE64");
	const decoded = Buffer.from(encoded, "base64").toString("utf8").trim();
	if (
		!decoded ||
		decoded.length > 1024 * 1024 ||
		!decoded.includes("apiVersion:")
	) {
		throw new Error("PLATFORM_KUBERNETES_KUBECONFIG_BASE64 is invalid");
	}
	return decoded;
};

export const parseOtlpHeaders = (value: string | undefined) => {
	if (!value?.trim()) return {};
	const headers: Record<string, string> = {};
	for (const entry of value.split(",")) {
		const separator = entry.indexOf("=");
		if (separator <= 0) throw new Error("OTLP headers are invalid");
		const name = decodeURIComponent(entry.slice(0, separator).trim());
		const headerValue = decodeURIComponent(entry.slice(separator + 1).trim());
		if (!HEADER_NAME.test(name) || /[\r\n]/.test(headerValue)) {
			throw new Error("OTLP headers are invalid");
		}
		headers[name] = headerValue;
	}
	return headers;
};

export const extractOtlpAuthorization = (headers: Record<string, string>) => {
	const authorization = Object.entries(headers).find(
		([name]) => name.toLowerCase() === "authorization",
	);
	if (!authorization) {
		throw new Error("OTEL_EXPORTER_OTLP_HEADERS must include Authorization");
	}
	const match = /^(Basic|Bearer)\s+(.+)$/i.exec(authorization[1].trim());
	if (!match?.[1] || !match[2]?.trim()) {
		throw new Error("OTLP Authorization header is invalid");
	}
	return {
		authScheme:
			match[1].toLowerCase() === "basic"
				? ("Basic" as const)
				: ("Bearer" as const),
		authToken: match[2].trim(),
		headers: Object.fromEntries(
			Object.entries(headers).filter(
				([name]) => name.toLowerCase() !== "authorization",
			),
		),
	};
};

const upsertRegion = async () => {
	const slug = optional("PLATFORM_REGION_SLUG") || "layerrail-primary";
	await db
		.update(platformRegions)
		.set({ isDefault: false, updatedAt: new Date() })
		.where(eq(platformRegions.isDefault, true));
	const [region] = await db
		.insert(platformRegions)
		.values({
			slug,
			name: optional("PLATFORM_REGION_NAME") || "Layerrail Primary",
			provider: optional("PLATFORM_REGION_PROVIDER") || "layerrail",
			location: required("PLATFORM_REGION_LOCATION"),
			status: "active",
			isDefault: true,
			metadata: { managedBy: "environment" },
		})
		.onConflictDoUpdate({
			target: platformRegions.slug,
			set: {
				name: optional("PLATFORM_REGION_NAME") || "Layerrail Primary",
				provider: optional("PLATFORM_REGION_PROVIDER") || "layerrail",
				location: required("PLATFORM_REGION_LOCATION"),
				status: "active",
				isDefault: true,
				metadata: { managedBy: "environment" },
				updatedAt: new Date(),
			},
		})
		.returning();
	if (!region) throw new Error("Failed to bootstrap platform region");
	return region;
};

const upsertNodePool = async (input: {
	clusterId: string;
	name: string;
	purpose: "runtime" | "build" | "system";
	runtimeClassName?: string;
	labels: Record<string, string>;
	taints: PlatformNodeTaint[];
	minNodes: number;
	maxNodes: number;
}) => {
	const [pool] = await db
		.insert(platformNodePools)
		.values({
			...input,
			status: "active",
			architecture: optional("PLATFORM_NODE_ARCHITECTURE") || "amd64",
			metadata: { managedBy: "environment" },
		})
		.onConflictDoUpdate({
			target: [platformNodePools.clusterId, platformNodePools.name],
			set: {
				purpose: input.purpose,
				status: "active",
				architecture: optional("PLATFORM_NODE_ARCHITECTURE") || "amd64",
				runtimeClassName: input.runtimeClassName,
				labels: input.labels,
				taints: input.taints,
				minNodes: input.minNodes,
				maxNodes: input.maxNodes,
				metadata: { managedBy: "environment" },
				updatedAt: new Date(),
			},
		})
		.returning();
	if (!pool) throw new Error(`Failed to bootstrap ${input.purpose} node pool`);
	return pool;
};

const bootstrapKubernetes = async (activate: boolean) => {
	const region = await upsertRegion();
	const slug = optional("PLATFORM_CLUSTER_SLUG") || "layerrail-primary";
	const inCluster = booleanValue("PLATFORM_KUBERNETES_IN_CLUSTER", false);
	const decodedKubeconfig = kubeconfig();
	const runtimeClassName = required("PLATFORM_RUNTIME_CLASS_NAME");
	const buildRuntimeClassName =
		optional("PLATFORM_BUILD_RUNTIME_CLASS_NAME") || runtimeClassName;
	const metadata: PlatformClusterMetadata = {
		inCluster,
		runtimeClassName,
		buildRuntimeClassName,
		gatewayNamespace: optional("PLATFORM_GATEWAY_NAMESPACE") || "vlyv-system",
		gatewayName: optional("PLATFORM_GATEWAY_NAME") || "vlyv-gateway",
		gatewaySectionName: optional("PLATFORM_GATEWAY_SECTION_NAME"),
		gatewayClassName: required("PLATFORM_GATEWAY_CLASS_NAME"),
		gatewayMode:
			(optional("PLATFORM_GATEWAY_MODE") as
				| "shared"
				| "dedicated"
				| "hybrid"
				| undefined) || "shared",
		gatewayPodSelector: stringRecord("PLATFORM_GATEWAY_POD_SELECTOR_JSON"),
		registrySecretName: required("PLATFORM_RUNTIME_REGISTRY_SECRET_NAME"),
		secretsEncryptionEnabled: booleanValue(
			"PLATFORM_KUBERNETES_SECRETS_ENCRYPTION_ENABLED",
			false,
		),
		networkPolicyEnabled: booleanValue(
			"PLATFORM_KUBERNETES_NETWORK_POLICY_ENABLED",
			false,
		),
		metricsServerEnabled: booleanValue(
			"PLATFORM_KUBERNETES_METRICS_SERVER_ENABLED",
			false,
		),
		gatewayApiEnabled: booleanValue(
			"PLATFORM_KUBERNETES_GATEWAY_API_ENABLED",
			false,
		),
		certManagerEnabled: booleanValue(
			"PLATFORM_KUBERNETES_CERT_MANAGER_ENABLED",
			false,
		),
		certIssuerName: required("PLATFORM_CERT_ISSUER_NAME"),
		externalDnsEnabled: booleanValue(
			"PLATFORM_KUBERNETES_EXTERNAL_DNS_ENABLED",
			false,
		),
		externalDnsNamespace:
			optional("PLATFORM_EXTERNAL_DNS_NAMESPACE") || "external-dns",
		externalDnsDeploymentName:
			optional("PLATFORM_EXTERNAL_DNS_DEPLOYMENT_NAME") || "external-dns",
		externalDnsTarget: optional("PLATFORM_EXTERNAL_DNS_TARGET"),
		externalDnsTtl: integerValue("PLATFORM_EXTERNAL_DNS_TTL", 60, 1, 86_400),
		metricsServerNamespace:
			optional("PLATFORM_METRICS_SERVER_NAMESPACE") || "kube-system",
		metricsServerDeploymentName:
			optional("PLATFORM_METRICS_SERVER_DEPLOYMENT_NAME") || "metrics-server",
		observabilityCollectorImage: digestImage(
			"PLATFORM_OBSERVABILITY_COLLECTOR_IMAGE",
		),
		observabilityNamespace:
			optional("PLATFORM_OBSERVABILITY_NAMESPACE") || "vlyv-observability",
		managedDataBackupImage: digestImage("PLATFORM_MANAGED_DATA_BACKUP_IMAGE"),
		managedDataBackupNamespace:
			optional("PLATFORM_MANAGED_DATA_BACKUP_NAMESPACE") || "vlyv-backups",
		multiZoneEnabled: booleanValue(
			"PLATFORM_KUBERNETES_MULTI_ZONE_ENABLED",
			false,
		),
		readOnlyRootFilesystem: booleanValue(
			"PLATFORM_KUBERNETES_READ_ONLY_ROOT_FILESYSTEM",
			false,
		),
		allowedEgressCidrs: stringArray("PLATFORM_ALLOWED_EGRESS_CIDRS_JSON"),
	};
	const existing = await db.query.platformClusters.findFirst({
		where: eq(platformClusters.slug, slug),
	});
	await db
		.update(platformClusters)
		.set({ isDefault: false, updatedAt: new Date() })
		.where(eq(platformClusters.isDefault, true));
	const cluster = existing
		? await updatePlatformCluster(existing.clusterId, {
				name: optional("PLATFORM_CLUSTER_NAME") || "Layerrail Primary",
				status: "provisioning",
				apiEndpoint: optional("PLATFORM_CLUSTER_API_ENDPOINT") || null,
				kubeconfig: decodedKubeconfig,
				isDefault: true,
				metadata,
			})
		: await createPlatformCluster({
				regionId: region.regionId,
				slug,
				name: optional("PLATFORM_CLUSTER_NAME") || "Layerrail Primary",
				runtime: "kubernetes",
				status: "provisioning",
				apiEndpoint: optional("PLATFORM_CLUSTER_API_ENDPOINT"),
				kubeconfig: decodedKubeconfig,
				isDefault: true,
				metadata,
			});

	const runtimeLabels = stringRecord("PLATFORM_RUNTIME_NODE_LABELS_JSON");
	const buildLabels = stringRecord("PLATFORM_BUILD_NODE_LABELS_JSON");
	const systemLabels = stringRecord("PLATFORM_SYSTEM_NODE_LABELS_JSON");
	if (
		Object.keys(runtimeLabels).length === 0 ||
		Object.keys(buildLabels).length === 0 ||
		Object.keys(systemLabels).length === 0
	) {
		throw new Error(
			"PLATFORM_RUNTIME_NODE_LABELS_JSON, PLATFORM_BUILD_NODE_LABELS_JSON, and PLATFORM_SYSTEM_NODE_LABELS_JSON must not be empty",
		);
	}
	const runtimePool = await upsertNodePool({
		clusterId: cluster.clusterId,
		name: optional("PLATFORM_RUNTIME_NODE_POOL_NAME") || "runtime",
		purpose: "runtime",
		runtimeClassName,
		labels: runtimeLabels,
		taints: taints("PLATFORM_RUNTIME_NODE_TAINTS_JSON"),
		minNodes: integerValue("PLATFORM_RUNTIME_MIN_NODES", 1, 0, 10_000),
		maxNodes: integerValue("PLATFORM_RUNTIME_MAX_NODES", 20, 1, 10_000),
	});
	const buildPoolNode = await upsertNodePool({
		clusterId: cluster.clusterId,
		name: optional("PLATFORM_BUILD_NODE_POOL_NAME") || "build",
		purpose: "build",
		runtimeClassName: buildRuntimeClassName,
		labels: buildLabels,
		taints: taints("PLATFORM_BUILD_NODE_TAINTS_JSON"),
		minNodes: integerValue("PLATFORM_BUILD_MIN_NODES", 1, 0, 10_000),
		maxNodes: integerValue("PLATFORM_BUILD_MAX_NODES", 20, 1, 10_000),
	});
	await upsertNodePool({
		clusterId: cluster.clusterId,
		name: optional("PLATFORM_SYSTEM_NODE_POOL_NAME") || "system",
		purpose: "system",
		labels: systemLabels,
		taints: taints("PLATFORM_SYSTEM_NODE_TAINTS_JSON"),
		minNodes: integerValue("PLATFORM_SYSTEM_MIN_NODES", 1, 0, 10_000),
		maxNodes: integerValue("PLATFORM_SYSTEM_MAX_NODES", 5, 1, 10_000),
	});

	const targetName = optional("PLATFORM_RUNTIME_TARGET_NAME") || "primary";
	const existingTarget = await db.query.platformRuntimeTargets.findFirst({
		where: and(
			eq(platformRuntimeTargets.clusterId, cluster.clusterId),
			eq(platformRuntimeTargets.name, targetName),
		),
	});
	const targetInput = {
		name: targetName,
		nodePoolId: runtimePool.nodePoolId,
		status: activate ? ("active" as const) : ("provisioning" as const),
		maxPlacements: integerValue(
			"PLATFORM_RUNTIME_MAX_PLACEMENTS",
			10_000,
			1,
			1_000_000,
		),
		weight: integerValue("PLATFORM_RUNTIME_TARGET_WEIGHT", 100, 1, 10_000),
		metadata: { managedBy: "environment" },
	};
	if (existingTarget) {
		await updatePlatformRuntimeTarget(
			existingTarget.runtimeTargetId,
			targetInput,
		);
	} else {
		await createPlatformRuntimeTarget({
			clusterId: cluster.clusterId,
			...targetInput,
		});
	}

	const registryAuthMode =
		(optional("PLATFORM_REGISTRY_AUTH_MODE") as
			| "basic"
			| "workload_identity"
			| undefined) || "basic";
	const supplyChain: NonNullable<PlatformBuildPoolMetadata["supplyChain"]> = {
		verifierImage: digestImage("PLATFORM_SUPPLY_CHAIN_VERIFIER_IMAGE"),
		outputPublisherImage: digestImage(
			"PLATFORM_SUPPLY_CHAIN_OUTPUT_PUBLISHER_IMAGE",
		),
		signingKeyRef: required("PLATFORM_SUPPLY_CHAIN_SIGNING_KEY_REF"),
		maxCriticalVulnerabilities: integerValue(
			"PLATFORM_SUPPLY_CHAIN_MAX_CRITICAL",
			0,
			0,
			1_000_000,
		),
		maxHighVulnerabilities: integerValue(
			"PLATFORM_SUPPLY_CHAIN_MAX_HIGH",
			0,
			0,
			1_000_000,
		),
		ignoreUnfixed: booleanValue("PLATFORM_SUPPLY_CHAIN_IGNORE_UNFIXED", false),
		artifactStorageClassName: required(
			"PLATFORM_SUPPLY_CHAIN_ARTIFACT_STORAGE_CLASS",
		),
		serviceAccountAnnotations: stringRecord(
			"PLATFORM_SUPPLY_CHAIN_SERVICE_ACCOUNT_ANNOTATIONS_JSON",
		),
		podLabels: stringRecord("PLATFORM_SUPPLY_CHAIN_POD_LABELS_JSON"),
		podAnnotations: stringRecord("PLATFORM_SUPPLY_CHAIN_POD_ANNOTATIONS_JSON"),
		outputPublisherServiceAccountAnnotations: stringRecord(
			"PLATFORM_OUTPUT_PUBLISHER_SERVICE_ACCOUNT_ANNOTATIONS_JSON",
		),
		outputPublisherPodLabels: stringRecord(
			"PLATFORM_OUTPUT_PUBLISHER_POD_LABELS_JSON",
		),
		outputPublisherPodAnnotations: stringRecord(
			"PLATFORM_OUTPUT_PUBLISHER_POD_ANNOTATIONS_JSON",
		),
	};
	const buildMetadata: PlatformBuildPoolMetadata = {
		rootlessBuilderValidated: booleanValue(
			"PLATFORM_ROOTLESS_BUILDER_VALIDATED",
			false,
		),
		registryCredentialHelperConfigured:
			registryAuthMode === "workload_identity"
				? booleanValue("PLATFORM_REGISTRY_CREDENTIAL_HELPER_CONFIGURED", false)
				: undefined,
		runtimeImagePullIdentityConfigured:
			registryAuthMode === "workload_identity"
				? booleanValue("PLATFORM_RUNTIME_IMAGE_PULL_IDENTITY_CONFIGURED", false)
				: undefined,
		supplyChain,
	};
	const buildName = optional("PLATFORM_BUILD_POOL_NAME") || "primary";
	const existingBuild = await db.query.platformBuildPools.findFirst({
		where: and(
			eq(platformBuildPools.clusterId, cluster.clusterId),
			eq(platformBuildPools.name, buildName),
		),
	});
	const buildInput = {
		name: buildName,
		nodePoolId: buildPoolNode.nodePoolId,
		status: activate ? ("active" as const) : ("provisioning" as const),
		builderImage: digestImage("PLATFORM_BUILDER_IMAGE"),
		runtimeClassName: buildRuntimeClassName,
		maxConcurrentBuilds: integerValue(
			"PLATFORM_MAX_CONCURRENT_BUILDS",
			10,
			1,
			1_000,
		),
		registryHost: required("PLATFORM_REGISTRY_HOST"),
		registryRepositoryPrefix: required("PLATFORM_REGISTRY_REPOSITORY_PREFIX"),
		registryAuthMode,
		registryUsername:
			registryAuthMode === "basic"
				? required("PLATFORM_REGISTRY_USERNAME")
				: null,
		registryPassword:
			registryAuthMode === "basic"
				? required("PLATFORM_REGISTRY_PASSWORD")
				: null,
		runtimeRegistrySecretName:
			registryAuthMode === "basic"
				? required("PLATFORM_RUNTIME_REGISTRY_SECRET_NAME")
				: null,
		metadata: buildMetadata,
	};
	if (existingBuild) {
		await updatePlatformBuildPool(existingBuild.buildPoolId, buildInput);
	} else {
		await createPlatformBuildPool({
			clusterId: cluster.clusterId,
			...buildInput,
		});
	}

	if (activate) {
		await updatePlatformCluster(cluster.clusterId, {
			status: "active",
			metadata,
		});
	}
	return cluster.clusterId;
};

const bootstrapCloudflare = async (activate: boolean) => {
	const accountId = required("CLOUDFLARE_ACCOUNT_ID");
	const providerName =
		optional("CLOUDFLARE_EDGE_PROVIDER_NAME") || "cloudflare";
	const edgeInput = {
		name: providerName,
		accountId,
		zoneId: required("CLOUDFLARE_ZONE_ID"),
		zoneName: required("CLOUDFLARE_ZONE_NAME"),
		apiToken: required("CLOUDFLARE_API_TOKEN"),
		originHostname: required("CLOUDFLARE_ORIGIN_HOSTNAME"),
		originToken: required("CLOUDFLARE_ORIGIN_TOKEN"),
		managedDomain:
			optional("CLOUDFLARE_MANAGED_DOMAIN") || required("PLATFORM_APPS_DOMAIN"),
		status: activate ? ("active" as const) : ("provisioning" as const),
		isDefault: true,
		metadata: {
			customHostnamesEnabled: true,
			managedWafEnabled: true,
			cacheEnabled: true,
			geoRoutingEnabled: booleanValue("CLOUDFLARE_GEO_ROUTING_ENABLED", false),
			originLockdownEnabled: true,
			authenticatedOriginPullsEnabled: true,
			analyticsEnabled: true,
			cacheTtlSeconds: integerValue(
				"CLOUDFLARE_CACHE_TTL_SECONDS",
				3600,
				1,
				31_536_000,
			),
			browserTtlSeconds: integerValue(
				"CLOUDFLARE_BROWSER_TTL_SECONDS",
				300,
				0,
				31_536_000,
			),
			loadBalancerPoolIds: stringArray(
				"CLOUDFLARE_LOAD_BALANCER_POOL_IDS_JSON",
			),
			loadBalancerFallbackPoolId: optional(
				"CLOUDFLARE_LOAD_BALANCER_FALLBACK_POOL_ID",
			),
		},
	};
	const existingEdge = await db.query.platformEdgeProviders.findFirst({
		where: eq(platformEdgeProviders.name, providerName),
	});
	if (existingEdge) {
		await updatePlatformEdgeProvider(existingEdge.edgeProviderId, edgeInput);
	} else {
		await createPlatformEdgeProvider(edgeInput);
	}

	const r2Name = optional("R2_STORAGE_NAME") || "cloudflare-r2";
	const r2Input = {
		name: r2Name,
		provider: "r2" as const,
		endpoint:
			optional("R2_ENDPOINT") ||
			`https://${accountId}.r2.cloudflarestorage.com`,
		region: optional("R2_REGION") || "auto",
		bucket: required("R2_BUCKET"),
		accessKeyId: required("R2_ACCESS_KEY_ID"),
		secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
		publicBaseUrl: required("R2_PUBLIC_BASE_URL"),
		prefix: optional("R2_PREFIX") || "vlyv-assets",
		forcePathStyle: booleanValue("R2_FORCE_PATH_STYLE", false),
		status: activate ? ("active" as const) : ("provisioning" as const),
		isDefault: true,
		metadata: {
			cacheControl:
				optional("R2_CACHE_CONTROL") || "public, max-age=31536000, immutable",
			publicAccessDisabled: false,
		},
	};
	const existingR2 = await db.query.platformObjectStorages.findFirst({
		where: eq(platformObjectStorages.name, r2Name),
	});
	if (existingR2) {
		await updatePlatformObjectStorage(existingR2.objectStorageId, r2Input);
	} else {
		await createPlatformObjectStorage(r2Input);
	}
};

const bootstrapArchiveStorage = async (activate: boolean) => {
	const name = optional("AWS_ARCHIVE_STORAGE_NAME") || "managed-data-archives";
	const region = required("AWS_ARCHIVE_REGION");
	const endpoint =
		optional("AWS_ARCHIVE_ENDPOINT") || `https://s3.${region}.amazonaws.com`;
	const input = {
		name,
		provider: "s3" as const,
		endpoint,
		region,
		bucket: required("AWS_ARCHIVE_BUCKET"),
		accessKeyId: required("AWS_ARCHIVE_ACCESS_KEY_ID"),
		secretAccessKey: required("AWS_ARCHIVE_SECRET_ACCESS_KEY"),
		publicBaseUrl: endpoint,
		prefix: optional("AWS_ARCHIVE_PREFIX") || "vlyv-managed-data-archives",
		forcePathStyle: false,
		status: activate ? ("active" as const) : ("provisioning" as const),
		isDefault: false,
		metadata: {
			serverSideEncryption: "aws:kms" as const,
			kmsKeyId: required("AWS_ARCHIVE_KMS_KEY_ARN"),
			managedDataBackups: true,
			publicAccessDisabled: true,
		},
	};
	const existing = await db.query.platformObjectStorages.findFirst({
		where: eq(platformObjectStorages.name, name),
	});
	if (existing) {
		if (
			existing.provider !== input.provider ||
			existing.endpoint !== input.endpoint ||
			existing.region !== input.region ||
			existing.bucket !== input.bucket ||
			existing.prefix !== input.prefix ||
			existing.metadata.kmsKeyId !== input.metadata.kmsKeyId ||
			existing.metadata.managedDataBackups !== true ||
			existing.metadata.publicAccessDisabled !== true
		) {
			throw new Error(
				"Managed archive storage location or KMS policy changed; migrate or expire retained archives before changing it",
			);
		}
		await updatePlatformObjectStorage(existing.objectStorageId, {
			name: input.name,
			status: input.status,
			accessKeyId: input.accessKeyId,
			secretAccessKey: input.secretAccessKey,
			publicBaseUrl: input.publicBaseUrl,
			isDefault: input.isDefault,
		});
	} else {
		await createPlatformObjectStorage(input);
	}
};

const upsertObservabilityBackend = async (
	input: {
		name: string;
		kind: "prometheus" | "loki" | "tempo" | "otlp";
		endpoint: string;
		authToken?: string | null;
		tenantHeader?: string;
		tenantId?: string;
		metadata: {
			retentionManagedExternally: true;
			healthEndpoint?: string;
			otlpHeaders?: Record<string, string>;
			authScheme?: "Bearer" | "Basic";
			omitTenantHeader?: boolean;
		};
	},
	activate: boolean,
) => {
	const existing = await db.query.platformObservabilityBackends.findFirst({
		where: eq(platformObservabilityBackends.name, input.name),
	});
	if (existing && existing.kind !== input.kind) {
		throw new Error(
			`Observability backend ${input.name} already exists with kind ${existing.kind}`,
		);
	}
	const { kind: _kind, ...changes } = input;
	const backend = existing
		? await updatePlatformObservabilityBackend(
				existing.observabilityBackendId,
				changes,
			)
		: await createPlatformObservabilityBackend(input);
	if (activate) {
		await activatePlatformObservabilityBackend(
			backend.observabilityBackendId,
			true,
		);
	}
};

const bootstrapGrafanaCloud = async (activate: boolean) => {
	const otlpEndpoint = required("OTEL_EXPORTER_OTLP_ENDPOINT");
	const credentials = extractOtlpAuthorization(
		parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS),
	);
	await upsertObservabilityBackend(
		{
			name: optional("GRAFANA_OTLP_BACKEND_NAME") || "grafana-cloud-otlp",
			kind: "otlp",
			endpoint: otlpEndpoint,
			authToken: credentials.authToken,
			metadata: {
				retentionManagedExternally: true,
				otlpHeaders: credentials.headers,
				authScheme: credentials.authScheme,
				omitTenantHeader: true,
			},
		},
		activate,
	);

	const basicAuth = optional("GRAFANA_CLOUD_BASIC_AUTH");
	for (const backend of [
		{
			kind: "prometheus" as const,
			name: "grafana-cloud-prometheus",
			endpoint: optional("GRAFANA_PROMETHEUS_URL"),
			healthEndpoint: optional("GRAFANA_PROMETHEUS_HEALTH_ENDPOINT"),
		},
		{
			kind: "loki" as const,
			name: "grafana-cloud-loki",
			endpoint: optional("GRAFANA_LOKI_URL"),
			healthEndpoint: optional("GRAFANA_LOKI_HEALTH_ENDPOINT"),
		},
		{
			kind: "tempo" as const,
			name: "grafana-cloud-tempo",
			endpoint: optional("GRAFANA_TEMPO_URL"),
			healthEndpoint: optional("GRAFANA_TEMPO_HEALTH_ENDPOINT"),
		},
	]) {
		if (!backend.endpoint) continue;
		if (!basicAuth) {
			throw new Error(
				"GRAFANA_CLOUD_BASIC_AUTH is required when query backends are configured",
			);
		}
		await upsertObservabilityBackend(
			{
				name: backend.name,
				kind: backend.kind,
				endpoint: backend.endpoint,
				authToken: basicAuth,
				metadata: {
					retentionManagedExternally: true,
					healthEndpoint: backend.healthEndpoint,
					authScheme: "Basic",
					omitTenantHeader: true,
				},
			},
			activate,
		);
	}
};

export const bootstrapManagedPlatformFromEnvironment = async () => {
	if (!booleanValue("PLATFORM_BOOTSTRAP_ENABLED", false)) {
		return { enabled: false } as const;
	}
	if (!IS_MANAGED_PAAS) {
		throw new Error(
			"PLATFORM_BOOTSTRAP_ENABLED requires PLATFORM_MODE=managed",
		);
	}
	const activate = booleanValue("PLATFORM_BOOTSTRAP_ACTIVATE", true);
	if (process.env.NODE_ENV === "production" && !activate) {
		throw new Error(
			"Production managed startup requires PLATFORM_BOOTSTRAP_ACTIVATE=true; prepare and verify providers before launching the tenant control plane",
		);
	}
	const clusterId = await bootstrapKubernetes(activate);
	await bootstrapCloudflare(activate);
	await bootstrapArchiveStorage(activate);
	await bootstrapGrafanaCloud(activate);
	return { enabled: true, activated: activate, clusterId } as const;
};
