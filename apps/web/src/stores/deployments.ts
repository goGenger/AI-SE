import {
  DeliveryEnvironment,
  Deployment,
  DeploymentDetailView,
  DeploymentEnvironmentConfig,
  UpsertDeploymentEnvironmentInput
} from "@ai-se/shared";
import { defineStore } from "pinia";
import {
  getDeployment,
  listDeployments,
  listEnvironments,
  rollbackDeployment,
  saveEnvironment
} from "../api/deployments";

interface State {
  deployments: Deployment[];
  environments: DeploymentEnvironmentConfig[];
  current: DeploymentDetailView | null;
  loading: boolean;
  acting: boolean;
  error: string;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "部署请求失败";
}

export const useDeploymentsStore = defineStore("deployments", {
  state: (): State => ({
    deployments: [],
    environments: [],
    current: null,
    loading: false,
    acting: false,
    error: ""
  }),
  actions: {
    async load(projectId?: string) {
      this.loading = true;
      this.error = "";
      try {
        [this.deployments, this.environments] = await Promise.all([
          listDeployments(projectId),
          listEnvironments(projectId)
        ]);
      } catch (error) {
        this.error = message(error);
      } finally {
        this.loading = false;
      }
    },

    async select(id: string) {
      this.loading = true;
      this.error = "";
      try {
        this.current = await getDeployment(id);
      } catch (error) {
        this.error = message(error);
      } finally {
        this.loading = false;
      }
    },

    async saveEnvironment(input: UpsertDeploymentEnvironmentInput) {
      this.acting = true;
      this.error = "";
      try {
        const saved = await saveEnvironment(input);
        const index = this.environments.findIndex(
          (entry) => entry.projectId === saved.projectId && entry.name === saved.name
        );
        if (index >= 0) this.environments[index] = saved;
        else this.environments.push(saved);
        return saved;
      } catch (error) {
        this.error = message(error);
        return null;
      } finally {
        this.acting = false;
      }
    },

    async rollback(reason: string) {
      if (!this.current) return null;
      this.acting = true;
      this.error = "";
      try {
        const rolledBack = await rollbackDeployment(this.current.deployment.id, { reason });
        await this.load(this.current.deployment.projectId);
        await this.select(this.current?.deployment.id ?? rolledBack.id);
        return rolledBack;
      } catch (error) {
        this.error = message(error);
        return null;
      } finally {
        this.acting = false;
      }
    },

    environment(projectId: string, name: DeliveryEnvironment) {
      return this.environments.find(
        (entry) => entry.projectId === projectId && entry.name === name
      );
    }
  }
});
