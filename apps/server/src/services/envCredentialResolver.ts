import type { MCPCredentialResolutionRequest, MCPCredentialResolver } from "@ai-se/mcp";

/** 只有 `secret:<path>` 形态的引用才会被解析 —— 服务端不能借引用去读任意的环境变量。 */
const REFERENCE_PATTERN = /^secret:([A-Za-z0-9/_.-]+)$/;

/**
 * `secret:mcp/servers/github` → `MCP_SECRET_MCP_SERVERS_GITHUB`。
 * 非 `secret:` 前缀、或含此字符集之外的字符，一律返回 undefined（不解析，而不是猜）。
 */
export function envVarNameForReference(reference: string): string | undefined {
  const match = REFERENCE_PATTERN.exec(reference.trim());
  if (!match) return undefined;
  return `MCP_SECRET_${match[1].toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

/**
 * 平台侧的 Credential Resolver（`packages/mcp` 只定义了类型，这里是它的第一个实现）。
 *
 * 解出来的值只交给构建 HTTP 请求头的代码（`RemoteMCPClient.resolveHeaders`），
 * 不进日志、不进 State、不回显；未配置时返回 undefined，由客户端既有的 fail-closed
 * 路径抛 CONNECTION 错。**不读进程环境变量以外的地方**：没有表、没有文件、没有第二套密钥体系。
 */
export function createEnvCredentialResolver(
  env: NodeJS.ProcessEnv = process.env
): MCPCredentialResolver {
  return ({ reference }: MCPCredentialResolutionRequest) => {
    const name = envVarNameForReference(reference);
    if (!name) return undefined;
    const value = env[name];
    // 全空白视为未配置（配错成空格比没配更隐蔽）。有内容时**原样**返回，不 trim ——
    // 静默改掉一个密钥的值比让它失败更糟。
    return value !== undefined && value.trim() !== "" ? value : undefined;
  };
}
