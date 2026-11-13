<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import {
  DetailRow,
  ErrorState,
  LoadingSkeleton,
  PageContainer,
  PageHeader,
  SectionHeader
} from "../components/common";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { useModelConfigStore } from "../stores/modelConfig";
import {
  buildModelConfigPatch,
  initialModelConfigForm,
  isModelConfigPatchDirty,
  overriddenFieldLabel,
  providerLabel
} from "../viewmodels/modelConfigViewModel";
import type { ModelConfigFormValues } from "../viewmodels/modelConfigViewModel";

/**
 * SettingsView（W13 / X1）：模型与凭据配置。
 *
 * 两件事：把**当前生效**的配置读出来给人看，以及允许在运行时改掉它。
 * 运行时改动只活在进程内存里（不落库、不落盘、不进日志），这是刻意的 —— 见 docs/145 §X1。
 *
 * 四处刻意的取舍：
 *   · 密钥输入框永远呈现空。服务端从不回显密钥值，「把现有密钥读进输入框」这条路径根本
 *     不存在，留空即「不改动」。
 *   · 表单是「未编辑时直接呈现服务端当前值」，而不是「建 ref + watch 回填」。后者在配置
 *     读回来之前表单是空的，而空表单会被判定成「全改过」—— 手快一点就会把几个字段一起
 *     写成 null，等于清掉覆盖。可写计算属性没有这个窗口。
 *   · 只发送真的改了的字段，见 viewmodels/modelConfigViewModel。
 *   · 提供方（mock / openai）只读。它是部署级选择，改它要重新装配整条模型链路。
 */
const store = useModelConfigStore();

/** 用户的编辑草稿；`null` = 还没动过，此时表单直接呈现服务端的当前值。 */
const draft = ref<ModelConfigFormValues | null>(null);

function currentValues(): ModelConfigFormValues {
  const base = initialModelConfigForm(store.status);
  return draft.value ? { ...base, ...draft.value } : base;
}

/** 一个可写计算属性 = 一个表单字段：没编辑过显示服务端的值，编辑过显示草稿。 */
function editableField(field: keyof ModelConfigFormValues) {
  return computed({
    get: () => currentValues()[field],
    set: (value: string) => {
      draft.value = { ...currentValues(), [field]: value };
    }
  });
}

const model = editableField("model");
const baseUrl = editableField("baseUrl");
const apiKey = editableField("apiKey");

onMounted(() => {
  void store.load();
});

/** 配置还没读回来时不产生任何 patch：没有「当前值」可比，比较就没有意义。 */
const patch = computed(() => {
  const status = store.status;
  return status ? buildModelConfigPatch(currentValues(), status) : {};
});

const dirty = computed(() => isModelConfigPatchDirty(patch.value));
const isRuntime = computed(() => store.status?.source === "runtime");

async function save() {
  // 保存成功才丢弃草稿（表单随之呈现新的生效值）；失败时草稿留着，用户敲的东西不丢。
  if (await store.save(patch.value)) {
    draft.value = null;
  }
}

async function clearOverrides() {
  if (await store.save({ model: null, baseUrl: null, apiKey: null })) {
    draft.value = null;
  }
}

function reload() {
  void store.load();
}
</script>

<template>
  <PageContainer>
    <PageHeader
      title="设置"
      description="模型与凭据。改动立即生效，但只活在进程内存里 —— 重启后端后回落到环境变量。"
    />

    <ErrorState
      v-if="store.error && !store.status"
      :message="store.error"
      :retrying="store.loading"
      @retry="reload"
    />

    <Card v-else-if="!store.status" class="grid gap-3 p-4">
      <LoadingSkeleton class="h-6 w-40" />
      <LoadingSkeleton class="h-4 w-full" />
      <LoadingSkeleton class="h-4 w-2/3" />
    </Card>

    <div v-else class="grid gap-[var(--section-gap)]">
      <Card class="p-4">
        <SectionHeader eyebrow="当前生效" title="模型配置" />
        <dl class="m-0">
          <DetailRow label="提供方">{{ providerLabel(store.status.provider) }}</DetailRow>
          <DetailRow label="模型">{{ store.status.model }}</DetailRow>
          <DetailRow label="Base URL">{{ store.status.baseUrl || "用提供方默认" }}</DetailRow>
          <DetailRow label="API 密钥">
            {{ store.status.apiKeyConfigured ? "已配置" : "未配置" }}
          </DetailRow>
          <DetailRow label="配置来源">
            {{ isRuntime ? `运行时覆盖：${overriddenFieldLabel(store.status)}` : "环境变量" }}
          </DetailRow>
        </dl>
        <p
          v-if="store.status.provider !== 'openai'"
          class="m-0 mt-3 text-secondary text-muted-foreground"
        >
          当前提供方是 mock，模型调用走脚本化实现；下面的改动要等部署切到 openai 才会生效。
        </p>
      </Card>

      <Card class="p-4">
        <SectionHeader eyebrow="运行时覆盖" title="修改" />
        <form class="grid gap-4" @submit.prevent="save">
          <div class="grid gap-2">
            <Label for="model-config-model">模型</Label>
            <Input
              id="model-config-model"
              v-model="model"
              maxlength="200"
              placeholder="gpt-5.4-mini"
            />
          </div>

          <div class="grid gap-2">
            <Label for="model-config-base-url">Base URL</Label>
            <Input
              id="model-config-base-url"
              v-model="baseUrl"
              maxlength="500"
              placeholder="留空则用提供方默认"
            />
          </div>

          <div class="grid gap-2">
            <Label for="model-config-api-key">API 密钥</Label>
            <Input
              id="model-config-api-key"
              v-model="apiKey"
              type="password"
              autocomplete="off"
              maxlength="4096"
              :placeholder="store.status.apiKeyConfigured ? '已配置；留空表示不改动' : '尚未配置'"
            />
            <p class="m-0 text-secondary text-muted-foreground">
              密钥只写不读：页面与接口都拿不到它的值，留空就是不改动。
            </p>
          </div>

          <p v-if="store.error" class="m-0 text-body text-danger">{{ store.error }}</p>
          <p v-if="store.notice" role="status" class="m-0 text-body text-success">
            {{ store.notice }}
          </p>

          <div class="flex flex-wrap items-center gap-2">
            <Button type="submit" :disabled="!dirty || store.saving">
              {{ store.saving ? "保存中…" : "保存" }}
            </Button>
            <Button
              type="button"
              variant="secondary"
              :disabled="store.saving || !isRuntime"
              @click="clearOverrides"
            >
              清除运行时覆盖
            </Button>
          </div>
        </form>
      </Card>
    </div>
  </PageContainer>
</template>
