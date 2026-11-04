import { describe, expect, it } from "vitest";
import { durationBetween, parseUtc, relativeTime, shortId } from "../lib/format";
import { taskStatusView } from "../lib/status";
import { mockReducer, streamedText } from "../state/mockRuns";

describe("format", () => {
  it("parses the Controller's 7-digit fractional timestamps", () => {
    expect(parseUtc("2026-09-25T14:37:14.0867405Z")).not.toBeNull();
    expect(parseUtc("garbage")).toBeNull();
    expect(parseUtc(null)).toBeNull();
  });
  it("relative time derives only from real values", () => {
    const now = Date.parse("2026-01-01T01:00:00Z");
    expect(relativeTime("2026-01-01T00:00:00Z", now)).toBe("1h ago");
    expect(relativeTime(null, now)).toBe("—");
  });
  it("duration is null when undeterminable", () => {
    expect(durationBetween("2026-01-01T00:00:00Z", null)).toBeNull();
    expect(durationBetween("2026-01-01T00:00:00Z", "2026-01-01T00:01:05Z")).toBe("1m 5s");
  });
  it("short ids and statuses", () => {
    expect(shortId("task_0123456789abcdef0123456789abcdef", 8)).toBe("task_012…cdef");
    expect(taskStatusView("failed").tone).toBe("error");
    expect(taskStatusView("weird-state").label).toBe("Weird state");
  });
});

describe("mock reducer", () => {
  it("preserves wire order and assembles text", () => {
    let s = mockReducer([], { type: "start", key: "k", prompt: "p", now: 1 });
    s = mockReducer(s, {
      type: "events",
      key: "k",
      events: [
        { type: "stream", index: 0, kind: "text", content: "A" },
        { type: "step", id: "x", label: "X" },
        { type: "stream", index: 1, kind: "text", content: "B" },
      ],
    });
    expect(streamedText(s[0]!)).toBe("AB");
    expect(s[0]!.steps).toHaveLength(1);
    s = mockReducer(s, { type: "fail", key: "k", error: { code: "c", message: "m" }, now: 2 });
    expect(s[0]!.status).toBe("failed");
  });
});
