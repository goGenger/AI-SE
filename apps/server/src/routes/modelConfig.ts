import { Router } from "express";
import { z } from "zod";
import { AppError, asyncHandler } from "../http/errors";
import { sendSuccess } from "../http/response";
import { ModelConfigService } from "../services/modelConfigService";

/**
 * 上限是防御性的：这里不做任何厂商格式校验（各家 key 形态不一），只挡住「把整个文件塞进来」。
 * 也刻意不设 `min(1)`：空串与 `null` 同义，都表示「清除运行时覆盖、回落到环境变量」，
 * 由下面的 `blankToNull` 归一 —— 表单清空输入框时发出来的正是空串。
 */
const ModelConfigPatchSchema = z
  .object({
    model: z.string().trim().max(200).nullish(),
    baseUrl: z.string().trim().max(500).nullish(),
    apiKey: z.string().trim().max(4096).nullish()
  })
  .strict();

const blankToNull = (value: string | null | undefined): string | null | undefined =>
  value === undefined ? undefined : value === null || value === "" ? null : value;

export function createModelConfigRouter(
  service: Pick<ModelConfigService, "status" | "update">
): Router {
  const router = Router();

  router.get("/model-config", (_req, res) => sendSuccess(res, service.status()));

  router.put(
    "/model-config",
    asyncHandler(async (req, res) => {
      const parsed = ModelConfigPatchSchema.safeParse(req.body);
      if (!parsed.success) {
        // 刻意**不**带 `parsed.error.flatten()`：这个请求体里可能有明文密钥，
        // 校验明细会把它带回响应与错误日志（AGENTS.md §10）。这里只回一句「不合法」。
        throw new AppError(400, "VALIDATION_ERROR", "Model config input is invalid");
      }

      const { model, baseUrl, apiKey } = parsed.data;
      sendSuccess(
        res,
        service.update({
          ...(model !== undefined ? { model: blankToNull(model) } : {}),
          ...(baseUrl !== undefined ? { baseUrl: blankToNull(baseUrl) } : {}),
          ...(apiKey !== undefined ? { apiKey: blankToNull(apiKey) } : {})
        })
      );
    })
  );

  return router;
}
