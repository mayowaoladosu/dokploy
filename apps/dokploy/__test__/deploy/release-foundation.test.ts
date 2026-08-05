import { selectImmutableImageRef } from "@dokploy/server/services/build-executor";
import { canTransitionRelease } from "@dokploy/server/services/release-state-machine";
import {
	assertPublicHealthEndpoint,
	summarizeSwarmTasks,
	verifyHttpEndpoint,
} from "@dokploy/server/services/runtime-scheduler";
import { describe, expect, it, vi } from "vitest";

describe("release transition policy", () => {
	it("allows the production release path and health rollback", () => {
		expect(canTransitionRelease("queued", "preparing")).toBe(true);
		expect(canTransitionRelease("preparing", "building")).toBe(true);
		expect(canTransitionRelease("building", "artifact_ready")).toBe(true);
		expect(canTransitionRelease("artifact_ready", "scheduling")).toBe(true);
		expect(canTransitionRelease("scheduling", "verifying")).toBe(true);
		expect(canTransitionRelease("verifying", "ready")).toBe(true);
		expect(canTransitionRelease("verifying", "rolling_back")).toBe(true);
		expect(canTransitionRelease("rolling_back", "rolled_back")).toBe(true);
	});

	it("rejects transitions that skip durable release stages", () => {
		expect(canTransitionRelease("queued", "ready")).toBe(false);
		expect(canTransitionRelease("building", "verifying")).toBe(false);
		expect(canTransitionRelease("rolled_back", "ready")).toBe(false);
		expect(canTransitionRelease("cancelled", "preparing")).toBe(false);
	});
});

describe("immutable artifact selection", () => {
	it("selects the digest for the intended runtime repository", () => {
		const result = selectImmutableImageRef({
			runtimeImageRef: "registry.example.com/team/app:latest",
			imageId: "sha256:local-image",
			repoDigests: [
				"registry.example.com/other/app@sha256:wrong",
				"registry.example.com/team/app@sha256:correct",
			],
		});

		expect(result).toEqual({
			imageRef: "registry.example.com/team/app@sha256:correct",
			imageDigest: "sha256:correct",
			isRegistryDigest: true,
		});
	});

	it("falls back to the immutable local image ID, not an unrelated digest", () => {
		const result = selectImmutableImageRef({
			runtimeImageRef: "registry.example.com/team/app:latest",
			imageId: "sha256:local-image",
			repoDigests: ["registry.example.com/other/app@sha256:wrong"],
		});

		expect(result).toEqual({
			imageRef: "sha256:local-image",
			imageDigest: "sha256:local-image",
			isRegistryDigest: false,
		});
	});
});

describe("Swarm release readiness", () => {
	const currentImage = "registry.example.com/team/app@sha256:new";

	it("does not count running tasks from the previous release", () => {
		const result = summarizeSwarmTasks(
			[
				{
					DesiredState: "running",
					Spec: {
						ContainerSpec: {
							Image: "registry.example.com/team/app@sha256:old",
						},
					},
					Status: { State: "running" },
				},
				{
					DesiredState: "running",
					Spec: { ContainerSpec: { Image: currentImage } },
					Status: { State: "preparing" },
				},
			],
			1,
			currentImage,
		);

		expect(result).toEqual({ readyReplicas: 0, state: "pending" });
	});

	it("reports readiness only when the desired current-image replicas run", () => {
		const result = summarizeSwarmTasks(
			[
				{
					DesiredState: "running",
					Spec: { ContainerSpec: { Image: currentImage } },
					Status: { State: "running" },
				},
				{
					DesiredState: "running",
					Spec: { ContainerSpec: { Image: currentImage } },
					Status: { State: "running" },
				},
			],
			2,
			currentImage,
		);

		expect(result).toEqual({ readyReplicas: 2, state: "ready" });
	});

	it("surfaces a failure from a current-image task", () => {
		const result = summarizeSwarmTasks(
			[
				{
					DesiredState: "running",
					Spec: { ContainerSpec: { Image: currentImage } },
					Status: { State: "rejected", Err: "image pull failed" },
				},
			],
			1,
			currentImage,
		);

		expect(result).toEqual({
			readyReplicas: 0,
			state: "failed",
			message: "image pull failed",
		});
	});
});

describe("HTTP health verification", () => {
	it("accepts a responding application even when its root route is 404", async () => {
		const fetcher = vi.fn(async () => new Response(null, { status: 404 }));

		const result = await verifyHttpEndpoint({
			endpoint: "https://app.example.com/",
			timeoutMs: 10,
			pollIntervalMs: 5,
			fetcher,
			sleep: async () => undefined,
			validateEndpoint: async () => undefined,
			now: () => 0,
		});

		expect(result).toMatchObject({
			passed: true,
			statusCode: 404,
			endpoint: "https://app.example.com/",
		});
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("fails after retrying server errors until the deadline", async () => {
		let time = 0;
		const fetcher = vi.fn(async () => new Response(null, { status: 503 }));

		const result = await verifyHttpEndpoint({
			endpoint: "https://app.example.com/",
			timeoutMs: 10,
			pollIntervalMs: 5,
			fetcher,
			sleep: async (durationMs) => {
				time += durationMs;
			},
			validateEndpoint: async () => undefined,
			now: () => time,
		});

		expect(result).toMatchObject({
			passed: false,
			statusCode: 503,
			error: "Health endpoint returned HTTP 503",
			latencyMs: 10,
		});
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it("rejects health targets that resolve to private infrastructure", async () => {
		const lookup = vi.fn(async () => [
			{ address: "169.254.169.254", family: 4 as const },
		]);

		await expect(
			assertPublicHealthEndpoint(
				"http://metadata.example.internal/",
				lookup as never,
			),
		).rejects.toThrow("public IP addresses");
	});
});
