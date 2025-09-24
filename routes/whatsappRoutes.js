const express = require("express");
const auth = require("../middleware/auth");
const { createClient, getClient } = require("../whatsapp/clientManager");
const router = express.Router();

// Get QR for user
router.get("/qr", auth, async (req, res) => {
  const userId = req.user.id;
  const client = createClient(userId);
  res.json({ qr: client.qr });
});

// Get status (connected or waiting for QR)
router.get("/status", auth, async (req, res) => {
  const userId = req.user.id;
  const client = createClient(userId);

  if (!client) {
    return res.json({ status: "not_initialized" });
  }

  if (client.client && client.client.info) {
    return res.json({
      status: "connected",
      user: client.client.info,
    });
  }

  if (client.qr) {
    return res.json({
      status: "qr",
      qr: client.qr,
    });
  }

  return res.json({ status: "loading" });
});

// Disconnect WhatsApp and clear session
router.post("/disconnect", auth, async (req, res) => {
  const userId = req.user.id;
  const clientObj = getClient(userId);

  if (!clientObj) {
    return res.status(404).json({ error: "No active WhatsApp session found" });
  }

  try {
    // Destroy the WhatsApp client session
    await clientObj.client.destroy();

    // Remove the client from the in-memory clients object
    delete require.cache[require.resolve("../whatsapp/clientManager")]; // optional if needed
    delete clientObj.client;
    delete clientObj.qr;

    res.json({ message: "WhatsApp disconnected successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to disconnect WhatsApp" });
  }
});


module.exports = router;
