const { WebSocketServer } = require("ws");
const http = require("http");

const PORT = process.env.PORT || 8080;

// In-memory message history (last 200 messages)
const history = [];

function saveMessage(msg) {
  history.push(msg);
  if (history.length > 200) history.shift();
}

// Track connected clients: username -> ws
const clients = new Map();

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Archivist Chat Server");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (socket) => {
  let username = "";
  console.log("🔌 New connection");

  // Send history to new connection
  for (const msg of history.slice(-50)) {
    socket.send(JSON.stringify(msg));
  }
  console.log(`📜 Sent ${Math.min(history.length, 50)} history messages`);

  socket.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (data.type === "ping") return;

    if (data.type === "join" && data.username) {
      username = String(data.username).slice(0, 50);
      clients.set(username, socket);
      console.log(`👋 JOIN: ${username}`);

      const msg = {
        type: "system",
        username: "Archivist",
        message: `${username} joined`,
        timestamp: Date.now(),
      };

      saveMessage(msg);
      broadcast(JSON.stringify(msg), username);
    }

    if (data.type === "chat" && username && data.message) {
      const text = String(data.message).slice(0, 200);
      console.log(`💬 ${username}: ${text}`);

      const msg = {
        type: "chat",
        username,
        message: text,
        timestamp: Date.now(),
      };

      saveMessage(msg);
      const json = JSON.stringify(msg);

      // Send to everyone including sender
      for (const [, client] of clients.entries()) {
        if (client.readyState === 1) {
          client.send(json);
        }
      }
    }
  });

  socket.on("close", () => {
    console.log(`👋 DISCONNECT: ${username || "unknown"}`);
    if (username) {
      clients.delete(username);

      const msg = {
        type: "system",
        username: "Archivist",
        message: `${username} left`,
        timestamp: Date.now(),
      };

      saveMessage(msg);
      broadcast(JSON.stringify(msg));
    }
  });

  socket.on("error", (e) => console.error("⚠️ Socket error:", e.message));
});

function broadcast(json, excludeUsername) {
  for (const [name, client] of clients.entries()) {
    if (name !== excludeUsername && client.readyState === 1) {
      client.send(json);
    }
  }
}

server.listen(PORT, () => {
  console.log(`🚀 Archivist Chat running on port ${PORT}`);
});
