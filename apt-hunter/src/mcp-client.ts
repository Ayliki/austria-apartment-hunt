import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export interface McpServerSpec {
  command: string;
  args: string[];
}

/**
 * A single persistent stdio connection to an MCP server.
 * apt-hunter keeps one connection per source open for the whole run —
 * enrichment makes dozens of willhaben_get_listing calls and spawning one
 * `npx` process per call would dominate runtime.
 */
export class McpConnection {
  private readonly client: Client;
  private readonly transport: StdioClientTransport;

  constructor(spec: McpServerSpec) {
    this.transport = new StdioClientTransport({
      command: spec.command,
      args: spec.args,
      stderr: 'inherit',
    });
    this.client = new Client({ name: 'apt-hunter', version: '0.1.0' });
  }

  async connect(): Promise<void> {
    await this.client.connect(this.transport);
  }

  /** Call a tool and return its joined text content; throws when isError is set. */
  async callToolText(tool: string, args: Record<string, unknown>): Promise<string> {
    const res = await this.client.callTool({ name: tool, arguments: args });
    const parts = (res.content ?? []) as { type: string; text?: string }[];
    const text = parts.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n');
    if (res.isError) throw new Error(`${tool} failed: ${text}`);
    return text;
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
