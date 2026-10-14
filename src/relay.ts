import { Context, Effect, Layer } from "effect";
import { appError, type FirstmateError } from "./domain.js";
import type { RelayConfig } from "./ledger.js";

type Op<A> = Effect.Effect<A, FirstmateError>;

/** A mention as the relay delivers it; every field is untrusted public input. */
export interface RelayMention {
  readonly requestId: string;
  readonly text: string;
  readonly author: string | null;
  readonly url: string | null;
  readonly at: string | null;
}

/**
 * The Relay adapter: every call the Relay connector makes. The HTTP
 * implementation speaks to the configured endpoint; tests and other relays
 * provide their own layer.
 */
export interface RelayShape {
  /** Mentions after the cursor, and the cursor to poll from next. */
  mentions(config: RelayConfig, cursor: string | null): Op<{ mentions: readonly RelayMention[]; cursor: string | null }>;
  /** Posts a reply under the idempotency key; the relay returns the same reply for a repeated key. */
  reply(config: RelayConfig, request: { requestId: string; text: string; final: boolean; key: string }): Op<{ id: string; url: string | null }>;
  /** Drops a request at the relay so it is not offered again. */
  dismiss(config: RelayConfig, requestId: string): Op<void>;
}

export class Relay extends Context.Service<Relay, RelayShape>()("firstmate/Relay") {
  static layer(relay?: RelayShape) { return Layer.succeed(Relay, relay ?? httpRelay()); }
}

const text = (value: unknown) => typeof value === "string" ? value : null;

/**
 * The HTTP relay: `GET <endpoint>/mentions?after=<cursor>` returns
 * `{ mentions: [{ request_id, text, author, url, at }], cursor }`,
 * `POST <endpoint>/replies` takes `{ request_id, text, final }` with an
 * `Idempotency-Key` header and returns `{ id, url }`, and
 * `POST <endpoint>/dismiss` takes `{ request_id }`. The bearer token is read
 * from the configured environment variable at each call.
 */
export function httpRelay(): RelayShape {
  const call = (config: RelayConfig, method: "GET" | "POST", path: string, body?: unknown, key?: string) => Effect.tryPromise({
    try: async () => {
      const headers: Record<string, string> = { accept: "application/json" };
      if (config.tokenEnv) {
        const token = process.env[config.tokenEnv];
        if (!token) throw new Error(`Relay token variable ${config.tokenEnv} is not set`);
        headers.authorization = `Bearer ${token}`;
      }
      if (body !== undefined) headers["content-type"] = "application/json";
      if (key) headers["idempotency-key"] = key;
      const response = await fetch(`${config.endpoint.replace(/\/+$/, "")}${path}`, {
        method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000),
      });
      const raw = await response.text();
      if (!response.ok) throw new Error(`Relay ${method} ${path.split("?")[0]} answered ${response.status}: ${raw.slice(0, 200)}`);
      return raw ? JSON.parse(raw) : null;
    },
    catch: appError,
  });
  return {
    mentions: (config, cursor) => call(config, "GET", `/mentions${cursor ? `?after=${encodeURIComponent(cursor)}` : ""}`).pipe(Effect.map(body => ({
      mentions: (Array.isArray(body?.mentions) ? body.mentions : []).flatMap((m: any) => typeof m?.request_id === "string" && typeof m?.text === "string"
        ? [{ requestId: m.request_id, text: m.text, author: text(m.author), url: text(m.url), at: text(m.at) }] : []),
      cursor: text(body?.cursor) ?? cursor,
    }))),
    reply: (config, { requestId, text: reply, final, key }) => call(config, "POST", "/replies", { request_id: requestId, text: reply, final }, key).pipe(Effect.flatMap(body =>
      typeof body?.id === "string" ? Effect.succeed({ id: body.id as string, url: text(body.url) }) : Effect.fail(appError(new Error("The relay returned no reply id"))))),
    dismiss: (config, requestId) => Effect.asVoid(call(config, "POST", "/dismiss", { request_id: requestId })),
  };
}
