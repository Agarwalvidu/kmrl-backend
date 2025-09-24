const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const Message = require("../models/Message");

const clients = {};
const HUGGINGFACE_API_KEY = process.env.HUGGINGFACE_API_KEY;
const MODEL_ID = "Sripriya16/kmrl-document-analyzer"; // replace with your model ID

// Helper function: send PDF to Hugging Face Inference API
async function analyzePDFWithHf(filePath) {
  const fileStream = fs.createReadStream(filePath);

  try {
    const response = await fetch(`https://api-inference.huggingface.co/models/${MODEL_ID}`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${HUGGINGFACE_API_KEY}`,
      },
      body: fileStream,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Hugging Face API error: ${text}`);
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
        const extension = media.mimetype.split("/")[1];
        const fileName = `${Date.now()}.${extension}`;
        const filePath = path.join("uploads", userId.toString());
        if (!fs.existsSync(filePath)) fs.mkdirSync(filePath, { recursive: true });

        const fullFilePath = path.join(filePath, fileName);
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

        // Analyze PDFs using Hugging Face Inference API
        if (extension === "pdf") {
          try {
            const apiData = await analyzePDFWithHf(fullFilePath);
            savedMsg.analysis = {
              isRelevant: apiData?.data?.includes("Relevant") || false,
              summary: apiData?.data?.[1] || "",
              raw: apiData,
            };
            await savedMsg.save();
            console.log(`📝 PDF analyzed for ${userId}: ${fileName}`);
          } catch (err) {
            console.error("PDF API Analysis failed:", err.message);
          }
        }
      } 
      // TEXT MESSAGES
      else if (msg.body) {
        await Message.create({
          userId,
          from: msg.from,
          type: "text",
          body: msg.body,
        });
        console.log(`💬 Text saved for ${userId}: ${msg.body}`);
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
