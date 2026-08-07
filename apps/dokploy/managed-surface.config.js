export const managedTenantRoutes = [
	"/dashboard/docker",
	"/dashboard/monitoring",
	"/dashboard/networks",
	"/dashboard/requests",
	"/dashboard/schedules",
	"/dashboard/swarm",
	"/dashboard/traefik",
	"/dashboard/settings/certificates",
	"/dashboard/settings/cluster",
	"/dashboard/settings/destinations",
	"/dashboard/settings/deployments",
	"/dashboard/settings/license",
	"/dashboard/settings/registry",
	"/dashboard/settings/server",
	"/dashboard/settings/servers",
	"/dashboard/settings/ssh-keys",
];

export const managedTenantDynamicRoutePatterns = [
	/^\/api\/deploy\/compose\/[^/]+\/?$/,
	/^\/dashboard\/project\/[^/]+\/environment\/[^/]+\/services\/(?:compose|libsql|mariadb|mongo|mysql|postgres|redis)\/[^/]+\/?$/,
];

export const managedTenantPageSourceFragments = [
	"pages/dashboard/docker.tsx",
	"pages/dashboard/monitoring.tsx",
	"pages/dashboard/networks.tsx",
	"pages/dashboard/requests.tsx",
	"pages/dashboard/schedules.tsx",
	"pages/dashboard/swarm.tsx",
	"pages/dashboard/traefik.tsx",
	"pages/dashboard/settings/certificates.tsx",
	"pages/dashboard/settings/cluster.tsx",
	"pages/dashboard/settings/destinations.tsx",
	"pages/dashboard/settings/deployments.tsx",
	"pages/dashboard/settings/license.tsx",
	"pages/dashboard/settings/registry.tsx",
	"pages/dashboard/settings/server.tsx",
	"pages/dashboard/settings/servers.tsx",
	"pages/dashboard/settings/ssh-keys.tsx",
	"pages/dashboard/project/[projectId]/environment/[environmentId]/services/compose/[composeId].tsx",
	"pages/dashboard/project/[projectId]/environment/[environmentId]/services/libsql/[libsqlId].tsx",
	"pages/dashboard/project/[projectId]/environment/[environmentId]/services/mariadb/[mariadbId].tsx",
	"pages/dashboard/project/[projectId]/environment/[environmentId]/services/mongo/[mongoId].tsx",
	"pages/dashboard/project/[projectId]/environment/[environmentId]/services/mysql/[mysqlId].tsx",
	"pages/dashboard/project/[projectId]/environment/[environmentId]/services/postgres/[postgresId].tsx",
	"pages/dashboard/project/[projectId]/environment/[environmentId]/services/redis/[redisId].tsx",
];

export const selfHostedOnlyPageSourceFragments = [
	"pages/api/operator/trpc/[trpc].ts",
];

export const managedRequiredRoutes = [
	"/api/polar/webhook",
	"/dashboard/settings/billing",
	"/dashboard/settings/invoices",
];

/** @param {string} pathname */
export const isManagedTenantRoute = (pathname) => {
	const normalized =
		pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
	return (
		managedTenantRoutes.includes(normalized) ||
		managedTenantDynamicRoutePatterns.some((pattern) =>
			pattern.test(normalized),
		)
	);
};
