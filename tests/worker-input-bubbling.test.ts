import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("worker input bubbling", () => {
  it("keeps native questions disabled", () => {
    const askQuestionTool = readFileSync("agent/tools/ask_question.ts", "utf8");

    expect(askQuestionTool).toMatch(/disableTool\(\)/);
  });

  it("ends the worker turn and routes the answer through its agent id", () => {
    const instructions = readFileSync("agent/instructions.md", "utf8");
    const browserSkill = readFileSync(
      "agent/subagents/worker/skills/browser-execution/SKILL.md",
      "utf8"
    );

    expect(instructions).toContain(
      "Ask the user directly in ordinary assistant text"
    );
    expect(instructions).toContain(
      "continue the returned `worker_agent_id` with the transient answer"
    );
    expect(instructions).toContain("returns a `Needs user input:` blocker");
    expect(instructions).toContain("`browser_auth_resume` with `bind`");
    expect(instructions).toContain(
      "Before starting any new authenticated browser task"
    );
    expect(instructions).toContain(
      "do not start another worker or describe it as an unidentified browser-profile lock"
    );
    expect(instructions).toContain(
      "Cancel it only when the user explicitly asks"
    );
    expect(browserSkill).toContain("`manage_auth_checkpoint` with `pause`");
    expect(browserSkill).toContain(
      "verify that the target view is operational, not merely visible"
    );
    expect(browserSkill).toContain(
      "An enabled submit control alone is not readiness"
    );
    expect(browserSkill).toContain("treat the interaction as a proven no-op");
    expect(browserSkill).toContain(
      "submit exactly once more only after readiness passes"
    );
    expect(browserSkill).toContain("End the turn immediately");
  });
});
