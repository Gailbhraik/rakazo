import { describe, expect, it, vi } from "vitest";
import { blockPinchZoom } from "./block-pinch-zoom";

describe("blockPinchZoom", () => {
  it("annule les trois gestes de zoom de WebKit, en écoute non passive", () => {
    const addEventListener = vi.fn();
    blockPinchZoom({ addEventListener } as unknown as Window);

    expect(addEventListener.mock.calls.map((call) => call[0])).toEqual([
      "gesturestart",
      "gesturechange",
      "gestureend",
    ]);
    // Sans `passive: false`, le navigateur ignore preventDefault et zoome quand même.
    for (const call of addEventListener.mock.calls) {
      expect(call[2]).toEqual({ passive: false });
    }

    const event = { preventDefault: vi.fn() };
    const handler = addEventListener.mock.calls[0]?.[1] as (value: unknown) => void;
    handler(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });
});
