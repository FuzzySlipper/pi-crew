/**
 * Background review runner — spawns review analyses in the Crew process.
 *
 * Supports two modes (config.backgroundReview.mode):
 * - "static": in-process static analysis of dense profile memories
 * - "llm":   HTTP call to the configured review model with a review prompt
 *
 * @module pi-crew/background-review-runner
 */

import { ConfigurationError } from "@pi-crew/core";
import type { Logger, EventBus } from "@pi-crew/core";
import type { ChannelProvider } from "@pi-crew/core";
import type { DenseProfileMemoryStore } from "@pi-crew/memory";
import type { DenseMemoryTarget } from "@pi-crew/memory";

// ── Types ─────────────────────────────────────────────────────

export type ReviewMode = "static" | "llm";

export interface BackgroundReviewRunnerConfig {
  readonly backgroundReview: {
    readonly enabled: boolean;
    readonly serviceWorkChannel?: string;
    readonly defaultMaxTokens?: number;
    readonly mode: ReviewMode;
    readonly static: {
      readonly maxEntryLength: number;
      readonly capacityAlertPercent: number;
      readonly patternChecks: string[];
    };
    readonly llm: {
      readonly reviewModel: string;
      readonly maxTokens?: number;
      readonly memoryPromptSlug: string;
      readonly skillPromptSlug: string;
      readonly combinedPromptSlug: string;
      readonly denMcpUrl: string;
      readonly denRouterUrl?: string;
      readonly requestTimeoutMs: number;
      readonly promptFetchTimeoutMs: number;
      readonly promptProjectId: string;
    };
  };
  readonly runtime?: {
    readonly modelProvider?: string;
    readonly modelName?: string;
  };
}

export interface BackgroundReviewRunnerOptions {
  readonly eventBus: EventBus;
  readonly logger: Logger;
  readonly channelProvider: ChannelProvider;
  readonly denseMemoryStore: DenseProfileMemoryStore;
  readonly config: BackgroundReviewRunnerConfig;
  readonly denRouterUrl?: string;
}

interface ReviewPayload {
  readonly profileId: string;
  readonly sessionId: string;
  readonly triggerType: "memory" | "skill" | "combined";
  readonly reviewId: string;
}

// ── Prompt templates ──────────────────────────────────────────

const MEMORY_REVIEW_PROMPT = `You are a memory curator. Review the agent's dense profile memories below for:
1. Quality — are entries well-written, specific, and actionable?
2. Staleness — are any entries outdated or superseded?
3. Gaps — what important facts are missing?
4. Suggestions — what should be added, updated, or removed?

Return your analysis as JSON with keys: findings (array of objects with severity/description/suggestion), quality (overall rating: good/fair/poor), and summary (brief sentence).`;

const SKILL_REVIEW_PROMPT = `You are a skill curator. Review the agent's loaded skills for quality, staleness, and coverage. NOTE: skill inspection tools are not yet available (#2633, #2634). Return: {"findings":[{"severity":"info","description":"Skill review not yet implemented","suggestion":"Implement skill_manage/skill_view tools"}],"summary":"Skill review pending skill tools"}`;

const COMBINED_REVIEW_PROMPT = `You are a knowledge curator. Review the agent's dense profile memories AND loaded skills for quality, staleness, gaps, and coverage.

**Memories:** Evaluate for quality, staleness, gaps, and suggestions. Flag vague, generic, or duplicate entries. Look for missing project conventions the agent keeps rediscovering.

**Skills:** Evaluate for quality (clear triggers, numbered steps, exact commands, pitfalls), staleness (outdated references), and coverage (repeated manual workflows that should be a skill).

Be concise. A good combined review costs <1500 tokens. Return JSON with keys:
- memoryFindings: array of {severity, description, suggestion?}
- skillFindings: array of {severity, description, suggestion?}
- quality: "good" | "fair" | "poor"
- summary: brief sentence (<200 chars)

If no issues, return {"memoryFindings": [], "skillFindings": [], "quality": "good", "summary": "Knowledge store looks healthy."}`;

// ── Runner ────────────────────────────────────────────────────

export class BackgroundReviewRunner {
  readonly #eventBus: EventBus;
  readonly #logger: Logger;
  readonly #channelProvider: ChannelProvider;
  readonly #denseMemoryStore: DenseProfileMemoryStore;
  readonly #config: BackgroundReviewRunnerConfig;
  readonly #denRouterUrl: string;

  constructor(options: BackgroundReviewRunnerOptions) {
    this.#eventBus = options.eventBus;
    this.#logger = options.logger;
    this.#channelProvider = options.channelProvider;
    this.#denseMemoryStore = options.denseMemoryStore;
    this.#config = options.config;
    if (options.config.backgroundReview.mode === "llm" && !options.denRouterUrl) {
      throw new ConfigurationError("backgroundReview.llm.denRouterUrl is required when mode is llm");
    }
    this.#denRouterUrl = options.denRouterUrl ?? "";
  }

  // ── Public entry point ─────────────────────────────────────

