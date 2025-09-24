const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  whatsappSession: { type: Object, default: {} }, // store WA session info
});

module.exports = mongoose.model("User", userSchema);
