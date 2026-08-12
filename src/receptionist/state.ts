import type { WebSocket } from "ws";
import type { FormSession, HistoryItem } from "./contracts";

export interface CallSocket extends WebSocket {
  history: HistoryItem[];
  processing: boolean;
  transferOffered: boolean;
  activeSpeech: string;
  caller: any;
  callerReady: Promise<any>;
  analyticsReady: Promise<any>;
  callerKey: string;
  awaitingPin: boolean;
  pinDigits: string;
  accountVerified: boolean;
  formOffer: string;
  formSession: FormSession | null;
  awaitingTransferReason: boolean;
  finalOutcome: string;
  callSid: string;
  fromNumber: string;
  transferSummary?: string;
}

export function initializeCallSocket(ws: WebSocket): CallSocket {
  const call = ws as CallSocket;
  call.history = [];
  call.processing = false;
  call.transferOffered = false;
  call.activeSpeech = "";
  call.caller = null;
  call.callerReady = Promise.resolve(null);
  call.analyticsReady = Promise.resolve(null);
  call.callerKey = "";
  call.awaitingPin = false;
  call.pinDigits = "";
  call.accountVerified = false;
  call.formOffer = "";
  call.formSession = null;
  call.awaitingTransferReason = false;
  call.finalOutcome = "disconnected";
  call.callSid = "";
  call.fromNumber = "";
  return call;
}
