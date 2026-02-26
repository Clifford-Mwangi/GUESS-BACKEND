require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient } = require("mongodb");
const { lipaNaMpesa } = require("./mpesa");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ======================
// DATABASE SETUP
// ======================

const client = new MongoClient(process.env.MONGO_URI);
let playersCollection, houseCollection;

async function connectDB() {
  await client.connect();
  const db = client.db("guessgame");
  playersCollection = db.collection("players");
  houseCollection = db.collection("houseBank");

  const houseExists = await houseCollection.findOne({ _id: "mainHouse" });
  if (!houseExists) {
    await houseCollection.insertOne({ _id: "mainHouse", balance: 0 });
  }

  console.log("✅ MongoDB Connected");
}
connectDB();

// ======================
// UTIL
// ======================

function generateSecret() {
  return Math.floor(Math.random() * 20) + 1;
}

// ======================
// LOGIN
// ======================

app.post("/login", async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: "Username required" });

  let player = await playersCollection.findOne({ username });

  if (!player) {
    player = {
      username,
      wallet: 0,
      secretNumber: generateSecret(),
      remainingGuesses: 3,
      totalDeposits: 0,
      totalWinnings: 0,
      totalLosses: 0,
    };

    await playersCollection.insertOne(player);
  }

  res.json({
    wallet: player.wallet,
    remainingGuesses: player.remainingGuesses,
  });
});

// ======================
// GUESS
// ======================

app.post("/guess", async (req, res) => {
  const { username, guess } = req.body;

  const player = await playersCollection.findOne({ username });
  if (!player) return res.status(404).json({ error: "Player not found" });

  if (player.wallet < 10 && player.remainingGuesses === 3)
    return res.status(400).json({ error: "Insufficient balance" });

  let house = await houseCollection.findOne({ _id: "mainHouse" });

  // Deduct stake once per round
  if (player.remainingGuesses === 3) {
    player.wallet -= 10;
    house.balance += 10;
  }

  player.remainingGuesses--;

  // WIN
  if (guess === player.secretNumber) {
    let winnings =
      player.remainingGuesses === 2
        ? 35
        : player.remainingGuesses === 1
          ? 25
          : 20;

    player.wallet += winnings;
    house.balance -= winnings;

    player.totalWinnings += winnings;

    player.secretNumber = generateSecret();
    player.remainingGuesses = 3;

    await playersCollection.updateOne({ username }, { $set: player });
    await houseCollection.updateOne({ _id: "mainHouse" }, { $set: house });

    return res.json({
      result: "win",
      winnings,
      wallet: player.wallet,
      remainingGuesses: player.remainingGuesses,
    });
  }

  // LOSE
  if (player.remainingGuesses <= 0) {
    const correctNumber = player.secretNumber;

    player.totalLosses += 10;

    player.secretNumber = generateSecret();
    player.remainingGuesses = 3;

    await playersCollection.updateOne({ username }, { $set: player });

    return res.json({
      result: "lose",
      correctNumber,
      wallet: player.wallet,
      remainingGuesses: player.remainingGuesses,
    });
  }

  await playersCollection.updateOne({ username }, { $set: player });

  res.json({
    result: guess > player.secretNumber ? "high" : "low",
    wallet: player.wallet,
    remainingGuesses: player.remainingGuesses,
  });
});

// ======================
// HOUSE BALANCE
// ======================

app.get("/house", async (req, res) => {
  const house = await houseCollection.findOne({ _id: "mainHouse" });
  res.json({ houseBank: house.balance });
});

// ======================
// DEPOSIT (MPESA STK)
// ======================

app.post("/deposit", async (req, res) => {
  const { username, phone, amount } = req.body;

  if (!username || !phone || !amount)
    return res.status(400).json({ error: "Missing fields" });

  try {
    const response = await lipaNaMpesa(phone, amount, username);
    res.json({ message: "STK Push sent", response });
  } catch (err) {
    res.status(500).json({ error: "Deposit failed" });
  }
});

// ======================
// MPESA CALLBACK
// ======================

app.post("/mpesa/callback", async (req, res) => {
  try {
    const callback = req.body?.Body?.stkCallback;
    if (!callback) return res.status(400).json({ message: "Invalid format" });

    if (callback.ResultCode === 0) {
      const items = callback.CallbackMetadata.Item;

      const amount = items.find((i) => i.Name === "Amount")?.Value;
      const username = items.find((i) => i.Name === "AccountReference")?.Value;

      const player = await playersCollection.findOne({ username });
      if (player) {
        player.wallet += amount;
        player.totalDeposits += amount;

        await playersCollection.updateOne({ username }, { $set: player });
      }
    }

    res.json({ message: "Callback processed" });
  } catch (err) {
    res.status(500).json({ error: "Callback error" });
  }
});

// ======================
// WITHDRAW
// ======================

app.post("/withdraw", async (req, res) => {
  const { username, amount } = req.body;

  const player = await playersCollection.findOne({ username });
  if (!player) return res.status(404).json({ error: "Player not found" });

  const netProfit = player.totalWinnings - player.totalLosses;

  if (netProfit < 50)
    return res.status(400).json({ error: "Minimum 50 KES profit required" });

  if (amount > player.wallet)
    return res.status(400).json({ error: "Insufficient balance" });

  player.wallet -= amount;

  await playersCollection.updateOne({ username }, { $set: player });

  res.json({ message: "Withdrawal initiated", wallet: player.wallet });
});

// ======================
// OWNER WITHDRAW
// ======================

app.post("/owner-withdraw", async (req, res) => {
  const { amount, password } = req.body;

  if (password !== process.env.ADMIN_PASSWORD)
    return res.status(403).json({ error: "Unauthorized" });

  const house = await houseCollection.findOne({ _id: "mainHouse" });

  if (amount > house.balance)
    return res.status(400).json({ error: "Not enough house balance" });

  house.balance -= amount;

  await houseCollection.updateOne({ _id: "mainHouse" }, { $set: house });

  res.json({ message: "Owner withdrawal successful" });
});

// ======================
// START SERVER
// ======================

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
