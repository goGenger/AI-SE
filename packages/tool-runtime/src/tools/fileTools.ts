import { assertPlaywrightManifestContent, PLATFORM_PLAYWRIGHT_VERSION } from "@ai-se/sandbox";
import { z } from "zod";
import { ToolExecutionError } from "../errors";
import { ToolDefinition } from "../types";
import { commandFailureDetails, normalizeRelativePath, shellQuote } from "./shell";

function assertPlaywrightManifestWrite(filePath: string, content: string): void {
  const verdict = assertPlaywrightManifestContent(content, filePath);
  if (!verdict.ok) {
    throw new ToolExecutionError("TOOL_ERROR", verdict.reason);
  }
}

const PathInputSchema = z.object({
  path: z.string().min(1),
  cwd: z.string().min(1).optional().describe("Workspace-relative path; omit for the workspace root")
});

const WriteFileInputSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  cwd: z.string().min(1).optional().describe("Workspace-relative path; omit for the workspace root")
});

const EditFileInputSchema = z.object({
  path: z.string().min(1),
  search: z.string().min(1),
  replace: z.string(),
  replaceAll: z.boolean().optional().default(true),
  cwd: z.string().min(1).optional().describe("Workspace-relative path; omit for the workspace root")
});

const SearchCodeInputSchema = z.object({
  query: z.string().min(1),
  path: z.string().min(1).default("."),
  cwd: z.string().min(1).optional().describe("Workspace-relative path; omit for the workspace root")
});

export type FileTool = ToolDefinition<unknown, unknown>;

export function createFileTools(): FileTool[] {
  return [readFileTool, writeFileTool, editFileTool, listDirectoryTool, searchCodeTool];
}

const readFileTool: ToolDefinition<
  z.infer<typeof PathInputSchema>,
  { path: string; content: string }
> = {
  name: "read_file",
  description: "Read a UTF-8 text file from the sandbox workspace.",
  riskLevel: "LOW",
  inputSchema: PathInputSchema,
  async execute(input, context) {
    const filePath = normalizeRelativePath(input.path);
    const result = await context.sandbox.runCommand(
      context.workspacePath,
      {
        command: `cat -- ${shellQuote(filePath)}`,
        cwd: input.cwd ? normalizeRelativePath(input.cwd, "cwd") : undefined,
        timeoutMs: context.timeoutMs
      },
      context.signal
    );

    if (result.exitCode !== 0) {
      throw new ToolExecutionError(
        "COMMAND_ERROR",
        "Failed to read file",
        commandFailureDetails(result.command, result.exitCode, result.stdout, result.stderr)
      );
    }

    return { path: filePath, content: result.stdout };
  }
};

const writeFileTool: ToolDefinition<
  z.infer<typeof WriteFileInputSchema>,
  { path: string; bytes: number }
> = {
  name: "write_file",
  description: "Write a UTF-8 text file inside the sandbox workspace.",
  riskLevel: "MEDIUM",
  inputSchema: WriteFileInputSchema,
  async execute(input, context) {
    const filePath = normalizeRelativePath(input.path);
    assertPlaywrightManifestWrite(filePath, input.content);
    const contentBase64 = Buffer.from(input.content, "utf8").toString("base64");
    const command = [
      `mkdir -p -- "$(dirname -- ${shellQuote(filePath)})"`,
      `node -e "require('node:fs').writeFileSync(process.argv[1], Buffer.from(process.argv[2], 'base64').toString('utf8'))" ${shellQuote(filePath)} ${shellQuote(contentBase64)}`
    ].join(" && ");
    const result = await context.sandbox.runCommand(
      context.workspacePath,
      {
        command,
        cwd: input.cwd ? normalizeRelativePath(input.cwd, "cwd") : undefined,
        timeoutMs: context.timeoutMs
      },
      context.signal
    );

    if (result.exitCode !== 0) {
      throw new ToolExecutionError(
        "COMMAND_ERROR",
        "Failed to write file",
        commandFailureDetails(result.command, result.exitCode, result.stdout, result.stderr)
      );
    }

    return { path: filePath, bytes: Buffer.byteLength(input.content, "utf8") };
  }
};

const editFileTool: ToolDefinition<
  z.infer<typeof EditFileInputSchema>,
  { path: string; replacements: number }
