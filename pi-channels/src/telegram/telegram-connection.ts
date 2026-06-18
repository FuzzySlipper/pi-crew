/**
 * Telegram Bot API connection via HTTP long-polling.
 *
 * Implements {@link TelegramConnection} using the `getUpdates`
 * long-polling API.  No webhook endpoint required — suitable
 * for daemon processes behind NAT.
 *
 * Rate limiting: Telegram enforces a global 1 msg/second/chat
 * limit.  On 429 responses, the connection honours `retry_after`
 * before retrying.
 *
 * @module pi-channels/telegram/telegram-connection
 */

import type { Logger } from "@pi-crew/core";
import { ConnectionError, AuthenticationError } from "@pi-crew/core";
import type {
  TelegramConnection,
  TelegramConnectionEvents,
  TelegramProviderConfig,
  TelegramUpdate,
  TelegramApiResponse,
  TelegramSendMessageParams,
  TelegramEditMessageTextParams,
  TelegramDeleteMessageParams,
  TelegramSendChatActionParams,
  TelegramGetFileParams,
  TelegramMessage,
  TelegramFile,
} from "./telegram-types.js";

const TELEGRAM_API_BASE = "https://api.telegram.org";

/**
 * HTTP-based Telegram Bot API connection using long-polling.
 */
export class TelegramPollingConnection implements TelegramConnection {
  #token: string;
  #logger: Logger;
  #pollingIntervalMs: number;
  #connectionTimeoutMs: number;
  #maxUpdatesPerPoll: number;
  #offset = 0;
  #running = false;
  #pollTimer: ReturnType<typeof setTimeout> | null = null;
  #listeners = new Map<keyof TelegramConnectionEvents, Set<(...args: unknown[]) => void>>();

  constructor(
    token: string,
    logger: Logger,
    config?: Pick<TelegramProviderConfig, "pollingIntervalMs" | "connectionTimeoutMs" | "maxUpdatesPerPoll">,
  ) {
    this.#token = token;
    this.#logger = logger;
    this.#pollingIntervalMs = config?.pollingIntervalMs ?? 1000;
    this.#connectionTimeoutMs = config?.connectionTimeoutMs ?? 30_000;
    this.#maxUpdatesPerPoll = config?.maxUpdatesPerPoll ?? 100;
  }

  get isOpen(): boolean {
    return this.#running;
  }

