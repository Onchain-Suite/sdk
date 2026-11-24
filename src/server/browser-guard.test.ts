// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { OnchainSuiteServer } from "./index";

const fetch = async () => {
  throw new Error("not called");
};

describe("in a browser", () => {
  it("refuses a live secret key", () => {
    expect(() => new OnchainSuiteServer("sk_live_leaked", { fetch })).toThrow(
      /must never run in a browser/,
    );
  });

  it("still allows a test key (local demos)", () => {
    expect(() => new OnchainSuiteServer("sk_test_x", { fetch })).not.toThrow();
  });
});
