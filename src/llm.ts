import { config } from "./config.ts";

export class LlmServiceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LlmServiceError";
  }
}

export interface ChatCompletionOptions {
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
}

const MAX_TRUNCATION_RETRY_TOKENS = 16_000;
const OUTPUT_TOKEN_LIMIT_ERROR = "LLM response exceeded the output token limit";

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function isOllamaApi(apiBase: string): boolean {
  try {
    const url = new URL(apiBase);
    return url.port === "11434";
  } catch {
    return false;
  }
}

export async function chatCompletion(
  apiBase: string,
  apiKey: string,
  model: string,
  systemPrompt: string,
  userContent: string,
  options: ChatCompletionOptions = {},
): Promise<string> {
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    temperature: options.temperature ?? config.llm.temperature,
  };
  if (options.maxTokens) body.max_tokens = options.maxTokens;
  if (options.jsonMode) body.response_format = { type: "json_object" };
  // Ollama enables thinking by default, so its explicit `none` is significant.
  // Continue omitting it for other providers that may not support the field.
  if (config.llm.reasoningEffort !== "none" || isOllamaApi(apiBase)) {
    body.reasoning_effort = config.llm.reasoningEffort;
  }

  let response: Response;
  try {
    response = await fetch(`${apiBase}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.security.modelTimeoutMs),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "UnknownError";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new LlmServiceError("LLM request timed out");
    }
    console.error(`LLM API transport failed (${name})`);
    throw new LlmServiceError("Unable to contact the LLM service");
  }

  if (!response.ok) {
    console.error(`LLM API request failed with status ${response.status}`);
    await response.body?.cancel();
    throw new LlmServiceError(
      `LLM service rejected the request (${response.status})`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new LlmServiceError("LLM service returned an invalid JSON response", {
      cause: error,
    });
  }

  let responseBody: Record<string, unknown>;
  try {
    responseBody = asRecord(payload, "LLM response");
  } catch (error) {
    throw new LlmServiceError("LLM service returned an invalid response", {
      cause: error,
    });
  }
  if (
    !Array.isArray(responseBody.choices) || responseBody.choices.length === 0
  ) {
    throw new LlmServiceError(
      "LLM response.choices must contain a completion",
    );
  }

  let choice: Record<string, unknown>;
  try {
    choice = asRecord(responseBody.choices[0], "LLM response.choices[0]");
  } catch (error) {
    throw new LlmServiceError("LLM service returned an invalid completion", {
      cause: error,
    });
  }
  if (choice.finish_reason === "length") {
    throw new LlmServiceError(OUTPUT_TOKEN_LIMIT_ERROR);
  }

  let message: Record<string, unknown>;
  try {
    message = asRecord(choice.message, "LLM response.choices[0].message");
  } catch (error) {
    throw new LlmServiceError("LLM service returned an invalid message", {
      cause: error,
    });
  }
  if (typeof message.content !== "string" || !message.content.trim()) {
    throw new LlmServiceError("LLM response content must not be empty");
  }
  return message.content;
}

export function parseJsonResponse(text: string, context: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  let json = fence?.[1].trim();
  if (json === undefined) {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    json = first >= 0 && last >= first
      ? text.slice(first, last + 1)
      : text.trim();
  }
  if (!json) throw new LlmServiceError(`${context} was empty`);
  try {
    return JSON.parse(json) as unknown;
  } catch (error) {
    throw new LlmServiceError(`${context} was not valid JSON`, {
      cause: error,
    });
  }
}

export async function structuredChatCompletion<T>(
  context: string,
  apiBase: string,
  apiKey: string,
  model: string,
  systemPrompt: string,
  userContent: string,
  options: ChatCompletionOptions,
  parse: (content: string) => T,
): Promise<T> {
  let completionOptions = options;
  let completionPrompt = systemPrompt;
  let content: string;
  try {
    content = await chatCompletion(
      apiBase,
      apiKey,
      model,
      completionPrompt,
      userContent,
      completionOptions,
    );
  } catch (error) {
    if (
      !(error instanceof LlmServiceError) ||
      error.message !== OUTPUT_TOKEN_LIMIT_ERROR
    ) {
      throw error;
    }
    const currentLimit = options.maxTokens ?? config.llm.maxTokens;
    const retryLimit = Math.min(
      MAX_TRUNCATION_RETRY_TOKENS,
      Math.ceil(currentLimit * 2),
    );
    if (retryLimit <= currentLimit) throw error;
    completionOptions = {
      ...options,
      maxTokens: retryLimit,
      temperature: 0,
    };
    completionPrompt = `${systemPrompt}

Your previous response reached its output limit. Return one complete, concise JSON object within the increased token budget. Preserve every required item and field.`;
    content = await chatCompletion(
      apiBase,
      apiKey,
      model,
      completionPrompt,
      userContent,
      completionOptions,
    );
  }
  try {
    return parse(content);
  } catch {
    const corrected = await chatCompletion(
      apiBase,
      apiKey,
      model,
      `${completionPrompt}\n\nYour previous response failed validation. Return exactly one valid JSON object matching every requested field and limit, with no Markdown fences or commentary.`,
      userContent,
      { ...completionOptions, temperature: 0 },
    );
    try {
      return parse(corrected);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "invalid output";
      throw new LlmServiceError(
        `${context} was invalid after one retry: ${reason}`,
        { cause: error },
      );
    }
  }
}
