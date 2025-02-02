import "./dotenv.js";

import { v4 as uuidv4 } from "uuid";
import http from "http";
import { WebSocket, WebSocketServer } from "ws";
import { IS_DEV } from "./constants";
import { allAgentSets, defaultAgentSetKey } from "./agentConfigs/index.js";
import { AgentConfig, ServerEvent } from "./types.js";

const port = Number(process.env.PORT) || 3000;
const corsWhitelist = process.env.CORS_WHITELIST?.split(",") ?? [];

const agents = allAgentSets[defaultAgentSetKey];

const server = http.createServer();
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const origin = request.headers.origin;

  // Allow requests without origin during development only
  const hasValidCors = (IS_DEV && !origin) || corsWhitelist.includes(origin!);

  if (hasValidCors && request.url === "/ws") {
    // Upgrade to WS
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (clientWs) => {
  console.log("Client connected");

  const url =
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17";
  const openaiWs = new WebSocket(url, {
    headers: {
      Authorization: "Bearer " + process.env.OPENAI_API_KEY,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  let currentAgent = agents[0];
  let streamSid: string | null = null;
  let markQueue: string[] = [];
  let latestMediaTimestamp = 0;
  let responseStartTimestampTwilio: number | null = null;
  let lastAssistantItem: string | null = null;

  openaiWs.on("open", () => {
    sendSessionUpdate(openaiWs, currentAgent);
    forceBotGreeting(openaiWs);
  });

  // Messages from OpenAI to Twilio call
  openaiWs.on("message", (message) => {
    try {
      const serverEvent: ServerEvent = JSON.parse(message.toString());

      console.log(`Event from server: ${serverEvent.type}`);
      if (serverEvent.type === "error") {
        console.log(serverEvent);
      }

      if (serverEvent.type === "session.updated") {
        console.log("Session updated:", serverEvent);
      }

      switch (serverEvent.type) {
        case "input_audio_buffer.speech_started": {
          // Handled user interruption
          if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
            const elapsedTime =
              latestMediaTimestamp - responseStartTimestampTwilio;

            if (lastAssistantItem) {
              const truncateEvent = {
                type: "conversation.item.truncate",
                item_id: lastAssistantItem,
                content_index: 0,
                audio_end_ms: elapsedTime,
              };

              sendEventToOpenAi(openaiWs, truncateEvent);
            }

            sendEventToTwilio(clientWs, {
              event: "clear",
              streamSid: streamSid,
            });

            // Reset
            markQueue = [];
            lastAssistantItem = null;
            responseStartTimestampTwilio = null;
          }
          break;
        }
        case "response.audio.delta": {
          const audioDelta = {
            event: "media",
            streamSid: streamSid,
            media: {
              payload: serverEvent.delta || "",
            },
          };
          sendEventToTwilio(clientWs, audioDelta);

          if (!responseStartTimestampTwilio) {
            responseStartTimestampTwilio = latestMediaTimestamp;
          }

          if (serverEvent.item_id) {
            lastAssistantItem = serverEvent.item_id;
          }

          if (streamSid) {
            sendMark(clientWs, streamSid, markQueue);
          }

          break;
        }
        case "conversation.item.input_audio_transcription.completed": {
          console.log("transcript", serverEvent.transcript);
          break;
        }
        case "response.done": {
          if (serverEvent.response?.output) {
            serverEvent.response.output.forEach((outputItem: any) => {
              if (
                outputItem.type === "function_call" &&
                outputItem.name &&
                outputItem.arguments
              ) {
                handleFunctionCall(
                  openaiWs,
                  {
                    name: outputItem.name,
                    call_id: outputItem.call_id,
                    arguments: outputItem.arguments,
                  },
                  (newAgentConfig) => {
                    currentAgent = newAgentConfig;
                  }
                );
              }
            });
          }
          break;
        }
        default:
          break;
      }
    } catch (err) {
      console.error("Error processing OpenAI message:", err);
    }
  });

  openaiWs.on("error", (err) => {
    console.error("Error during WS connection with OpenAI:", err);
  });

  openaiWs.on("close", () => {
    console.log("OpenAI WS connection closed");
  });

  // Messages from Twilio call to OpenAi
  clientWs.on("message", (message) => {
    try {
      const data = JSON.parse(message.toString());

      switch (data.event) {
        case "start": {
          streamSid = data.start.streamSid;
          console.log(`Stream iniciado: ${streamSid}`, data.start);

          // Reset start and media timestamp on a new stream
          responseStartTimestampTwilio = null;
          latestMediaTimestamp = 0;
          break;
        }
        case "media": {
          latestMediaTimestamp = data.media.timestamp;

          if (openaiWs.readyState === WebSocket.OPEN) {
            sendEventToOpenAi(openaiWs, {
              type: "input_audio_buffer.append",
              audio: data.media.payload,
            });
          }
          break;
        }
        case "mark":
          {
            if (markQueue.length > 0) {
              markQueue.shift();
            }
          }
          break;
      }
    } catch (err) {
      console.error("Error processing Twilio client message:", err);
    }
  });

  clientWs.on("close", () => {
    console.log("Twilio client disconnected.");
    if (
      openaiWs.readyState === WebSocket.OPEN ||
      openaiWs.readyState === WebSocket.CONNECTING
    ) {
      openaiWs.close();
    }
  });

  clientWs.on("error", (err) => {
    console.error("Error during Twilio client WS connection:", err);
  });
});

server.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

// Necessary to make bot greet without the need for the user to speak first
function forceBotGreeting(openaiWs: WebSocket) {
  const id = uuidv4().slice(0, 32);
  const simulatedUserInput = "Hi";

  sendEventToOpenAi(openaiWs, {
    type: "conversation.item.create",
    item: {
      id,
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: simulatedUserInput }],
    },
  });

  sendEventToOpenAi(openaiWs, { type: "response.create" });
}

