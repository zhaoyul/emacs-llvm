import { EMACS_OPERATOR_VERSION } from "../../protocol/src/index.js";
import { TOOL_DEFINITIONS } from "./tools/catalog.js";
import { ToolRouter } from "./tools/toolRouter.js";

const SUPPORTED_VERSIONS = new Set(["2026-07-28", "2025-06-18", "2025-03-26"]);
const DEFAULT_VERSION = "2026-07-28";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export class McpWireServer {
  constructor(readonly router = new ToolRouter()) {}

  async handle(message: JsonRpcRequest): Promise<Record<string, unknown> | null> {
    const id = message.id;
    if (message.method.startsWith("notifications/")) return null;
    try {
      if (message.method === "initialize") {
        const requested = typeof message.params?.protocolVersion === "string" ? message.params.protocolVersion : DEFAULT_VERSION;
        const protocolVersion = SUPPORTED_VERSIONS.has(requested) ? requested : DEFAULT_VERSION;
        return this.result(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "emacs-operator", version: EMACS_OPERATOR_VERSION },
          instructions: "Open an explicit emacs_session_open before stateful operations. Prefer semantic, then internal_keys. Use native_keys only with trusted_local after the connected platform Host reports desktop-control capability."
        });
      }
      if (message.method === "ping") return this.result(id, {});
      if (message.method === "tools/list") return this.result(id, { tools: TOOL_DEFINITIONS });
      if (message.method === "tools/call") {
        const name = message.params?.name;
        if (typeof name !== "string") return this.error(id, -32602, "tools/call requires params.name");
        const args = message.params?.arguments ?? {};
        const envelope = await this.router.call(name, args);
        if (name === "emacs_capture" && envelope.ok && envelope.result && typeof envelope.result === "object") {
          const capture = envelope.result as Record<string, unknown>;
          if (typeof capture.image_data === "string" && typeof capture.mime_type === "string") {
            const compactResult = { ...capture };
            delete compactResult.image_data;
            const compactEnvelope = { ...envelope, result: compactResult };
            return this.result(id, {
              content: [
                { type: "text", text: JSON.stringify(compactEnvelope) },
                { type: "image", data: capture.image_data, mimeType: capture.mime_type }
              ],
              structuredContent: compactEnvelope,
              isError: false
            });
          }
        }
        const serialized = JSON.stringify(envelope);
        return this.result(id, {
          content: [{ type: "text", text: serialized }],
          structuredContent: envelope,
          isError: !envelope.ok
        });
      }
      return this.error(id, -32601, `Method not found: ${message.method}`);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      return this.error(id, -32603, messageText);
    }
  }

  private result(id: string | number | null | undefined, result: unknown): Record<string, unknown> {
    return { jsonrpc: "2.0", id: id ?? null, result };
  }

  private error(id: string | number | null | undefined, code: number, message: string): Record<string, unknown> {
    return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
  }
}
