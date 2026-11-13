import { createSSRApp, h, type Component } from "vue";
import { renderToString } from "vue/server-renderer";
import { describe, expect, it } from "vitest";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { Drawer } from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Pagination } from "@/components/ui/pagination";
import { Select } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Table } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/components/ui/utils";

/**
 * Phase 3-B 核心视觉组件 —— 组件契约测试。
 *
 * 只测组件契约（渲染出的标签/类名/原生属性/ARIA 状态），不测业务功能。
 * 采用 Vue 官方 SSR 渲染在 Node 环境断言 DOM 输出：无需 jsdom / @vue/test-utils，
 * 不新增任何测试依赖，也不改动 vitest 环境配置。
 * 真实浏览器的 hover / focus-visible / 布局验证见 Phase 3-B 实施记录。
 */

type Slots = Record<string, (...args: never[]) => unknown>;

async function render(
  component: Component,
  props: Record<string, unknown> = {},
  slots: Slots = {}
): Promise<string> {
  const app = createSSRApp({ render: () => h(component, props, slots) });
  return renderToString(app);
}

/** 取根元素上的 class 属性值。 */
function classes(html: string): string {
  const match = html.match(/class="([^"]*)"/);
  return match ? match[1] : "";
}

describe("Button", () => {
  it("渲染原生 button 标签并使用 Primary Token 作为默认变体", async () => {
    const html = await render(Button, {}, { default: () => "保存" });
    expect(html.startsWith("<button")).toBe(true);
    expect(classes(html)).toContain("bg-primary");
    expect(classes(html)).toContain("text-primary-foreground");
    expect(html).toContain("保存");
  });

  it("variant 契约：default / secondary / destructive / outline / ghost / link 各自映射到既有 Token", async () => {
    const cases: Array<[string, string[]]> = [
      ["default", ["bg-primary", "hover:bg-primary-hover"]],
      ["secondary", ["bg-muted", "text-foreground", "hover:bg-border"]],
      ["destructive", ["bg-danger", "text-primary-foreground"]],
      ["outline", ["border-border", "bg-card", "hover:bg-muted"]],
      ["ghost", ["bg-transparent", "text-foreground", "hover:bg-muted"]],
      ["link", ["bg-transparent", "text-primary", "underline-offset-4", "hover:underline"]]
    ];
    for (const [variant, expected] of cases) {
      const cls = classes(await render(Button, { variant }));
      for (const token of expected) {
        expect(cls, `variant=${variant} 应包含 ${token}`).toContain(token);
      }
    }
  });

  it("size 契约：default / sm / lg / icon 使用固定高度刻度", async () => {
    expect(classes(await render(Button))).toContain("h-9");
    expect(classes(await render(Button, { size: "sm" }))).toContain("h-8");
    expect(classes(await render(Button, { size: "lg" }))).toContain("h-10");
    expect(classes(await render(Button, { size: "icon" }))).toContain("size-9");
  });

  it("disabled 与原生属性透传", async () => {
    const html = await render(Button, { disabled: true, type: "submit", "data-testid": "btn" });
    expect(html).toContain("disabled");
    expect(html).toContain('type="submit"');
    expect(html).toContain('data-testid="btn"');
    expect(classes(html)).toContain("disabled:pointer-events-none");
    expect(classes(html)).toContain("disabled:opacity-60");
  });

  it("屏蔽浏览器原生按钮外观（未启用 Preflight 时 UA 会带 2px outset 边框与 buttonface 底色）", async () => {
    const cls = classes(await render(Button));
    expect(cls).toContain("appearance-none");
    expect(cls).toContain("cursor-pointer");
    expect(cls).toContain("border-transparent");
    expect(classes(await render(Button, { variant: "ghost" }))).toContain("bg-transparent");
    expect(classes(await render(Button, { variant: "link" }))).toContain("bg-transparent");
  });

  it("focus-visible 契约与 class 合并（tailwind-merge 消解冲突类）", async () => {
    const cls = classes(await render(Button, { class: "h-12 w-full" }));
    expect(classes(await render(Button))).toContain("focus-visible:ring-2");
    expect(classes(await render(Button))).toContain("focus-visible:ring-ring");
    expect(cls).toContain("h-12");
    expect(cls).toContain("w-full");
    expect(cls).not.toContain("h-9");
  });

  it("as-child：样式与行为合并到子元素（Phase 12-D 迁移至 shadcn-vue Primitive 后新增能力）", async () => {
    const html = await renderToString(
      createSSRApp({
        render: () =>
          h(Button, { asChild: true }, { default: () => h("a", { href: "/projects" }, "打开") })
      })
    );
    expect(html).toContain("<a");
    expect(html).not.toContain("<button");
    expect(html).toContain('href="/projects"');
    expect(html).toContain("bg-primary");
  });

  it("as：把根节点换成指定元素（默认仍为 button）", async () => {
    const html = await render(Button, { as: "a", href: "/x" }, { default: () => "链接" });
    expect(html).toContain("<a");
    expect(html).toContain('href="/x"');
    expect(html).toContain("bg-primary");
  });
});

