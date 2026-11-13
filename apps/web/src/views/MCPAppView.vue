<script setup lang="ts">
import { MCPAppLink } from "@ai-se/shared";
import { AppWindow, ShieldCheck } from "@lucide/vue";
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { useRoute } from "vue-router";
import { getMCPUiResource, listMCPApps, runMCPAppAction } from "../api/mcp";
import {
  EmptyState,
  ErrorState,
  LoadingSkeleton,
  PageContainer,
  PageHeader,
  SectionHeader
} from "../components/common";
import { Button, buttonVariants } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  MCP_APP_SANDBOX,
  buildAppDocument,
  createMCPAppHost,
  type MCPAppBridgeAction
} from "../viewmodels/mcpAppBridge";
import { useModEnterSubmit } from "../composables/useModEnterSubmit";

/**
 * Phase 5.5-7: MCP App viewer.
 *
 * The app HTML is served by the backend (capability-gated resources/read) and
 * rendered in a sandboxed iframe (`allow-scripts` only). Everything the app
 * asks for goes through the Host Bridge → console REST → Tool Runtime.
 *
 * Phase 10-B：**仅视觉层重构**。以下被视为安全/协议红线，逐行未改：
 *   · iframe 的 `:sandbox="MCP_APP_SANDBOX"`（allow-scripts 唯一权限）与 `:srcdoc`（不透明源）
 *   · `buildAppDocument()` 的调用与 `createMCPAppHost` 的装配（来源校验 / schema / 体积 / allowedTools）
 *   · `runMCPAppAction` 的入参构造、`window` message 监听与 onBeforeUnmount 清理
 *   · 桥接日志只记录工具名与拒绝原因码、`slice(0, 20)` 上限、`pushLog` 文案
 *   · `?projectId=&agentName=` 查询预填与 `canLoad` 守卫、加载失败文案
 * 视觉层：PageHeader / Card + SectionHeader / EmptyState / Button / Input / Label；
 * legacy 类（page / panel / stacked-form / compact-list / mcp-note / mcp-app-frame /
 * mcp-app-log）全部停用，改由 Tailwind + scoped 样式承担（iframe 外观尺寸亦为纯视觉）。
 */

/** W8：表单内 Cmd/Ctrl + Enter 提交（`<textarea>` 里 Enter 是换行，提交不了）。 */
const onFormKeydown = useModEnterSubmit();
const route = useRoute();
const serverId = computed(() => String(route.params.serverId));

const form = reactive({
  projectId: String(route.query.projectId ?? ""),
  agentName: String(route.query.agentName ?? "")
});

const apps = ref<MCPAppLink[]>([]);
const appHtml = ref("");
const appMeta = reactive({ uri: "", toolName: "" });
const frameKey = ref(0);
const frame = ref<HTMLIFrameElement | null>(null);
const log = ref<string[]>([]);
const loading = ref(false);
const error = ref("");

const srcdoc = computed(() => (appHtml.value ? buildAppDocument(appHtml.value) : ""));
const canLoad = computed(() => form.projectId.trim() !== "" && form.agentName.trim() !== "");

let host: ReturnType<typeof createMCPAppHost> | null = null;

function pushLog(entry: string) {
  log.value = [`${new Date().toISOString()} ${entry}`, ...log.value].slice(0, 20);
}

function attachHost() {
  host = createMCPAppHost({
    getContentWindow: () => frame.value?.contentWindow ?? null,
    context: {
      serverId: serverId.value,
      toolName: appMeta.toolName || undefined,
      resourceUri: appMeta.uri
    },
    onAction: async (action: MCPAppBridgeAction) => {
      try {
        const result = await runMCPAppAction({
          serverId: serverId.value,
          projectId: form.projectId.trim(),
          agentName: form.agentName.trim(),
          toolName: action.toolName,
          arguments: action.arguments,
          // Strict default: an app may call exactly the tool it is linked to.
          allowedTools: appMeta.toolName ? [appMeta.toolName] : undefined
        });
        pushLog(`动作成功：${action.toolName}`);
        return { ok: true, data: result.data };
      } catch (actionError) {
        const message = actionError instanceof Error ? actionError.message : "动作失败";
        pushLog(`动作被拒绝：${action.toolName}：${message}`);
        return { ok: false, error: { code: "MCP_APP_ACTION_FAILED", message } };
      }
    },
    onRejected: (reason) => pushLog(`消息被拒绝：${reason}`)
  });
}

function onWindowMessage(event: MessageEvent) {
  void host?.handleMessage({ source: event.source, data: event.data });
}

async function loadApps() {
  if (!canLoad.value) {
    error.value = "需要项目 ID 与 Agent 名称。";
    return;
  }
  loading.value = true;
  error.value = "";
  try {
    apps.value = await listMCPApps(serverId.value, form.projectId.trim(), form.agentName.trim());
  } catch (loadError) {
    apps.value = [];
    error.value = loadError instanceof Error ? loadError.message : "加载应用失败";
  } finally {
    loading.value = false;
  }
}

