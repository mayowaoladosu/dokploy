export type ApiSurface = "tenant" | "operator";

export const canUsePlatformOperatorSurface = ({
	managed,
	surface,
}: {
	managed: boolean;
	surface?: ApiSurface;
}) => !managed || surface === "operator";
