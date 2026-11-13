import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDeployment,
  listDeployments,
  listEnvironments,
  rollbackDeployment,
  saveEnvironment
} from "../../api/deployments";
import { useDeploymentsStore } from "../deployments";

vi.mock("../../api/deployments", () => ({
  getDeployment: vi.fn(),
  listDeployments: vi.fn(),
  listEnvironments: vi.fn(),
  rollbackDeployment: vi.fn(),
  saveEnvironment: vi.fn()
}));

const deployment = {
  id: "deployment",
  projectId: "project",
  workflowRunId: "workflow",
  taskId: "task",
  version: "abcdef1",
  environment: "staging",
  image: "app:abcdef1",
  gitCommit: "abcdef1",
  operation: "DEPLOY",
  status: "SUCCESS",
  endpoint: "http://localhost:18001",
  healthCheck: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
} as const;

describe("deployment store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.resetAllMocks();
  });

  it("loads, selects, and rolls back a deployment", async () => {
    vi.mocked(listDeployments).mockResolvedValue([deployment]);
    vi.mocked(listEnvironments).mockResolvedValue([]);
    vi.mocked(getDeployment).mockResolvedValue({ deployment, logs: [] });
    vi.mocked(rollbackDeployment).mockResolvedValue({
      ...deployment,
      id: "rollback",
      operation: "ROLLBACK"
    });
    const store = useDeploymentsStore();
    await store.load("project");
    await store.select("deployment");
    await store.rollback("health failed");
    expect(store.deployments).toHaveLength(1);
    expect(rollbackDeployment).toHaveBeenCalledWith("deployment", { reason: "health failed" });
  });

  it("upserts environment configuration without storing a secret value", async () => {
    vi.mocked(saveEnvironment).mockResolvedValue({
      id: "environment",
      projectId: "project",
      name: "production",
      endpoint: "https://production.example.test",
      adapter: "docker",
      configuration: {},
      secretReference: "secret://production/app",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    });
    const store = useDeploymentsStore();
    const result = await store.saveEnvironment({
      projectId: "00000000-0000-4000-8000-000000000000",
      name: "production",
      endpoint: "https://production.example.test",
      configuration: {},
      secretReference: "secret://production/app"
    });
    expect(result?.secretReference).toBe("secret://production/app");
    expect(store.environments).toHaveLength(1);
  });
});
