import http from 'node:http';
import { config } from './config.js';
import { createApp } from './app.js';
import { attachSockets } from './socket.js';
import { query } from './db.js';
import { clearQueue } from './services/matchmaking.js';
import { loadModel, score } from './services/toxicity.js';

// Moderation cannot run without the model, so load and warm it up before accepting chats.
try {
  await loadModel();
  await score(['warm up']);
  console.log('Toxicity model loaded.');
} catch (err) {
  console.error(`Could not load the moderation model: ${err.message}`);
  process.exit(1);
}

const app = createApp();
const server = http.createServer(app);
attachSockets(server);

// Chats and queue tickets left over from a crash or restart are cleared on boot.
await query("UPDATE chat_sessions SET ended_at = now(), end_reason = 'server restart' WHERE ended_at IS NULL");
await clearQueue();

server.listen(config.port, () => {
  console.log(`Unveil server listening on http://localhost:${config.port}`);
});
