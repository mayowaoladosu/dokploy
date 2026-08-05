import {
	kubernetesCpuNanocores,
	kubernetesMemoryBytes,
} from "@dokploy/server/services/runtime-usage-metering";
import { describe, expect, it } from "vitest";

describe("Kubernetes runtime usage quantities", () => {
	it("parses CPU metrics without floating-point loss", () => {
		expect(kubernetesCpuNanocores("250m")).toBe(250_000_000n);
		expect(kubernetesCpuNanocores("100000n")).toBe(100_000n);
		expect(kubernetesCpuNanocores("12u")).toBe(12_000n);
		expect(kubernetesCpuNanocores("1.5")).toBe(1_500_000_000n);
	});

	it("parses binary and decimal memory metrics exactly", () => {
		expect(kubernetesMemoryBytes("512Ki")).toBe(524_288n);
		expect(kubernetesMemoryBytes("1.5Mi")).toBe(1_572_864n);
		expect(kubernetesMemoryBytes("2G")).toBe(2_000_000_000n);
		expect(kubernetesMemoryBytes("1024")).toBe(1_024n);
	});

	it("rejects malformed and negative quantities", () => {
		expect(() => kubernetesCpuNanocores("-1m")).toThrow("invalid");
		expect(() => kubernetesCpuNanocores("NaN")).toThrow("invalid");
		expect(() => kubernetesMemoryBytes("10MB")).toThrow("invalid");
	});
});
