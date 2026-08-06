import { isPlatformAdmin, validateRequest } from "@dokploy/server";
import { createNextApiHandler } from "@trpc/server/adapters/next";
import type { NextApiRequest, NextApiResponse } from "next";
import { operatorRouter } from "@/server/api/operator-root";
import { createOperatorTRPCContext } from "@/server/api/trpc";

const operatorHandler = createNextApiHandler({
	router: operatorRouter,
	createContext: createOperatorTRPCContext,
	onError:
		process.env.NODE_ENV === "development"
			? ({ path, error }) =>
					console.error(
						`Operator tRPC failed on ${path ?? "<no-path>"}: ${error.message}`,
					)
			: undefined,
});

export default async function handler(
	req: NextApiRequest,
	res: NextApiResponse,
) {
	const { user } = await validateRequest(req);
	if (!user || !(await isPlatformAdmin(user.id))) {
		res.status(404).json({ message: "Not found" });
		return;
	}
	return operatorHandler(req, res);
}

export const config = {
	api: {
		bodyParser: false,
		sizeLimit: "100mb",
	},
};