describe("Card", () => {
  it("子组件可以组合渲染，且不默认使用阴影（设计 §7：优先 border）", async () => {
    const html = await render(
      Card,
      {},
      {
        default: () => [
          h(
            CardHeader,
            {},
            {
              default: () => [
                h(CardTitle, {}, { default: () => "标题" }),
                h(CardDescription, {}, { default: () => "说明" })
              ]
            }
          ),
          h(CardContent, {}, { default: () => "内容" }),
          h(CardFooter, {}, { default: () => "底部" })
        ]
      }
    );
    expect(html).toContain("标题");
    expect(html).toContain("说明");
    expect(html).toContain("内容");
    expect(html).toContain("底部");
    expect(html).toMatch(/<h3[^>]*>(?:<!--\[-->)?标题/);
    expect(html).toMatch(/<p[^>]*>(?:<!--\[-->)?说明/);
    expect(classes(html)).not.toContain("shadow");
    expect(classes(html)).toContain("rounded-lg");
    expect(classes(html)).toContain("border-border");
    expect(classes(html)).toContain("bg-card");
  });

  it("Card 与子组件均支持 class 合并，并归零未启用 Preflight 带来的 UA 外边距", async () => {
    const card = await render(Card, { class: "p-4" });
    expect(classes(card)).toContain("p-4");
    expect(classes(card)).toContain("border-border");
    const title = await render(CardTitle, { class: "text-danger" });
    expect(classes(title)).toContain("m-0");
    expect(classes(title)).toContain("text-danger");
    expect(classes(title)).toContain("text-section-title");
    expect(classes(await render(CardDescription))).toContain("m-0");
    expect(classes(await render(CardContent))).toContain("pt-0");
    expect(classes(await render(CardFooter))).toContain("pt-0");
  });
});

describe("Badge", () => {
  it("variant 契约：状态色全部复用既有语义 Token，未新增状态色", async () => {
    expect(classes(await render(Badge, {}, { default: () => "默认" }))).toContain("bg-primary");
    expect(classes(await render(Badge, { variant: "secondary" }))).toContain("bg-muted");
    expect(classes(await render(Badge, { variant: "success" }))).toContain("bg-success-bg");
    expect(classes(await render(Badge, { variant: "success" }))).toContain("text-success");
    expect(classes(await render(Badge, { variant: "warning" }))).toContain("bg-warning-bg");
    expect(classes(await render(Badge, { variant: "warning" }))).toContain("text-warning");
    expect(classes(await render(Badge, { variant: "destructive" }))).toContain("bg-danger-bg");
    expect(classes(await render(Badge, { variant: "destructive" }))).toContain("text-danger");
  });

  it("使用行内 span 渲染且支持 class 合并", async () => {
    const html = await render(Badge, { class: "ml-2" });
    expect(html.startsWith("<span")).toBe(true);
    expect(classes(html)).toContain("ml-2");
    expect(classes(html)).toContain("rounded-full");
  });
});

describe("Input / Textarea", () => {
  it("Input 默认使用既有输入类 Token", async () => {
    const html = await render(Input);
    expect(html.startsWith("<input")).toBe(true);
    expect(classes(html)).toContain("border-input");
    expect(classes(html)).toContain("bg-card");
    expect(classes(html)).toContain("focus-visible:ring-2");
    expect(classes(html)).toContain("focus-visible:ring-ring");
  });

  it("Input 的 disabled / invalid / placeholder 状态可表达", async () => {
    const disabled = await render(Input, { disabled: true });
    expect(disabled).toContain("disabled");
    expect(classes(disabled)).toContain("disabled:cursor-not-allowed");
    const invalid = await render(Input, { "aria-invalid": "true" });
    expect(invalid).toContain('aria-invalid="true"');
    expect(classes(invalid)).toContain("aria-invalid:border-danger");
    const placeholder = await render(Input, { placeholder: "请输入名称" });
    expect(placeholder).toContain('placeholder="请输入名称"');
    expect(classes(placeholder)).toContain("placeholder:text-muted-foreground");
  });

  it("Input 支持 class 合并且不与自身高度刻度冲突", async () => {
    const cls = classes(await render(Input, { class: "h-12" }));
    expect(cls).toContain("h-12");
    expect(cls).not.toContain("h-9");
  });

  it("Textarea 渲染原生 textarea 并支持 disabled / invalid / focus 契约", async () => {
    const html = await render(Textarea);
    expect(html.startsWith("<textarea")).toBe(true);
    expect(classes(html)).toContain("min-h-20");
    expect(classes(html)).toContain("border-input");
    expect(classes(html)).toContain("focus-visible:ring-2");
    const disabled = await render(Textarea, { disabled: true });
    expect(disabled).toContain("disabled");
    expect(classes(disabled)).toContain("disabled:opacity-60");
    const invalid = await render(Textarea, { "aria-invalid": "true" });
    expect(invalid).toContain('aria-invalid="true"');
    expect(classes(invalid)).toContain("aria-invalid:border-danger");
  });
});

describe("Label", () => {
  it("通过 for 与表单控件关联，且属性透传", async () => {
    const html = await render(Label, { for: "project-name" }, { default: () => "项目名称" });
    expect(html.startsWith("<label")).toBe(true);
    expect(html).toContain('for="project-name"');
    expect(html).toContain("项目名称");
    expect(classes(html)).toContain("text-secondary");
  });

  it("与 Input 组合时 for/id 对应关系成立", async () => {
    const pair = await renderToString(
      createSSRApp({
        render: () =>
          h("div", {}, [
            h(Label, { for: "f1" }, { default: () => "名称" }),
            h(Input, { id: "f1", name: "name" })
          ])
      })
    );
    expect(pair).toContain('for="f1"');
    expect(pair).toContain('id="f1"');
  });

  it("as-child：可渲染为自定义元素（Phase 12-D 迁移至 shadcn-vue Label 原语后新增能力）", async () => {
    const html = await renderToString(
      createSSRApp({
        render: () => h(Label, { asChild: true }, { default: () => h("span", {}, "标签") })
      })
    );
    expect(html).toContain("<span");
    expect(html).not.toContain("<label");
    expect(html).toContain("text-secondary");
  });
});

describe("Separator", () => {
  it("horizontal 契约：1px 高、占满宽度、不声明 aria-orientation", async () => {
    const html = await render(Separator);
    expect(html).toContain('role="separator"');
    expect(classes(html)).toContain("h-px");
    expect(classes(html)).toContain("w-full");
    expect(classes(html)).toContain("bg-border");
    expect(html).not.toContain("aria-orientation");
  });

  it("vertical 契约：1px 宽、占满高度、声明 aria-orientation", async () => {
    const html = await render(Separator, { orientation: "vertical" });
    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-orientation="vertical"');
    expect(classes(html)).toContain("w-px");
    expect(classes(html)).toContain("h-full");
  });

  it("支持 class 合并", async () => {
    expect(classes(await render(Separator, { class: "my-4" }))).toContain("my-4");
  });

  it("由 Reka UI Separator 原语渲染：输出 data-orientation 与装饰性开关", async () => {
    expect(await render(Separator, { orientation: "vertical" })).toContain(
      'data-orientation="vertical"'
    );
    // decorative=true 时原语输出 role="none"（默认 false，保留既有 separator 语义）
    expect(await render(Separator, { decorative: true })).toContain('role="none"');
  });
});

describe("cn() 对 AI-SE 排版 Token 的处理（回归：字号类不得被颜色类吞掉）", () => {
  it("字号 Token 与颜色类共存时两者都保留", () => {
    expect(cn("text-caption", "text-success")).toBe("text-caption text-success");
    expect(cn("text-secondary", "font-medium", "text-foreground")).toBe(
      "text-secondary font-medium text-foreground"
    );
    expect(cn("text-body", "text-primary-foreground")).toBe("text-body text-primary-foreground");
    expect(cn("text-section-title", "text-card-foreground")).toBe(
      "text-section-title text-card-foreground"
    );
  });

  it("同组冲突仍然按后写覆盖（字号 vs 字号、颜色 vs 颜色）", () => {
    expect(cn("text-body", "text-caption")).toBe("text-caption");
    expect(cn("text-foreground", "text-danger")).toBe("text-danger");
    expect(cn("h-9", "h-12")).toBe("h-12");
    expect(cn("bg-primary", "bg-card")).toBe("bg-card");
  });
});

/** Phase 12-C：组件库化 —— Table / Select / Checkbox 的组件契约。 */
describe("Table（组件库表格，替代原生 <table> 标记）", () => {
  const columns = [
    { key: "name", label: "项目名称" },
    { key: "status", label: "状态" }
  ];
  const rows = [
    { id: "p1", name: "Mini Todo", status: "ACTIVE" },
    { id: "p2", name: "AI-SE", status: "ARCHIVED" }
  ];
  const rowKey = (row: { id: string }) => row.id;

  it("渲染语义表格结构：table / thead / th[scope=col] / tbody / tr", async () => {
    const html = await render(Table as unknown as Component, { columns, rows, rowKey });
    expect(html).toContain("<table");
    expect(html).toContain("<thead");
    expect(html).toContain("<tbody");
    expect((html.match(/<th scope="col"/g) || []).length).toBe(2);
    expect((html.match(/<tr/g) || []).length).toBe(3);
    expect(html).toContain("项目名称");
    expect(html).toContain("状态");
  });

  it("行渲染为 tbody 数据行，且外层提供横向滚动容器", async () => {
    const html = await render(Table as unknown as Component, { columns, rows, rowKey });
    expect((html.match(/<td/g) || []).length).toBe(4);
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain("min-w-160");
  });

  it("列插槽优先渲染；未提供插槽的列回退为字段文本", async () => {
    const html = await render(
      Table as unknown as Component,
      { columns, rows, rowKey },
      {
        "cell-name": (slotProps: unknown) => {
          const { row } = slotProps as { row: { name: string } };
          return `链接:${row.name}`;
        }
      }
    );
    expect(html).toContain("链接:Mini Todo");
    expect(html).toContain("链接:AI-SE");
    // status 列无插槽 → 回退为字段原值
    expect(html).toContain("ACTIVE");
    expect(html).toContain("ARCHIVED");
  });

  it("行与表头视觉契约：表头 12px muted、行 hover 使用 --muted、首末行无重复描边", async () => {
    const html = await render(Table as unknown as Component, { columns, rows, rowKey });
    expect(html).toContain("text-caption");
    expect(html).toContain("text-muted-foreground");
    expect(html).toContain("hover:bg-muted");
    expect(html).toContain("last:border-b-0");
  });

  it("rows 为空时仍渲染表头（页面用 EmptyState 短路，组件本身不崩）", async () => {
    const html = await render(Table as unknown as Component, { columns, rows: [], rowKey });
    expect(html).toContain("<thead");
    expect(html).not.toContain("<td");
  });

  it("支持 class 合并到 table 元素", async () => {
    const html = await render(Table as unknown as Component, {
      columns,
      rows,
      rowKey,
      class: "table-compact"
    });
    expect(html).toContain("table-compact");
  });
});

describe("Select（组件库下拉选择：shadcn-vue / Reka UI Primitive）", () => {
  const options = [
    { value: "", label: "选择项目" },
    { value: "b55c87fc", label: "Mini Todo" },
    { value: "archived", label: "已归档项目", disabled: true }
  ];
  /** SSR 只渲染触发器：浮层（SelectContent/SelectItem）在 Teleport + 打开态内，其选项列表由真实浏览器验证。 */
  const select = (extra: Record<string, unknown> = {}) =>
    render(Select, { options, modelValue: "", ...extra });

  it("由 Reka UI 原语渲染触发器（button[role=combobox]），不再输出原生 <select>", async () => {
    const html = await select();
    expect(html).not.toContain("<select");
    expect(html).toContain("<button");
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("data-state");
    expect(html).toContain("<svg");
  });

  it("空值选项：触发器显示其 label，内部哨兵值不泄漏到 DOM", async () => {
    const html = await select();
    expect(html).toContain("选择项目");
    expect(html).not.toContain("__ai_se_empty__");
  });

  it("选中项回显：v-model 指向某选项时触发器显示该选项 label", async () => {
    const html = await select({ modelValue: "b55c87fc" });
    expect(html).toContain("Mini Todo");
    expect(html).not.toContain("选择项目");
  });

  it("无匹配选项时显示 placeholder 文案（reka 内部 label 解析依赖已渲染的 item，故这里只断言文案）", async () => {
    const html = await render(Select, {
      options: [{ value: "a", label: "A" }],
      modelValue: "",
      placeholder: "请选择"
    });
    expect(html).toContain("请选择");
  });

  it("原生属性透传：id / aria-* 落到触发器，required 同时进入 a11y 状态", async () => {
    const html = await select({
      modelValue: "b55c87fc",
      id: "deployment-project",
      required: true,
      "aria-label": "项目"
    });
    expect(html).toContain('id="deployment-project"');
    expect(html).toContain('aria-label="项目"');
    expect(html).toContain('aria-required="true"');
  });

  it("disabled：触发器禁用并带 data-disabled", async () => {
    const html = await select({ disabled: true });
    expect(html).toContain("disabled");
    expect(html).toContain("data-disabled");
  });

  it("视觉契约：触发器与 Input 同一刻度（h-9 / border-input / rounded-md / focus ring）", async () => {
    const cls = classes(await select());
    expect(cls).toContain("h-9");
    expect(cls).toContain("border-input");
    expect(cls).toContain("rounded-md");
    expect(cls).toContain("focus-visible:ring-2");
    expect(cls).not.toContain("appearance-none");
  });

  it("支持 class 合并", async () => {
    expect(classes(await select({ class: "w-40" }))).toContain("w-40");
  });
});

describe("Checkbox（组件库复选框：shadcn-vue / Reka UI CheckboxRoot）", () => {
  it("由 Reka UI 原语渲染（button[role=checkbox]），不再输出原生 <input type=checkbox>", async () => {
    const html = await render(Checkbox, { modelValue: true });
    expect(html).not.toContain('type="checkbox"');
    expect(html).toContain("<button");
    expect(html).toContain('role="checkbox"');
    expect(html).toContain("aria-checked");
    expect(html).toContain('data-state="checked"');
    expect(html).toContain("<svg");
  });

  it("未选中时 data-state 为 unchecked", async () => {
    const html = await render(Checkbox, { modelValue: false });
    expect(html).toContain('data-state="unchecked"');
  });

  it("选中态视觉使用 Design Token（primary 底 + 前景勾），并保留未启用 Preflight 的尺寸兜底类", async () => {
    const cls = classes(await render(Checkbox, { modelValue: false, class: "mr-2" }));
    expect(cls).toContain("mr-2");
    expect(cls).toContain("size-4");
    expect(cls).toContain("shrink-0");
    expect(cls).toContain("border-input");
    expect(cls).toContain("data-[state=checked]:bg-primary");
    expect(cls).toContain("data-[state=checked]:text-primary-foreground");
    expect(cls).toContain("focus-visible:ring-2");
  });

  it("disabled / required / id 原生属性透传（页面侧 <label for> 与表单语义保持）", async () => {
    const html = await render(Checkbox, {
      modelValue: false,
      id: "workflow-approval",
      disabled: true,
      required: true
    });
    expect(html).toContain('id="workflow-approval"');
    expect(html).toContain("disabled");
    expect(html).toContain('aria-required="true"');
  });
});

/**
 * Phase 12-C 护栏：业务页面不得再书写原生表单/表格控件标记。
 * 这些控件必须由 components/ui 提供（Table / Select / Checkbox / Input / Textarea / Button）。
 * 例外说明：
 *   · MCPServerDetailView 的 <datalist> 是 free-text + 建议值的输入语义，
 *     与下拉选择不等价（Phase 10-A 已裁定保持 Input + datalist）。
 */
describe("组件库化护栏：views 不得书写原生 <select> / <table> / checkbox", () => {
  const viewSources = import.meta.glob("../views/*.vue", {
    query: "?raw",
    import: "default",
    eager: true
  }) as Record<string, string>;

  /** 注释里可以提及这些标记名（说明性文字），扫描前先剥离注释。 */
  function stripComments(source: string): string {
    return source
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\*.*$/gm, "")
      .replace(/^\s*\/\/.*$/gm, "");
  }

  it("扫描到全部业务页面（防止 glob 失效导致空扫描）", () => {
    expect(Object.keys(viewSources).length).toBeGreaterThanOrEqual(11);
  });

  it('不存在原生 <select> / <table> / <input type="checkbox">', () => {
    const offenders: string[] = [];

    for (const [path, source] of Object.entries(viewSources)) {
      const name = path.split("/").pop() ?? path;
      const markup = stripComments(source);
      if (/<select[\s>]/.test(markup)) offenders.push(`${name}: <select>`);
      if (/<table[\s>]/.test(markup)) offenders.push(`${name}: <table>`);
      if (/<input[^>]*type="checkbox"/.test(markup)) {
        offenders.push(`${name}: <input type="checkbox">`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("表格、下拉选择、弹窗与抽屉均通过组件库组件使用（页面侧引用存在）", () => {
    const tableUsers = Object.entries(viewSources)
      .filter(([, source]) => source.includes("<Table"))
      .map(([path]) => path.split("/").pop());
    const selectUsers = Object.entries(viewSources)
      .filter(([, source]) => source.includes("<Select"))
      .map(([path]) => path.split("/").pop());
    const dialogUsers = Object.entries(viewSources)
      .filter(([, source]) => source.includes("<Dialog"))
      .map(([path]) => path.split("/").pop());
    const drawerUsers = Object.entries(viewSources)
      .filter(([, source]) => source.includes("<Drawer"))
      .map(([path]) => path.split("/").pop());

    expect(tableUsers.sort()).toEqual([
      "AgentRunView.vue",
      "AgentsView.vue",
      "AutonomyRunsView.vue",
      "DashboardView.vue",
      "ProjectsView.vue",
      "RequirementsView.vue",
      "WorkflowsView.vue"
    ]);
    expect(selectUsers.sort()).toEqual([
      "AutonomyRunsView.vue",
      "DeploymentsView.vue",
      "MCPServersView.vue",
      "RequirementsView.vue",
      "WorkflowsView.vue"
    ]);
    expect(dialogUsers.sort()).toEqual([
      "AgentRunView.vue",
      "DeploymentsView.vue",
      "MCPServersView.vue",
      "ProjectsView.vue",
      "RequirementsView.vue",
      "WorkflowsView.vue"
    ]);
    expect(drawerUsers.sort()).toEqual([
      "AgentRunView.vue",
      "AgentsView.vue",
      "AutonomyRunsView.vue",
      "RequirementsView.vue",
      "WorkflowsView.vue"
    ]);
  });

  it("危险操作的确认一律走 ConfirmDialog：views 里不存在 window.confirm", () => {
    const offenders = Object.entries(viewSources)
      .filter(([, source]) => /window\.confirm\s*\(/.test(stripComments(source)))
      .map(([path]) => path.split("/").pop());

    expect(offenders).toEqual([]);
  });

  it("ConfirmDialog 的使用者与「受控开合 + 一个实例」写法一致", () => {
    const confirmUsers = Object.entries(viewSources)
      .filter(([, source]) => source.includes("<ConfirmDialog"))
      .map(([path]) => path.split("/").pop());

    expect(confirmUsers.sort()).toEqual([
      "MCPServerDetailView.vue",
      "ProjectDetailView.vue",
      "ProjectsView.vue",
      "WorkflowsView.vue"
    ]);

    // 列表页（每行一个「删除」/「拒绝」触发）必须用受控 `:open` 只挂一个实例；
    // 详情页只有一个目标，`v-model:open` 即可。
    for (const name of ["ProjectsView.vue", "MCPServerDetailView.vue", "WorkflowsView.vue"]) {
      const entry = Object.entries(viewSources).find(([path]) => path.endsWith(name));
      expect(entry, `${name} 应存在`).toBeTruthy();
      expect(entry?.[1], `${name} 应受控开合`).toContain(":open=");
    }
  });

  it("W12：views 里的每个 <Dialog 都带 description（否则屏幕阅读器只念得出标题）", () => {
    const offenders: string[] = [];
    let scanned = 0;

    for (const [path, source] of Object.entries(viewSources)) {
      const name = path.split("/").pop() ?? path;
      for (const match of stripComments(source).matchAll(/<Dialog\b[\s\S]*?>/g)) {
        scanned += 1;
        if (!/description=/.test(match[0])) {
          offenders.push(`${name}: ${match[0].replace(/\s+/g, " ").slice(0, 60)}`);
        }
      }
    }

    // 防「正则失效 ⇒ 空扫描永远通过」（W10 学到的教训）
    expect(scanned, "应扫到全部新建/设置弹窗").toBeGreaterThanOrEqual(5);
    expect(offenders).toEqual([]);
  });

  it("破坏性按钮一律带 danger 语义色（destructive 或 ghost + text-danger）", () => {
    const offenders: string[] = [];

    for (const [path, source] of Object.entries(viewSources)) {
      const name = path.split("/").pop() ?? path;
      const markup = stripComments(source);
      // 逐个 <Button ...> 开标签检查：它必须要么是 destructive，要么显式带 text-danger
      for (const [tag] of markup.matchAll(/<Button\b[^>]*>/g)) {
        const looksDestructive = /@click="[^"]*(remove|delete|Remove|Delete|rollback|reject)/.test(tag);
        if (!looksDestructive) continue;
        if (/variant="destructive"/.test(tag) || /text-danger/.test(tag)) continue;
        offenders.push(`${name}: ${tag.replace(/\s+/g, " ").slice(0, 90)}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe("W10 · legacy 类名清剿", () => {
  /** W10 终验点名的 13 个，加上本次扫描额外查出的 5 个无 CSS 规则的死类名。 */
  const LEGACY = [
    // docs/132 §W10 机械检查点名的
    "page-header",
    "eyebrow",
    "status-pill",
    "compact-list",
    "project-row",
    "detail-grid",
    "event-timeline",
    "tool-call-row",
    "mcp-detail-grid",
    "deployment-layout",
    "tab-bar",
    "mcp-app-frame",
    "workflow-checkbox",
    // W10 用「产物 CSS 里找不到规则」的办法额外查出的
    "nav-link",
    "nav-link--active",
    "agent-link",
    "mcp-action-link",
    "requirement-dependencies"
  ];

  const allSources = {
    ...(import.meta.glob("../views/*.vue", {
      query: "?raw",
      import: "default",
      eager: true
    }) as Record<string, string>),
    ...(import.meta.glob("../components/**/*.vue", {
      query: "?raw",
      import: "default",
      eager: true
    }) as Record<string, string>)
  };

  /** 注释里的提及不算：`SectionHeader` 的文档注释举的就是一批 legacy 标记作为「它替掉了什么」。 */
  function stripComments(source: string): string {
    return source
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\*.*$/gm, "")
      .replace(/^\s*\/\/.*$/gm, "");
  }

  /** 只取 class 属性的值 —— 属性名与注释里的提及不算（`SectionHeader` 的 `eyebrow` prop 是活的）。 */
  function classAttributes(source: string): string[] {
    return [...stripComments(source).matchAll(/\bclass="([^"{]*?)"/g)].map((m) => m[1]);
  }

  it("生产文件的 class 属性里不再出现任何 legacy 类名", () => {
    const offenders: string[] = [];
    for (const [path, source] of Object.entries(allSources)) {
      const name = path.split("/").pop() ?? path;
      const classText = classAttributes(source).join(" ");
      for (const legacy of LEGACY) {
        if (new RegExp(`(^|\\s)${legacy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`).test(classText)) {
          offenders.push(`${name}: ${legacy}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("扫描覆盖到内容（防止 glob 失效导致空扫描）", () => {
    expect(Object.keys(allSources).length).toBeGreaterThanOrEqual(26);
  });

  it("`eyebrow` 仍然只作为 SectionHeader 的 prop 存在（PageHeader 的已在 W5 删除）", () => {
    const sectionHeader = Object.entries(allSources).find(([path]) =>
      path.endsWith("SectionHeader.vue")
    );
    // prop 与模板绑定都在代码里（注释剥离后仍在）
    expect(stripComments(sectionHeader?.[1] ?? "")).toContain("eyebrow");
    const pageHeader = Object.entries(allSources).find(([path]) => path.endsWith("PageHeader.vue"));
    // 只在注释里被提到「已删除」是可以的，代码里不许再有
    expect(stripComments(pageHeader?.[1] ?? "")).not.toContain("eyebrow");
  });
});

describe("Input / Textarea（Phase 12-E：渲染路径经 Reka Primitive）", () => {
  it("Input 仍输出单个原生 input（无额外包裹节点），类名与原生属性不变", async () => {
    const html = await render(Input, { id: "f1", placeholder: "名称", type: "number", min: "1" });
    expect(html.startsWith("<input")).toBe(true);
    expect(html).not.toContain("<div");
    expect(html).toContain('id="f1"');
    expect(html).toContain('placeholder="名称"');
    expect(html).toContain('type="number"');
    expect(html).toContain('min="1"');
    expect(html).toContain("border-input");
  });

  it("Textarea 仍输出单个原生 textarea（无额外包裹节点），rows / maxlength 透传", async () => {
    const html = await render(Textarea, { rows: "7", maxlength: "20000" });
    expect(html.startsWith("<textarea")).toBe(true);
    expect(html).not.toContain("<div");
    expect(html).toContain('rows="7"');
    expect(html).toContain('maxlength="20000"');
    expect(html).toContain("min-h-20");
  });
});

describe("Pagination（组件库分页：shadcn-vue / Reka UI Pagination）", () => {
  it("渲染页码按钮；当前页带 aria-current 与 data-selected", async () => {
    const html = await render(Pagination, { total: 50, itemsPerPage: 10, page: 3 });
    // 默认 show-edges=false：只渲染当前页 ± siblingCount(=1)
    expect(html).toContain('aria-label="Page 2"');
    expect(html).toContain('aria-label="Page 3"');
    expect(html).toContain('aria-label="Page 4"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('data-selected="true"');
    expect((html.match(/aria-label="Page /g) || []).length).toBeGreaterThanOrEqual(3);
    expect(html).toContain("<svg");
  });

  it("首/上/下/末四个跳转按钮渲染，且样式使用 AI-SE Token（选中态 Primary）", async () => {
    const html = await render(Pagination, { total: 30, itemsPerPage: 10 });
    expect(html).toContain('aria-label="首页"');
    expect(html).toContain('aria-label="上一页"');
    expect(html).toContain('aria-label="下一页"');
    expect(html).toContain('aria-label="末页"');
    expect(html).toContain("data-[selected]:bg-primary");
    expect(html).toContain("border-input");
  });

  it("页数很多时显示省略号；show-edges 时首末页常驻", async () => {
    const html = await render(Pagination, {
      total: 1000,
      itemsPerPage: 10,
      page: 50,
      showEdges: true
    });
    expect(html).toContain('aria-label="Page 1"');
    expect(html).toContain('aria-label="Page 100"');
  });

  it("支持 class 合并", async () => {
    const html = await render(Pagination, { total: 20, itemsPerPage: 10, class: "mt-4" });
    expect(html).toContain("mt-4");
  });
});

describe("Table 列对齐与排序（W7）", () => {
  const columns = [
    { key: "name", label: "名称", sortable: true },
    { key: "count", label: "数量", align: "right" as const, sortable: true },
    { key: "actions", label: "操作", align: "right" as const }
  ];
  const rows = [
    { id: "b", name: "banana", count: 20 },
    { id: "a", name: "apple", count: 3 },
    { id: "c", name: "", count: 100 }
  ];
  const rowKey = (row: { id: string }) => row.id;

  it("默认左对齐；align=right 的列在 th 与 td 上都右对齐并带等宽数字", async () => {
    const html = await render(Table as unknown as Component, { columns, rows, rowKey });
    // 表头：名称左、数量右、操作右
    const heads = [...html.matchAll(/<th scope="col"[^>]*class="([^"]*)"/g)].map((m) => m[1]);
    expect(heads).toHaveLength(3);
    expect(heads[0]).toContain("text-left");
    expect(heads[1]).toContain("text-right");
    expect(heads[2]).toContain("text-right");
    // 单元格：右对齐列带 tabular-nums
    const cells = [...html.matchAll(/<td class="([^"]*)"/g)].map((m) => m[1]);
    expect(cells.filter((cls) => cls.includes("text-right tabular-nums"))).toHaveLength(6);
    expect(cells.filter((cls) => cls.includes("text-center"))).toHaveLength(0);
  });

  it("不再有任何 text-center（旧版全表居中已移除）", async () => {
    const html = await render(Table as unknown as Component, { columns, rows, rowKey });
    expect(html).not.toContain("text-center");
  });

  it("sortable 列的表头是按钮并带 aria-sort；不可排序列仍是纯文本", async () => {
    const html = await render(Table as unknown as Component, { columns, rows, rowKey });
    expect((html.match(/<th scope="col"[^>]*aria-sort="none"/g) || []).length).toBe(2);
    expect((html.match(/<th scope="col"(?![^>]*aria-sort)/g) || []).length).toBe(1); // 操作列
    expect((html.match(/<button type="button"/g) || []).length).toBe(2);
    expect(html).toContain("lucide-chevrons-up-down"); // 未排序时的指示图标
  });

  it("表头按钮关掉原生 button 外观（本项目不含 Tailwind preflight）", async () => {
    const html = await render(Table as unknown as Component, { columns, rows, rowKey });
    const buttons = [...html.matchAll(/<button type="button" class="([^"]*)"/g)].map((m) => m[1]);
    expect(buttons).toHaveLength(2);
    for (const cls of buttons) {
      expect(cls).toContain("appearance-none");
      expect(cls).toContain("border-0");
      expect(cls).toContain("bg-transparent");
    }
  });

  it("未点击表头时不重排：行顺序与入参一致（排序是显式动作，不是默认行为）", async () => {
    const html = await render(Table as unknown as Component, {
      columns,
      rows,
      rowKey,
      pageSize: 0
    });
    expect(html.indexOf("banana")).toBeGreaterThan(-1);
    expect(html.indexOf("banana")).toBeLessThan(html.indexOf("apple"));
  });
});

describe("Table 内置分页（Phase 12-E）", () => {
  const columns = [
    { key: "name", label: "名称" },
    { key: "status", label: "状态" }
  ];
  const rows = Array.from({ length: 5 }, (_, index) => ({
    id: `r${index + 1}`,
    name: `行${index + 1}`,
    status: "ACTIVE"
  }));
  const rowKey = (row: { id: string }) => row.id;

  it("默认 pageSize = 10（W7）：列表页不传参数也分页 —— 10 条以内在第 1 页，页脚已出现", async () => {
    const html = await render(Table as unknown as Component, { columns, rows, rowKey });
    expect((html.match(/<tr/g) || []).length).toBe(6); // 表头 1 + 数据 5（未超过一页）
    expect(html).toContain("共 5 条");
    expect(html).toContain('aria-label="Page 1"');
  });

  it("pageSize = 0：显式关闭分页（仅摘要表用）—— 全部行渲染且无分页脚", async () => {
    const html = await render(Table as unknown as Component, { columns, rows, rowKey, pageSize: 0 });
    expect((html.match(/<tr/g) || []).length).toBe(6); // 表头 1 + 数据 5
    expect(html).not.toContain("共 ");
    expect(html).not.toContain('aria-label="Page 2"');
  });

  it("默认每页 10 条：11 行只渲染前 10 行，第 2 页可翻", async () => {
    const many = Array.from({ length: 11 }, (_, index) => ({
      id: `m${index + 1}`,
      name: `行${index + 1}`,
      status: "ACTIVE"
    }));
    const html = await render(Table as unknown as Component, {
      columns,
      rows: many,
      rowKey
    });
    expect((html.match(/<tr/g) || []).length).toBe(11); // 表头 1 + 数据 10
    expect(html).toContain("共 11 条");
    expect(html).toContain('aria-label="Page 2"');
    expect(html).not.toContain("行11");
  });

  it("pageSize > 0：只渲染当前页切片，并渲染条目计数与分页控件", async () => {
    const html = await render(Table as unknown as Component, {
      columns,
      rows,
      rowKey,
      pageSize: 2,
      page: 1
    });
    expect((html.match(/<tr/g) || []).length).toBe(3); // 表头 1 + 当前页 2
    expect(html).toContain("共 5 条");
    expect(html).toContain('aria-label="Page 3"');
    expect(html).toContain("行1");
    expect(html).not.toContain("行3");
  });

  it("受控 page=2 渲染第 3/4 行；页码越界时收敛到末页", async () => {
    const page2 = await render(Table as unknown as Component, {
      columns,
      rows,
      rowKey,
      pageSize: 2,
      page: 2
    });
    expect(page2).toContain("行3");
    expect(page2).toContain("行4");
    expect(page2).not.toContain("行1");
    const page9 = await render(Table as unknown as Component, {
      columns,
      rows,
      rowKey,
      pageSize: 2,
      page: 9
    });
    expect(page9).toContain("行5");
  });
});

/**
 * Phase 12-F（需求页布局重构）：Dialog / Drawer 组件契约。
 *
 * 两个组件都由 Reka UI Dialog 原语族渲染；关闭态内容保持挂载（unmount-on-hide=false）
 * 且 Portal force-mount ⇒ SSR 输出在 ctx.teleports 中可见（以 display:none 隐藏）。
 */
async function renderOverlay(
  component: Component,
  props: Record<string, unknown>,
  slots: Slots = {}
): Promise<{ html: string; body: string }> {
  const app = createSSRApp({ render: () => h(component, props, slots) });
  const ctx: { teleports?: Record<string, string> } = {};
  const html = await renderToString(app, ctx);
  return { html, body: Object.values(ctx.teleports ?? {}).join("\n") };
}

describe("Dialog（组件库弹窗：Reka UI Dialog）", () => {
  const trigger = () => h("button", { type: "button" }, "打开");

  it("关闭态：触发器为 button[aria-haspopup=dialog]，内容挂载于 Teleport 并以 display:none 隐藏", async () => {
    const { html, body } = await renderOverlay(
      Dialog,
      { title: "新建需求", open: false },
      { trigger, default: () => "弹窗正文" }
    );
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('data-state="closed"');
    expect(body).toContain("新建需求");
    expect(body).toContain("弹窗正文");
    expect(body).toContain("display:none");
  });

  it("打开态：内容可见（data-state=open）且标题参与 aria-labelledby", async () => {
    const { body } = await renderOverlay(
      Dialog,
      { title: "新建需求", open: true },
      { default: () => "弹窗正文" }
    );
    expect(body).toContain('data-state="open"');
    expect(body).toContain("aria-labelledby");
    expect(body).toContain("弹窗正文");
    expect(body).not.toContain("display:none");
  });

  it("description 可选：未提供时移除 aria-describedby；提供时渲染描述与引用", async () => {
    const none = await renderOverlay(Dialog, { title: "T", open: true }, { default: () => "x" });
    expect(none.body).not.toContain("aria-describedby");

    const withDescription = await renderOverlay(
      Dialog,
      { title: "T", description: "说明文案", open: true },
      { default: () => "x" }
    );
    expect(withDescription.body).toContain("说明文案");
    expect(withDescription.body).toContain("aria-describedby");
  });

  it("关闭按钮为组件库图标按钮（aria-label=关闭），遮罩与面板使用 Token 类", async () => {
    const { body } = await renderOverlay(
      Dialog,
      { title: "T", open: true },
      { default: () => "x" }
    );
    expect(body).toContain('aria-label="关闭"');
    expect(body).toContain("bg-foreground/40");
    expect(body).toContain("shadow-[var(--shadow-overlay)]");
  });

  it("支持 class 合并到面板", async () => {
    const { body } = await renderOverlay(
      Dialog,
      { title: "T", open: true, class: "w-[800px]" },
      { default: () => "x" }
    );
    expect(body).toContain("w-[800px]");
  });
});

describe("Drawer（组件库抽屉：右侧贴边面板）", () => {
  it("关闭态：内容挂载于 Teleport 并以 display:none 隐藏", async () => {
    const { body } = await renderOverlay(
      Drawer,
      { title: "需求详情", open: false },
      { default: () => "抽屉正文" }
    );
    expect(body).toContain("需求详情");
    expect(body).toContain("抽屉正文");
    expect(body).toContain("display:none");
  });

  it("打开态：右侧全高面板 + 遮罩 + data-state=open", async () => {
    const { body } = await renderOverlay(
      Drawer,
      { title: "需求详情", open: true },
      { default: () => "抽屉正文" }
    );
    expect(body).toContain('data-state="open"');
    expect(body).toContain("right-0");
    expect(body).toContain("border-l");
    expect(body).toContain("bg-foreground/40");
    expect(body).not.toContain("display:none");
  });
});
