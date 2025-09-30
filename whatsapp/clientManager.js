const { Client, LocalAuth, RemoteAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode");
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");
const fetch = require("node-fetch");
const Message = require("../models/Message");
const WhatsappSession = require("../models/WhatsappSession");

const clients = {};
const initialisingClients = {};

async function getSession(userId) {
  const record = await WhatsappSession.findOne({ userId });
  return record?.sessionData || null;
}

const store = {
  save: async ({ session, clientId }) => {
    // The clientId is the userId you passed to RemoteAuth
    await WhatsappSession.findOneAndUpdate(
      { userId: clientId },
      { sessionData: session },
      { upsert: true }
    );
  },
  fetch: async ({ clientId }) => {
    const record = await WhatsappSession.findOne({ userId: clientId });
    return record ? record.sessionData : null;
  },
  delete: async ({ clientId }) => {
    await WhatsappSession.deleteOne({ userId: clientId });
  }
};

async function saveSession(userId, session) {
  await WhatsappSession.findOneAndUpdate(
    { userId },
    { sessionData: session, updatedAt: new Date() },
    { upsert: true }
  );
}

async function analyzeWithKMRLApi(filePath) {
  const form = new FormData();
  form.append("file", fs.createReadStream(filePath));

  const response = await fetch(
    "https://kmrl-document-analysis-1.onrender.com/analyze",
    {
      method: "POST",
      body: form,
      headers: form.getHeaders(),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`KMRL API error: ${text}`);
  }

  return response.json();
}

async function createClient(userId) {
  // If a client already exists, return it
  if (clients[userId]) return clients[userId];

  // If a client is currently being initialized, return the ongoing promise
  if (initialisingClients[userId]) return initialisingClients[userId];

  const clientPromise = new Promise(async (resolve, reject) => {
    try {
      const client = new Client({
        authStrategy: new RemoteAuth({
    store: store,
    clientId: userId,
    backupSyncIntervalMs: 300000 // Correct value (5 minutes)
}),
        puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu'
        ],
    }
      });

      const clientWrapper = { client, qr: null };

      client.on("qr", async (qr) => {
        console.log("📌 Scan QR to authenticate!");
        const qrCodeImage = await qrcode.toDataURL(qr);
        clientWrapper.qr = qrCodeImage;
        resolve(clientWrapper); // Resolve with QR without storing client yet
      });

      client.on("ready", () => {
        console.log(`✅ WhatsApp client ready for user ${userId}`);
        clients[userId] = clientWrapper; // Store the client once it's fully ready
        delete initialisingClients[userId];
        resolve(clientWrapper);
      });

      client.on('remote_session_saved', () => {
        console.log(`[DEBUG] Remote session for user ${userId} saved to DB.`);
      });

      client.on("auth_failure", (msg) => {
        console.error(`Authentication failure for user ${userId}:`, msg);
        reject(new Error("Authentication failure"));
      });

      client.on('disconnected', async (reason) => {
        console.log(`Client for user ${userId} was logged out:`, reason);
        try {
          await store.delete({ clientId: userId });
        } catch (err) {
          console.error('Failed to delete session from DB on disconnect:', err);
        }
        delete clients[userId];
      });

      client.on("message", async (msg) => {
        try {
          // MEDIA MESSAGES

          if (msg.hasMedia) {
            const media = await msg.downloadMedia();

            const extension = media.mimetype.split("/")[1] || "bin";

            const fileName = `${Date.now()}.${extension}`;

            const userDir = path.join("uploads", userId.toString());

            if (!fs.existsSync(userDir))
              fs.mkdirSync(userDir, { recursive: true });

            const fullFilePath = path.join(userDir, fileName);

            fs.writeFileSync(fullFilePath, media.data, "base64");

            const savedMsg = await Message.create({
              userId,

              from: msg.from,

              type: "media",

              fileName,

              mimeType: media.mimetype,

              path: fullFilePath,
            });

            if (["pdf", "txt", "png", "jpg", "jpeg"].includes(extension)) {
              try {
                const apiData = await analyzeWithKMRLApi(fullFilePath);

                savedMsg.analysis = {
                  isRelevant: apiData?.is_relevant ?? false,

                  summary: apiData?.summary || "",

                  raw: apiData,
                };

                await savedMsg.save(); // Delete irrelevant media

                if (!savedMsg.analysis.isRelevant) {
                  if (fs.existsSync(savedMsg.path))
                    fs.unlinkSync(savedMsg.path);

                  await Message.findByIdAndDelete(savedMsg._id);

                  console.log(`❌ Irrelevant media deleted: ${fileName}`);
                }
              } catch (err) {
                console.error("KMRL API Analysis failed:", err.message);
              }
            }
          } // TEXT MESSAGES
          else if (msg.body) {
            const savedMsg = await Message.create({
              userId,

              from: msg.from,

              type: "text",

              body: msg.body,
            });

            console.log(`💬 Text saved: ${msg.body}`); // Auto-delete all text messages

            await Message.findByIdAndDelete(savedMsg._id);

            console.log(`❌ Text message deleted: ${msg.body}`);
          }
        } catch (err) {
          console.error("Message handling error:", err.message);
        }
      });

      await client.initialize();
    } catch (err) {
      console.error("Failed to create client:", err);
      delete initialisingClients[userId];
      reject(err);
    }
  });

  initialisingClients[userId] = clientPromise;
  return clientPromise;
}

function getClient(userId) {
  return clients[userId];
}

module.exports = { createClient, getClient };
