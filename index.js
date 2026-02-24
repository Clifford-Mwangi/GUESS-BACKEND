require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { MongoClient } = require("mongodb");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// --- MongoDB setup ---
const uri = process.env.MONGO_URI; // your Render env variable
const client = new MongoClient(uri);

let db;
let playersCollection;
let houseCollection;

// Connect to MongoDB
async function connectDB() {
  try {
    await client.connect();
    db = client.db("guessgame"); // database name
    playersCollection = db.collection("players");
    houseCollection = db.collection("houseBank");

    // Initialize houseBank if not present
    const houseExists = await houseCollection.findOne({ _id: "mainHouse" });
    if (!houseExists) {
      await houseCollection.insertOne({ _id: "mainHouse", balance: 0 });
    }

    console.log("✅ Connected to MongoDB");
  } catch (err) {
    console.error("❌ MongoDB connection failed:", err);
  }
}

connectDB();

// --- Utility ---
function generateSecret() {
  return Math.floor(Math.random() * 20) + 1;
}

// --- LOGIN ---
app.post("/login", async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: "Username required" });

  let player = await playersCollection.findOne({ username });

  if (!player) {
    player = {
      username,
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

// --- PLAY ROUND ---
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

  // --- Player wins ---
  if (guess === player.secretNumber) {
    let winnings;
    if (player.remainingGuesses === 2) winnings = 35;
    else if (player.remainingGuesses === 1) winnings = 25;
    else winnings = 20;

    player.wallet += winnings;
    house.balance -= winnings;

    // Reset for next round
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

  // --- Player loses round ---
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

  // --- Player guess too high or low ---
  await playersCollection.updateOne({ username }, { $set: player });

  res.json({
    result: guess > player.secretNumber ? "high" : "low",
    remainingGuesses: player.remainingGuesses,
    wallet: player.wallet,
  });
});

// --- GET HOUSE BANK (Admin only later) ---
app.get("/house", async (req, res) => {
  const house = await houseCollection.findOne({ _id: "mainHouse" });
  res.json({ houseBank: house.balance });
});

// --- Start server ---
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// mongodb+srv://cliffordmwangi924_db_user:Phenomenon05@cluster0.7nsqy7b.mongodb.net/?appName=Cluster0