  async runReview(payload: ReviewPayload): Promise<void> {
    const { profileId, triggerType, reviewId } = payload;
    const logMeta = { reviewId, profileId, sessionId: payload.sessionId, triggerType };

    this.#logger.info("Background review runner starting", { ...logMeta, mode: this.#config.backgroundReview.mode });

    try {
      await this.#postToChannel(profileId, triggerType, reviewId, "running");

      let findings: string[] = [];
      const mode = this.#config.backgroundReview.mode;

      if (mode === "llm") {
        findings = await this.#spawnLLMReview(payload);
      } else {
        findings = await this.#runStaticAnalysis(payload);
      }

      const summary = findings.length > 0
        ? `Reviewed ${triggerType} for ${profileId}: ${findings.length} finding(s)`
        : `No issues found for ${profileId} ${triggerType} review`;

      await this.#postToChannel(profileId, triggerType, reviewId, "completed", { summary, findings });

      this.#logger.info("Background review runner completed", { ...logMeta, findingCount: findings.length, summary });
    } catch (err) {
      this.#logger.error("Background review runner failed", { ...logMeta, error: String(err) });
      await this.#postToChannel(profileId, triggerType, reviewId, "failed", { error: String(err) })
        .catch((postErr: unknown) => this.#logger.warn("Failed to post review failure", { error: String(postErr) }));
    }
  }

  // ── Static analysis strategy ───────────────────────────────

  async #runStaticAnalysis(payload: ReviewPayload): Promise<string[]> {
    const findings: string[] = [];

    if (payload.triggerType === "memory" || payload.triggerType === "combined") {
      findings.push(...await this.#analyzeMemories(payload.profileId, payload.reviewId));
    }

    if (payload.triggerType === "skill" || payload.triggerType === "combined") {
      findings.push("Skill review not yet implemented — pending skill_manage/skill_view tools (#2633, #2634)");
    }

    return findings;
  }

  async #analyzeMemories(profileId: string, reviewId: string): Promise<string[]> {
    const cfg = this.#config.backgroundReview.static;
    const findings: string[] = [];

    try {
      const memory = await this.#denseMemoryStore.read(profileId, "memory");

      if (!memory || !memory.content) {
        findings.push("No memory entries found — agent has not saved any memories yet");
        return findings;
      }

      const entries = memory.content.split("\n").filter(Boolean);

      if (entries.length === 0) {
        findings.push("Memory store is empty (content present but no non-empty entries)");
        return findings;
      }

      const overLong = entries.filter((e: string) => e.length > cfg.maxEntryLength);
      if (overLong.length > 0) {
        findings.push(`${overLong.length} entry/entries exceeded ${cfg.maxEntryLength} characters — dense memories should be compact`);
      }

      const upped = entries.map((e: string) => e.toUpperCase());
      const genericEntries = upped.filter((e: string) =>
        cfg.patternChecks.some((p: string) => e.includes(p.toUpperCase())),
      );
      if (genericEntries.length > 0) {
        findings.push(`${genericEntries.length} entry/entries contain placeholder patterns (${cfg.patternChecks.join(", ")})`);
      }

      const usagePct = memory.capBytes > 0 ? Math.round((memory.usedBytes / memory.capBytes) * 100) : 0;
      if (usagePct > cfg.capacityAlertPercent) {
        findings.push(`Memory store is ${usagePct}% full (${memory.usedBytes}/${memory.capBytes} bytes) — consider pruning stale entries`);
      }

      this.#logger.debug("Memory review completed", { reviewId, entryCount: entries.length, usagePct, findings: findings.length });
    } catch (err) {
      this.#logger.warn("Memory review failed", { reviewId, error: String(err) });
      findings.push(`Memory review error: ${String(err)}`);
    }

    return findings;
  }

  // ── LLM review strategy ────────────────────────────────────

