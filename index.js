require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const OpenAI = require("openai");

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Game state storage
let games = {};

// Helper function to generate random access codes
function generateAccessCode(length = 5) {
  return Math.random().toString(36).substr(2, length).toUpperCase();
}

const optionsSystemMessage = process.env.OPTIONS_SYSTEM_MESSAGE;

const gameSystemMessage = process.env.GAME_SYSTEM_MESSAGE;

// Socket.io connection
io.on("connection", (socket) => {
  console.log("A user connected:", socket.id);

  // Handle creating a new game
  socket.on("createGame", () => {
    const accessCode = generateAccessCode();
    games[accessCode] = {
      leader: socket.id,
      players: [socket.id],
      adventure: null,
      characters: {},
      currentTurn: 0,
      messages: [
        {
          role: "system",
          content: gameSystemMessage,
        },
      ],
    };
    socket.join(accessCode);
    socket.emit("gameCreated", { accessCode });
    console.log(`Game created with access code: ${accessCode}`);
  });

  socket.on("joinGame", ({ accessCode }) => {
    if (games[accessCode]) {
      games[accessCode].players.push(socket.id);
      socket.join(accessCode);
      io.to(games[accessCode].leader).emit("playerJoined", {
        playerCount: games[accessCode].players.length,
      });
      socket.emit("gameJoined", { accessCode });
    } else {
      socket.emit("error", { message: "Invalid access code." });
    }
  });

  socket.on("getAdventureOptions", async ({ accessCode, socketId }) => {
    if (socket.id !== games[accessCode].leader) {
        return;
    }
    console.log("Getting adventure options");
    const prompt = "Generate three exciting adventure starting points.";
    const response = await openai.chat.completions.create({
      model: "gpt-4o-2024-08-06",
      messages: [
        {
          role: "system",
          content: optionsSystemMessage,
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 1.2,
      max_completion_tokens: 300,
    });
    console.log("response:", response)
    const adventures = response.choices[0].message.content
      .trim()
      .split("\n")
      .filter((adventure) => adventure.length > 0)
      .map((adventure) => adventure.replace(/^\d+\.?\s*|-?\s*/, ""));
    socket.emit("adventureOptions", { adventures });
  });

  socket.on("selectAdventure", ({ accessCode, adventure }) => {
    games[accessCode].adventure = adventure;
    io.to(accessCode).emit("adventureSelected", { adventure });
    games[accessCode].messages.push({
      role: "user",
      content: `The following is the outline and inciting action of the adventure: \n${adventure}`,
    });
  });

  socket.on("getCharacterOptions", async ({ accessCode, socketId }) => {
    const adventure = games[accessCode].adventure;
    const prompt = `Based on the following adventure: "${adventure}", generate three suitable character descriptions.`;
    const response = await openai.chat.completions.create({
      model: "gpt-4o-2024-08-06",
      messages: [
        {
          role: "system",
          content: optionsSystemMessage,
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 1.2,
      max_completion_tokens: 300,
    });
    const characters = response.choices[0].message.content
      .trim()
      .split("\n")
      .filter((adventure) => adventure.length > 0)
      .map((adventure) => adventure.replace(/^\d+\.?\s*|-?\s*/, "").replace("**", ""));
    socket.emit("characterOptions", { characters, socketId });
  });

  socket.on("selectCharacter", ({ accessCode, character }) => {
    games[accessCode].characters[socket.id] = { character, characterName: character.split(":")[0] };

    games[accessCode].messages.push({
      role: "assistant",
      content: `The character with id ${socket.id} has been assigned the following description: \n${character}`,
    });

    // Notify the leader if all players have selected characters
    if (
      Object.keys(games[accessCode].characters).length ===
      games[accessCode].players.length
    ) {
      io.to(games[accessCode].leader).emit("allCharactersSelected");
    }
  });

  socket.on("startGame", ({ accessCode }) => {
    const adventure = games[accessCode].adventure;
    io.to(accessCode).emit("gameStarted", { adventure });

    const currentPlayerId =
      games[accessCode].players[games[accessCode].currentTurn];
    io.to(currentPlayerId).emit("yourTurn");
  });

  socket.on("playerAction", async ({ accessCode, action, socketId }) => {
    const characterName = games[accessCode].characters[socketId].characterName;
    const response = await openai.chat.completions.create({
      model: "gpt-4o-2024-08-06",
      messages: [
        ...games[accessCode].messages,
        {
          role: "assistant",
          content: `The character with id ${socketId} (${characterName}) has taken the following action: \n`
        },
        {
          role: "user",
          content: action,
        },
      ],
      max_completion_tokens: 300,
    });
    const outcome = response.choices[0].message.content.trim();
    io.to(accessCode).emit("actionOutcome", { outcome });
    games[accessCode].messages.push({
      role: "user",
      content: action,
    });

    // Move to the next player's turn
    games[accessCode].currentTurn =
      (games[accessCode].currentTurn + 1) % games[accessCode].players.length;
    const nextPlayerId =
      games[accessCode].players[games[accessCode].currentTurn];
    io.to(nextPlayerId).emit("yourTurn");
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
    // Handle cleanup if necessary
  });
});

server.listen(3001, () => {
  console.log("Server is running on port 3001");
});
