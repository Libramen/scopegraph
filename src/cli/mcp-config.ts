/**
 * `scopegraph mcp-config` — prints a ready-to-paste MCP client config
 * (Claude Desktop's `claude_desktop_config.json` shape) that runs this
 * checkout's server over stdio.
 *
 * MCP clients launch the command from their own working directory with their
 * own PATH, so every path is absolute and the command is the node binary
 * running this CLI. It runs the TypeScript sources through tsx, so edits to
 * catalog/ and src/extend/ take effect on the next client restart without a
 * build. tsx gets this checkout's tsconfig explicitly: by default it reads
 * `tsconfig.json` from the working directory, whose `paths` could redirect
 * the server's own imports to code in that directory. (The CLI reads only the
 * checkout's `.env` for the same reason; see ./env-file.ts.) `npm run` is
 * deliberately NOT used: it prints a banner to stdout, which corrupts the
 * stdio protocol.
 */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { loadGraph } from '../compile/index.js';
import { CHECKOUT_ROOT } from './env-file.js';

export interface StdioServerConfig {
  command: string;
  args: string[];
}

/** The stdio launch command for this checkout, with absolute paths only. */
export function stdioServerConfig(catalogDir: string): StdioServerConfig {
  const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
  return {
    command: process.execPath,
    args: [
      tsxCli,
      '--tsconfig',
      resolve(CHECKOUT_ROOT, 'tsconfig.json'),
      resolve(CHECKOUT_ROOT, 'src/cli/index.ts'),
      'serve',
      '--stdio',
      '--catalog',
      resolve(catalogDir),
    ],
  };
}

export async function runMcpConfig(options: { catalogDir: string }): Promise<number> {
  const { graph, diagnostics } = await loadGraph(options.catalogDir);
  if (graph === undefined) {
    const errors = diagnostics.filter((d) => d.severity === 'error').length;
    process.stderr.write(`error: the catalog has ${String(errors)} error(s) — run 'npm run sg -- validate' first\n`);
    return 1;
  }
  const key = graph.business.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'scopegraph';
  const config = { mcpServers: { [key]: stdioServerConfig(options.catalogDir) } };
  process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
  process.stderr.write(
    [
      '',
      `Merge "mcpServers.${key}" into your MCP client config, then restart the client:`,
      '  Claude Desktop (macOS):   ~/Library/Application Support/Claude/claude_desktop_config.json',
      '  Claude Desktop (Windows): %APPDATA%\\Claude\\claude_desktop_config.json',
      'Deployed? Add https://<your-host>/mcp as a remote (Streamable HTTP) connector instead.',
      '',
    ].join('\n'),
  );
  return 0;
}