  /**
   * Load review prompt content from a Den document via MCP JSON-RPC.
   * Falls back to the supplied constant on any error.
   */
  async #loadPromptFromDenDoc(slug: string, fallback: string): Promise<string> {
    const mcpUrl = this.#config.backgroundReview.llm.denMcpUrl;
    try {
      // Initialize a fresh MCP session
      const initResponse = await fetch(mcpUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "initialize",
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "pi-crew-runner", version: "1.0.0" } },
        }),
        signal: AbortSignal.timeout(this.#config.backgroundReview.llm.promptFetchTimeoutMs),
      });

      // Extract Mcp-Session-Id from response headers
      const sessionId = initResponse.headers.get("Mcp-Session-Id");
      if (!sessionId) {
        this.#logger.warn("Den MCP session not created for prompt fetch", { slug });
        return fallback;
      }

      // Read the full response to clear the stream
      await initResponse.text();

      // Call get_document tools/call
      const docResponse = await fetch(mcpUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "Mcp-Session-Id": sessionId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 2, method: "tools/call",
          params: { name: "get_document", arguments: { project_id: this.#config.backgroundReview.llm.promptProjectId, slug, verbose: true } },
        }),
        signal: AbortSignal.timeout(this.#config.backgroundReview.llm.promptFetchTimeoutMs),
      });

      const rawText = await docResponse.text();

      // Parse SSE — find the "data:" line and extract JSON
      for (const line of rawText.split("\n")) {
        if (line.startsWith("data: ")) {
          const parsed = JSON.parse(line.slice(6));
          const contentArray = parsed?.result?.content as Array<{ type: string; text: string }> | undefined;
          if (contentArray?.[0]?.text) {
            const doc = JSON.parse(contentArray[0].text) as { content?: string };
            if (doc.content) {
              this.#logger.info("Loaded review prompt from Den doc", { slug });
              return doc.content;
            }
          }
        }
      }

      this.#logger.warn("Den doc content not found in MCP response", { slug });
      return fallback;
    } catch (err) {
      this.#logger.warn("Failed to load prompt from Den doc, using fallback", { slug, error: String(err) });
      return fallback;
    }
  }

  async #spawnLLMReview(payload: ReviewPayload): Promise<string[]> {
    const findings: string[] = [];

    const profileId = payload.profileId;
    const reviewId = payload.reviewId;
    const llmCfg = this.#config.backgroundReview.llm;

    // Read the agent's memories
    let memoryContent = "";
    try {
      const memory = await this.#denseMemoryStore.read(profileId, "memory");
      memoryContent = memory?.content ?? "(no memories saved)";
    } catch (err) {
      findings.push(`Failed to read memories for LLM review: ${String(err)}`);
      return findings;
    }

    // Load the review prompt from Den docs (with hardcoded fallback)
    let promptSlug: string;
    let promptFallback: string;
    if (payload.triggerType === "combined") {
      promptSlug = llmCfg.combinedPromptSlug;
      promptFallback = COMBINED_REVIEW_PROMPT;
    } else if (payload.triggerType === "memory") {
      promptSlug = llmCfg.memoryPromptSlug;
      promptFallback = MEMORY_REVIEW_PROMPT;
    } else {
      promptSlug = llmCfg.skillPromptSlug;
      promptFallback = SKILL_REVIEW_PROMPT;
    }
    const systemPrompt = await this.#loadPromptFromDenDoc(promptSlug, promptFallback);

    const userPrompt = `Agent profile: ${profileId}
Review type: ${payload.triggerType}
Review ID: ${reviewId}

Current memory contents:
--- START MEMORY ---
${memoryContent}
--- END MEMORY ---

${systemPrompt}`;

    // Call the LLM via the Den Router — reviewModel default is in schema now
    const maxTokens = llmCfg.maxTokens ?? this.#config.backgroundReview.defaultMaxTokens ?? 5000;
    const modelName = llmCfg.reviewModel;

    try {
      const response = await fetch(`${this.#denRouterUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: modelName,
          messages: [
            { role: "user", content: userPrompt },
          ],
          max_tokens: maxTokens,
          temperature: 0.3,
        }),
        signal: AbortSignal.timeout(this.#config.backgroundReview.llm.requestTimeoutMs),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "unknown");
        findings.push(`LLM review call failed (HTTP ${response.status}): ${body.slice(0, 200)}`);
        return findings;
      }

      const data = await response.json() as { choices?: { message?: { content?: string } }[] };
      const llmText = data?.choices?.[0]?.message?.content ?? "(empty response)";

      // Try to parse as JSON for structured findings
      try {
        const parsed = JSON.parse(llmText) as { findings?: Array<{ description?: string }>; summary?: string };
        if (Array.isArray(parsed.findings)) {
          for (const f of parsed.findings) {
            findings.push(f.description ?? JSON.stringify(f));
          }
        }
        if (parsed.summary) {
          findings.push(`LLM summary: ${parsed.summary}`);
        }
      } catch {
        // Not valid JSON — include raw LLM output as a single finding
        findings.push(`LLM review output: ${llmText.slice(0, 500)}`);
      }

      this.#logger.info("LLM review completed", {
        reviewId,
        model: modelName,
        findingCount: findings.length,
      });
    } catch (err) {
      findings.push(`LLM review error: ${String(err)}`);
      this.#logger.warn("LLM review failed", { reviewId, error: String(err) });
    }

    return findings;
  }

  // ── Channel messaging ──────────────────────────────────────

  async #postToChannel(
    profileId: string,
    triggerType: string,
    reviewId: string,
    status: "running" | "completed" | "failed",
    details?: Record<string, unknown>,
  ): Promise<void> {
    const channelId = this.#config.backgroundReview.serviceWorkChannel;
    if (!channelId) return;

    const payload: Record<string, unknown> = {
      type: `background_review_${status}`,
      reviewId,
      profileId,
      triggerType,
      timestamp: new Date().toISOString(),
      ...details,
    };

    await this.#channelProvider.sendMessage(channelId, {
      kind: "text",
      text: JSON.stringify(payload),
    }).catch((err: unknown) => {
      this.#logger.warn("Failed to post review status to channel", { channelId, status, error: String(err) });
    });
  }
}