> = {
  name: "edit_file",
  description: "Edit a text file by replacing an exact string inside the sandbox workspace.",
  riskLevel: "MEDIUM",
  inputSchema: EditFileInputSchema,
  async execute(input, context) {
    const filePath = normalizeRelativePath(input.path);
    if (/(^|\/)package\.json$/i.test(filePath.replace(/\\/g, "/"))) {
      if (input.replace.trim().startsWith("{")) {
        assertPlaywrightManifestWrite(filePath, input.replace);
      }
      const field = /["'](?:@playwright\/test|playwright(?:-core)?)["']\s*:\s*["']([^"']+)["']/g;
      for (const match of input.replace.matchAll(field)) {
        const spec = match[1] ?? "";
        if (spec && spec !== PLATFORM_PLAYWRIGHT_VERSION && spec !== `=${PLATFORM_PLAYWRIGHT_VERSION}`) {
          assertPlaywrightManifestWrite(
            filePath,
            JSON.stringify({ devDependencies: { playwright: spec } })
          );
        }
      }
    }
    const searchBase64 = Buffer.from(input.search, "utf8").toString("base64");
    const replaceBase64 = Buffer.from(input.replace, "utf8").toString("base64");
    const script = [
      "const fs = require('node:fs');",
      "const file = process.argv[1];",
      "const search = Buffer.from(process.argv[2], 'base64').toString('utf8');",
      "const replace = Buffer.from(process.argv[3], 'base64').toString('utf8');",
      "const content = fs.readFileSync(file, 'utf8');",
      "if (!content.includes(search)) { console.error('Search text not found'); process.exit(2); }",
      "const replaceAll = process.argv[4] === 'true';",
      "const replacements = replaceAll ? content.split(search).length - 1 : 1;",
      "fs.writeFileSync(file, replaceAll ? content.split(search).join(replace) : content.replace(search, replace));",
      "console.log(String(replacements));"
    ].join(" ");
    const result = await context.sandbox.runCommand(
      context.workspacePath,
      {
        command: `node -e ${shellQuote(script)} ${shellQuote(filePath)} ${shellQuote(searchBase64)} ${shellQuote(replaceBase64)} ${shellQuote(String(input.replaceAll))}`,
        cwd: input.cwd ? normalizeRelativePath(input.cwd, "cwd") : undefined,
        timeoutMs: context.timeoutMs
      },
      context.signal
    );

    if (result.exitCode !== 0) {
      throw new ToolExecutionError(
        "COMMAND_ERROR",
        "Failed to edit file",
        commandFailureDetails(result.command, result.exitCode, result.stdout, result.stderr)
      );
    }

    return { path: filePath, replacements: Number(result.stdout.trim()) };
  }
};

const listDirectoryTool: ToolDefinition<
  z.infer<typeof PathInputSchema>,
  { path: string; entries: string[] }
> = {
  name: "list_directory",
  description: "List files and directories in the sandbox workspace.",
  riskLevel: "LOW",
  inputSchema: PathInputSchema,
  async execute(input, context) {
    const dirPath = normalizeRelativePath(input.path);
    const result = await context.sandbox.runCommand(
      context.workspacePath,
      {
        command: `find ${shellQuote(dirPath)} -maxdepth 2 -mindepth 1 -print | sort`,
        cwd: input.cwd ? normalizeRelativePath(input.cwd, "cwd") : undefined,
        timeoutMs: context.timeoutMs
      },
      context.signal
    );

    if (result.exitCode !== 0) {
      throw new ToolExecutionError(
        "COMMAND_ERROR",
        "Failed to list directory",
        commandFailureDetails(result.command, result.exitCode, result.stdout, result.stderr)
      );
    }

    return {
      path: dirPath,
      entries: result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    };
  }
};

const searchCodeTool: ToolDefinition<
  z.infer<typeof SearchCodeInputSchema>,
  { query: string; matches: string[] }
> = {
  name: "search_code",
  description: "Search code with a fixed string in the sandbox workspace.",
  riskLevel: "LOW",
  inputSchema: SearchCodeInputSchema,
  async execute(input, context) {
    const searchPath = normalizeRelativePath(input.path);
    const result = await context.sandbox.runCommand(
      context.workspacePath,
      {
        command: `grep -RInF --exclude-dir=node_modules --exclude-dir=.git -- ${shellQuote(input.query)} ${shellQuote(searchPath)}`,
        cwd: input.cwd ? normalizeRelativePath(input.cwd, "cwd") : undefined,
        timeoutMs: context.timeoutMs
      },
      context.signal
    );

    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new ToolExecutionError(
        "COMMAND_ERROR",
        "Search command failed",
        commandFailureDetails(result.command, result.exitCode, result.stdout, result.stderr)
      );
    }

    return {
      query: input.query,
      matches: result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    };
  }
};
