import { createNextApiHandler } from "@trpc/server/adapters/next";
import { runtimeRouter } from "@/server/api/runtime-root";
import { createTRPCContext } from "@/server/api/trpc";

// export API handler (v11: body parsed by Content-Type automatically, no experimental_contentTypeHandlers)
export default createNextApiHandler({
	router: runtimeRouter,
	createContext: createTRPCContext,
	onError:
		process.env.NODE_ENV === "development"
			? ({ path, error }) => {
					console.error(
						`❌ tRPC failed on ${path ?? "<no-path>"}: ${error.message}`,
					);
				}
			: undefined,
});

export const config = {
	api: {
		bodyParser: false,
		sizeLimit: "1gb",
	},
};
