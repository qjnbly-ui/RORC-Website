import type { WebSocket } from "ws";

export type RelayInboundMessage =
  | { type: "setup"; accountSid?: string; callSid?: string; from?: string }
  | { type: "prompt"; voicePrompt?: string; last?: boolean }
  | { type: "dtmf"; digit?: string }
  | { type: "interrupt"; utteranceUntilInterrupt?: string }
  | { type: "error"; description?: string }
  | { type: string; [key: string]: unknown };

export function parseRelayMessage(raw: Buffer | ArrayBuffer | Buffer[]): RelayInboundMessage | null {
  try {
    const bytes = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as { type?: unknown }).type !== "string") return null;
    return value as RelayInboundMessage;
  } catch {
    return null;
  }
}

export function sendRelayText(ws: WebSocket, text: string): void {
  ws.send(JSON.stringify({ type: "text", token: text, last: true, interruptible: true, preemptible: true }));
}

export function sendApprovedHandoff(ws: WebSocket, summary: string): void {
  ws.send(JSON.stringify({
    type: "end",
    handoffData: JSON.stringify({ reasonCode: "approved-rorc-transfer", summary }),
  }));
}
