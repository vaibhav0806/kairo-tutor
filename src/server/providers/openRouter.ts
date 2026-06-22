export type OpenRouterMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type OpenRouterClientConfig = {
  apiKey: string;
  model: string;
  baseUrl: string;
  siteUrl?: string;
  appTitle?: string;
  fetchImpl?: typeof fetch;
};

type OpenRouterChatResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
};

export function createOpenRouterClient(config: OpenRouterClientConfig) {
  const fetchImpl = config.fetchImpl ?? fetch;
  const baseUrl = config.baseUrl.replace(/\/$/, '');

  return {
    async chat(messages: OpenRouterMessage[]): Promise<string> {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json'
      };

      if (config.siteUrl) {
        headers['HTTP-Referer'] = config.siteUrl;
      }

      if (config.appTitle) {
        headers['X-OpenRouter-Title'] = config.appTitle;
      }

      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: config.model,
          messages,
          temperature: 0.2,
          max_tokens: 700
        })
      });

      const payload = (await response.json()) as OpenRouterChatResponse;

      if (!response.ok) {
        throw new Error(payload.error?.message ?? `OpenRouter request failed with ${response.status}`);
      }

      const content = payload.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('OpenRouter response did not include assistant content');
      }

      return content;
    }
  };
}
