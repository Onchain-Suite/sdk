import { describe, it, expect, beforeAll } from "vitest";

/**
 * The IIFE/browser entry (bundled to dist/inapp.js) must, on load: expose the
 * class + factory globally for no-bundler pages, make socket.io self-contained
 * (globalThis.io), and — when the loader tag carries a publishable key — build a
 * ready `window.onchainsuite`. jsdom stands in for the browser; the loader tag is
 * found via the `data-onchainsuite` marker (document.currentScript is null here).
 */
describe("browser IIFE entry", () => {
  beforeAll(async () => {
    const s = document.createElement("script");
    s.setAttribute("data-onchainsuite", "");
    s.dataset.key = "pk_test_browser";
    s.dataset.api = "https://api.example.test";
    document.body.appendChild(s);
    await import("./browser"); // runs the entry's side effects once
  });

  it("exposes the class + factory on the global", () => {
    const g = globalThis as any;
    expect(typeof g.OnchainSuite).toBe("function");
    expect(typeof g.createClient).toBe("function");
  });

  it("bundles socket.io (globalThis.io) so no separate <script> is needed", () => {
    expect((globalThis as any).io).toBeTruthy();
  });

  it("auto-inits window.onchainsuite from the loader tag's data-key", () => {
    const g = globalThis as any;
    expect(g.onchainsuite).toBeInstanceOf(g.OnchainSuite);
  });
});
