import { type NextRequest, NextResponse } from "next/server";
import { isManagedTenantRoute } from "./managed-surface.config.js";

export const proxy = (request: NextRequest) => {
	if (
		process.env.PLATFORM_MODE === "managed" &&
		isManagedTenantRoute(request.nextUrl.pathname)
	) {
		return new NextResponse("Not found", {
			status: 404,
			headers: { "Content-Type": "text/plain; charset=utf-8" },
		});
	}
	return NextResponse.next();
};

export const config = {
	matcher: ["/dashboard/:path*", "/api/deploy/compose/:path*"],
};
