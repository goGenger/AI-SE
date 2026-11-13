import { describe, expect, it } from "vitest";
import { HarnessDeps, RunOptions, waitWorkflowTerminal } from "../harness";

/**
 * N-32（`docs/216`）：**harness 必须放行任务级审批，否则工作流停在 `WAITING_APPROVAL` 直到超时。**
 *
 * 实测（批次 `l1-m4s` run 2）：最终切片规划出生产部署，平台按 L1-9 红线要求人审；而 harness 此前
 * 只批准**规划**类审批 ⇒ 工作流一直停在 `WAITING_APPROVAL`，跑满 E1 的 `runTimeoutMs`（**2 小时**）
 * 才超时。此前批次从没走到最终切片，所以从未暴露；库里还留着 3 个更早的同形遗留（已清理）。
 *
 * 这里测的是**接线**：`waitWorkflowTerminal` 在 `WAITING_APPROVAL` 时必须真的去批准，并把次数
 * 计入 `interventions`（调用方累加到 `humanInterventions`）。只测一个纯函数不会发现它没被调用。
 */

const options: RunOptions = {
  runs: 1,
  replan: false,
  runTimeoutMs: 1000,
  pollIntervalMs: 1,
  oracleTimeoutMs: 1000
};

interface Scenario {
  /** 首轮读到的状态。 */
  initialStatus: string;
  /** 审批列表里的状态（没有审批时传 null）。 */
  approvalStatus: string | null;
  /** 第二轮读到的状态（缺省 = 停在 initialStatus）。 */
  statusAfterPoll?: string;
}

function scenario(spec: Scenario) {
  let workflowStatus = spec.initialStatus;
  let polls = 0;
  const approvalsRequested: string[] = [];
  const approved: string[] = [];

  const deps = {
    http: {
      get: async (path: string) => {
        if (path.endsWith("/approvals")) {
          approvalsRequested.push(path);
          return {
            success: true,
            data:
              spec.approvalStatus === null
                ? []
                : [{ id: "ap-1", status: spec.approvalStatus, reason: "Task requires human approval" }]
          };
        }
        polls += 1;
        if (polls > 1 && spec.statusAfterPoll !== undefined) workflowStatus = spec.statusAfterPoll;
        return {
          success: true,
          data: { workflow: { status: workflowStatus }, tasks: [], events: [] }
        };
      },
      post: async (path: string) => {
        approved.push(path);
        return { success: true, data: {} };
      },
      del: async () => undefined
    },
    log: () => undefined,
    sleep: async () => undefined
  } as unknown as HarnessDeps;

  return { deps, approvalsRequested, approved };
}

describe("waitWorkflowTerminal 任务级审批（N-32）", () => {
  it("停在 WAITING_APPROVAL 且有 PENDING 审批 ⇒ 批准、计入 1 次介入、随后读到终态", async () => {
    const { deps, approved } = scenario({
      initialStatus: "WAITING_APPROVAL",
      approvalStatus: "PENDING",
      statusAfterPoll: "SUCCESS"
    });

    const result = await waitWorkflowTerminal(deps, "wf-1", options);

    expect(result).toMatchObject({ status: "SUCCESS", interventions: 1 });
    expect(approved).toEqual(["/api/approvals/ap-1/approve"]);
  });

  it("审批已被别人批过（APPROVED）⇒ 不重复批准、不计入介入", async () => {
    const { deps, approved } = scenario({
      initialStatus: "WAITING_APPROVAL",
      approvalStatus: "APPROVED",
      statusAfterPoll: "SUCCESS"
    });

    const result = await waitWorkflowTerminal(deps, "wf-1", options);

    expect(result).toMatchObject({ status: "SUCCESS", interventions: 0 });
    expect(approved).toHaveLength(0);
  });

  it("根本没有审批记录 ⇒ 不凭空记一次人工介入", async () => {
    const { deps, approved } = scenario({
      initialStatus: "WAITING_APPROVAL",
      approvalStatus: null,
      statusAfterPoll: "FAILED"
    });

    const result = await waitWorkflowTerminal(deps, "wf-1", options);

    expect(result).toMatchObject({ status: "FAILED", interventions: 0 });
    expect(approved).toHaveLength(0);
  });

  it("不是 WAITING_APPROVAL ⇒ 完全不碰审批接口", async () => {
    const { deps, approvalsRequested, approved } = scenario({
      initialStatus: "SUCCESS",
      approvalStatus: "PENDING"
    });

    const result = await waitWorkflowTerminal(deps, "wf-1", options);

    expect(result).toMatchObject({ status: "SUCCESS", interventions: 0 });
    expect(approvalsRequested).toHaveLength(0);
    expect(approved).toHaveLength(0);
  });
});
