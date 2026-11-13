import { createSSRApp, h, type Component } from "vue";
import { renderToString } from "vue/server-renderer";
import { describe, expect, it } from "vitest";
import {
  ConfirmDialog,
  CopyableId,
  DetailRow,
  EmptyState,
  ErrorState,
  LoadingSkeleton,
  PageHeader,
  SectionHeader,
  StatusBadge,
  TableSkeleton
} from "@/components/common";

/**
 * Phase 3-C 公共组件 + W5 骨架/状态组件 —— 组件契约测试。
 *
 * 与 Phase 3-B 相同的方法：Vue 官方 SSR 渲染 + Node 环境断言真实 DOM 输出
 * （无 jsdom / @vue/test-utils，未新增测试依赖）。
 * 只测组件契约（标签、层级、类名、插槽、Token 映射），不测业务功能 ——
 * 组件本身不含任何业务状态判断。
 *
 * 说明：`ErrorState` 的 `@retry` 事件无法在 SSR 下模拟点击触发，
 * 因此只断言按钮存在与禁用态；真实点击行为由浏览器验证承担。
 */

type Slots = Record<string, () => unknown>;

async function render(component: Component, props: Record<string, unknown> = {}, slots: Slots = {}): Promise<string> {
  const app = createSSRApp({ render: () => h(component, props, slots) });
  return renderToString(app);
}

/**
 * Dialog / Drawer / ConfirmDialog 的内容经 Portal 输出到 Teleport，
 * `renderToString` 的返回值里只有一个 `<teleport start/end>` 占位 —— 真实内容在
 * SSR context 的 `teleports` 里，必须一并取回才能断言（与各页面测试同一手法）。
 */
async function renderWithTeleport(
  component: Component,
  props: Record<string, unknown> = {}
): Promise<string> {
  const app = createSSRApp({ render: () => h(component, props) });
  const ctx: { teleports?: Record<string, string> } = {};
  const raw = await renderToString(app, ctx);
  return `${raw}\n${Object.values(ctx.teleports ?? {}).join("\n")}`;
}

/** 取第一个元素的 class 属性值。 */
function classes(html: string): string {
  const match = html.match(/class="([^"]*)"/);
  return match ? match[1] : "";
}

/** 取全部 class 属性拼接（用于断言整棵子树，如 SectionHeader 的标题层级）。 */
function allClasses(html: string): string {
  return [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1]).join(" | ");
}