  async open(): Promise<void> {
    if (this.#running) return; // idempotent

    // Validate token by calling getMe
    await this.#validateToken();

    this.#running = true;
    this.#emit("connected");
    this.#logger.info("Telegram polling connection opened");

    // Start the polling loop
    void this.#pollLoop();
  }

  async close(): Promise<void> {
    if (!this.#running) return;

    this.#running = false;

    if (this.#pollTimer !== null) {
      clearTimeout(this.#pollTimer);
      this.#pollTimer = null;
    }

    this.#emit("disconnected", "closed");
    this.#logger.info("Telegram polling connection closed");
  }

  async sendMessage(params: TelegramSendMessageParams): Promise<TelegramMessage> {
    return this.#apiCall<TelegramMessage>("sendMessage", params);
  }

  async editMessageText(params: TelegramEditMessageTextParams): Promise<TelegramMessage> {
    return this.#apiCall<TelegramMessage>("editMessageText", params);
  }

  async deleteMessage(params: TelegramDeleteMessageParams): Promise<boolean> {
    return this.#apiCall<boolean>("deleteMessage", params);
  }

  async sendChatAction(params: TelegramSendChatActionParams): Promise<boolean> {
    return this.#apiCall<boolean>("sendChatAction", params);
  }

  async getFile(params: TelegramGetFileParams): Promise<TelegramFile> {
    return this.#apiCall<TelegramFile>("getFile", params);
  }

  on<K extends keyof TelegramConnectionEvents>(
    event: K,
    listener: TelegramConnectionEvents[K],
  ): () => void {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(listener as (...args: unknown[]) => void);

    return () => {
      const s = this.#listeners.get(event);
      if (s) {
        s.delete(listener as (...args: unknown[]) => void);
      }
    };
  }

  // ── Private ───────────────────────────────────────────────────

  async #validateToken(): Promise<void> {
    try {
      await this.#apiCall<unknown>("getMe", {});
    } catch (error) {
      if (error instanceof AuthenticationError) {
        throw error;
      }
      throw new AuthenticationError(
        `Telegram bot token validation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async #pollLoop(): Promise<void> {
    while (this.#running) {
      try {
        const updates = await this.#fetchUpdates();
        for (const update of updates) {
          this.#offset = update.update_id + 1;
          this.#emit("update", update);
        }
      } catch (error) {
        if (error instanceof AuthenticationError) {
          this.#logger.error("Telegram authentication failed, stopping polling", {
            error: error.message,
          });
          this.#running = false;
          this.#emit("disconnected", "authentication_failed");
          return;
        }

        this.#logger.warn("Telegram polling error, will retry", {
          error: error instanceof Error ? error.message : String(error),
        });
        this.#emit("error", error instanceof Error ? error : new Error(String(error)));
      }

      // Wait before next poll
      if (this.#running) {
        await this.#delay(this.#pollingIntervalMs);
      }
    }
  }

  async #fetchUpdates(): Promise<readonly TelegramUpdate[]> {
    const params = {
      offset: this.#offset,
      limit: this.#maxUpdatesPerPoll,
      timeout: Math.floor(this.#connectionTimeoutMs / 1000),
      allowed_updates: ["message", "callback_query"] as string[],
    };

    return this.#apiCall<readonly TelegramUpdate[]>("getUpdates", params);
  }

  /**
   * Make a Telegram Bot API call.
   *
   * DESIGN: Accepts any serializable object as params.
   * Rationale: The Telegram API types are readonly interfaces without
   * index signatures, so we accept `object` and let JSON.stringify
   * handle serialization.
   */
  async #apiCall<T>(method: string, params: object): Promise<T> {
    const url = `${TELEGRAM_API_BASE}/bot${this.#token}/${method}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#connectionTimeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
        signal: controller.signal,
      });

      if (response.status === 401) {
        throw new AuthenticationError("Telegram bot token is invalid or revoked");
      }

      if (response.status === 429) {
        const retryAfter = Number(response.headers.get("retry-after") ?? "5");
        this.#logger.warn("Telegram rate limited, backing off", {
          retryAfter,
          method,
        });
        await this.#delay(retryAfter * 1000);
        // Retry once after backoff
        return this.#apiCall<T>(method, params);
      }

      if (!response.ok) {
        throw new ConnectionError(
          `Telegram API error: ${String(response.status)} ${response.statusText}`,
        );
      }

      const body = (await response.json()) as TelegramApiResponse<T>;

      if (!body.ok) {
        throw new ConnectionError(
          `Telegram API returned error: ${body.description ?? "unknown"}`,
        );
      }

      return body.result as T;
    } catch (error) {
      if (error instanceof AuthenticationError || error instanceof ConnectionError) {
        throw error;
      }
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new ConnectionError(`Telegram API call timed out: ${method}`);
      }
      throw new ConnectionError(
        `Telegram API call failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  #emit<K extends keyof TelegramConnectionEvents>(
    event: K,
    ...args: Parameters<TelegramConnectionEvents[K]>
  ): void {
    const set = this.#listeners.get(event);
    if (set) {
      for (const listener of set) {
        try {
          listener(...(args as unknown[]));
        } catch (error) {
          this.#logger.error("Telegram event listener threw", {
            event,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  #delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.#pollTimer = setTimeout(resolve, ms);
    });
  }
}

// ── Factory ─────────────────────────────────────────────────────

/**
 * Resolve a bot token from a config that specifies `tokenEnv`.
 *
 * @throws {AuthenticationError} if the env var is not set.
 */
export function resolveBotToken(config: TelegramProviderConfig): string {
  const token = process.env[config.tokenEnv];
  if (!token) {
    throw new AuthenticationError(
      `Telegram bot token not found in environment variable: ${config.tokenEnv}`,
    );
  }
  return token;
}
