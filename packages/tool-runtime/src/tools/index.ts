import { ToolDefinition } from "../types";
import { createCommandTools } from "./commandTools";
import { createFileTools } from "./fileTools";
import { createGitTools } from "./gitTools";

export function createPhase1Tools(): ToolDefinition<unknown, unknown>[] {
  return [...createFileTools(), ...createGitTools(), ...createCommandTools()];
}
