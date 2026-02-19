const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 3000;

// --- In-memory storage (for now) ---
let players = {};
let houseBank = 0;

// --- Utility ---
function generateSecret() {
  return Math.floor(Math.random() * 20) + 1;
}

// --- LOGIN ---
app.post("/login", (req, res) => {
  const { username } = req.body;

  if (!username) {
    return res.status(400).json({ error: "Username required" });
  }

  if (!players[username]) {
    players[username] = {
      wallet: 100,
      secretNumber: generateSecret(),
      remainingGuesses: 3,
      winnings: 0,
    };
  }

  res.json({
    wallet: players[username].wallet,
    houseBank,
  });
});

// --- PLAY ROUND ---
app.post("/guess", (req, res) => {
  const { username, guess } = req.body;

  const player = players[username];

  if (!player) {
    return res.status(400).json({ error: "Player not found" });
  }

  if (player.wallet < 10 && player.remainingGuesses === 3) {
    return res.status(400).json({ error: "Not enough money" });
  }

  // Deduct stake once per 3 guesses
  if (player.remainingGuesses === 3) {
    player.wallet -= 10;
    houseBank += 10;
  }

  player.remainingGuesses--;

  if (guess === player.secretNumber) {
    let winnings;

    if (player.remainingGuesses === 2) winnings = 35;
    else if (player.remainingGuesses === 1) winnings = 25;
    else winnings = 20;

    player.wallet += winnings;
    houseBank -= winnings;

    player.secretNumber = generateSecret();
    player.remainingGuesses = 3;

    return res.json({
      result: "win",
      winnings,
      wallet: player.wallet,
      houseBank,
    });
  }
  if (player.remainingGuesses <= 0) {
    const correctNumber = player.secretNumber;

    player.secretNumber = generateSecret();
    player.remainingGuesses = 3;

    return res.json({
      result: "lose",
      correctNumber,
      wallet: player.wallet,
      houseBank,
    });
  }

  res.json({
    result: guess > player.secretNumber ? "high" : "low",
    remainingGuesses: player.remainingGuesses,
    wallet: player.wallet,
  });
});

// --- GET HOUSE BANK (Admin only later) ---
app.get("/house", (req, res) => {
  res.json({ houseBank });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
