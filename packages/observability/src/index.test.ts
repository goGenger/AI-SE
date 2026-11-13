import { describe, expect, it } from "vitest";
import { sanitizeLogData } from "./index";

describe("sanitizeLogData", () => {
  it("redacts nested sensitive fields", () => {
    expect(
      sanitizeLogData({
        requestId: "req-1",
        nested: {
          cookie: "session=secret",
          token: "secret-token",
          password: "secret-password"
        }
      })
    ).toEqual({
      requestId: "req-1",
      nested: {
        cookie: "[REDACTED]",
        token: "[REDACTED]",
        password: "[REDACTED]"
      }
    });
  });

  it("redacts sensitive values inside strings", () => {
    expect(sanitizeLogData("token = abc password: def cookie=session")).toBe(
      "token= [REDACTED] password: [REDACTED] cookie= [REDACTED]"
    );
  });

  it("redacts credential-shaped substrings (D-3/T8-c)", () => {
    const output = sanitizeLogData(
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJyZWR0ZWFtIn0.fake-signature key sk-test-redteam-0123456789abcdef header Bearer abcdefgh12345678"
    );
    expect(output).not.toContain("eyJhbGci");
    expect(output).not.toContain("sk-test-redteam");
    expect(output).not.toContain("abcdefgh12345678");
    expect(output).toContain("[REDACTED]");
  });

  /**
   * N-65（`docs/232` §10）：**`sk-` 形态不能吃掉散文标识符**。
   *
   * 原实现 `sk-[A-Za-z0-9_-]{8,}` 把 `ta` + `sk-title-input` 当成 OpenAI 密钥，
   * 于是 PRD 里的 testid 名字在每一条回到模型面前的工具结果里都变成 `ta[REDACTED]`——
   * 「testid 自创」连续三轮的真因。
   */
  describe("N-65：kebab 标识符不算凭证", () => {
    it("PRD 里以 `task-` 开头的 testid 原样保留", () => {
      for (const id of [
        "task-title-input",
        "task-done-toggle",
        "task-delete-button",
        "task-item",
        "task-count"
      ]) {
        expect(sanitizeLogData(`| \`${id}\` | 用途 |`)).toContain(id);
      }
    });

    it("真实密钥形态仍被打码（单段无连字符 / 含数字 / 含大写）", () => {
      const output = sanitizeLogData(
        "a sk-test-redteam-0123456789abcdef b sk-proj-ABCDEFGHIJKLMNOP c sk-abcdefghijklmnop"
      );
      expect(output).not.toContain("sk-test-redteam");
      expect(output).not.toContain("sk-proj-ABCDEFGHIJKLMNOP");
      // 单段、无连字符 ⇒ 不是 kebab 词组 ⇒ 仍按凭证打码（`traceService` 的既有断言）。
      expect(output).not.toContain("sk-abcdefghijklmnop");
    });

    it("kebab 词组才放行——`sk-title-input-0123456789` 这种带数字的仍打码", () => {
      expect(sanitizeLogData("data-testid=\"sk-title-input-0123456789\"")).toContain("[REDACTED]");
    });
  });

  it("preserves Error message and stack (non-enumerable fields)", () => {
    const err = new Error("slice planning exploded");
    (err as Error & { code?: string }).code = "PLAN_FAIL";
    const output = sanitizeLogData({ error: err }) as {
      error: { type: string; message: string; stack?: string; code?: string };
    };
    expect(output.error.type).toBe("Error");
    expect(output.error.message).toBe("slice planning exploded");
    expect(output.error.code).toBe("PLAN_FAIL");
    expect(output.error.stack).toContain("slice planning exploded");
  });

  it("redacts secrets inside Error message/stack and nested cause", () => {
    const cause = new Error("upstream token = super-secret-value");
    const err = new Error("Bearer abcdefgh12345678 failed");
    (err as Error & { cause?: unknown }).cause = cause;
    const output = sanitizeLogData(err) as {
      message: string;
      cause: { message: string };
    };
    expect(output.message).toContain("[REDACTED]");
    expect(output.message).not.toContain("abcdefgh12345678");
    expect(output.cause.message).toContain("[REDACTED]");
    expect(output.cause.message).not.toContain("super-secret-value");
  });
});
