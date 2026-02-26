require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient } = require("mongodb");
const { lipaNaMpesa } = require("./mpesa"); // Import MPESA helper
const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ======================
// MONGODB SETUP
// ======================
const client = new MongoClient(process.env.MONGO_URI);
let db, playersCollection, houseCollection;

async function connectDB() {
  await client.connect();
  db = client.db("guessgame");
  playersCollection = db.collection("players");
  houseCollection = db.collection("houseBank");

  // Initialize houseBank if not exists
  const houseExists = await houseCollection.findOne({ _id: "mainHouse" });
  if (!houseExists) {
    await houseCollection.insertOne({ _id: "mainHouse", balance: 0 });
  }

  console.log("✅ Connected to MongoDB");
}

connectDB();

// ======================
// UTILITY
// ======================
function generateSecret() {
  return Math.floor(Math.random() * 20) + 1;
}

// ======================
// LOGIN ROUTE
// ======================
app.post("/login", async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: "Username required" });

  let player = await playersCollection.findOne({ username });
  if (!player) {
    player = {
      username,
      phone: req.body.phone || null,
      wallet: 100,
      secretNumber: generateSecret(),
      remainingGuesses: 3,
      winnings: 0,
    };
    await playersCollection.insertOne(player);
  }

  const house = await houseCollection.findOne({ _id: "mainHouse" });
  res.json({
    wallet: player.wallet,
    houseBank: house.balance,
  });
});

// ======================
// GUESS ROUTE
// ======================
app.post("/guess", async (req, res) => {
  const { username, guess } = req.body;
  const player = await playersCollection.findOne({ username });
  if (!player) return res.status(400).json({ error: "Player not found" });

  if (player.wallet < 10 && player.remainingGuesses === 3)
    return res.status(400).json({ error: "Not enough money" });

  let house = await houseCollection.findOne({ _id: "mainHouse" });

  // Deduct stake once per 3 guesses
  if (player.remainingGuesses === 3) {
    player.wallet -= 10;
    house.balance += 10;
  }

  player.remainingGuesses--;

  if (guess === player.secretNumber) {
    let winnings;
    if (player.remainingGuesses === 2) winnings = 35;
    else if (player.remainingGuesses === 1) winnings = 25;
    else winnings = 20;

    player.wallet += winnings;
    house.balance -= winnings;

    player.secretNumber = generateSecret();
    player.remainingGuesses = 3;

    await playersCollection.updateOne({ username }, { $set: player });
    await houseCollection.updateOne({ _id: "mainHouse" }, { $set: house });

    return res.json({
      result: "win",
      winnings,
      wallet: player.wallet,
      houseBank: house.balance,
    });
  }

  if (player.remainingGuesses <= 0) {
    const correctNumber = player.secretNumber;
    player.secretNumber = generateSecret();
    player.remainingGuesses = 3;
    await playersCollection.updateOne({ username }, { $set: player });
    return res.json({
      result: "lose",
      correctNumber,
      wallet: player.wallet,
      houseBank: house.balance,
    });
  }

  await playersCollection.updateOne({ username }, { $set: player });
  res.json({
    result: guess > player.secretNumber ? "high" : "low",
    remainingGuesses: player.remainingGuesses,
    wallet: player.wallet,
  });
});

// ======================
// GET HOUSE BANK
// ======================
app.get("/house", async (req, res) => {
  const house = await houseCollection.findOne({ _id: "mainHouse" });
  res.json({ houseBank: house.balance });
});

// ======================
// MPESA PAYMENT
// ======================
app.post("/pay", async (req, res) => {
  const { username, phone, amount } = req.body;
  if (!username || !phone || !amount)
    return res
      .status(400)
      .json({ error: "username, phone, and amount required" });

  const player = await playersCollection.findOne({ username });
  if (!player) return res.status(404).json({ error: "Player not found" });

  try {
    const response = await lipaNaMpesa(phone, amount);
    res.json({ message: "STK Push initiated", response });
  } catch (err) {
    console.error("MPESA ERROR:", err.response?.data || err.message);
    res.status(500).json({
      error: "Failed to initiate payment",
      details: err.response?.data || err.message,
    });
  }
});

// ======================
// MPESA CALLBACK
// ======================
app.post("/mpesa/callback", async (req, res) => {
  try {
    // Daraja sends the callback under Body.stkCallback
    const callback = req.body?.Body?.stkCallback;

    if (!callback) {
      console.log("⚠️ Unexpected callback format:", req.body);
      return res.status(400).json({ message: "Invalid callback format" });
    }

    const {
      ResultCode,
      ResultDesc,
      CallbackMetadata,
      MerchantRequestID,
      CheckoutRequestID,
    } = callback;

    console.log(
      "📩 MPESA CALLBACK RECEIVED:",
      JSON.stringify(callback, null, 2),
    );

    if (ResultCode === 0) {
      // Payment successful

      const items = CallbackMetadata.Item;

      // Extract data from callback
      const amountObj = items.find((i) => i.Name === "Amount");
      const phoneObj = items.find((i) => i.Name === "PhoneNumber");
      const receiptObj = items.find((i) => i.Name === "MpesaReceiptNumber");
      const accountRefObj = items.find((i) => i.Name === "AccountReference"); // <-- This is your username

      const amount = amountObj?.Value || 0;
      const phone = phoneObj?.Value; // For logging/debugging
      const receipt = receiptObj?.Value; // Transaction receipt
      const username = accountRefObj?.Value; // This is what we use to update wallet

      if (!username) {
        console.log("⚠️ AccountReference (username) missing in callback");
        return res.status(400).json({ message: "AccountReference missing" });
      }

      // Update player wallet using username (recommended)
      const player = await playersCollection.findOne({ username });
      if (!player) {
        console.log(`⚠️ No player found with username: ${username}`);
      } else {
        const newWallet = (player.wallet || 0) + amount;
        await playersCollection.updateOne(
          { username },
          { $set: { wallet: newWallet } },
        );
        console.log(
          `✅ Updated wallet for ${username}: +${amount}, new wallet = ${newWallet}`,
        );
      }

      // Optional: log phone and receipt for reference
      console.log(`📱 Phone used: ${phone}, Receipt: ${receipt}`);

      return res
        .status(200)
        .json({ message: "Payment processed successfully" });
    } else {
      // Payment failed
      console.log(`❌ Payment failed: ${ResultDesc}`);
      return res
        .status(200)
        .json({ message: "Payment failed", details: ResultDesc });
    }
  } catch (err) {
    console.error("❌ CALLBACK HANDLER ERROR:", err.message);
    res
      .status(500)
      .json({ message: "Callback processing error", error: err.message });
  }
});

// ======================
// TEST ROUTE
// ======================
app.get("/test", (req, res) => {
  console.log("TEST ROUTE HIT");
  res.json({ message: "Server working" });
});

// ======================
// START SERVER
// ======================
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
