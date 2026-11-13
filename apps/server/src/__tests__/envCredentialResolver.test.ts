import { describe, expect, it } from "vitest";
import {
  createEnvCredentialResolver,
  envVarNameForReference
} from "../services/envCredentialResolver";

describe("envCredentialResolver", () => {
  it("把 secret: 引用映射成带命名空间的环境变量名", () => {
    expect(envVarNameForReference("secret:mcp/servers/github")).toBe(
      "MCP_SECRET_MCP_SERVERS_GITHUB"
    );
    expect(envVarNameForReference("  secret:llm/openai-key ")).toBe("MCP_SECRET_LLM_OPENAI_KEY");
    expect(envVarNameForReference("secret:mcp/servers/github.v2")).toBe(
      "MCP_SECRET_MCP_SERVERS_GITHUB_V2"
    );
  });

  it("映射结果始终带 MCP_SECRET_ 前缀，所以引用无法点名任意环境变量", () => {
    // 带路径穿越形态的引用只会被压成一个名字，读到的仍是 MCP_SECRET_ 命名空间下的变量。
    expect(envVarNameForReference("secret:../etc/passwd")).toMatch(/^MCP_SECRET_/);
    expect(envVarNameForReference("secret:../../.ssh/id_rsa")).toMatch(/^MCP_SECRET_/);
    expect(envVarNameForReference("OPENAI_API_KEY")).toBeUndefined();
    expect(envVarNameForReference("secret:")).toBeUndefined();
  });

  it("按引用取到环境变量里的值", () => {
    const resolve = createEnvCredentialResolver({ MCP_SECRET_MCP_SERVERS_GITHUB: "ghp_x" });

    expect(
      resolve({ serverId: "s1", kind: "credentialRef", reference: "secret:mcp/servers/github" })
    ).toBe("ghp_x");
  });

  it("未配置、空值与非法引用都返回 undefined —— 交给客户端既有的 fail-closed 路径", () => {
    const resolve = createEnvCredentialResolver({ MCP_SECRET_EMPTY: "", MCP_SECRET_BLANK: "   " });
    const ask = (reference: string) => resolve({ serverId: "s1", kind: "authRef", reference });

    expect(ask("secret:mcp/servers/github")).toBeUndefined();
    expect(ask("secret:empty")).toBeUndefined();
    expect(ask("OPENAI_API_KEY")).toBeUndefined();
  });
});
