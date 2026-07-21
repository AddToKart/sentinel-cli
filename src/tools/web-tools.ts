import axios from 'axios';
import { ToolDefinition, isPrivateIP, truncateText } from './security.js';

export const webFetchTool: ToolDefinition = {
  name: 'web_fetch',
  displayName: 'Fetching Web',
  description: 'Fetch web pages or API endpoints via HTTP GET. Returns text/markdown representation. Use to look up documentation, APIs, or web resources.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The HTTP/HTTPS URL to fetch' },
      max_chars: { type: 'number', description: 'Max characters to return (default: 10000)' },
    },
    required: ['url'],
  },
  getLabel: ({ url }) => url,
  async execute({ url, max_chars = 10000 }) {
    try {
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        return 'Error: URL must start with http:// or https://';
      }

      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return `Error: Invalid URL format: "${url}"`;
      }

      if (isPrivateIP(parsed.hostname)) {
        return `⚠ Blocked by security policy: Access to private/internal network addresses (${parsed.hostname}) is prohibited.`;
      }

      if (parsed.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(parsed.hostname)) {
        // Warning logged, but HTTPS is preferred
      }

      const response = await axios.get(url, {
        timeout: 10000,
        maxContentLength: 1024 * 1024 * 2,
        headers: {
          'User-Agent': 'SentinelCLI/1.0 (AI Assistant Terminal Harness)',
          'Accept': 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9',
        },
        responseType: 'text',
      });

      let content = String(response.data);

      if (response.headers['content-type']?.includes('text/html')) {
        content = content
          .replace(/<script\b[^<]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style\b[^<]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<nav\b[^<]*>[\s\S]*?<\/nav>/gi, '')
          .replace(/<footer\b[^<]*>[\s\S]*?<\/footer>/gi, '')
          .replace(/<header\b[^<]*>[\s\S]*?<\/header>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      }

      const truncated = truncateText(content, Number(max_chars) || 10000);
      return `web_fetch: ${url} (${response.status} ${response.statusText})\n\n${truncated}`;
    } catch (err: any) {
      if (axios.isAxiosError(err)) {
        if (err.code === 'ECONNABORTED') return `Error: request timed out (10s) for ${url}`;
        if (err.response) return `HTTP ${err.response.status} ${err.response.statusText} for ${url}`;
        return `Network error fetching ${url}: ${err.message}`;
      }
      return `Error fetching web content: ${err.message}`;
    }
  },
};
