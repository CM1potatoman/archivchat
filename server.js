const { WebSocketServer } = require("ws");
const http = require("http");
const mongoose = require("mongoose");

const PORT = process.env.PORT || 8080;
const MONGO_URI = "mongodb+srv://rustiarhedmarcus_db_user:bruhman123@cluster0.5trtutu.mongodb.net/archivist?appName=Cluster0";

// ==================== SCHEMA ====================
const messageSchema = new mongoose.Schema({
  type: { type: String, enum: ["chat", "system"], required: true },
  username: { type: String, required: true }, // Real name (for logs)
  displayName: { type: String, required: true }, // What users see
  message: { type: String, required: true },
  timestamp: { type: Number, required: true },
  scope: { type: String, enum: ["global", "server"], default: "global" },
  gameId: { type: String, default: "" },
  serverId: { type: String, default: "" }
});

const Message = mongoose.model("Message", messageSchema);

// ==================== MONGO ====================
mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((e) => console.error("❌ MongoDB error:", e.message));

// ==================== STATE ====================
const clients = new Map();

// ==================== SERVER ====================
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Archivist Chat Server");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (socket) => {
  let username = "";
  let displayName = "";
  let gameId = "";
  let serverId = "";
  console.log("🔌 New connection");

  socket.on("message", async (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (data.type === "ping") return;

    // ---- JOIN ----
    if (data.type === "join" && data.username) {
      username = String(data.username).slice(0, 50);
      displayName = String(data.displayName || data.username).slice(0, 50);
      gameId = String(data.gameId || "").slice(0, 100);
      serverId = String(data.serverId || "").slice(0, 100);

      if (clients.has(username)) {
        const old = clients.get(username);
        if (old.socket !== socket) {
          console.log(`⚠️ Duplicate join for ${username}, closing old socket`);
          old.socket.terminate();
        }
      }

      clients.set(username, { socket, displayName, gameId, serverId });
      console.log(`👋 JOIN: ${displayName} (${username}) (${clients.size} online)`);

      try {
        const globalHistory = await Message.find({ type: "chat", scope: "global" })
          .sort({ timestamp: -1 })
          .limit(50)
          .lean();

        const serverHistory = await Message.find({ 
          type: "chat", 
          scope: "server",
          gameId: gameId,
          serverId: serverId
        })
          .sort({ timestamp: -1 })
          .limit(50)
          .lean();

        const historyBatch = {
          type: "history",
          global: globalHistory.reverse(),
          server: serverHistory.reverse()
        };
        
        if (socket.readyState === 1) {
          socket.send(JSON.stringify(historyBatch));
          console.log(`📜 Sent ${globalHistory.length} global + ${serverHistory.length} server messages`);
        }
      } catch (e) {
        console.error("❌ History error:", e.message);
      }

      const joinMsg = {
        type: "system",
        username: "Archivist",
        displayName: "Archivist",
        message: `${displayName} joined`,
        timestamp: Date.now(),
        scope: "global"
      };
      try { await Message.create(joinMsg); } catch (e) { console.error("❌ Save error:", e.message); }
      broadcastExclude(JSON.stringify(joinMsg), username);
    }

    // ---- CHAT ----
    if (data.type === "chat" && username && data.message) {
      const text = String(data.message).slice(0, 200);
      const scope = data.scope === "server" ? "server" : "global";
      const msgDisplayName = String(data.displayName || username).slice(0, 50);
      console.log(`💬 [${scope}] ${msgDisplayName} (${username}): ${text}`);

      const msg = {
        type: "chat",
        username: username, // Real name for logs/identification
        displayName: msgDisplayName, // What everyone sees
        message: text,
        timestamp: Date.now(),
        scope,
        gameId,
        serverId
      };

      try { await Message.create(msg); } catch (e) { console.error("❌ Save error:", e.message); }

      const json = JSON.stringify(msg);
      
      if (scope === "global") {
        for (const [, client] of clients.entries()) {
          if (client.socket.readyState === 1) {
            client.socket.send(json);
          }
        }
      } else {
        for (const [, client] of clients.entries()) {
          if (client.gameId === gameId && client.serverId === serverId && client.socket.readyState === 1) {
            client.socket.send(json);
          }
        }
      }
    }
  });

  socket.on("close", async () => {
    console.log(`👋 DISCONNECT: ${displayName || username || "unknown"}`);

    if (username && clients.get(username)?.socket === socket) {
      clients.delete(username);

      const msg = {
        type: "system",
        username: "Archivist",
        displayName: "Archivist",
        message: `${displayName || username} left`,
        timestamp: Date.now(),
        scope: "global"
      };

      try { await Message.create(msg); } catch (e) { console.error("❌ Save error:", e.message); }
      broadcastExclude(JSON.stringify(msg), username);
    }
  });

  socket.on("error", (e) => console.error("⚠️ Socket error:", e.message));
});

function broadcastExclude(json, excludeUsername) {
  for (const [name, client] of clients.entries()) {
    if (name !== excludeUsername && client.socket.readyState === 1) {
      client.socket.send(json);
    }
  }
}

async function pruneHistory() {
  try {
    const count = await Message.countDocuments();
    if (count > 1000) {
      const oldest = await Message.find()
        .sort({ timestamp: 1 })
        .limit(count - 1000)
        .select("_id")
        .lean();
      await Message.deleteMany({ _id: { $in: oldest.map((m) => m._id) } });
      console.log(`🧹 Pruned ${oldest.length} old messages`);
    }
  } catch (e) {
    console.error("❌ Prune error:", e.message);
  }
}

setInterval(pruneHistory, 60 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`🚀 Archivist Chat running on port ${PORT}`);
});
