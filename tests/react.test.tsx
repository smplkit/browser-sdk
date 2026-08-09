/** React bindings — provider, hooks, live updates. @vitest-environment jsdom */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Context, SmplClient } from "../src/index.js";
import {
  SmplProvider,
  useBooleanFlag,
  useConfig,
  useJsonFlag,
  useNumberFlag,
  useSmpl,
  useSmplReady,
  useStringFlag,
} from "../src/react.js";
import { CONFIGS_BODY, FLAGS_BODY, scriptedFetch, testEnv } from "./_helpers.js";

const KEY = "sk_public_react";

function makeClient() {
  const { fn } = scriptedFetch([
    { match: "flags.", respond: () => ({ body: FLAGS_BODY, etag: 'W/"f1"' }) },
    { match: "config.", respond: () => ({ body: CONFIGS_BODY, etag: 'W/"c1"' }) },
  ]);
  const { env } = testEnv({ fetch: fn, streaming: false });
  return new SmplClient({ apiKey: KEY, bootstrap: "none", streaming: false, _env: env });
}

afterEach(() => {
  cleanup();
});

function Probe(): React.JSX.Element {
  const dark = useBooleanFlag("dark-mode", false);
  const label = useStringFlag("label", "default-label");
  const count = useNumberFlag("count", 3);
  const json = useJsonFlag("shape", { kind: "none" });
  const config = useConfig("web-app");
  const ready = useSmplReady();
  return (
    <div>
      <span data-testid="ready">{String(ready)}</span>
      <span data-testid="dark">{String(dark)}</span>
      <span data-testid="label">{label}</span>
      <span data-testid="count">{String(count)}</span>
      <span data-testid="json">{JSON.stringify(json)}</span>
      <span data-testid="timeout">{String(config.timeout ?? "unset")}</span>
    </div>
  );
}

describe("SmplProvider + hooks", () => {
  it("renders defaults before ready, live values after, and re-renders on context change", async () => {
    const client = makeClient();
    render(
      <SmplProvider client={client}>
        <Probe />
      </SmplProvider>,
    );
    expect(screen.getByTestId("ready").textContent).toBe("false");
    expect(screen.getByTestId("dark").textContent).toBe("false");
    expect(screen.getByTestId("timeout").textContent).toBe("unset");

    await act(async () => {
      await client.waitUntilReady();
    });
    expect(screen.getByTestId("ready").textContent).toBe("true");
    expect(screen.getByTestId("timeout").textContent).toBe("30");
    expect(screen.getByTestId("dark").textContent).toBe("false");

    await act(async () => {
      client.setContext([new Context("user", "u", { plan: "pro" })]);
    });
    expect(screen.getByTestId("dark").textContent).toBe("true");

    expect(screen.getByTestId("label").textContent).toBe("default-label");
    expect(screen.getByTestId("count").textContent).toBe("3");
    expect(screen.getByTestId("json").textContent).toBe('{"kind":"none"}');
    client.close();
  });

  it("constructs and owns a client from options, closing it on unmount", async () => {
    const { fn } = scriptedFetch([
      { match: "flags.", respond: () => ({ body: FLAGS_BODY }) },
      { match: "config.", respond: () => ({ body: CONFIGS_BODY }) },
    ]);
    const { env } = testEnv({ fetch: fn, streaming: false });
    let seen: SmplClient | null = null;
    function Grab(): null {
      seen = useSmpl();
      return null;
    }
    const view = render(
      <SmplProvider options={{ apiKey: KEY, bootstrap: "none", streaming: false, _env: env }}>
        <Grab />
      </SmplProvider>,
    );
    expect(seen).not.toBeNull();
    const client = seen! as SmplClient;
    view.unmount();
    expect(client.connectionStatus).toBe("disconnected");
  });

  it("throws without a provider and without client/options", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    function Bare(): null {
      useSmpl();
      return null;
    }
    expect(() => render(<Bare />)).toThrow(/within a <SmplProvider>/);
    expect(() => render(<SmplProvider />)).toThrow(/requires either a client or options/);
    spy.mockRestore();
  });
});