async function openApp(link: MCPAppLink) {
  loading.value = true;
  error.value = "";
  try {
    const resource = await getMCPUiResource(
      serverId.value,
      link.resourceUri,
      form.projectId.trim(),
      form.agentName.trim()
    );
    appMeta.uri = resource.uri;
    appMeta.toolName = link.toolName;
    appHtml.value = resource.html;
    frameKey.value += 1;
    attachHost();
    pushLog(`应用已加载：${resource.uri}`);
  } catch (openError) {
    error.value = openError instanceof Error ? openError.message : "打开应用失败";
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  window.addEventListener("message", onWindowMessage);
});

onBeforeUnmount(() => {
  window.removeEventListener("message", onWindowMessage);
  host = null;
});
</script>

<template>
  <PageContainer>
    <PageHeader title="沙箱化 UI 应用">
      <template #actions>
        <RouterLink
          :class="buttonVariants({ variant: 'secondary' })"
          :to="`/mcp/${serverId}`"
        >
          返回服务器
        </RouterLink>
      </template>
    </PageHeader>

    <p class="m-0 mb-[var(--section-gap)] flex items-start gap-3 rounded-lg border border-border bg-muted px-4 py-3 text-secondary text-muted-foreground">
      <ShieldCheck class="size-4 shrink-0" />
      <span class="min-w-0 break-words">
        应用文档运行在沙箱化 iframe（{{ MCP_APP_SANDBOX }}）中，使用不透明源：无 Cookie、无父页面
        DOM、无凭据。 它发起的每个动作都会经过 Host Bridge → 后端 Tool Runtime（权限 / 策略 / 审批 /
        审计）。
      </span>
    </p>

    <Card class="mb-[var(--section-gap)] grid gap-4 p-[var(--card-padding)]">
      <form
        class="grid gap-4"
        @submit.prevent="loadApps"
        @keydown="onFormKeydown"
      >
        <div class="grid gap-1.5">
          <Label for="mcp-app-project">项目 ID</Label>
          <Input
            id="mcp-app-project"
            v-model.trim="form.projectId"
            required
            placeholder="项目 UUID"
          />
        </div>
        <div class="grid gap-1.5">
          <Label for="mcp-app-agent">Agent 名称</Label>
          <Input
            id="mcp-app-agent"
            v-model.trim="form.agentName"
            required
            placeholder="dev-agent"
          />
        </div>
        <div>
          <Button type="submit" :disabled="loading">
            {{ loading ? "加载中…" : "加载应用" }}
          </Button>
        </div>
      </form>
    </Card>

    <!--
      数据区四种状态（加载 → 错误 → 空 → 有数据）。
      未填写项目 / Agent 时三态都不出现，只留上方那张加载表单 —— 那是本页的「工具行」，
      也是唯一能驱动数据的控件。
    -->
    <div
      v-if="loading"
      class="mb-[var(--section-gap)] grid gap-3"
      role="status"
      aria-label="加载中"
    >
      <LoadingSkeleton class="h-20 rounded-lg" />
      <LoadingSkeleton class="h-20 rounded-lg" />
    </div>
    <ErrorState
      v-else-if="error"
      class="mb-[var(--section-gap)]"
      :message="error"
      @retry="loadApps"
    />

    <Card
      v-else-if="apps.length > 0"
      class="mb-[var(--section-gap)] grid gap-4 p-[var(--card-padding)]"
    >
      <SectionHeader title="可用应用" />
      <ul class="m-0 grid list-none gap-3 p-0">
        <li
          v-for="link in apps"
          :key="link.resourceUri + link.toolName"
          class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted px-4 py-4"
        >
          <div class="min-w-0 flex-1 basis-70">
            <strong class="block text-body font-semibold text-foreground">{{
              link.toolName
            }}</strong>
            <p class="m-0 mt-1 break-words text-caption text-muted-foreground">
              {{ link.resourceUri }}
            </p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" type="button" @click="openApp(link)">
              打开
            </Button>
          </div>
        </li>
      </ul>
    </Card>
    <!--
      空态不另设动作按钮：下一步动作就是「改上方的项目 / Agent 再加载」，
      控件在同一屏内，再放一个按钮是冗余（与部署详情、需求详情同一处理）。
    -->
    <EmptyState
      v-else-if="canLoad"
      class="mb-[var(--section-gap)]"
      :icon="AppWindow"
      title="当前项目 / Agent 下没有可见的 MCP 应用。"
    />

    <Card v-if="srcdoc" class="grid gap-4 p-[var(--card-padding)]">
      <SectionHeader :title="`应用框架 — ${appMeta.uri}`" />
      <iframe
        :key="frameKey"
        ref="frame"
        class="w-full min-h-105 rounded-lg border border-border bg-card"
        :sandbox="MCP_APP_SANDBOX"
        :srcdoc="srcdoc"
        title="MCP 应用"
      />
      <h3 class="m-0 text-section-title text-foreground">桥接日志</h3>
      <ul class="m-0 grid list-none gap-1 p-0 font-mono text-caption text-muted-foreground">
        <li v-for="(entry, index) in log" :key="index" class="break-words">{{ entry }}</li>
      </ul>
    </Card>
  </PageContainer>
</template>
