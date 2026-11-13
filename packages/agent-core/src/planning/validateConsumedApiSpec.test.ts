import { BACKEND_NODE_PROFILE, FRONTEND_VUE_PROFILE } from "@ai-se/shared";
import { describe, expect, it } from "vitest";
import {
  INVENTED_API_ENDPOINT_ERROR_PREFIX,
  normalizeApiPathForGrounding,
  validateConsumedApiSpec
} from "./validateConsumedApiSpec";

const listTodos = {
  method: "GET" as const,
  path: "/api/todos",
  description: "List Todo items.",
  request: {},
  response: { todos: "Todo[]" },
  errors: []
};

const updateTodo = {
  method: "PATCH" as const,
  path: "/api/todos/:id",
  description: "Update a Todo item.",
  request: { title: "string" },
  response: { id: "uuid" },
  errors: ["TODO_NOT_FOUND"]
};

describe("validateConsumedApiSpec (docs/269)", () => {
  it("does not constrain backend-node generate-API plans", () => {
    expect(
      validateConsumedApiSpec({
        profile: BACKEND_NODE_PROFILE,
        apiSpec: { endpoints: [listTodos] },
        requirement: {
          title: "Todo",
          description: "Planning sample",
          rawContent: "创建一个 Todo 管理系统。"
        }
      })
    ).toEqual([]);
  });

  it("accepts endpoints grounded in a TRD encapsulation example", () => {
    expect(
      validateConsumedApiSpec({
        profile: FRONTEND_VUE_PROFILE,
        apiSpec: {
          endpoints: [listTodos, updateTodo],
          encapsulation: [
            {
              source: "GET /api/todos",
              client: "src/api/todo.ts#listTodos",
              pages: ["Todo List"],
              notes: "Follow the TRD wrapper example."
            }
          ]
        },
        providedTechnicalDocs: [
          {
            fileName: "trd.md",
            text: [
              "Frontend encapsulation example:",
              "export function listTodos() { return request.get('/api/todos'); }",
              "export function updateTodo(id, body) { return request.patch(`/api/todos/${id}`, body); }",
              "The update contract is PATCH /api/todos/{id}."
            ].join("\n")
          }
        ],
        requirement: {
          title: "Todo 管理系统",
          description: "Planning sample",
          rawContent: "创建一个简单的 Todo 管理系统。"
        }
      })
    ).toEqual([]);
  });

  it("rejects invented backend endpoints that are not in the TRD or PRD", () => {
    expect(
      validateConsumedApiSpec({
        profile: FRONTEND_VUE_PROFILE,
        apiSpec: { endpoints: [listTodos] },
        requirement: {
          title: "Todo 管理系统",
          description: "Planning sample",
          rawContent: "创建一个简单的 Todo 管理系统，支持用户创建、查看、修改和删除 Todo。"
        }
      })
    ).toEqual([`${INVENTED_API_ENDPOINT_ERROR_PREFIX} GET /api/todos`]);
  });

  it("allows an empty endpoint list when no API contract is provided, including an explicit gap", () => {
    expect(
      validateConsumedApiSpec({
        profile: FRONTEND_VUE_PROFILE,
        apiSpec: {
          endpoints: [],
          apiContractGaps: [{ topic: "Todo API", note: "No API contract was provided." }]
        },
        requirement: {
          title: "Todo 管理系统",
          description: "Planning sample",
          rawContent: "创建一个简单的 Todo 管理系统。"
        }
      })
    ).toEqual([]);

    expect(
      validateConsumedApiSpec({
        profile: FRONTEND_VUE_PROFILE,
        apiSpec: { endpoints: [] }
      })
    ).toEqual([]);
  });

  it("normalizes path parameter syntax when grounding endpoints", () => {
    expect(normalizeApiPathForGrounding("/api/todos/{id}/")).toBe("/api/todos/:param");
    expect(normalizeApiPathForGrounding("/api/todos/:todoId")).toBe("/api/todos/:param");
  });
});
