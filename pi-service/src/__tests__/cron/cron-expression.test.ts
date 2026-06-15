import { describe, expect, it } from "vitest";
import { CronExpression, CronExpressionError } from "../../cron/cron-expression.js";

describe("CronExpression", () => {
  it("computes the next matching minute in UTC", () => {
    const expression = new CronExpression("*/15 9-10 * * 1-5");
    expect(expression.nextAfter(new Date("2026-06-15T09:01:10Z")).toISOString()).toBe("2026-06-15T09:15:00.000Z");
    expect(expression.nextAfter(new Date("2026-06-15T10:45:00Z")).toISOString()).toBe("2026-06-16T09:00:00.000Z");
  });

  it("fails closed on malformed expressions", () => {
    expect(() => new CronExpression("* * *")).toThrow(CronExpressionError);
    expect(() => new CronExpression("61 * * * *")).toThrow(CronExpressionError);
    expect(() => new CronExpression("*/0 * * * *")).toThrow(CronExpressionError);
  });
});
