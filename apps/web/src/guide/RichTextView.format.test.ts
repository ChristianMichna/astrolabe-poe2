import { describe, expect, it } from "vitest";
import { formatNumber } from "./RichTextView";

describe("formatNumber", () => {
  it("gives fewer digits to larger values", () => {
    expect(formatNumber(1149.87)).toBe("1,150");
    expect(formatNumber(99.99)).toBe("100");
    expect(formatNumber(61.44)).toBe("61.4");
    expect(formatNumber(0.3456)).toBe("0.35");
  });

  it("keeps the sign", () => {
    expect(formatNumber(-1234.5)).toBe("-1,235");
  });
});