function sendSessionUpdate(openaiWs: WebSocket, currentAgent: AgentConfig) {
  const instructions = currentAgent?.instructions || "";
  const tools = currentAgent?.tools || [];

  const sessionUpdate = {
    type: "session.update",
    session: {
      modalities: ["text", "audio"],
      instructions,
      voice: "coral",
      input_audio_format: "g711_ulaw", // Audio format required by Twilio
      output_audio_format: "g711_ulaw",
      input_audio_transcription: { model: "whisper-1" },
      turn_detection: {
        type: "server_vad",
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 200,
        create_response: true,
      },
      tools,
    },
  };

  sendEventToOpenAi(openaiWs, sessionUpdate);
}

async function handleFunctionCall(
  openaiWs: WebSocket,
  functionCallParams: {
    name: string;
    call_id?: string;
    arguments: string;
  },
  onNewAgent?: (newAgentConfig: AgentConfig) => void
) {
  const args = JSON.parse(functionCallParams.arguments);

  console.log(`function call: ${functionCallParams.name}`, args);

  if (functionCallParams.name === "transferAgents") {
    const destinationAgent = args.destination_agent;
    const newAgentConfig =
      agents?.find((a) => a.name === destinationAgent) || null;
    if (newAgentConfig) {
      onNewAgent?.(newAgentConfig);
      console.log("new agent", newAgentConfig);

      sendSessionUpdate(openaiWs, newAgentConfig);
    }
    const functionCallOutput = {
      destination_agent: destinationAgent,
      did_transfer: !!newAgentConfig,
    };
    sendEventToOpenAi(openaiWs, {
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: functionCallParams.call_id,
        output: JSON.stringify(functionCallOutput),
      },
    });
    console.log(
      `function call: ${functionCallParams.name} response`,
      functionCallOutput
    );

    sendEventToOpenAi(openaiWs, { type: "response.create" });
  } else {
    const simulatedResult = { result: true };
    console.log(
      `function call fallback: ${functionCallParams.name}`,
      simulatedResult
    );

    sendEventToOpenAi(openaiWs, {
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: functionCallParams.call_id,
        output: JSON.stringify(simulatedResult),
      },
    });
    sendEventToOpenAi(openaiWs, { type: "response.create" });
  }
}

function sendMark(clientWs: WebSocket, streamSid: string, markQueue: string[]) {
  const markEvent = {
    event: "mark",
    streamSid: streamSid,
    mark: { name: "responsePart" },
  };
  sendEventToTwilio(clientWs, markEvent);
  markQueue.push("responsePart");
}

function sendEventToOpenAi(
  openaiWs: WebSocket,
  event: {
    type: string;
    [x: string]: any;
  }
) {
  openaiWs.send(JSON.stringify(event));
}

function sendEventToTwilio(
  clientWs: WebSocket,
  event: {
    event: string;
    [x: string]: any;
  }
) {
  clientWs.send(JSON.stringify(event));
}
