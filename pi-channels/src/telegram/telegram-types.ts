/**
 * Telegram Bot API types used by the Telegram channel provider.
 *
 * Subset of the full Telegram Bot API — only the types we actually
 * consume or produce.  Field names match the Telegram API exactly
 * (snake_case) so serialization is trivial.
 *
 * Reference: https://core.telegram.org/bots/api
 *
 * @module pi-channels/telegram/telegram-types
 */

// ── Core objects ────────────────────────────────────────────────

/**
 * A Telegram user or bot.
 */
export interface TelegramUser {
  readonly id: number;
  readonly is_bot: boolean;
  readonly first_name: string;
  readonly last_name?: string;
  readonly username?: string;
}

/**
 * A Telegram chat (private, group, supergroup, or channel).
 */
export interface TelegramChat {
  readonly id: number;
  readonly type: "private" | "group" | "supergroup" | "channel";
  readonly title?: string;
  readonly username?: string;
  readonly first_name?: string;
  readonly last_name?: string;
}

/**
 * A photo size variant.
 */
export interface TelegramPhotoSize {
  readonly file_id: string;
  readonly file_unique_id: string;
  readonly width: number;
  readonly height: number;
  readonly file_size?: number;
}

/**
 * A document (file) attachment.
 */
export interface TelegramDocument {
  readonly file_id: string;
  readonly file_unique_id: string;
  readonly file_name?: string;
  readonly mime_type?: string;
  readonly file_size?: number;
}

// ── Message ─────────────────────────────────────────────────────

/**
 * A Telegram message.
 *
 * Only the fields we care about — the full API has dozens more.
 */
export interface TelegramMessage {
  readonly message_id: number;
  readonly from?: TelegramUser;
  readonly date: number;
  readonly chat: TelegramChat;
  readonly text?: string;
  readonly caption?: string;
  readonly photo?: readonly TelegramPhotoSize[];
  readonly document?: TelegramDocument;
  readonly reply_to_message?: TelegramMessage;
}

// ── Callback query ──────────────────────────────────────────────

/**
 * An inline button callback query.
 */
export interface TelegramCallbackQuery {
  readonly id: string;
  readonly from: TelegramUser;
  readonly message?: TelegramMessage;
  readonly data?: string;
}

// ── Update ──────────────────────────────────────────────────────

/**
 * A single update from the Telegram `getUpdates` response.
 *
 * Each update contains exactly one of the optional event types.
 * We handle `message` and `callback_query`; others are ignored.
 */
export interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: TelegramMessage;
  readonly callback_query?: TelegramCallbackQuery;
}

/**
 * Response envelope from `getUpdates`.
 */
export interface TelegramGetUpdatesResponse {
  readonly ok: boolean;
  readonly result: readonly TelegramUpdate[];
}

// ── Outbound API types ──────────────────────────────────────────

/**
 * Parameters for `sendMessage`.
 */
export interface TelegramSendMessageParams {
  readonly chat_id: number | string;
  readonly text: string;
  readonly parse_mode?: "MarkdownV2" | "HTML" | "Markdown";
  readonly reply_to_message_id?: number;
}

/**
 * Parameters for `sendChatAction` (typing indicator).
 */
export interface TelegramSendChatActionParams {
  readonly chat_id: number | string;
  readonly action: "typing" | "upload_photo" | "upload_document";
}

/**
 * Parameters for `editMessageText`.
 */
export interface TelegramEditMessageTextParams {
  readonly chat_id: number | string;
  readonly message_id: number;
  readonly text: string;
  readonly parse_mode?: "MarkdownV2" | "HTML" | "Markdown";
}

/**
 * Parameters for `deleteMessage`.
 */
export interface TelegramDeleteMessageParams {
  readonly chat_id: number | string;
  readonly message_id: number;
}

/**
 * Parameters for `getFile` (resolve file_id → download path).
 */
export interface TelegramGetFileParams {
  readonly file_id: string;
}

/**
 * Response from `getFile`.
 */
export interface TelegramFile {
  readonly file_id: string;
  readonly file_unique_id: string;
  readonly file_size?: number;
  readonly file_path?: string;
}

// ── Generic API response ────────────────────────────────────────

/**
 * Generic Telegram Bot API response envelope.
 */
export interface TelegramApiResponse<T> {
  readonly ok: boolean;
  readonly result?: T;
  readonly error_code?: number;
  readonly description?: string;
  readonly retry_after?: number;
}

// ── Provider config ─────────────────────────────────────────────

/**
 * Configuration for the Telegram channel provider.
 */
export interface TelegramProviderConfig {
  /**
   * Environment variable name containing the bot token.
   * The actual token is resolved at runtime from this env var.
   */
  readonly tokenEnv: string;

  /** Polling interval in milliseconds.  Default: 1000. */
  readonly pollingIntervalMs?: number;

  /** Optional allowlist of chat IDs.  If set, messages from other chats are ignored. */
  readonly allowedChats?: readonly string[];

  /** Connection timeout for HTTP requests in milliseconds.  Default: 30_000. */
  readonly connectionTimeoutMs?: number;

  /** Maximum number of updates per getUpdates call.  Default: 100. */
  readonly maxUpdatesPerPoll?: number;
}

// ── Connection events ───────────────────────────────────────────

/**
 * Typed events emitted by a {@link TelegramConnection}.
 */
export interface TelegramConnectionEvents {
  /** Fired when polling starts successfully. */
  connected: () => void;

  /** Fired when polling stops (normal or abnormal). */
  disconnected: (reason: string) => void;

  /** Fired when an update is received. */
  update: (update: TelegramUpdate) => void;

  /** Fired on non-fatal errors (e.g. transient HTTP failure). */
  error: (error: Error) => void;
}

// ── Connection interface ────────────────────────────────────────

/**
 * Contract for a Telegram Bot API connection.
 *
 * The provider talks to this interface; actual HTTP transport
 * lives behind it.  Test fakes implement this interface.
 */
export interface TelegramConnection {
  /**
   * Start polling for updates.
   *
   * @throws {ConnectionError} on transport failure.
   * @throws {AuthenticationError} on invalid bot token.
   */
  open(): Promise<void>;

  /** Stop polling and release resources. */
  close(): Promise<void>;

  /** Whether the connection is currently polling. */
  readonly isOpen: boolean;

  /** Send a text message to a chat. */
  sendMessage(params: TelegramSendMessageParams): Promise<TelegramMessage>;

  /** Edit an existing message's text. */
  editMessageText(params: TelegramEditMessageTextParams): Promise<TelegramMessage>;

  /** Delete a message. */
  deleteMessage(params: TelegramDeleteMessageParams): Promise<boolean>;

  /** Send a chat action (typing indicator). */
  sendChatAction(params: TelegramSendChatActionParams): Promise<boolean>;

  /** Resolve a file_id to a downloadable file path. */
  getFile(params: TelegramGetFileParams): Promise<TelegramFile>;

  /** Register an event listener.  Returns an unsubscribe function. */
  on<K extends keyof TelegramConnectionEvents>(
    event: K,
    listener: TelegramConnectionEvents[K],
  ): () => void;
}
