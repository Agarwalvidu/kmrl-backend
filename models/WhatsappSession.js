// models/WhatsappSession.js
const mongoose = require("mongoose");

const sessionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
  sessionData: { type: Object, required: true },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("WhatsappSession", sessionSchema);
