import type { ModelConfigPatch, ModelConfigStatus } from "@ai-se/shared";
import { defineStore } from "pinia";
import { getModelConfig, updateModelConfig } from "../api/modelConfig";

interface State {
  status: ModelConfigStatus | null;
  loading: boolean;
  saving: boolean;
  error: string;
  notice: string;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "模型配置请求失败";
}

export const useModelConfigStore = defineStore("modelConfig", {
  state: (): State => ({
    status: null,
    loading: false,
    saving: false,
    error: "",
    notice: ""
  }),
  actions: {
    async load() {
      this.loading = true;
      this.error = "";
      try {
        this.status = await getModelConfig();
      } catch (error) {
        this.error = message(error);
      } finally {
        this.loading = false;
      }
    },
    /**
     * 保存运行时覆盖，返回是否成功。页面据此决定要不要清空密钥输入框 ——
     * 失败时必须保留用户刚敲进去的东西，否则他得重敲一遍。
     */
    async save(patch: ModelConfigPatch): Promise<boolean> {
      this.saving = true;
      this.error = "";
      this.notice = "";
      try {
        this.status = await updateModelConfig(patch);
        this.notice = "已生效。这是运行时覆盖，重启后端后会回落到环境变量。";
        return true;
      } catch (error) {
        this.error = message(error);
        return false;
      } finally {
        this.saving = false;
      }
    },
    clearNotice() {
      this.notice = "";
    }
  }
});
