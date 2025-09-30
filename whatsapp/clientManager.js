const { Client, LocalAuth } = require("whatsapp-web.js");
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
        authStrategy: new LocalAuth({ clientId: userId }),
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
        clients[userId] = clientWrapper;
        delete initialisingClients[userId];
        resolve(clientWrapper);
      });

      client.on("authenticated", async (session) => {
    console.log("[DEBUG] Event: 'authenticated'. Attempting to save session to DB.");
    try {
        await saveSession(userId, session);
        console.log("[DEBUG] Session saved to DB successfully!");
    } catch (error) {
        console.error("[DEBUG] CRITICAL ERROR: Failed to save session to DB.", error);
    }
    
    if (clients[userId]) {
        clients[userId].qr = null; 
    }
});

      client.on("ready", () => {
        console.log(`✅ WhatsApp client ready for user ${userId}`);
        clientWrapper.qr = null;
        clients[userId] = clientWrapper;
        delete initialisingClients[userId];
        resolve(clientWrapper);
      });

      client.on("auth_failure", (msg) => {
        console.error("Authentication failure", msg);
        delete clients[userId];
        delete initialisingClients[userId];
        reject(new Error("Authentication failure"));
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
