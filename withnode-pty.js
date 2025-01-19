const { app, BrowserWindow, autoUpdater, protocol } = require("electron");

const express = require("express");
const kill = require('tree-kill');
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const pty = require("node-pty");

app.whenReady().then(() => {
  protocol.handle("teja-util", (request, callback) => {
    const url = request.url.replace("teja-util://", "");
    console.log("Custom protocol URL:", url);
  });
  // Register the custom protocol
  protocol.registerFileProtocol("teja-util", (request, callback) => {
    const url = request.url.replace("teja-util://", "");
    console.log("Custom protocol URL:", url);

    // You can handle the URL here, for example, by opening a specific window or navigating somewhere
    // If needed, pass a file or resource to serve
    callback({ path: "" }); // Serve appropriate resource if needed
  });

  console.log("Custom protocol teja-util:// registered");
});
app.setAsDefaultProtocolClient("teja-util");

autoUpdater.on("update-available", () => {
  console.log("Update available");
});

autoUpdater.on("update-downloaded", () => {
  autoUpdater.quitAndInstall();
});

const PORT = 4593; // REST API at http://localhost:PORT
const WSPORT = 4594; // WebSocket at ws://localhost:WSPORT

const HTML_URL_FILE = `data:text/html,<html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>teja-util-daemon</title></head><body><h1>TEJA-UTIL DAEMON v${app.getVersion()}</h1><button onclick="fetchSessions()">refresh</button><div id="sess"></div><div id="err"></div></body></html>`;
const HTML_STYLE = `body{background:#000;color:#fff;font-family:sans-serif;}#sess{display:flex;flex-direction:column;gap:10px;}#sess.session{display:flex;flex-direction:row;gap:10px;}#err{color:#da1616}`;
const HTML_SCRIPT = `const sess=document.querySelector("#sess");const fetchSessions=async()=>{try{const response=await fetch("http://localhost:${PORT}/sessions");const data=await response.json();sess.innerHTML=data.map((session)=>{return "<div class='session'>Session ID: "+session+"</div>"}).join("");}catch(e){console.log(e);const errDiv=document.createElement("div");errDiv.innerHTML=e;document.querySelector("#err").appendChild(errDiv);}};`;

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
  try {
    const server = express();
    server.use(express.json());
    // CORS configuration
    const allowedOrigins = [
      "https://teja-util.netlify.app",
      "http://localhost:3000",
    ];
    const corsOptions = {
      origin: (origin, callback) => {
        console.log("Origin:", origin);
        if (!origin || allowedOrigins.filter((allowedOrigin) => origin.startsWith(allowedOrigin)).length > 0) {
          console.log("Origin allowed:", origin);
          callback(null, true);
        } else {
          console.log("Origin not allowed:", origin);
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
      console.log("GET /sessions");
      const sessionData = Array.from(sessions.keys());
      res.status(200).send(sessionData || "No sessions found");
    });

    try {
      server.listen(PORT, () => {
        console.log(`REST API running at http://localhost:${PORT}`);
      });
    } catch (error) {
      console.error("Failed to start server:", error);
    }
  } catch (error) {
    console.error("Failed to maintain server:", error);
  }
};

// Create a WebSocket server
const createWebSocketServer = () => {
  const wss = new WebSocketServer({ port: WSPORT });

  wss.on("connection", (ws) => {
    // Create a new session when a WebSocket connection is established
    const sessionId = crypto.randomUUID();
    const childProcess = pty.spawn("cmd.exe", [], {
      name: "xterm-color",
      cols: 80,
      rows: 30,
      cwd: process.cwd(),
      env: process.env,
    }); // Create a persistent command prompt process using node-pty

    sessions.set(sessionId, childProcess);
    console.log(`[Session ${sessionId} ${childProcess.pid}] Created for new WebSocket connection`);

    // Send session creation confirmation to the client
    ws.send(
      JSON.stringify({
        action: "session-created",
        sessionId,
        message: `Session ${sessionId} ${childProcess.pid} created successfully`,
      })
    );

    // Handle process output (stdout)
    childProcess.on("data", (data) => {
      ws.send(
        JSON.stringify({
          action: "command-output",
          sessionId,
          output: data.toString(),
        })
      );
    });

    // Handle process errors (stderr)
    childProcess.on("error", (data) => {
      ws.send(
        JSON.stringify({
          action: "command-error",
          sessionId,
          error: data.toString(),
        })
      );
    });

    const killProcess = () => {
      kill(childProcess.pid, "SIGKILL", (err) => {
        if (err) {
          console.error("Failed to kill process:", err);
        } else {
          console.log("Process killed successfully");
        }
      });
      sessions.delete(sessionId); // Remove session
    };

    // Handle WebSocket messages (commands from client)
    ws.on("message", (message) => {
      const { command, action, sessionId } = JSON.parse(message);

      if (action === "interrupt") {
        childProcess.write("\x03"); // Send Ctrl+C to interrupt the process
        console.log(`[Session ${sessionId} ${childProcess.pid}] Session interrupted`);
        return;
      }
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
            message: `Session ${sessionId} ${childProcess.pid} exited successfully`,
          })
        );
        killProcess();
        console.log(`[Session ${sessionId} ${childProcess.pid}] Session ended by client using exit command`);
        ws.close();
        return;
      }
      console.log(`[Session ${sessionId} ${childProcess.pid}] Executing command: ${command}`);
      childProcess.write(`${command}\n`);
    });

    // Cleanup on WebSocket close
    ws.on("close", () => {
      console.log(`[Session ${sessionId} ${childProcess.pid}] WebSocket connection closed`);
      if (sessions.has(sessionId)) {
        killProcess();
        console.log(`[Session ${sessionId} ${childProcess.pid}] Session ended by client using exit command`);
      }
    });
  });

  console.log(`WebSocket server running at ws://localhost:${WSPORT}`);
};

// Create the Electron window
const createWindow = () => {
  const win = new BrowserWindow({
    width: 400,
    height: 200,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: true,
      webSecurity: false, // Allow local resources
      additionalArguments: ["--allow-insecure-localhost"], // Allow self-signed certificates
    },
  });

  win.loadURL(HTML_URL_FILE); // Load the React app
  win.webContents.insertCSS(HTML_STYLE);
  win.webContents.executeJavaScript(HTML_SCRIPT);

  win.autoHideMenuBar = true;
  // Fallback to localhost if loading fails
  win.webContents.on("did-fail-load", () => {
    win.loadURL("data:text/html,<html><body><h1>Failed to load the app.</h1></body></html>");
  });
};
app.on("ready", () => {
  createServer();
  createWebSocketServer();
  createWindow();
  autoUpdater.checkForUpdates();
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
