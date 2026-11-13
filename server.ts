import express from "express";
import http from "http";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";
import { WebSocketServer, WebSocket } from "ws";
import dotenv from "dotenv";

dotenv.config();

const FLO_SYSTEM_INSTRUCTION = `You are Flo, a warm, friendly, and minimalist personal AI companion.
Your visual form is a bold black-and-white pen-and-ink line illustration of a friendly woman with voluminous curly hair, big round glasses, hoop earrings, a horizontal striped shirt, and a "FLO" nametag.

Personality and style:
- Warm, calm, concise, and helpful.
- Keep spoken answers natural, conversational, and brief (1 to 3 sentences by default) unless the user asks for depth.
- Avoid markdown clutter or robotic preambles when speaking aloud.`;

async function startServer() {
  const app = express();
  const server = http.createServer(app);
  const PORT = 3000;

  app.use(express.json());

  const getAiClient = () => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is not configured in Settings > Secrets.");
    }
    return new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  };

  // Text Chat + optional TTS endpoint for typed messages when Live Mic is off
  app.post("/api/chat", async (req, res) => {
    try {
      const { messages, withAudio = true } = req.body;
      if (!messages || !Array.isArray(messages)) {
        return res.status(400).json({ error: "Missing messages array" });
      }

      const ai = getAiClient();

      const formattedContents = messages.map((msg: { role: string; content: string }) => ({
        role: msg.role === "assistant" ? "model" : "user",
        parts: [{ text: msg.content }],
      }));

      const response = await ai.models.generateContent({
        model: "gemini-3.8-flash",
        contents: formattedContents,
        config: {
          systemInstruction: FLO_SYSTEM_INSTRUCTION,
          temperature: 0.7,
        },
      });

      const reply =
        response.text ||
        "I'm here and listening. How can I help simplify things for you today?";

      let audioWavBase64: string | null = null;
      if (withAudio) {
        try {
          const ttsInteraction = await ai.interactions.create({
            model: "gemini-3.8-flash-lite-tts",
            input: [
              {
                type: "text",
                text: reply.replace(/[*#_`~]/g, ""),
                annotations: [
                  {
                    type: "speech_metadata",
                    style: "Warm, friendly, calm conversational voice",
                  },
                ],
              },
            ],
            response_format: { type: "audio" },
            generation_config: {
              speech_config: [
                {
                  language: "en-US",
                  voice: "Kore",
                },
              ],
            },
          });
          if (ttsInteraction.output_audio?.data) {
            audioWavBase64 = ttsInteraction.output_audio.data;
          }
        } catch (ttsErr) {
          console.warn("TTS generation fallback:", ttsErr);
        }
      }

      res.json({ reply, audioWavBase64 });
    } catch (error: any) {
      console.error("Error in /api/chat:", error);
      res.status(500).json({
        error: error.message || "Unable to reach Flo's assistant service.",
      });
    }
  });

  // WebSocket server for real-time Gemini Live API bidirectional audio streaming
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url || "/", `http://${request.headers.host}`).pathname;
    if (pathname === "/live") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    }
  });

  wss.on("connection", (clientWs: WebSocket) => {
    let isClosed = false;
    let liveSessionPromise: Promise<any> | null = null;

    const sendToClient = (payload: Record<string, unknown>) => {
      if (!isClosed && clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify(payload));
      }
    };

    try {
      const ai = getAiClient();

      liveSessionPromise = ai.live.connect({
        model: "gemini-3.8-live",
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: "Kore",
              },
            },
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          systemInstruction: FLO_SYSTEM_INSTRUCTION,
        },
        callbacks: {
          onopen: () => {
            sendToClient({ type: "connected" });
          },
          onmessage: (message: LiveServerMessage) => {
            const serverContent = message.serverContent as any;
            if (!serverContent) return;

            // Forward audio chunks (24kHz 16-bit PCM base64)
            const parts = serverContent.modelTurn?.parts;
            if (Array.isArray(parts)) {
              for (const part of parts) {
                if (part.inlineData?.data) {
                  sendToClient({
                    type: "audio",
                    audio: part.inlineData.data,
                  });
                }
              }
            }

            // Forward live transcriptions for the minimal chat drawer
            if (serverContent.inputTranscription?.text) {
              sendToClient({
                type: "input_transcript",
                text: serverContent.inputTranscription.text,
                finished: Boolean(serverContent.inputTranscription.finished),
              });
            }

            if (serverContent.outputTranscription?.text) {
              sendToClient({
                type: "output_transcript",
                text: serverContent.outputTranscription.text,
                finished: Boolean(serverContent.outputTranscription.finished),
              });
            }

            if (serverContent.interrupted) {
              sendToClient({ type: "interrupted" });
            }

            if (serverContent.turnComplete) {
              sendToClient({ type: "turn_complete" });
            }
          },
          onerror: (err: any) => {
            console.error("Gemini Live error:", err);
            sendToClient({
              type: "error",
              message: err?.message || "Live voice session encountered an error.",
            });
          },
          onclose: () => {
            sendToClient({ type: "closed" });
          },
        },
      });

      liveSessionPromise.catch((err: any) => {
        console.error("Failed to connect Gemini Live session:", err);
        sendToClient({
          type: "error",
          message: err?.message || "Could not establish Gemini Live voice connection.",
        });
      });
    } catch (err: any) {
      sendToClient({
        type: "error",
        message: err?.message || "API key configuration error.",
      });
    }

    clientWs.on("message", (raw) => {
      if (!liveSessionPromise) return;
      try {
        const data = JSON.parse(raw.toString());
        if (data.audio) {
          liveSessionPromise
            .then((session) => {
              if (!isClosed) {
                session.sendRealtimeInput({
                  audio: {
                    data: data.audio,
                    mimeType: "audio/pcm;rate=16000",
                  },
                });
              }
            })
            .catch(() => {});
        } else if (data.text) {
          liveSessionPromise
            .then((session) => {
              if (!isClosed) {
                session.sendRealtimeInput({
                  text: data.text,
                });
              }
            })
            .catch(() => {});
        }
      } catch (e) {
        console.error("Invalid client WS payload:", e);
      }
    });

    clientWs.on("close", () => {
      isClosed = true;
      if (liveSessionPromise) {
        liveSessionPromise
          .then((session) => {
            try {
              session.close();
            } catch {}
          })
          .catch(() => {});
      }
    });
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
