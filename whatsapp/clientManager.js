const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode");
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");
const fetch = require("node-fetch");
const Message = require("../models/Message");
const { text } = require("stream/consumers");

const clients = {};

// Helper function: send file to your Flask API (/analyze)
async function analyzeWithKMRLApi(filePath) {
  const form = new FormData();
  form.append("file", fs.createReadStream(filePath));

  try {
    const response = await fetch("https://kmrl-document-analysis-1.onrender.com/analyze", {
      method: "POST",
      body: form,
      headers: form.getHeaders(), // Important for multipart/form-data
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`KMRL API error: ${text}`);
    }

    const result = await response.json();
    return result;
  } catch (err) {
    throw new Error(`Predict error: ${err.message}`);
  }
}

function createClient(userId) {
  if (clients[userId]) return clients[userId];

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: userId }),
  });

  client.on("qr", async (qr) => {
    const qrCodeImage = await qrcode.toDataURL(qr);
    clients[userId].qr = qrCodeImage;
  });

  client.on("ready", () => {
    console.log(`✅ WhatsApp client ready for user ${userId}`);
  });

  client.on("message", async (msg) => {
    try {
      // MEDIA MESSAGES
      if (msg.hasMedia) {
        const media = await msg.downloadMedia();
        const extension = media.mimetype.split("/")[1] || "bin"; // fallback
        const fileName = `${Date.now()}.${extension}`;
        const userDir = path.join("uploads", userId.toString());
        if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });

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

        console.log(`📂 Media saved for ${userId}: ${fileName}`);

        // Analyze document using KMRL API
        if (["pdf", "txt", "png", "jpg", "jpeg"].includes(extension)) {
          try {
            const apiData = await analyzeWithKMRLApi(fullFilePath);
            console.log("📊 KMRL API response:", apiData);

            savedMsg.analysis = {
              isRelevant: apiData?.is_relevant ?? false,
              summary: apiData?.summary || "",
              raw: apiData,
            };

            try {
              await savedMsg.save();
            } catch (err) {
              console.error("Failed to save message with analysis:", err.message);
            }

            console.log(`📝 File analyzed for ${userId}: ${fileName}`);

             if (savedMsg.type === "text" || (savedMsg.type === "media" && savedMsg.analysis && !savedMsg.analysis.isRelevant))  {
      // Delete file from disk
      if (savedMsg.type === "media" && savedMsg.path && fs.existsSync(savedMsg.path)) {
      fs.unlinkSync(savedMsg.path);
    }

      // Delete document from MongoDB
      await Message.findByIdAndDelete(savedMsg._id);

      console.log(`❌ Irrelevant media deleted: ${fileName}`);
    }
          } catch (err) {
            console.error("KMRL API Analysis failed:", err.message);
          }
        }
      } 
      // TEXT MESSAGES
      else if (msg.body) {
        const savedMsg = await Message.create({
    userId,
    from: msg.from,
    type: "text",
    body: msg.body,
  });
        console.log(`💬 Text saved for ${userId}: ${msg.body}`);
        await Message.findByIdAndDelete(savedMsg._id);
  console.log(`❌ Text message deleted: ${msg.body}`);
      }
    } catch (err) {
      console.error("Message handling error:", err.message);
    }
  });

  client.initialize();
  clients[userId] = { client, qr: null };
  return clients[userId];
}

function getClient(userId) {
  return clients[userId];
}

module.exports = { createClient, getClient };