describe("PageHeader", () => {
  it("渲染 header + h1，标题使用页面级排版 Token", async () => {
    const html = await render(PageHeader, { title: "项目" });
    expect(html.startsWith("<header")).toBe(true);
    expect(html).toMatch(/<h1[^>]*>(?:<!--\[-->)?项目/);
    expect(html).toContain("项目");
    const cls = allClasses(html);
    expect(cls).toContain("text-page-title");
    expect(cls).toContain("text-foreground");
    expect(classes(html)).toContain("mb-[var(--section-gap)]");
  });

  it("description 未传时不渲染段落，传了则用次级排版 Token", async () => {
    const minimal = await render(PageHeader, { title: "项目" });
    expect(minimal).not.toContain("<p");
    expect(allClasses(minimal)).toContain("m-0");
    const full = await render(PageHeader, { title: "项目", description: "全部项目" });
    expect((full.match(/<p/g) || []).length).toBe(1);
    expect(full).toContain("全部项目");
    expect(allClasses(full)).toContain("text-secondary");
  });

  it("W5：eyebrow prop 已删除 —— 不再渲染成任何元素或文案（反向护栏）", async () => {
    const legacy = await render(PageHeader, { title: "项目", eyebrow: "分组" });
    // 组件已不声明该 prop。Vue 会把未知属性透传到根元素（`eyebrow="分组"`），
    // 那是框架行为而非组件行为；关键是它不再渲染 <p>，也不再产生任何文案节点。
    expect(legacy).not.toContain("<p");
    expect(legacy).not.toContain(">分组<");
    expect(allClasses(legacy)).toBe(allClasses(await render(PageHeader, { title: "项目" })));
  });

  it("actions 插槽：无插槽时不渲染右侧容器，有插槽时渲染", async () => {
    const without = await render(PageHeader, { title: "项目" });
    expect(without).not.toContain("shrink-0");
    const withSlot = await render(PageHeader, { title: "项目" }, { actions: () => h("button", { type: "button" }, "新建项目") });
    expect(withSlot).toContain("新建项目");
    expect(withSlot).toContain("shrink-0");
  });

  it("支持 class 合并", async () => {
    const cls = classes(await render(PageHeader, { title: "项目", class: "mb-0" }));
    expect(cls).toContain("mb-0");
    expect(cls).not.toContain("mb-[var(--section-gap)]");
  });
});

describe("SectionHeader", () => {
  it("默认渲染 h2 + 区段级排版 Token", async () => {
    const html = await render(SectionHeader, { title: "历史" });
    expect(html).toMatch(/<h2[^>]*>(?:<!--\[-->)?历史/);
    expect(allClasses(html)).toContain("text-section-title");
    expect(classes(html)).toContain("mb-4");
  });

  it("level 决定标题层级（卡片内可用 h3）", async () => {
    expect(await render(SectionHeader, { title: "标题", level: 3 })).toMatch(/<h3[^>]*>(?:<!--\[-->)?标题/);
    expect(await render(SectionHeader, { title: "标题", level: 4 })).toMatch(/<h4[^>]*>(?:<!--\[-->)?标题/);
    expect(await render(SectionHeader, { title: "标题" })).not.toMatch(/<h3/);
  });

  it("eyebrow 可选；actions 插槽承载 StatusBadge / Button", async () => {
    const plain = await render(SectionHeader, { title: "历史" });
    expect(plain).not.toContain("<p");
    const withEyebrow = await render(SectionHeader, { title: "部署详情", eyebrow: "部署详情" });
    expect((withEyebrow.match(/<p/g) || []).length).toBe(1);
    const withActions = await render(
      SectionHeader,
      { title: "部署详情" },
      { actions: () => h(StatusBadge, { tone: "success" }, { default: () => "成功" }) }
    );
    expect(withActions).toContain("成功");
    expect(withActions).toContain("bg-success-bg");
  });

  it("支持 class 合并", async () => {
    expect(classes(await render(SectionHeader, { title: "历史", class: "mb-0" }))).toContain("mb-0");
  });
});

describe("StatusBadge", () => {
  it("六个 tone 全部映射到既有语义 Token", async () => {
    const cases: Array<[string, string[]]> = [
      ["success", ["bg-success-bg", "text-success"]],
      ["running", ["bg-info-bg", "text-info"]],
      ["pending", ["bg-neutral-bg", "text-neutral"]],
      ["warning", ["bg-warning-bg", "text-warning"]],
      ["error", ["bg-danger-bg", "text-danger"]],
      ["neutral", ["bg-muted", "text-muted-foreground"]]
    ];
    for (const [tone, expected] of cases) {
      const cls = classes(await render(StatusBadge, { tone }, { default: () => "状态" }));
      for (const token of expected) {
        expect(cls, `tone=${tone} 应包含 ${token}`).toContain(token);
      }
    }
  });

  it("默认 tone 为 neutral，渲染行内 span，文案来自插槽（组件内无业务文案）", async () => {
    const html = await render(StatusBadge, {}, { default: () => "已取消" });
    expect(html.startsWith("<span")).toBe(true);
    expect(classes(html)).toContain("bg-muted");
    expect(html).toContain("已取消");
    const cls = classes(html);
    expect(cls).toContain("text-caption");
    expect(cls).toContain("rounded-full");
  });

  it("不包含任何业务状态枚举（组件保持业务无关）", async () => {
    const html = await render(StatusBadge, { tone: "success" }, { default: () => "文本" });
    for (const business of ["PENDING", "RUNNING", "SUCCESS", "FAILED", "WAITING_APPROVAL", "已注册"]) {
      expect(html).not.toContain(business);
    }
  });

  it("支持 class 合并", async () => {
    expect(classes(await render(StatusBadge, { class: "ml-2" }))).toContain("ml-2");
  });

  it("W9 三重冗余：六个 tone 各带一枚**互不相同**的图标（去色后仍可分辨）", async () => {
    const tones = ["success", "running", "pending", "warning", "error", "neutral"];
    const icons: string[] = [];
    for (const tone of tones) {
      const html = await render(StatusBadge, { tone }, { default: () => "状态" });
      const match = html.match(/lucide-([a-z-]+)/);
      expect(match, `tone=${tone} 应渲染图标`).not.toBeNull();
      icons.push(match?.[1] ?? "");
    }
    // 形状必须互不相同：否则色觉障碍用户仍然分不出 success 与 error
    expect(new Set(icons).size).toBe(tones.length);
  });

  it("W9：状态图标是装饰性的（aria-hidden），旁边的文字已承担朗读", async () => {
    const html = await render(StatusBadge, { tone: "error" }, { default: () => "失败" });
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("失败");
  });

  it("W9：图标与文字之间用 gap-1 分隔（不留粘连）", async () => {
    expect(classes(await render(StatusBadge, { tone: "warning" }))).toContain("gap-1");
  });
});

describe("EmptyState", () => {
  it("渲染卡片容器 + 标题（design §9 的 Card 规范：白底 / border / 12px 圆角）", async () => {
    const html = await render(EmptyState, { title: "暂无项目。" });
    expect(html).toContain("暂无项目。");
    const cls = classes(html);
    expect(cls).toContain("bg-card");
    expect(cls).toContain("border-border");
    expect(cls).toContain("rounded-lg");
    expect(cls).toContain("text-center");
    expect(allClasses(html)).toContain("m-0");
  });

  it("size 变体：default 内距大于 compact", async () => {
    expect(classes(await render(EmptyState, { title: "x" }))).toContain("p-6");
    expect(classes(await render(EmptyState, { title: "x", size: "compact" }))).toContain("p-4");
  });

  it("description 可选，且仅在同时存在标题时加顶部间距", async () => {
    const only = await render(EmptyState, { description: "补充说明" });
    expect(only).toContain("补充说明");
    expect(only).not.toContain("mt-1");
    const both = await render(EmptyState, { title: "暂无项目。", description: "补充说明" });
    expect(both).toContain("暂无项目。");
    expect(allClasses(both)).toContain("mt-1");
  });

  it("icon 由调用方传入（组件不内置图标），actions 插槽承载操作", async () => {
    const Icon = { render: () => h("svg", { "data-icon": "stub" }) } as unknown as Component;
    const withIcon = await render(EmptyState, { title: "x", icon: Icon });
    expect(withIcon).toContain('data-icon="stub"');
    expect(allClasses(withIcon)).toContain("text-foreground-disabled");
    const noIcon = await render(EmptyState, { title: "x" });
    expect(noIcon).not.toContain("<svg");
    const withActions = await render(
      EmptyState,
      { title: "暂无项目。" },
      { actions: () => h("button", { type: "button" }, "新建项目") }
    );
    expect(withActions).toContain("新建项目");
    expect(allClasses(withActions)).toContain("justify-center");
  });

  it("支持 class 合并", async () => {
    expect(classes(await render(EmptyState, { title: "x", class: "mt-4" }))).toContain("mt-4");
  });
});

describe("DetailRow（W5「字段名 / 值」详情行）", () => {
  it("渲染 dt + dd，label 进 dt、插槽内容进 dd", async () => {
    const html = await render(DetailRow, { label: "创建时间" }, { default: () => "2026年1月1日" });
    expect(html).toMatch(/<dt[^>]*>(?:<!--\[-->)?创建时间/);
    expect(html).toMatch(/<dd[^>]*>(?:<!--\[-->)?2026年1月1日/);
    expect(html).toContain("detail-row");
  });

  it("栅格与边框由 .detail-row 组件样式承担（模板里不再有 grid-cols-[110px…]）", async () => {
    const html = await render(DetailRow, { label: "x" }, { default: () => "y" });
    expect(html).not.toContain("grid-cols-[");
    expect(allClasses(html)).toContain("text-body");
  });

  it("值列默认可换行，valueClass 可覆盖（如错误堆栈保留原生换行）", async () => {
    const plain = await render(DetailRow, { label: "x" }, { default: () => "y" });
    expect(allClasses(plain)).toContain("break-words");

    const pre = await render(
      DetailRow,
      { label: "错误", valueClass: "break-all whitespace-pre-wrap" },
      { default: () => "stack" }
    );
    const cls = allClasses(pre);
    expect(cls).toContain("break-all");
    expect(cls).toContain("whitespace-pre-wrap");
  });

  it("标签用次级排版（caption 档），不承载业务语义", async () => {
    const html = await render(DetailRow, { label: "任意字段" }, { default: () => "值" });
    expect(html).toContain("任意字段");
    for (const business of ["PENDING", "SUCCESS", "已注册"]) {
      expect(html).not.toContain(business);
    }
  });
});

describe("LoadingSkeleton（W5 骨架条）", () => {
  it("渲染脉冲占位块，底色取 --muted，且对辅助技术隐藏", async () => {
    const html = await render(LoadingSkeleton);
    const cls = classes(html);
    expect(cls).toContain("animate-pulse");
    expect(cls).toContain("bg-muted");
    expect(cls).toContain("rounded-sm");
    expect(html).toContain('aria-hidden="true"');
  });

  it("prefers-reduced-motion 下停掉动画但保留占位", async () => {
    const cls = classes(await render(LoadingSkeleton));
    expect(cls).toContain("motion-reduce:animate-none");
  });

  it("支持 class 合并（尺寸交给调用方）", async () => {
    const cls = classes(await render(LoadingSkeleton, { class: "h-4 flex-1" }));
    expect(cls).toContain("h-4");
    expect(cls).toContain("flex-1");
  });
});

describe("TableSkeleton（W5 列表加载态）", () => {
  it("容器与 Table 的数据态同款（Card 边界），并作为 status 播报「加载中」", async () => {
    const html = await render(TableSkeleton, { columns: 4, rows: 3 });
    const cls = classes(html);
    expect(cls).toContain("bg-card");
    expect(cls).toContain("border-border");
    expect(cls).toContain("rounded-lg");
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="加载中"');
  });

  it("占位条数量 = (行数 + 1 表头行) × 列数", async () => {
    const html = await render(TableSkeleton, { columns: 4, rows: 3 });
    expect((html.match(/aria-hidden="true"/g) || []).length).toBe(16);
  });

  it("默认 4 列 5 行", async () => {
    const html = await render(TableSkeleton);
    expect((html.match(/aria-hidden="true"/g) || []).length).toBe(24);
  });

  it("表头行比数据行矮", async () => {
    const html = await render(TableSkeleton, { columns: 1, rows: 1 });
    expect(html).toContain("h-3");
    expect(html).toContain("h-4");
  });

  it("不含任何业务文案或数据（组件保持业务无关）", async () => {
    const html = await render(TableSkeleton, { columns: 2, rows: 2 });
    for (const forbidden of ["项目", "需求", "工作流", "<table", "<td"]) {
      expect(html).not.toContain(forbidden);
    }
  });

  it("支持 class 合并", async () => {
    expect(classes(await render(TableSkeleton, { class: "mt-4" }))).toContain("mt-4");
  });
});

describe("ErrorState（W5 可重试错误态）", () => {
  it("用语义色三件套渲染 alert，文案原样来自调用方（组件不编造）", async () => {
    const html = await render(ErrorState, { message: "网络请求失败：无法连接后端服务" });
    expect(html).toContain('role="alert"');
    expect(html).toContain("网络请求失败：无法连接后端服务");
    const cls = classes(html);
    expect(cls).toContain("bg-danger-bg");
    expect(cls).toContain("border-danger-border");
    expect(allClasses(html)).toContain("text-danger-foreground");
  });

  it("默认可重试：渲染真实的「重试」按钮", async () => {
    const html = await render(ErrorState, { message: "x" });
    // SSR 会把插槽内容包在片段注释里：<button …><!--[-->重试<!--]--></button>
    expect(html).toMatch(/<button[^>]*>(?:<!--\[-->)?重试(?:<!--\]-->)?<\/button>/);
  });

  it("retryable=false 时只显示错误，不渲染按钮", async () => {
    const html = await render(ErrorState, { message: "x", retryable: false });
    expect(html).not.toContain("<button");
    expect(html).toContain("x");
  });

  it("retrying 时按钮禁用并改文案（防重复点击）", async () => {
    const html = await render(ErrorState, { message: "x", retrying: true });
    expect(html).toContain("重试中…");
    expect(html).not.toMatch(/<button[^>]*>(?:<!--\[-->)?重试(?:<!--\]-->)?<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled/);
  });

  it("支持 class 合并", async () => {
    expect(classes(await render(ErrorState, { message: "x", class: "mt-4" }))).toContain("mt-4");
  });
});

describe("CopyableId（W7：ID 文本本身可点复制）", () => {
  const FULL = "99975877-aaaa-bbbb-cccc-ddddeeeeffff";

  it("渲染 button，列表里只把前 8 位当**可见文本**（完整 ID 只出现在属性里）", async () => {
    const html = await render(CopyableId, { id: FULL });
    expect(html).toMatch(/^<button/);
    expect(html).toContain("ID 99975877");
    // 完整 ID 恰好出现两次：title + aria-label。再多一次就说明它被当正文铺了出来。
    expect(html.split(FULL)).toHaveLength(3);
    expect(classes(html)).toContain("font-mono");
  });

  it("复制的是完整 ID：aria-label 与 hover 提示都给出完整值", async () => {
    const html = await render(CopyableId, { id: FULL });
    expect(html).toContain(`aria-label="复制 ID ${FULL}"`);
    expect(html).toContain(`title="点击复制完整 ID：${FULL}"`);
  });

  it("display=full（详情页）时直接显示完整 ID", async () => {
    const html = await render(CopyableId, { id: FULL, display: "full" });
    expect(html).toContain(`ID ${FULL}`);
    expect(allClasses(html)).toContain("break-all");
  });

  it("默认渲染复制图标，且图标是装饰性的（aria-hidden）", async () => {
    const html = await render(CopyableId, { id: FULL });
    expect(html).toContain("lucide-copy");
    expect(html).toContain('aria-hidden="true"');
  });

  it("关掉原生 button 外观（本项目不含 Tailwind preflight）", async () => {
    const cls = classes(await render(CopyableId, { id: FULL }));
    expect(cls).toContain("appearance-none");
    expect(cls).toContain("border-0");
    expect(cls).toContain("bg-transparent");
  });

  it("支持 class 合并", async () => {
    expect(classes(await render(CopyableId, { id: FULL, class: "mt-1" }))).toContain("mt-1");
  });
});

describe("ConfirmDialog（W8：全站唯一的危险操作确认方式）", () => {
  const base = {
    title: "删除项目",
    description: "删除后不可恢复：该项目下的需求、工作流与部署记录都会一并失去归属。"
  };

  it("打开时渲染标题与后果说明（description 是必填）", async () => {
    const html = await renderWithTeleport(ConfirmDialog, { ...base, open: true });
    expect(html).toContain("删除项目");
    expect(html).toContain("删除后不可恢复");
    expect(html).toContain('role="dialog"');
  });

  it("确认按钮是实心 destructive，取消按钮是 secondary", async () => {
    const html = await renderWithTeleport(ConfirmDialog, { ...base, open: true });
    const buttons = [...html.matchAll(/<button[^>]*class="([^"]*)"/g)].map((m) => m[1]);
    expect(buttons.some((cls) => cls.includes("bg-danger"))).toBe(true);
    expect(buttons.some((cls) => cls.includes("bg-muted"))).toBe(true);
  });

  it("默认文案「确认 / 取消」，可被覆盖", async () => {
    const fallback = await renderWithTeleport(ConfirmDialog, { ...base, open: true });
    expect(fallback).toContain("确认");
    expect(fallback).toContain("取消");

    const custom = await renderWithTeleport(ConfirmDialog, {
      ...base,
      open: true,
      confirmLabel: "删除项目",
      cancelLabel: "再想想"
    });
    expect(custom).toContain("删除项目<");
    expect(custom).toContain("再想想");
  });

  it("busy 时确认按钮禁用并改用 busyLabel（防重复提交）", async () => {
    const html = await renderWithTeleport(ConfirmDialog, { ...base, open: true, busy: true });
    expect(html).toContain("处理中…");
    expect(html).not.toContain(">确认<");
    expect(html).toMatch(/<button[^>]*disabled/);
  });

  it("失败信息以 role=alert 显示在框内（对话框保持打开）", async () => {
    const html = await renderWithTeleport(ConfirmDialog, { ...base, open: true, error: "删除项目失败" });
    expect(html).toContain('role="alert"');
    expect(html).toContain("删除项目失败");
    expect(html).toContain("text-danger");
  });

  it("未传 error 时不渲染 alert 区域", async () => {
    const html = await renderWithTeleport(ConfirmDialog, { ...base, open: true });
    expect(html).not.toContain('role="alert"');
  });

  it("description 会作为 aria-describedby 的目标（可访问名称与说明都被朗读）", async () => {
    const html = await renderWithTeleport(ConfirmDialog, { ...base, open: true });
    const describedBy = html.match(/aria-describedby="([^"]*)"/);
    expect(describedBy).not.toBeNull();
    expect(html).toContain(`id="${describedBy?.[1]}"`);
  });
});
