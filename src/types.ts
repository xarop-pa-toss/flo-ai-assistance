export type AvatarMode = "idle" | "listening" | "thinking" | "speaking";

export type AvatarFrameKey =
  | "base"
  | "talk_mid"
  | "talk_open"
  | "talk_o"
  | "listening"
  | "thinking";

export type LiveConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}
