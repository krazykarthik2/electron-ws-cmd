const { app, BrowserWindow,autoUpdater } = require("electron");

const express = require("express");
const { spawn } = require("child_process");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const cors = require("cors");
const https = require("https");
const fs = require("fs");
const path = require('path');


autoUpdater.on('update-available', () => {
  console.log('Update available');
});

autoUpdater.on('update-downloaded', () => {
  autoUpdater.quitAndInstall();
});

const PORT = 4593; // REST API at http://localhost:PORT
const WSPORT = 4594; // WebSocket at ws://localhost:WSPORT

const appPath = app.getAppPath(); // Get the packaged app path
const SSL_KEY_PATH = path.join(appPath, "ssl.key"); // Adjust path accordingly
const SSL_CERT_PATH = path.join(appPath, "ssl.cert");

// Generate HTTPS server options
const httpsOptions = {
  key: fs.readFileSync(SSL_KEY_PATH),
  cert: fs.readFileSync(SSL_CERT_PATH),
};

const sessions = new Map(); // To store session IDs and their child processes

// Create an Express server (for backward compatibility)
const createServer = () => {
  const server = express();

  // CORS configuration
  const allowedOrigins = [
    "https://teja-util.netlify.app",
    "http://localhost",
    "http://127.0.0.1",
  ];
  const corsOptions = {
    origin: (origin, callback) => {
      console.log("Origin:", origin);
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
  };

  server.use(cors(corsOptions));

  /**
   * Endpoint: Get information about all active sessions
   * Method: GET /sessions
   */
  server.get("/sessions", (req, res) => {
    const sessionData = Array.from(sessions.keys());
    res.status(200).send(sessionData);
  });

  const httpsServer = https.createServer(httpsOptions, server);

  httpsServer.listen(PORT, () => {
    console.log(`REST API running at http://localhost:${PORT}`);
  });
};

// Create a WebSocket server
const createWebSocketServer = () => {
  const wss = new WebSocketServer({ port: WSPORT });
  
  wss.on("connection", (ws) => {
    // Create a new session when a WebSocket connection is established
    const sessionId = crypto.randomUUID();
    const childProcess = spawn("cmd.exe"); // Create a persistent command prompt process

    sessions.set(sessionId, childProcess);
    console.log(`[Session ${sessionId}] Created for new WebSocket connection`);

    // Send session creation confirmation to the client
    ws.send(
      JSON.stringify({
        action: "session-created",
        sessionId,
        message: `Session ${sessionId} created successfully`,
      })
    );

    // Handle process output (stdout)
    childProcess.stdout.on("data", (data) => {
      ws.send(
        JSON.stringify({
          action: "command-output",
          sessionId,
          output: data.toString(),
        })
      );
    });

    // Handle process errors (stderr)
    childProcess.stderr.on("data", (data) => {
      ws.send(
        JSON.stringify({
          action: "command-error",
          sessionId,
          error: data.toString(),
        })
      );
    });

    // Handle WebSocket messages (commands from client)
    ws.on("message", (message) => {
      const { command } = JSON.parse(message);

      if (!command) {
        ws.send(
          JSON.stringify({
            action: "error",
            sessionId,
            error: "No command provided",
          })
        );
        return;
      }
      if (command === "exit") {
        ws.send(
          JSON.stringify({
            action: "exit",
            sessionId,
            message: `Session ${sessionId} exited successfully`,
          })
        );
        childProcess.kill(); // Terminate the process
        sessions.delete(sessionId); // Remove session
        console.log(`[Session ${sessionId}] Session ended`);
        return;
      }
      console.log(`[Session ${sessionId}] Executing command: ${command}`);
      childProcess.stdin.write(`${command}\n`);
    });

    // Cleanup on WebSocket close
    ws.on("close", () => {
      console.log(`[Session ${sessionId}] WebSocket connection closed`);
      if (sessions.has(sessionId)) {
        childProcess.kill(); // Terminate the process
        sessions.delete(sessionId); // Remove session
        console.log(`[Session ${sessionId}] Session ended`);
      }
    });
  });

  console.log(`WebSocket server running at ws://localhost:${WSPORT}`);
};

// Create the Electron window
const createWindow = () => {
  const win = new BrowserWindow({
    width:"100%",
    height:"100%",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: true,
      webSecurity: false, // Allow local resources
      additionalArguments: ["--allow-insecure-localhost"], // Allow self-signed certificates
    },
  });

  win.loadURL("http://teja-util.netlify.app"); // Load the React app

  // Fallback to localhost if loading fails
  win.webContents.on("did-fail-load", () => {
    win.loadURL("http://localhost:3000");
  });

};
app.on("ready", () => {
  createServer();
  createWebSocketServer();
  createWindow();
  autoUpdater.checkForUpdatesAndNotify();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
