// 预算回归：单轮上限按轮重置、并发轮次互不计数；总预算默认关闭且与请求日志隔离。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { budgetError, createLifetimeBudget, createTurnBudget, lifetimeBudgetEnabled, spendLifetimeRequest,
  spendModelRequest, spendToolStep } from "./request-budget.mjs";

const serverSource = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
const bridgeSource = readFileSync(new URL("./operation-bridge.mjs", import.meta.url), "utf8");

describe("单轮预算", () => {
    test("达到上限后拒绝并把原因说清楚；同一轮内计数累加", () => {
        const budget = createTurnBudget({ maxRequests: 2 });
        expect(spendModelRequest(budget)).toEqual({ allowed: true });
        expect(spendModelRequest(budget)).toEqual({ allowed: true });
        const denied = spendModelRequest(budget);
        expect(denied.allowed).toBe(false);
        expect(denied.reason).toBe("turn_request_budget_exhausted");
        expect(denied.message).toContain("2");
        expect(budget.requests).toBe(2);
    });

    test("新一轮从零开始：上一轮耗尽不影响下一轮", () => {
        const first = createTurnBudget({ maxRequests: 1 });
        spendModelRequest(first);
        expect(spendModelRequest(first).allowed).toBe(false);
        const second = createTurnBudget({ maxRequests: 1 });
        expect(spendModelRequest(second)).toEqual({ allowed: true });
    });

    test("两张画布的并发轮次各用自己的预算，不互相计数", () => {
        const canvasA = createTurnBudget({ maxRequests: 1 });
        const canvasB = createTurnBudget({ maxRequests: 1 });
        expect(spendModelRequest(canvasA).allowed).toBe(true);
        expect(spendModelRequest(canvasB).allowed).toBe(true);
        expect(canvasA.requests).toBe(1);
        expect(canvasB.requests).toBe(1);
    });

    test("工具步骤是独立的一条线，并且可以直接丢给上层当错误", () => {
        const budget = createTurnBudget({ maxToolSteps: 1 });
        expect(spendToolStep(budget).allowed).toBe(true);
        const denied = spendToolStep(budget);
        expect(denied.reason).toBe("turn_tool_step_budget_exhausted");
        const error = budgetError(denied);
        expect(error.reason).toBe("turn_tool_step_budget_exhausted");
        expect(error.message).toContain("下一轮");
    });

    test("max 为 0 或缺失时不限制，而不是立刻拒绝", () => {
        const budget = createTurnBudget({});
        for (let index = 0; index < 5; index += 1) expect(spendModelRequest(budget).allowed).toBe(true);
        expect(spendToolStep(undefined).allowed).toBe(true);
    });
});

describe("总预算", () => {
    test("默认关闭：没有显式 limit 时永远允许", () => {
        const budget = createLifetimeBudget({ used: 999 });
        expect(lifetimeBudgetEnabled(budget)).toBe(false);
        expect(spendLifetimeRequest(budget).allowed).toBe(true);
    });

    test("显式启用后按独立计数拒绝，并说明这是总预算", () => {
        const budget = createLifetimeBudget({ limit: 2, used: 1 });
        expect(spendLifetimeRequest(budget).allowed).toBe(true);
        const denied = spendLifetimeRequest(budget);
        expect(denied.reason).toBe("request_budget_exhausted");
        expect(denied.message).toContain("总预算");
        expect(budget.used).toBe(2);
    });
});

describe("server 接线", () => {
    test("ops 调用带宿主凭据与当前回合，不再用 owner 凭据自报身份", () => {
        expect(bridgeSource).toContain("'X-Beeftv-Agent-Token': hostToken");
        expect(bridgeSource).toContain("'X-Beeftv-Agent-Turn': turnId");
        expect(serverSource).not.toContain("X-Beeftv-Owner");
        expect(bridgeSource).not.toContain("X-Beeftv-Owner");
    });

    test("预算按轮构造并跑在独立的异步上下文里", () => {
        expect(serverSource).toContain("turnBudgetContext.run(entry.budget");
        expect(serverSource).toContain("createDurableTurnBudget(entry,{maxRequests:MAX_REQUESTS_PER_TURN");
        expect(serverSource).not.toContain("MAX_MODEL_REQUESTS");
        expect(serverSource).not.toContain("readFileSync(ledgerPath");
    });

    test("模型能力描述里不再有 operationId，幂等键只由宿主生成", () => {
        expect(bridgeSource).toContain("delete clone.properties.operationId");
        expect(bridgeSource).toContain("name !== 'canvasId' && name !== 'operationId'");
    });

    test("Chat 信封里的引用进入模型上下文", () => {
        // Durable 路径把整封 Chat 信封交给 turnContextPrefix：选中对象与引用都在其中。
        expect(serverSource).toContain("turnContextPrefix(body)");
    });
});
