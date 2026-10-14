import type { MockEvent, MockResult, UiError } from "../lib/contracts";

export interface MockStep {
  id: string;
  label: string;
}
export interface MockFragment {
  index: number;
  kind: string;
  content: string;
}
export interface MockRun {
  key: string;
  /** Durable conversation id (`mock_*`), once the backend has opened it. */
  conversationId: string | null;
  prompt: string;
  startedAtMs: number;
  finishedAtMs: number | null;
  status: "running" | "done" | "failed";
  steps: MockStep[];
  stream: MockFragment[];
  result: MockResult | null;
  error: UiError | null;
}

export type MockAction =
  | { type: "start"; key: string; prompt: string; now: number }
  | { type: "events"; key: string; events: MockEvent[] }
  | { type: "hydrate"; runs: MockRun[] }
  | { type: "done"; key: string; result: MockResult; now: number }
  | { type: "fail"; key: string; error: UiError; now: number };

export function mockReducer(state: MockRun[], action: MockAction): MockRun[] {
  switch (action.type) {
    case "start":
      return [
        {
          key: action.key,
          conversationId: null,
          prompt: action.prompt,
          startedAtMs: action.now,
          finishedAtMs: null,
          status: "running",
          steps: [],
          stream: [],
          result: null,
          error: null,
        },
        ...state,
      ];
    case "hydrate": {
      const known = new Set(state.map((r) => r.conversationId).filter(Boolean));
      return [...state, ...action.runs.filter((r) => !known.has(r.conversationId))];
    }
    case "events":
      return state.map((r) => {
        if (r.key !== action.key) return r;
        const steps = [...r.steps];
        const stream = [...r.stream];
        let conversationId = r.conversationId;
        for (const e of action.events) {
          if (e.type === "conversation") conversationId = e.conversationId;
          if (e.type === "step") steps.push({ id: e.id, label: e.label });
          else if (e.type === "stream")
            stream.push({ index: e.index, kind: e.kind, content: e.content });
        }
        return { ...r, steps, stream, conversationId };
      });
    case "done":
      return state.map((r) =>
        r.key === action.key
          ? {
              ...r,
              status: "done",
              result: action.result,
              conversationId: action.result.conversationId,
              finishedAtMs: action.now,
            }
          : r,
      );
    case "fail":
      return state.map((r) =>
        r.key === action.key
          ? { ...r, status: "failed", error: action.error, finishedAtMs: action.now }
          : r,
      );
  }
}

/** Concatenated assistant text from streamed fragments, in wire order. */
export function streamedText(run: MockRun): string {
  return run.stream
    .filter((f) => f.kind === "text")
    .sort((a, b) => a.index - b.index)
    .map((f) => f.content)
    .join("");
}
