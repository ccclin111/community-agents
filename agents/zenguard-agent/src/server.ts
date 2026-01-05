import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import rateLimit from "express-rate-limit";
import { HumanMessage, BaseMessage } from "@langchain/core/messages";
import { zenGuardWorkflow } from "./graph/workflow";
import { randomUUID } from "crypto";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// Rate Limiting Configuration
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per 15 min per IP
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply rate limiting globally
app.use(limiter);

// Session Configuration
const SESSION_TTL = 30 * 60 * 1000; // 30 minutes
const MAX_SESSIONS = 1000;
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes

// Session-based Memory Store
const sessions = new Map<string, BaseMessage[]>();
const sessionLastActive = new Map<string, number>();

// Session Cleanup Function
const cleanupExpiredSessions = () => {
  const now = Date.now();
  let cleanedCount = 0;

  for (const [sessionId, lastActive] of sessionLastActive.entries()) {
    if (now - lastActive > SESSION_TTL) {
      sessions.delete(sessionId);
      sessionLastActive.delete(sessionId);
      cleanedCount++;
    }
  }

  if (cleanedCount > 0) {
    console.log(`🧹 Cleaned ${cleanedCount} expired sessions. Active: ${sessions.size}`);
  }
};

// Start cleanup interval
setInterval(cleanupExpiredSessions, CLEANUP_INTERVAL);

// Helper: Remove oldest session if at capacity
const enforceSessionLimit = () => {
  if (sessions.size >= MAX_SESSIONS) {
    let oldestId: string | null = null;
    let oldestTime = Infinity;

    for (const [sessionId, lastActive] of sessionLastActive.entries()) {
      if (lastActive < oldestTime) {
        oldestTime = lastActive;
        oldestId = sessionId;
      }
    }

    if (oldestId) {
      sessions.delete(oldestId);
      sessionLastActive.delete(oldestId);
      console.log(`⚠️ Max sessions reached. Removed oldest: ${oldestId.slice(0, 8)}...`);
    }
  }
};

// Health Check Endpoint (Required by Warden Agent Hub)
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    agent: "ZenGuard",
    version: "1.0.0",
    activeSessions: sessions.size,
    maxSessions: MAX_SESSIONS,
    sessionTTL: `${SESSION_TTL / 60000} minutes`,
  });
});

// Main Chat Endpoint (Stateful)
app.post("/api/chat", async (req, res) => {
  try {
    const { message, sessionId: providedSessionId } = req.body;

    if (!message) {
      return res.status(400).json({ error: "Message is required" });
    }

    // Generate or use provided sessionId
    const sessionId = providedSessionId || randomUUID();

    // Retrieve or initialize session history
    if (!sessions.has(sessionId)) {
      enforceSessionLimit(); // Check capacity before adding new session
      sessions.set(sessionId, []);
      console.log(`\n>>> [API] New session created: ${sessionId}`);
    }

    // Update last active timestamp
    sessionLastActive.set(sessionId, Date.now());

    const history = sessions.get(sessionId)!;

    console.log(`>>> [API] Session ${sessionId.slice(0, 8)}... | Message: "${message}"`);

    // Add user message to history
    history.push(new HumanMessage(message));

    // Invoke workflow with FULL conversation history
    const result = await zenGuardWorkflow.invoke({
      messages: history,
    });

    // Get AI response and add to history
    const aiResponse = result.messages[result.messages.length - 1];
    history.push(aiResponse);

    const responseText =
      typeof aiResponse.content === "string"
        ? aiResponse.content
        : JSON.stringify(aiResponse.content);

    console.log(`>>> [API] Response sent. History length: ${history.length}`);

    res.json({
      response: responseText,
      sessionId: sessionId,
      historyLength: history.length,
      metrics: result.metrics,
      interventionLevel: result.interventionLevel,
      wardenIntent: result.wardenIntent || null,
    });
  } catch (error: any) {
    console.error("[API Error]", error.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Clear Session Endpoint
app.delete("/api/session/:sessionId", (req, res) => {
  const { sessionId } = req.params;

  if (sessions.has(sessionId)) {
    sessions.delete(sessionId);
    sessionLastActive.delete(sessionId);
    console.log(`>>> [API] Session ${sessionId.slice(0, 8)}... deleted.`);
    res.json({ success: true, message: `Session ${sessionId} cleared.` });
  } else {
    res.status(404).json({ error: "Session not found" });
  }
});

// List Sessions Endpoint (for debugging)
app.get("/api/sessions", (req, res) => {
  const now = Date.now();
  const sessionList = Array.from(sessions.entries()).map(([id, messages]) => ({
    sessionId: id,
    messageCount: messages.length,
    lastActive: sessionLastActive.get(id),
    expiresIn: `${Math.round((SESSION_TTL - (now - (sessionLastActive.get(id) || 0))) / 60000)} minutes`,
  }));
  res.json({ sessions: sessionList, total: sessions.size });
});

app.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════════════════════════════╗
  ║              🧘 ZenGuard API Server Running               ║
  ╠═══════════════════════════════════════════════════════════╣
  ║  POST   /api/chat              - Chat (with memory)       ║
  ║  DELETE /api/session/:id       - Clear session            ║
  ║  GET    /api/sessions          - List all sessions        ║
  ║  GET    /health                - Health check             ║
  ╠═══════════════════════════════════════════════════════════╣
  ║  Session TTL: ${SESSION_TTL / 60000} min | Max: ${MAX_SESSIONS} | Cleanup: ${CLEANUP_INTERVAL / 60000} min   ║
  ║  Server: http://localhost:${PORT}                          ║
  ╚═══════════════════════════════════════════════════════════╝
  `);
});
