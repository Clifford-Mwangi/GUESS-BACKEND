require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");
const { lipaNaMpesa } = require("./mpesa");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

// ======================
// MONGODB SETUP
// ======================
const client = new MongoClient(process.env.MONGO_URI);
let db, playersCollection, houseCollection, withdrawalsCollection;

async function connectDB() {
  await client.connect();
  db = client.db("guessgame");
  playersCollection = db.collection("players");
  houseCollection = db.collection("houseBank");
  withdrawalsCollection = db.collection("withdrawals");

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
      wallet: 0,
      sessionDeposit: 0,
      secretNumber: generateSecret(),
      remainingGuesses: 3,
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

  let house = await houseCollection.findOne({ _id: "mainHouse" });

  // Charge 10 KES only at start of round (3 guesses)
  if (player.remainingGuesses === 3) {
    if (player.wallet < 10)
      return res.status(400).json({ error: "Not enough money" });

    player.wallet -= 10;
    house.balance += 10;
  }

  player.remainingGuesses--;

  if (guess === player.secretNumber) {
    let winnings;

    if (player.remainingGuesses === 2) winnings = 35;
    else if (player.remainingGuesses === 1) winnings = 25;
    else winnings = 20;

    // Prevent house from going negative
    let payout = winnings;
    if (house.balance < winnings) {
      payout = house.balance;
      console.log("⚠️ House balance low. Payout capped.");
    }

    player.wallet += payout;
    house.balance -= payout;

    player.secretNumber = generateSecret();
    player.remainingGuesses = 3;

    await playersCollection.updateOne({ username }, { $set: player });
    await houseCollection.updateOne({ _id: "mainHouse" }, { $set: house });

    return res.json({
      result: "win",
      winnings: payout,
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
// RESET ROUTE
// ======================
app.post("/reset", async (req, res) => {
  const { username } = req.body;

  const player = await playersCollection.findOne({ username });
  if (!player) return res.status(404).json({ error: "Player not found" });

  player.secretNumber = generateSecret();
  player.remainingGuesses = 3;

  await playersCollection.updateOne({ username }, { $set: player });

  res.json({ message: "Round reset", remainingGuesses: 3 });
});

// ======================
// MPESA DEPOSIT ROUTE
// ======================
app.post("/pay", async (req, res) => {
  const { username, phone, amount } = req.body;

  if (!username || !phone || !amount)
    return res.status(400).json({ error: "username, phone, amount required" });

  if (amount < 10)
    return res.status(400).json({ error: "Minimum deposit is 10 KES" });

  const player = await playersCollection.findOne({ username });
  if (!player) return res.status(404).json({ error: "Player not found" });

  try {
    const response = await lipaNaMpesa(phone, amount, username);
    res.json({ message: "STK Push initiated", response });
  } catch (err) {
    res.status(500).json({ error: "Failed to initiate payment" });
  }
});

// ======================
// MPESA CALLBACK
// ======================
app.post("/mpesa/callback", async (req, res) => {
  try {
    const callback = req.body?.Body?.stkCallback;
    if (!callback)
      return res.status(400).json({ message: "Invalid callback format" });

    const { ResultCode, CallbackMetadata } = callback;

    if (ResultCode === 0) {
      const items = CallbackMetadata.Item;
      const amount = items.find((i) => i.Name === "Amount")?.Value;
      const username = items.find((i) => i.Name === "AccountReference")?.Value;

      const player = await playersCollection.findOne({ username });
      if (!player) return res.status(400).json({ message: "Player not found" });

      const fee = amount * 0.05;
      const netAmount = amount - fee;

      const newWallet = player.wallet + netAmount;
      const newSessionDeposit = player.sessionDeposit + netAmount;

      await playersCollection.updateOne(
        { username },
        { $set: { wallet: newWallet, sessionDeposit: newSessionDeposit } },
      );

      let house = await houseCollection.findOne({ _id: "mainHouse" });
      house.balance += fee;
      await houseCollection.updateOne({ _id: "mainHouse" }, { $set: house });

      console.log(`💰 Deposit successful:
User: ${username}
Gross: ${amount}
Fee: ${fee}
Net: ${netAmount}`);

      return res.status(200).json({ message: "Deposit processed" });
    }

    res.status(200).json({ message: "Payment failed" });
  } catch (err) {
    res.status(500).json({ error: "Callback processing error" });
  }
});

// ======================
// WITHDRAW ROUTE (MANUAL)
// ======================
app.post("/withdraw", async (req, res) => {
  const { username, amount, phone } = req.body;

  if (!username || !amount || !phone)
    return res.status(400).json({ error: "username, amount, phone required" });

  const player = await playersCollection.findOne({ username });
  if (!player) return res.status(404).json({ error: "Player not found" });

  const profit = player.wallet - player.sessionDeposit;

  if (profit < 50)
    return res.status(400).json({ error: "Minimum profit of 50 required" });

  if (amount > profit)
    return res.status(400).json({ error: "Cannot withdraw deposit money" });

  const fee = amount * 0.05;
  const netAmount = amount - fee;

  player.wallet -= amount;

  let house = await houseCollection.findOne({ _id: "mainHouse" });
  house.balance += fee;

  await playersCollection.updateOne({ username }, { $set: player });
  await houseCollection.updateOne({ _id: "mainHouse" }, { $set: house });

  const withdrawal = await withdrawalsCollection.insertOne({
    username,
    phone,
    grossAmount: amount,
    fee,
    netAmount,
    status: "pending",
    createdAt: new Date(),
  });

  console.log(`🚨 WITHDRAWAL REQUEST:
User: ${username}
Gross: ${amount}
Fee: ${fee}
Net to send: ${netAmount}`);

  res.json({
    message: "Withdrawal recorded",
    netAmount,
    withdrawalId: withdrawal.insertedId,
  });
});

// ======================
// ADMIN CONFIRM WITHDRAWAL
// ======================
app.post("/admin/confirm-withdrawal", async (req, res) => {
  const { withdrawalId } = req.body;

  const withdrawal = await withdrawalsCollection.findOne({
    _id: new ObjectId(withdrawalId),
  });

  if (!withdrawal)
    return res.status(404).json({ error: "Withdrawal not found" });

  if (withdrawal.status === "paid")
    return res.status(400).json({ error: "Already paid" });

  await withdrawalsCollection.updateOne(
    { _id: withdrawal._id },
    { $set: { status: "paid", paidAt: new Date() } },
  );

  console.log(`✅ Withdrawal completed for ${withdrawal.username}`);

  res.json({ message: "Marked as paid" });
});

// ======================
// ADMIN WITHDRAWAL
// ======================
app.get("/admin/withdrawals", async (req, res) => {
  const withdrawals = await withdrawalsCollection
    .find({})
    .sort({ createdAt: -1 })
    .toArray();

  res.json(withdrawals);
});
// ======================
// HOUSE BALANCE
// ======================
app.get("/house", async (req, res) => {
  const house = await houseCollection.findOne({ _id: "mainHouse" });
  res.json({ houseBank: house.balance });
});

// ======================
app.get("/test", (req, res) => {
  res.json({ message: "Server working ✅" });
});

// ======================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

// require("dotenv").config();
// const express = require("express");
// const cors = require("cors");
// const { MongoClient } = require("mongodb");
// const { lipaNaMpesa } = require("./mpesa"); // Import MPESA helper
// const app = express();

// app.use(cors());
// app.use(express.json());

// const PORT = process.env.PORT || 3000;

// // ======================
// // MONGODB SETUP
// // ======================
// const client = new MongoClient(process.env.MONGO_URI);
// let db, playersCollection, houseCollection;

// async function connectDB() {
//   await client.connect();
//   db = client.db("guessgame");
//   playersCollection = db.collection("players");
//   houseCollection = db.collection("houseBank");

//   // Initialize houseBank if not exists
//   const houseExists = await houseCollection.findOne({ _id: "mainHouse" });
//   if (!houseExists) {
//     await houseCollection.insertOne({ _id: "mainHouse", balance: 0 });
//   }

//   console.log("✅ Connected to MongoDB");
// }
// connectDB();

// // ======================
// // UTILITY
// // ======================
// function generateSecret() {
//   return Math.floor(Math.random() * 20) + 1;
// }

// // ======================
// // LOGIN ROUTE
// // ======================
// app.post("/login", async (req, res) => {
//   const { username } = req.body;
//   if (!username) return res.status(400).json({ error: "Username required" });

//   let player = await playersCollection.findOne({ username });

//   if (!player) {
//     player = {
//       username,
//       phone: req.body.phone || null,
//       wallet: 100,
//       secretNumber: generateSecret(),
//       remainingGuesses: 3,
//       winnings: 0,
//     };
//     await playersCollection.insertOne(player);
//   }

//   const house = await houseCollection.findOne({ _id: "mainHouse" });

//   res.json({
//     wallet: player.wallet,
//     houseBank: house.balance,
//   });
// });

// // ======================
// // GUESS ROUTE
// // ======================
// app.post("/guess", async (req, res) => {
//   const { username, guess } = req.body;
//   const player = await playersCollection.findOne({ username });
//   if (!player) return res.status(400).json({ error: "Player not found" });

//   if (player.wallet < 10 && player.remainingGuesses === 3)
//     return res.status(400).json({ error: "Not enough money" });

//   let house = await houseCollection.findOne({ _id: "mainHouse" });

//   // Deduct stake once per 3 guesses
//   if (player.remainingGuesses === 3) {
//     player.wallet -= 10;
//     house.balance += 10;
//   }

//   player.remainingGuesses--;

//   if (guess === player.secretNumber) {
//     let winnings;
//     if (player.remainingGuesses === 2) winnings = 35;
//     else if (player.remainingGuesses === 1) winnings = 25;
//     else winnings = 20;

//     player.wallet += winnings;
//     house.balance -= winnings;
//     player.secretNumber = generateSecret();
//     player.remainingGuesses = 3;

//     await playersCollection.updateOne({ username }, { $set: player });
//     await houseCollection.updateOne({ _id: "mainHouse" }, { $set: house });

//     return res.json({
//       result: "win",
//       winnings,
//       wallet: player.wallet,
//       houseBank: house.balance,
//     });
//   }

//   if (player.remainingGuesses <= 0) {
//     const correctNumber = player.secretNumber;
//     player.secretNumber = generateSecret();
//     player.remainingGuesses = 3;

//     await playersCollection.updateOne({ username }, { $set: player });

//     return res.json({
//       result: "lose",
//       correctNumber,
//       wallet: player.wallet,
//       houseBank: house.balance,
//     });
//   }

//   await playersCollection.updateOne({ username }, { $set: player });

//   res.json({
//     result: guess > player.secretNumber ? "high" : "low",
//     remainingGuesses: player.remainingGuesses,
//     wallet: player.wallet,
//   });
// });
// // ======================
// // RESET ROUND
// // ======================
// app.post("/reset", async (req, res) => {
//   try {
//     const { username } = req.body;

//     if (!username) {
//       return res.status(400).json({ error: "Username required" });
//     }

//     const player = await playersCollection.findOne({ username });
//     if (!player) {
//       return res.status(404).json({ error: "Player not found" });
//     }

//     player.secretNumber = generateSecret();
//     player.remainingGuesses = 3;

//     await playersCollection.updateOne({ username }, { $set: player });

//     console.log(`🔄 Round reset for ${username}`);

//     res.json({
//       message: "Round reset",
//       remainingGuesses: 3,
//     });
//   } catch (err) {
//     console.error("❌ RESET ERROR:", err.message);
//     res.status(500).json({ error: "Reset failed" });
//   }
// });

// // ======================
// // GET HOUSE BANK
// // ======================
// app.get("/house", async (req, res) => {
//   const house = await houseCollection.findOne({ _id: "mainHouse" });
//   res.json({ houseBank: house.balance });
// });

// // ======================
// // MPESA PAYMENT (DEPOSIT)
// // ======================
// app.post("/pay", async (req, res) => {
//   const { username, phone, amount } = req.body;
//   if (!username || !phone || !amount)
//     return res
//       .status(400)
//       .json({ error: "username, phone, and amount required" });

//   const player = await playersCollection.findOne({ username });
//   if (!player) return res.status(404).json({ error: "Player not found" });

//   try {
//     // === CHANGE HERE ===
//     // Use username as AccountReference so callback knows wallet
//     const response = await lipaNaMpesa(phone, amount, username);
//     res.json({ message: "STK Push initiated", response });
//   } catch (err) {
//     console.error("MPESA ERROR:", err.response?.data || err.message);
//     res.status(500).json({
//       error: "Failed to initiate payment",
//       details: err.response?.data || err.message,
//     });
//   }
// });

// // ======================
// // MPESA CALLBACK
// // ======================
// app.post("/mpesa/callback", async (req, res) => {
//   try {
//     const callback = req.body?.Body?.stkCallback;
//     if (!callback) {
//       console.log("⚠️ Unexpected callback format:", req.body);
//       return res.status(400).json({ message: "Invalid callback format" });
//     }

//     const { ResultCode, ResultDesc, CallbackMetadata } = callback;

//     console.log(
//       "📩 MPESA CALLBACK RECEIVED:",
//       JSON.stringify(callback, null, 2),
//     );

//     if (ResultCode === 0) {
//       const items = CallbackMetadata.Item;
//       const amountObj = items.find((i) => i.Name === "Amount");
//       const usernameObj = items.find((i) => i.Name === "AccountReference");
//       const amount = amountObj?.Value || 0;
//       const username = usernameObj?.Value;

//       if (!username) {
//         console.log("⚠️ AccountReference (username) missing in callback");
//         return res.status(400).json({ message: "AccountReference missing" });
//       }

//       const player = await playersCollection.findOne({ username });
//       if (!player) console.log(`⚠️ No player found with username: ${username}`);
//       else {
//         const newWallet = (player.wallet || 0) + amount;
//         await playersCollection.updateOne(
//           { username },
//           { $set: { wallet: newWallet } },
//         );
//         console.log(
//           `✅ Updated wallet for ${username}: +${amount}, new wallet = ${newWallet}`,
//         );
//       }

//       return res
//         .status(200)
//         .json({ message: "Payment processed successfully" });
//     } else {
//       console.log(`❌ Payment failed: ${ResultDesc}`);
//       return res
//         .status(200)
//         .json({ message: "Payment failed", details: ResultDesc });
//     }
//   } catch (err) {
//     console.error("❌ CALLBACK HANDLER ERROR:", err.message);
//     res
//       .status(500)
//       .json({ message: "Callback processing error", error: err.message });
//   }
// });

// // ======================
// // WITHDRAW ROUTE
// // ======================
// app.post("/withdraw", async (req, res) => {
//   const { username, amount } = req.body;
//   if (!username || !amount)
//     return res.status(400).json({ error: "username and amount required" });

//   const player = await playersCollection.findOne({ username });
//   if (!player) return res.status(404).json({ error: "Player not found" });

//   if (amount < 50)
//     return res.status(400).json({ error: "Minimum withdraw is 50 KES" });

//   if (player.wallet < amount)
//     return res.status(400).json({ error: "Insufficient wallet balance" });

//   let house = await houseCollection.findOne({ _id: "mainHouse" });

//   player.wallet -= amount;
//   house.balance += amount;

//   await playersCollection.updateOne({ username }, { $set: player });
//   await houseCollection.updateOne({ _id: "mainHouse" }, { $set: house });

//   res.json({
//     message: `Withdrawal request successful for ${amount} KES`,
//     wallet: player.wallet,
//     houseBank: house.balance,
//   });
// });

// // ======================
// // TEST ROUTE
// // ======================
// app.get("/test", (req, res) => {
//   res.json({ message: "Server working ✅" });
// });

// // ======================
// // START SERVER
// // ======================
// app.listen(PORT, () => {
//   console.log(`🚀 Server running on port ${PORT}`);
// });

// require("dotenv").config();
// const express = require("express");
// const cors = require("cors");
// const { MongoClient } = require("mongodb");
// const { lipaNaMpesa } = require("./mpesa");

// const app = express();
// app.use(cors());
// app.use(express.json());

// const PORT = process.env.PORT || 3000;

// // ======================
// // DATABASE SETUP
// // ======================

// const client = new MongoClient(process.env.MONGO_URI);
// let playersCollection, houseCollection;

// async function connectDB() {
//   await client.connect();
//   const db = client.db("guessgame");
//   playersCollection = db.collection("players");
//   houseCollection = db.collection("houseBank");

//   const houseExists = await houseCollection.findOne({ _id: "mainHouse" });
//   if (!houseExists) {
//     await houseCollection.insertOne({ _id: "mainHouse", balance: 0 });
//   }

//   console.log("✅ MongoDB Connected");
// }
// connectDB();

// // ======================
// // UTIL
// // ======================

// function generateSecret() {
//   return Math.floor(Math.random() * 20) + 1;
// }

// // ======================
// // LOGIN
// // ======================

// app.post("/login", async (req, res) => {
//   const { username } = req.body;
//   if (!username) return res.status(400).json({ error: "Username required" });

//   let player = await playersCollection.findOne({ username });

//   if (!player) {
//     player = {
//       username,
//       wallet: 0,
//       secretNumber: generateSecret(),
//       remainingGuesses: 3,
//       totalDeposits: 0,
//       totalWinnings: 0,
//       totalLosses: 0,
//     };

//     await playersCollection.insertOne(player);
//   }

//   res.json({
//     wallet: player.wallet,
//     remainingGuesses: player.remainingGuesses,
//   });
// });

// // ======================
// // GUESS
// // ======================

// app.post("/guess", async (req, res) => {
//   const { username, guess } = req.body;

//   const player = await playersCollection.findOne({ username });
//   if (!player) return res.status(404).json({ error: "Player not found" });

//   if (player.wallet < 10 && player.remainingGuesses === 3)
//     return res.status(400).json({ error: "Insufficient balance" });

//   let house = await houseCollection.findOne({ _id: "mainHouse" });

//   // Deduct stake once per round
//   if (player.remainingGuesses === 3) {
//     player.wallet -= 10;
//     house.balance += 10;
//   }

//   player.remainingGuesses--;

//   // WIN
//   if (guess === player.secretNumber) {
//     let winnings =
//       player.remainingGuesses === 2
//         ? 35
//         : player.remainingGuesses === 1
//           ? 25
//           : 20;

//     player.wallet += winnings;
//     house.balance -= winnings;

//     player.totalWinnings += winnings;

//     player.secretNumber = generateSecret();
//     player.remainingGuesses = 3;

//     await playersCollection.updateOne({ username }, { $set: player });
//     await houseCollection.updateOne({ _id: "mainHouse" }, { $set: house });

//     return res.json({
//       result: "win",
//       winnings,
//       wallet: player.wallet,
//       remainingGuesses: player.remainingGuesses,
//     });
//   }

//   // LOSE
//   if (player.remainingGuesses <= 0) {
//     const correctNumber = player.secretNumber;

//     player.totalLosses += 10;

//     player.secretNumber = generateSecret();
//     player.remainingGuesses = 3;

//     await playersCollection.updateOne({ username }, { $set: player });

//     return res.json({
//       result: "lose",
//       correctNumber,
//       wallet: player.wallet,
//       remainingGuesses: player.remainingGuesses,
//     });
//   }

//   await playersCollection.updateOne({ username }, { $set: player });

//   res.json({
//     result: guess > player.secretNumber ? "high" : "low",
//     wallet: player.wallet,
//     remainingGuesses: player.remainingGuesses,
//   });
// });

// // ======================
// // HOUSE BALANCE
// // ======================

// app.get("/house", async (req, res) => {
//   const house = await houseCollection.findOne({ _id: "mainHouse" });
//   res.json({ houseBank: house.balance });
// });

// // ======================
// // DEPOSIT (MPESA STK)
// // ======================

// app.post("/deposit", async (req, res) => {
//   const { username, phone, amount } = req.body;

//   if (!username || !phone || !amount)
//     return res.status(400).json({ error: "Missing fields" });

//   try {
//     const response = await lipaNaMpesa(phone, amount, username);
//     res.json({ message: "STK Push sent", response });
//   } catch (err) {
//     res.status(500).json({ error: "Deposit failed" });
//   }
// });

// // ======================
// // MPESA CALLBACK
// // ======================

// app.post("/mpesa/callback", async (req, res) => {
//   try {
//     const callback = req.body?.Body?.stkCallback;
//     if (!callback) return res.status(400).json({ message: "Invalid format" });

//     if (callback.ResultCode === 0) {
//       const items = callback.CallbackMetadata.Item;

//       const amount = items.find((i) => i.Name === "Amount")?.Value;
//       const username = items.find((i) => i.Name === "AccountReference")?.Value;

//       const player = await playersCollection.findOne({ username });
//       if (player) {
//         player.wallet += amount;
//         player.totalDeposits += amount;

//         await playersCollection.updateOne({ username }, { $set: player });
//       }
//     }

//     res.json({ message: "Callback processed" });
//   } catch (err) {
//     res.status(500).json({ error: "Callback error" });
//   }
// });

// // ======================
// // WITHDRAW
// // ======================

// app.post("/withdraw", async (req, res) => {
//   const { username, amount } = req.body;

//   const player = await playersCollection.findOne({ username });
//   if (!player) return res.status(404).json({ error: "Player not found" });

//   const netProfit = player.totalWinnings - player.totalLosses;

//   if (netProfit < 50)
//     return res.status(400).json({ error: "Minimum 50 KES profit required" });

//   if (amount > player.wallet)
//     return res.status(400).json({ error: "Insufficient balance" });

//   player.wallet -= amount;

//   await playersCollection.updateOne({ username }, { $set: player });

//   res.json({ message: "Withdrawal initiated", wallet: player.wallet });
// });

// // ======================
// // OWNER WITHDRAW
// // ======================

// app.post("/owner-withdraw", async (req, res) => {
//   const { amount, password } = req.body;

//   if (password !== process.env.ADMIN_PASSWORD)
//     return res.status(403).json({ error: "Unauthorized" });

//   const house = await houseCollection.findOne({ _id: "mainHouse" });

//   if (amount > house.balance)
//     return res.status(400).json({ error: "Not enough house balance" });

//   house.balance -= amount;

//   await houseCollection.updateOne({ _id: "mainHouse" }, { $set: house });

//   res.json({ message: "Owner withdrawal successful" });
// });

// // ======================
// // START SERVER
// // ======================

// app.listen(PORT, () => {
//   console.log(`🚀 Server running on port ${PORT}`);
// });
