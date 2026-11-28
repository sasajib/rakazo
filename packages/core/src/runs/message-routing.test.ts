import { describe, expect, it } from "vitest";
import type { RouteTask } from "./message-routing.js";
import {
  certainRoute,
  chatTasksInstruction,
  decideMessageRoute,
  parseRouteJudgeAnswer,
  repliedTask,
  routingJudgeInput,
  taskTitle,
} from "./message-routing.js";

const at = (minute: number) => new Date(Date.UTC(2026, 10, 28, 8, minute));
const working: RouteTask = {
  runId: "run-a",
  taskId: "task-a",
  state: "working",
  title: "Write the blog post",
  request: "Write the blog post about the Q1 launch",
  progress: "Drafting section 2",
  messageIds: ["m-a1"],
  steerable: true,
  createdAt: at(0),
};
const waiting: RouteTask = {
  runId: "run-b",
  taskId: "task-b",
  state: "waiting_question",
  title: "Book dinner",
  request: "Book dinner on Friday",
  question: {
    messageId: "q-b",
    text: "Which one: Izumi or Spitfire?",
    options: ["Izumi", "Spitfire"],
  },
  steerable: true,
  createdAt: at(5),
};
const judged = (over: Partial<ReturnType<typeof parseRouteJudgeAnswer> & object>) => ({
  intent: "addition" as const,
  task: "T1",
  confidence: 0.9,
  addsRequirement: false,
  overrideKind: "redirect" as const,
  reason: "r",
  ...over,
});

describe("message routing (fork 1.42)", () => {
  it("answers a reply to the open question's card without the model", () => {
    expect(
      certainRoute({ text: "the first", replyToMessageId: "q-b", tasks: [working, waiting] }),
    ).toMatchObject({ intent: "answer", targetRunId: "run-b", basis: "reply_to_question" });
  });

  it("answers an option typed back, ignoring case and punctuation", () => {
    expect(certainRoute({ text: " izumi! ", tasks: [working, waiting] })).toMatchObject({
      intent: "answer",
      targetRunId: "run-b",
      basis: "question_option",
    });
  });

  it("leaves every other message to the judge (no keyword routing)", () => {
    for (const text of ["stop, do X instead", "forget that", "never mind", "use the other logo"])
      expect(certainRoute({ text, tasks: [working, waiting] })).toBeUndefined();
  });

  it("a reply to a task's message pins that task", () => {
    expect(repliedTask([working, waiting], "m-a1")?.runId).toBe("run-a");
    expect(repliedTask([working, waiting], "other")).toBeUndefined();
  });

  it.each([
    ["timeout", "judge_timeout"],
    ["error", "judge_error"],
    ["off", "judge_off"],
    ["invalid", "judge_invalid"],
  ] as const)("judge %s = addition to the most recent task", (failure, basis) => {
    expect(decideMessageRoute({ tasks: [working, waiting], judged: failure })).toMatchObject({
      intent: "addition",
      targetRunId: "run-b",
      basis,
    });
  });

  it("low confidence is an addition, never an override", () => {
    expect(
      decideMessageRoute({
        tasks: [working],
        judged: judged({ intent: "override", overrideKind: "replace", confidence: 0.65 }),
      }),
    ).toMatchObject({ intent: "addition", basis: "judge_low_confidence" });
  });

  it("an override stops the task only when it is a sure replace", () => {
    const decide = (overrideKind: "redirect" | "replace", confidence: number) =>
      decideMessageRoute({
        tasks: [working],
        judged: judged({ intent: "override", overrideKind, confidence }),
      });
    expect(decide("replace", 0.9)).toMatchObject({ intent: "override", action: "replace" });
    expect(decide("replace", 0.8)).toMatchObject({ intent: "override", action: "redirect" });
    expect(decide("redirect", 0.99)).toMatchObject({ intent: "override", action: "redirect" });
  });

  it("an answer needs an open question", () => {
    expect(
      decideMessageRoute({ tasks: [working], judged: judged({ intent: "answer" }) }),
    ).toMatchObject({ intent: "addition", basis: "judge_invalid" });
    expect(
      decideMessageRoute({
        tasks: [working, waiting],
        judged: judged({ intent: "answer", task: "T2" }),
      }),
    ).toMatchObject({ intent: "answer", targetRunId: "run-b" });
  });

  it("a new task has no target, unless the person replied to a task's message", () => {
    expect(
      decideMessageRoute({ tasks: [working], judged: judged({ intent: "new_task", task: null }) }),
    ).toMatchObject({ intent: "new_task", targetRunId: null });
    expect(
      decideMessageRoute({
        tasks: [working],
        pinnedRunId: "run-a",
        judged: judged({ intent: "new_task", task: null }),
      }),
    ).toMatchObject({ intent: "addition", targetRunId: "run-a" });
  });

  it("parses the judge's JSON inside a fence and clamps confidence", () => {
    expect(
      parseRouteJudgeAnswer(
        '```json\n{"intent":"Override","task":"t1","confidence":3,"override_kind":"replace","reason":"x"}\n```',
      ),
    ).toMatchObject({ intent: "override", task: "T1", confidence: 1, overrideKind: "replace" });
    expect(parseRouteJudgeAnswer("no json")).toBeUndefined();
    expect(parseRouteJudgeAnswer('{"intent":"maybe"}')).toBeUndefined();
  });

  it("gives the judge task keys, never run ids", () => {
    const input = JSON.parse(
      routingJudgeInput({ message: "hi", tasks: [waiting, working], recentTurns: [] }),
    );
    expect(input.tasks.map((task: { task: string }) => task.task)).toEqual(["T1", "T2"]);
    expect(JSON.stringify(input)).not.toContain("run-a");
    expect(input.tasks[1].open_question).toContain("Izumi");
  });

  it("names the run's task and the others only when there are others", () => {
    expect(chatTasksInstruction({ ownTitle: "A", others: [] })).toBeUndefined();
    expect(
      chatTasksInstruction({ ownTitle: "A", others: [{ title: "B", state: "working" }] }),
    ).toContain('this run serves the task "A"');
    expect(taskTitle("\n  first line\nsecond")).toBe("first line");
  });
});
