# @smplkit/browser

Read [Smpl Flags](https://smplkit.com) feature flags and [Smpl Config](https://smplkit.com) configuration in the browser, with a publishable key.

- **Browser-first.** Native `EventSource` live updates, `localStorage` bootstrap for a 0ms first paint, automatic pause in background tabs and while offline. Also runs under Node 18+ for SSR and edge workers.
- **Zero runtime dependencies.** This code runs in your users' browsers; every dependency there is supply-chain surface. The one third-party piece — the JSON Logic rule evaluator — is vendored, reduced to the operators flags actually use, and conformance-tested against the reference implementation.
- **Read-only by construction.** The client only accepts publishable `sk_public_` keys and has no create/update/delete surface. A private `sk_api_` key is rejected at construction.
- **Small.** Core ≤ 12 KB gzipped; React bindings ≤ 3 KB more. Enforced in CI.

## Install

```bash
npm install @smplkit/browser
```

## Quickstart

Create a **public key** in the smplkit console (API Keys → Create Public Key). Public keys are scoped to exactly one environment and can only read flags and configuration — they are safe to embed in your site.

```ts
import { SmplClient, Context } from "@smplkit/browser";

const smpl = new SmplClient({ apiKey: "sk_public_..." });
await smpl.waitUntilReady();

// Identify the user for targeting rules.
smpl.setContext([new Context("user", "u_1", { plan: "pro" })]);

if (smpl.flags.booleanFlag("dark-mode", false).get()) {
  document.body.classList.add("dark");
}

const settings = await smpl.config.subscribe("web-app");
console.log(settings["api_timeout"]);

smpl.flags.onChange((event) => {
  console.log(`flag ${event.id} changed (${event.source})`);
});
```

The runtime surface mirrors the server [`@smplkit/sdk`](https://www.npmjs.com/package/@smplkit/sdk): `booleanFlag` / `stringFlag` / `numberFlag` / `jsonFlag` handles with `.get()`, `config.subscribe` / `config.getValue`, `setContext`, `waitUntilReady`, `close`. Two browser adaptations: handle factories are synchronous (evaluation runs against the local cache — `await`-ing them still works, so server-SDK snippets port unchanged), and there is no environment option anywhere — the environment is baked into the key.

## React

```tsx
import { SmplProvider, useBooleanFlag, useConfig, useSmplReady } from "@smplkit/browser/react";

function App() {
  return (
    <SmplProvider options={{ apiKey: "sk_public_..." }}>
      <Page />
    </SmplProvider>
  );
}

function Page() {
  const ready = useSmplReady();
  const darkMode = useBooleanFlag("dark-mode", false);
  const settings = useConfig("web-app");
  if (!ready) return <Skeleton />;
  return <main className={darkMode ? "dark" : ""}>timeout: {String(settings.timeout)}</main>;
}
```

Hooks: `useBooleanFlag`, `useStringFlag`, `useNumberFlag`, `useJsonFlag`, `useConfig`, `useSmpl` (the client, e.g. for `setContext` on login), `useSmplReady`. All are built on `useSyncExternalStore`, so tearing and SSR hydration behave correctly. React ≥ 18 is an optional peer dependency — non-React consumers install nothing extra.

## Live updates

Streaming is the default: the client holds a Server-Sent Events connection and re-fetches definitions (with a small random delay, past any CDN cache) whenever a change event arrives. Polling is an automatic safety net — slow (15 min) while the stream is healthy, tighter (60s) while it is down, paused entirely in hidden tabs and while offline, and directed by the server when the stream endpoint asks clients to back off. Set `streaming: false` if your network mangles long-lived connections; the client then just polls.

## SSR / server-rendered bootstrap

```ts
// server: fetch the two public endpoints and pass the JSON bodies down
const smpl = new SmplClient({
  apiKey: "sk_public_...",
  bootstrap: { flags: flagsJson, configs: configsJson },
});
```

`bootstrap: "localStorage"` (the default) caches the last payload per key; `bootstrap: "none"` opts out of storage entirely.

## What is public

Everything this SDK receives is **readable by your end users** — flag names and keys, targeting rule logic and values, config keys and values for the key's environment. The platform scrubs descriptions, sources, and timestamps from public-key reads, but rule logic itself necessarily ships to the browser (that is what makes local evaluation instant). Do not put secrets in flag values or config values that a public key can read, and do not encode sensitive business logic in targeting rules if its disclosure would hurt you. Server-side secrets belong behind the server SDKs with private keys.

## License

MIT. Vendored third-party code is listed in [NOTICE](./NOTICE).
