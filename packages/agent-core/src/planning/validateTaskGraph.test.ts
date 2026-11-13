import { describe, expect, it } from "vitest";
import { TaskPlan } from "@ai-se/shared";
import { validateTaskGraph } from "./validateTaskGraph";

function plan(tasks: TaskPlan["tasks"]): TaskPlan {
  return {
    summary: "test plan",
    tasks
  };
}

function task(id: string, dependencies: string[] = []): TaskPlan["tasks"][number] {
  return {
    id,
    title: id,
    description: `${id} description`,
    type: "DESIGN",
    priority: "MEDIUM",
    dependencies,
    estimatedComplexity: 1,
    acceptanceCriteria: [`${id} acceptance`],
    sourceSpecTypes: ["ARCHITECTURE"]
  };
}

describe("validateTaskGraph", () => {
  it("accepts a simple DAG", () => {
    const result = validateTaskGraph(plan([task("A"), task("B", ["A"])]));

    expect(result.valid).toBe(true);
    expect(result.roots).toEqual(["A"]);
    expect(result.leaves).toEqual(["B"]);
  });

  it("accepts branching dependencies", () => {
    const result = validateTaskGraph(plan([task("A"), task("B", ["A"]), task("C", ["A"])]));

    expect(result.valid).toBe(true);
    expect(result.edges).toHaveLength(2);
  });

  it("accepts merging dependencies", () => {
    const result = validateTaskGraph(plan([task("A"), task("B"), task("C", ["A", "B"])]));

    expect(result.valid).toBe(true);
    expect(result.roots.sort()).toEqual(["A", "B"]);
    expect(result.leaves).toEqual(["C"]);
  });

  it("rejects cycles", () => {
    const result = validateTaskGraph(plan([task("A", ["C"]), task("B", ["A"]), task("C", ["B"])]));

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Task DAG must contain at least one root task");
    expect(result.errors).toContain("Cycle detected in Task DAG");
  });

  it("rejects self dependency", () => {
    const result = validateTaskGraph(plan([task("A", ["A"])]));

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Task cannot depend on itself: A");
  });

  it("rejects missing dependency targets", () => {
    const result = validateTaskGraph(plan([task("A", ["B"])]));

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Dependency points to missing task: B -> A");
  });

  it("rejects duplicate dependencies", () => {
    const result = validateTaskGraph(plan([task("A"), task("B", ["A", "A"])]));

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Duplicate dependency: A->B");
  });

  it("rejects runtime-only task types (DEBUG / MONITOR / INCIDENT)", () => {
    for (const type of ["DEBUG", "MONITOR", "INCIDENT"] as const) {
      const result = validateTaskGraph(plan([{ ...task("A"), type }]));

      expect(result.valid).toBe(false);
      expect(result.errors.join("\n")).toContain(`runtime-only type ${type}`);
    }
  });

  it("rejects a DEPLOY task without a deployable delivery block", () => {
    const bare = validateTaskGraph(plan([{ ...task("A"), type: "DEPLOY" }]));
    expect(bare.valid).toBe(false);
    expect(bare.errors.join("\n")).toContain("deployable delivery block");

    const wrongAction = validateTaskGraph(
      plan([
        {
          ...task("A"),
          type: "DEPLOY",
          delivery: { action: "CI", ref: "main", workflowFile: "ci.yml" }
        }
      ])
    );
    expect(wrongAction.valid).toBe(false);
  });

  it("accepts a DEPLOY task with a delivery block", () => {
    const result = validateTaskGraph(
      plan([
        {
          ...task("A"),
          type: "DEPLOY",
          delivery: { action: "DEPLOY", environment: "staging" }
        }
      ])
    );

    expect(result.valid).toBe(true);
  });
  it("rejects delivery tasks when the project has no repository bound", () => {
    const deliveryTask = {
      ...task("CI"),
      type: "BUILD",
      delivery: { action: "CI", environment: "dev", ref: "main", workflowFile: "ci.yml" }
    } as TaskPlan["tasks"][number];

    const result = validateTaskGraph(plan([deliveryTask]), { deliveryConfigured: false });

    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("no Git repository bound");
  });

  it("accepts delivery tasks when a repository is bound", () => {
    const deliveryTask = {
      ...task("CI"),
      type: "BUILD",
      delivery: { action: "CI", environment: "dev", ref: "main", workflowFile: "ci.yml" }
    } as TaskPlan["tasks"][number];

    expect(validateTaskGraph(plan([deliveryTask]), { deliveryConfigured: true }).valid).toBe(true);
  });

  it("keeps the previous behavior when delivery capability is unknown", () => {
    const deliveryTask = {
      ...task("CI"),
      type: "BUILD",
      delivery: { action: "CI", environment: "dev", ref: "main", workflowFile: "ci.yml" }
    } as TaskPlan["tasks"][number];

    expect(validateTaskGraph(plan([deliveryTask])).valid).toBe(true);
  });
});
