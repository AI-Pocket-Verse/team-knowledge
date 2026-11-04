import { describe, it, expect } from "vitest";
import { getAssistantName, setAssistantName } from "./assistantName";

describe("assistantName", () => {
  it("默认 AI；设置后返回新名；空值回退默认", () => {
    expect(getAssistantName()).toBe("AI");
    setAssistantName("小智");
    expect(getAssistantName()).toBe("小智");
    setAssistantName("  ");
    expect(getAssistantName()).toBe("AI");
    setAssistantName(undefined);
    expect(getAssistantName()).toBe("AI");
  });
});
