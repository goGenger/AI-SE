<script setup lang="ts">
import { RefreshCw, Server } from "@lucide/vue";
import { storeToRefs } from "pinia";
import { onMounted, reactive, ref } from "vue";
import {
  EmptyState,
  ErrorState,
  LoadingSkeleton,
  PageContainer,
  PageHeader,
  StatusBadge
} from "../components/common";
import { Button, buttonVariants } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, type SelectOption } from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import {
  MCPServerFormState,
  emptyMCPServerForm,
  enabledLabel,
  enabledTone,
  formatMCPTimestamp,
  serverStatusHint,
  serverStatusLabel,
  serverStatusTone,
  toCreateMCPServerInput,
  transportLabel
} from "../viewmodels/mcpViewModel";
import { useMCPStore } from "../stores/mcp";

/**
 * MCP 服务器列表（W5 统一页面骨架 + T2 控制台注册）。
 *
 * 数据来源仍是 `GET /api/mcp/servers`（唯一取数），错误 / 空 / 列表的判定与文案不变。
 *
 * T2（`docs/231` §3）新增的是**创建入口**：此前注册表只能带外写入，页面上没有
 * `POST /api/mcp/servers` 的落点。表单只收形状，传输方式的强制项由后端的冻结契约
 * （`validateMCPServerDefinition`）权威判定；客户端只挡「必填没填」。
 *
 * **表单里没有 env**：stdio 的 env 会把明文凭据写进 `mcp_servers.env`，与
 * `AGENTS.md` §10 冲突——需要 env 的服务器走带外注册。
 */
const mcpStore = useMCPStore();
const { servers, loading, error } = storeToRefs(mcpStore);

const createOpen = ref(false);
const creating = ref(false);
const createError = ref("");
const createdNotice = ref("");
const form = reactive<MCPServerFormState>(emptyMCPServerForm());

const transportOptions: SelectOption[] = [
  { value: "stdio", label: "stdio（本地子进程）" },
  { value: "streamable-http", label: "streamable-http（远程端点）" }
];

/** 错误态重试 / 空态动作：沿用既有取数方法。 */
function reload() {
  void mcpStore.fetchServers();
}

function resetForm() {
  Object.assign(form, emptyMCPServerForm());
}

async function submitServer() {
  const input = toCreateMCPServerInput(form);
  if (!input) {
    createError.value =
      form.transport === "stdio" ? "请填写启动命令。" : "请填写 MCP 端点地址。";
    return;
  }

  creating.value = true;
  createError.value = "";
  createdNotice.value = "";
  try {
    const server = await mcpStore.createServer(input);
    createdNotice.value =
      server.status === "CONNECTED"
        ? `已添加「${server.name}」并连接成功。`
        : `已添加「${server.name}」，当前状态：${serverStatusLabel(server.status)}。`;
    createOpen.value = false;
    resetForm();
  } catch (error) {
    createError.value = error instanceof Error ? error.message : "添加 MCP 服务器失败";
  } finally {
    creating.value = false;
  }
}

onMounted(() => {
  void mcpStore.fetchServers();
});
</script>

