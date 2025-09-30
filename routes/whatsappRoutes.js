const express = require("express");
const auth = require("../middleware/auth");
const WhatsappSession = require("../models/WhatsappSession");
const { createClient, getClient } = require("../whatsapp/clientManager");
const router = express.Router();

// Get QR for user
router.get("/qr", auth, async (req, res) => {
  const userId = req.user.id;
  const client = await createClient(userId);
  res.json({ qr: client.qr });
});

// Get status (connected or waiting for QR)
router.get("/status", auth, async (req, res) => {
    const userId = req.user.id;
    const clientWrapper = await createClient(userId).catch(err => {
        console.error(err);
        return null; // Handle initialization errors
    });

    if (!clientWrapper || !clientWrapper.client) {
        return res.json({ status: "not_initialized", message: "Client is not running." });
    }

    try {
        const state = await clientWrapper.client.getState();

        // Check if the state is CONNECTED
        if (state === "CONNECTED") {
            return res.json({
                status: "connected",
                user: clientWrapper.client.info,
            });
        }

        // If not connected, check if there's a QR code to show
        if (clientWrapper.qr) {
            return res.json({
                status: "qr",
                qr: clientWrapper.qr,
            });
        }
        
        // Otherwise, it's likely starting up or in another state
        return res.json({ status: "loading", message: `Client state: ${state}` });

    } catch (error) {
        console.error("Error getting client state:", error.message);
        // If getState fails, it might mean the client is destroyed or in a bad state
        // Check for a QR code as a fallback
        if (clientWrapper.qr) {
            return res.json({ status: "qr", qr: clientWrapper.qr });
        }
        return res.json({ status: "disconnected", message: "Failed to get client status." });
    }
});

// Disconnect WhatsApp and clear session
router.post("/disconnect", auth, async (req, res) => {
  const userId = req.user.id;
  const clientObj = getClient(userId);

  if (!clientObj) return res.status(404).json({ error: "No active WhatsApp session found" });

  try {
    await clientObj.client.destroy();

    // Remove session from DB
    await WhatsappSession.deleteOne({ userId });

    // Remove from memory
    delete clientObj[userId];

    res.json({ message: "WhatsApp disconnected successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to disconnect WhatsApp" });
  }
});




module.exports = router;
