import type { ApplicationNested } from "@dokploy/server/utils/builders";

export type ReleaseDomain = {
	host: string;
	https: boolean;
	path: string | null;
};

/**
 * Immutable execution identity and route overrides for one release. The base
 * application remains the customer resource; previews receive a separate
 * identity so runtime resources and registry repositories cannot collide with
 * production.
 */
export type ReleaseApplication = ApplicationNested & {
	releaseIdentity?: string;
	releaseDomains?: ReleaseDomain[];
	domains?: ReleaseDomain[];
};

export type ApplicationReleaseIntent = {
	kind: "deploy" | "rebuild" | "preview-deploy" | "preview-rebuild";
	/** Application that owns patches when releaseIdentity is a preview ID. */
	sourceApplicationId?: string;
};
