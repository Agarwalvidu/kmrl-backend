const express = require("express");
const auth = require("../middleware/auth");
const Message = require("../models/Message");
const path = require("path");
const axios = require("axios");
const router = express.Router();

// Get all messages for user
router.get("/", auth, async (req, res) => {
  try {
    const messages = await Message.find({ userId: req.user.id }).sort({ date: -1 });
    res.json(messages);
  } catch (err) {
    res.status(500).send("Server error");
  }
});

// Download media
router.get("/download/:id", auth, async (req, res) => {
  try {
    const message = await Message.findById(req.params.id);
    if (!message || message.type !== "media") {
      return res.status(404).json({ msg: "Media not found" });
    }

    res.download(path.resolve(message.path), message.fileName);
  } catch (err) {
    res.status(500).send("Server error");
  }
});

router.post("/analyze", auth, async (req, res) => {
  try {
    const messages = await Message.find({ userId: req.user.id, type: "text" }).sort({ date: -1 });

    if (!messages.length) {
      return res.status(404).json({ msg: "No text messages found" });
    }

    const analyzed = [];
    for (let msg of messages) {
      // Skip if already analyzed
      if (msg.analysis && msg.analysis.summary) {
        analyzed.push(msg);
        continue;
      }

      // Call KMRL API
      const response = await axios.post(
        "https://sripriya16-kmrl-document-analyzer.hf.space/api/predict",
        { data: [msg.body] }
      );

      // Example: extract relevant fields
      const apiData = response.data;
      msg.analysis = {
        isRelevant: apiData?.data?.includes("Relevant") || false,
        summary: apiData?.data?.[1] || "",
        raw: apiData
      };

      await msg.save();
      analyzed.push(msg);
    }

    res.json(analyzed);

  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});

module.exports = router;
