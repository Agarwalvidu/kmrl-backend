const { Client, RemoteAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode");
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");
const fetch = require("node-fetch");
const Message = require("../models/Message");
const WhatsappSession = require("../models/WhatsappSession");

const clients = {};
const initialisingClients = {};

// Define a directory to store temporary session files for RemoteAuth.
const SESSION_FILE_PATH = path.join(__dirname, ".wwebjs_auth");
if (!fs.existsSync(SESSION_FILE_PATH)) {
  fs.mkdirSync(SESSION_FILE_PATH, { recursive: true });
}

// The RemoteAuth store object to handle session saving/loading from MongoDB
const store = {
  save: async ({ session, clientId }) => {
    let effectiveClientId = clientId;
    // Workaround for a bug where clientId is sometimes null on the initial save.
    if (!effectiveClientId && typeof session === 'string' && session.startsWith('RemoteAuth-')) {
        effectiveClientId = session.split('-')[1];
    }

    if (effectiveClientId) {
        const sessionFilePath = path.join(SESSION_FILE_PATH, `${session}.zip`);
        try {
            // Read the session file content and convert it to a storable format (base64).
            const fileData = await fs.promises.readFile(sessionFilePath);
            const sessionData = fileData.toString('base64');

            // Save the actual session data to MongoDB.
            await WhatsappSession.findOneAndUpdate(
                { userId: effectiveClientId },
                { 
                    $set: { 
                        sessionData: sessionData,
                        updatedAt: new Date() 
                    } 
                },
                { upsert: true }
            );
        } catch (err) {
            console.error(`[store.save] ERROR: Failed to read session file for client ${effectiveClientId}.`, err);
        }
    } else {
        console.error(`[store.save] ERROR: Could not determine a clientId to save the session.`);
    }
  },
  extract: async ({ clientId }) => {
    if (!clientId) return null;
    const record = await WhatsappSession.findOne({ userId: clientId });
    
    if (record && record.sessionData) {
        const sessionFileName = `RemoteAuth-${clientId}`;
        const sessionFilePath = path.join(SESSION_FILE_PATH, `${sessionFileName}.zip`);
        try {
            // Decode the session data and write it back to a local file for the library to use.
            const fileData = Buffer.from(record.sessionData, 'base64');
            await fs.promises.writeFile(sessionFilePath, fileData);
            // Return the session name, which the library uses to find the file.
            return sessionFileName;
        } catch (err) {
            console.error(`[store.extract] ERROR: Failed to write session file for client ${clientId}.`, err);
            return null;
        }
    }
    return null;
  },
  delete: async ({ clientId }) => {
    await WhatsappSession.deleteOne({ userId: clientId });
  },
  sessionExists: async ({ clientId }) => {
    if (!clientId) return false;
    const record = await WhatsappSession.findOne({ userId: clientId });
    return record != null;
  },
};

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
  if (!userId) {
    console.error("ERROR: createClient called with a null or undefined userId.");
    return Promise.reject(
      new Error("A valid User ID is required to create a WhatsApp client.")
    );
  }

  if (clients[userId]) {
    return clients[userId];
  }
  if (initialisingClients[userId]) {
    return initialisingClients[userId];
  }

  const clientPromise = new Promise(async (resolve, reject) => {
    try {
      const client = new Client({
        authStrategy: new RemoteAuth({
          store: store,
          clientId: userId,
          dataPath: SESSION_FILE_PATH,
          backupSyncIntervalMs: 300000,
        }),
        puppeteer: {
          headless: true,
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-accelerated-2d-canvas",
            "--no-first-run",
            "--no-zygote",
            "--single-process",
            "--disable-gpu",
          ],
        },
      });

      const clientWrapper = { client, qr: null };

      client.on("qr", async (qr) => {
        console.log(`📌 QR code received for user ${userId}. Scan to authenticate!`);
        const qrCodeImage = await qrcode.toDataURL(qr);
        clientWrapper.qr = qrCodeImage;
        if (!clients[userId]) {
          resolve(clientWrapper);
        }
      });

      client.on("ready", () => {
        console.log(`✅ WhatsApp client ready for user ${userId}`);
        clientWrapper.qr = null;
        clients[userId] = clientWrapper;
        delete initialisingClients[userId];
        resolve(clientWrapper);
      });

      client.on("remote_session_saved", () => {
        console.log(`Remote session for user ${userId} saved to DB.`);
      });

      client.on("auth_failure", (msg) => {
        console.error(`Authentication failure for user ${userId}:`, msg);
        delete initialisingClients[userId];
        reject(new Error("Authentication failure"));
      });

      client.on("disconnected", async (reason) => {
        console.log(`Client for user ${userId} was logged out:`, reason);
        try {
          await store.delete({ clientId: userId });
        } catch (err) {
          console.error("Failed to delete session from DB on disconnect:", err);
        }
        delete clients[userId];
      });

      client.on("message", async (msg) => {
        try {
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
                await savedMsg.save();

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
          } else if (msg.body) {
            // This section currently saves a text message and immediately deletes it.
            // If this is not the desired behavior, you may want to adjust the logic.
            const savedMsg = await Message.create({
              userId,
              from: msg.from,
              type: "text",
              body: msg.body,
            });
            console.log(`💬 Text received: ${msg.body}`);
            await Message.findByIdAndDelete(savedMsg._id);
            console.log(`🗑️ Text message auto-deleted: ${msg.body}`);
          }
        } catch (err) {
          console.error("Message handling error:", err.message);
        }
      });

      await client.initialize();
    } catch (err) {
      console.error(`Failed to create client for user ${userId}:`, err);
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