<template>
  <PageContainer width="wide">
    <PageHeader title="MCP 服务器">
      <template #actions>
        <Button variant="secondary" type="button" :disabled="loading" @click="reload">
          <RefreshCw class="size-4" />
          刷新
        </Button>
        <Dialog
          v-model:open="createOpen"
          title="添加 MCP 服务器"
          description="添加后会立即尝试连接并发现工具；连不上不影响保存，状态会显示在列表里。绑定到项目后，agent 才能调用这些工具。"
        >
          <template #trigger>
            <Button type="button">添加服务器</Button>
          </template>
          <form class="grid gap-4" @submit.prevent="submitServer">
            <div class="grid gap-2">
              <Label for="mcp-server-name">名称</Label>
              <Input
                id="mcp-server-name"
                v-model.trim="form.name"
                required
                maxlength="120"
                placeholder="github"
              />
              <p class="m-0 text-secondary text-muted-foreground">
                名称会进入工具名（<code>mcp__&lt;名称&gt;__&lt;工具&gt;</code>），请用简短英文。
              </p>
            </div>

            <div class="grid gap-2">
              <Label for="mcp-server-transport">传输方式</Label>
              <Select
                id="mcp-server-transport"
                v-model="form.transport"
                :options="transportOptions"
              />
            </div>

            <template v-if="form.transport === 'stdio'">
              <div class="grid gap-2">
                <Label for="mcp-server-command">启动命令</Label>
                <Input
                  id="mcp-server-command"
                  v-model.trim="form.command"
                  required
                  maxlength="500"
                  placeholder="npx"
                />
              </div>
              <div class="grid gap-2">
                <Label for="mcp-server-args">参数（可选）</Label>
                <Input
                  id="mcp-server-args"
                  v-model="form.argsText"
                  maxlength="2000"
                  placeholder="-y @modelcontextprotocol/server-github"
                />
                <p class="m-0 text-secondary text-muted-foreground">
                  空格或换行分隔，无需引号。
                </p>
              </div>
              <div class="grid gap-2">
                <Label for="mcp-server-cwd">工作目录（可选）</Label>
                <Input id="mcp-server-cwd" v-model.trim="form.cwd" maxlength="1000" />
              </div>
            </template>

            <template v-else>
              <div class="grid gap-2">
                <Label for="mcp-server-endpoint">端点地址</Label>
                <Input
                  id="mcp-server-endpoint"
                  v-model.trim="form.endpoint"
                  type="url"
                  required
                  maxlength="2000"
                  placeholder="https://mcp.example.com/mcp"
                />
                <p class="m-0 text-secondary text-muted-foreground">
                  只填地址本身；不要把账号密码写进 URL。
                </p>
              </div>
              <div class="grid gap-2">
                <Label for="mcp-server-credential-ref">凭据引用（可选）</Label>
                <Input
                  id="mcp-server-credential-ref"
                  v-model.trim="form.credentialRef"
                  maxlength="200"
                  placeholder="env:MCP_GITHUB_TOKEN"
                />
                <p class="m-0 text-secondary text-muted-foreground">
                  这里填的是「引用」（指向平台环境变量），不是凭据本身。
                </p>
              </div>
            </template>

            <div class="grid gap-2">
              <Label for="mcp-server-description">描述（可选）</Label>
              <Textarea
                id="mcp-server-description"
                v-model.trim="form.description"
                maxlength="1000"
                rows="3"
              />
            </div>

            <p v-if="createError" class="m-0 text-body text-danger">{{ createError }}</p>

            <Button type="submit" :disabled="creating">
              {{ creating ? "添加中…" : "添加" }}
            </Button>
          </form>
        </Dialog>
      </template>
    </PageHeader>

    <p
      v-if="createdNotice"
      class="m-0 mb-[var(--section-gap)] rounded-lg border border-border bg-muted px-5 py-3 text-secondary"
    >
      {{ createdNotice }}
    </p>

    <p
      class="m-0 mb-[var(--section-gap)] rounded-lg border border-border bg-muted px-5 py-3 text-secondary text-muted-foreground"
    >
      注册表数据由 AI-SE 后端提供。浏览器不会直接连接 MCP 服务器，也不会持有 MCP 凭据。
    </p>

    <!-- 四种状态：加载 → 错误 → 空 → 有数据（顺序固定） -->
    <div v-if="loading" class="grid gap-3" role="status" aria-label="加载中">
      <LoadingSkeleton v-for="row in 3" :key="row" class="h-24 rounded-lg" />
    </div>
    <ErrorState v-else-if="error" :message="error" @retry="reload" />
    <EmptyState v-else-if="servers.length === 0" :icon="Server" title="暂无已注册的 MCP 服务器。">
      <template #actions>
        <Button type="button" @click="createOpen = true">添加服务器</Button>
        <Button variant="secondary" type="button" @click="reload">刷新</Button>
      </template>
    </EmptyState>
    <ul v-else class="m-0 grid list-none gap-3 p-0">
      <li
        v-for="server in servers"
        :key="server.id"
        class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-5 py-4 hover:bg-muted"
      >
        <div class="min-w-0 flex-1 basis-70">
          <RouterLink class="mb-1 inline-block text-section-title text-primary hover:underline" :to="`/mcp/${server.id}`">
            {{ server.name }}
          </RouterLink>
          <p class="m-0 text-secondary text-muted-foreground">{{ server.description || "—" }}</p>
          <span class="block text-caption text-muted-foreground">
            {{ transportLabel(server.transport) }} · {{ server.toolCount }} 个工具
            <template v-if="server.lastConnectedAt">
              · 最近连接 {{ formatMCPTimestamp(server.lastConnectedAt) }}
            </template>
          </span>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <StatusBadge
            :tone="serverStatusTone(server.status)"
            :title="serverStatusHint(server.status)"
          >
            {{ serverStatusLabel(server.status) }}
          </StatusBadge>
          <StatusBadge :tone="enabledTone(server.enabled)">
            {{ enabledLabel(server.enabled) }}
          </StatusBadge>
          <RouterLink
            :class="buttonVariants({ variant: 'secondary', size: 'sm' })"
            :to="`/mcp/${server.id}`"
          >
            打开
          </RouterLink>
        </div>
      </li>
    </ul>
  </PageContainer>
</template>
