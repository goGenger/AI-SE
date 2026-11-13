import { describe, expect, it } from "vitest";
import {
  emptyMCPServerForm,
  parseCommandArgs,
  toCreateMCPServerInput
} from "@/viewmodels/mcpViewModel";

/**
 * T2：MCP 服务器表单 → 创建载荷（纯逻辑，无 DOM）。
 *
 * 关键点不是「能拼出对象」，而是**传输方式决定字段**：把另一侧的残值一起发出去
 * 会被 `CreateMCPServerSchema.strict()` 拒绝，用户只会看到一句看不懂的校验错误。
 */
describe("toCreateMCPServerInput", () => {
  it("stdio：切分参数、丢弃空段、带上工作目录", () => {
    const form = {
      ...emptyMCPServerForm(),
      name: "  github  ",
      command: "npx",
      argsText: "-y\nexample-mcp-server   --verbose",
      cwd: " /tmp "
    };

    expect(toCreateMCPServerInput(form)).toEqual({
      name: "github",
      transport: "stdio",
      enabled: true,
      command: "npx",
      args: ["-y", "example-mcp-server", "--verbose"],
      cwd: "/tmp"
    });
  });

  it("stdio：缺启动命令返回 null（由调用方给出可读提示）", () => {
    const form = { ...emptyMCPServerForm(), name: "github", command: "   " };
    expect(toCreateMCPServerInput(form)).toBeNull();
  });

  it("http：只带端点与凭据引用，stdio 的残值不进载荷", () => {
    const form = {
      ...emptyMCPServerForm(),
      name: "remote",
      transport: "streamable-http" as const,
      endpoint: "https://mcp.example.com/mcp",
      credentialRef: "env:MCP_TOKEN",
      // 用户在切换传输方式前留下的值
      command: "npx",
      cwd: "/tmp"
    };

    expect(toCreateMCPServerInput(form)).toEqual({
      name: "remote",
      transport: "streamable-http",
      enabled: true,
      endpoint: "https://mcp.example.com/mcp",
      credentialRef: "env:MCP_TOKEN"
    });
  });

  it("http：缺端点返回 null", () => {
    const form = { ...emptyMCPServerForm(), name: "remote", transport: "streamable-http" as const };
    expect(toCreateMCPServerInput(form)).toBeNull();
  });

  it("空名称 / 空描述都不进入载荷", () => {
    const blank = { ...emptyMCPServerForm(), command: "npx" };
    expect(toCreateMCPServerInput(blank)).toBeNull();

    const described = {
      ...emptyMCPServerForm(),
      name: "github",
      command: "npx",
      description: "   "
    };
    expect(toCreateMCPServerInput(described)).not.toHaveProperty("description");
  });

  it("禁用态原样传递（建了但先不连）", () => {
    const form = { ...emptyMCPServerForm(), name: "github", command: "npx", enabled: false };
    expect(toCreateMCPServerInput(form)).toMatchObject({ enabled: false });
  });
});

describe("parseCommandArgs", () => {
  it("空串和纯空白都得到空数组", () => {
    expect(parseCommandArgs("")).toEqual([]);
    expect(parseCommandArgs("   \n\t ")).toEqual([]);
  });

  it("连续空白不产生空参数", () => {
    expect(parseCommandArgs("a   b\n\nc")).toEqual(["a", "b", "c"]);
  });
});
