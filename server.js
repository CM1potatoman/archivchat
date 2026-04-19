const { WebSocketServer } = require("ws");
const http = require("http");
const mongoose = require("mongoose");

const PORT = process.env.PORT || 8080;
const MONGO_URI = "mongodb+srv://rustiarhedmarcus_db_user:bruhman123@cluster0.5trtutu.mongodb.net/archivist?appName=Cluster0";

// ==================== SCHEMA ====================
const messageSchema = new mongoose.Schema({
  type: { type: String, enum: ["chat", "system"], required: true },
  username: { type: String, required: true },
  message: { type: String, required: true },
  timestamp: { type: Number, required: true },
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

      // Kill duplicate socket for same username
      if (clients.has(username)) {
        const old = clients.get(username);
        if (old !== socket) {
          console.log(`⚠️ Duplicate join for ${username}, closing old socket`);
          old.terminate();
        }
      }

      clients.set(username, socket);
      console.log(`👋 JOIN: ${username} (${clients.size} online)`);

      // Delay history by 1.5s to give Lua time to attach OnMessage handler
      setTimeout(async () => {
        if (socket.readyState !== 1) return;
        try {
          const history = await Message.find({ type: "chat" })
            .sort({ timestamp: -1 })
            .limit(50)
            .lean();

          history.reverse().forEach((msg) => {
            if (socket.readyState === 1) {
              socket.send(JSON.stringify({
                type: msg.type,
                username: msg.username,
                message: msg.message,
                timestamp: msg.timestamp,
              }));
            }
          });
          console.log(`📜 Sent ${history.length} history messages to ${username}`);
        } catch (e) {
          console.error("❌ History error:", e.message);
        }
      }, 1500);

      // Broadcast join notice to everyone else
      const joinMsg = {
        type: "system",
        username: "Archivist",
        message: `${username} joined`,
        timestamp: Date.now(),
      };
      try { await Message.create(joinMsg); } catch (e) { console.error("❌ Save error:", e.message); }
      broadcastExclude(JSON.stringify(joinMsg), username);
    }

    // ---- CHAT ----
    if (data.type === "chat" && username && data.message) {
      const text = String(data.message).slice(0, 200);
      console.log(`💬 ${username}: ${text}`);

      const msg = {
        type: "chat",
        username,
        message: text,
        timestamp: Date.now(),
      };

      try { await Message.create(msg); } catch (e) { console.error("❌ Save error:", e.message); }

      const json = JSON.stringify(msg);
      for (const [, client] of clients.entries()) {
        if (client.readyState === 1) {
          client.send(json);
        }
      }
    }
  });

  socket.on("close", async () => {
    console.log(`👋 DISCONNECT: ${username || "unknown"}`);

    if (username && clients.get(username) === socket) {
      clients.delete(username);

      const msg = {
        type: "system",
        username: "Archivist",
        message: `${username} left`,
        timestamp: Date.now(),
      };

      try { await Message.create(msg); } catch (e) { console.error("❌ Save error:", e.message); }
      broadcastExclude(JSON.stringify(msg), username);
    }
  });

  socket.on("error", (e) => console.error("⚠️ Socket error:", e.message));
});

function broadcastExclude(json, excludeUsername) {
  for (const [name, client] of clients.entries()) {
    if (name !== excludeUsername && client.readyState === 1) {
      client.send(json);
    }
  }
}

async function pruneHistory() {
  try {
    const count = await Message.countDocuments();
    if (count > 500) {
      const oldest = await Message.find()
        .sort({ timestamp: 1 })
        .limit(count - 500)
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
