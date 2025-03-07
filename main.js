const {
  app,
  BrowserWindow,
  autoUpdater,
  protocol,
  dialog,
} = require("electron");

const express = require("express");
const { spawn, exec } = require("child_process");
const process = require("process");
const kill = require("tree-kill");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const cors = require("cors");
const https = require("https");
const fs = require("fs");
const path = require("path");

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

autoUpdater.setFeedURL({
  provider: "github",
  repo: "electron-ws-cmd",
  owner: "krazykarthik2",
  private: false,
  releaseType: "release",
  url: "https://api.github.com/repos/krazykarthik2/electron-ws-cmd/releases",
});

autoUpdater.on("update-available", () => {
  console.log("Update available");
  // a dialog box will be shown to the user to ask if they want to update
  dialog
    .showMessageBox({
      type: "info",
      title: "Update available",
      message:
        "A new version of the app is available. Do you want to update now?",
      buttons: ["Yes", "No"],
    })
    .then((result) => {
      if (result.response === 0) {
        autoUpdater.downloadUpdate();
      }
    });
});

autoUpdater.on("update-downloaded", () => {
  autoUpdater.quitAndInstall();
});

const PORT = 4593; // REST API at http://localhost:PORT
const WSPORT_CMD = 4594; // WebSocket at ws://localhost:WSPORT_CMD
const WSPORT_BATCH = 4595; // WebSocket at ws://localhost:WSPORT_BATCH

const HTML_URL_FILE = `data:text/html,<html><head><meta charset=UTF-8 /><meta content="width=device-width,initial-scale=1"name=viewport /><title>teja-util-daemon</title><style></style></head><body><h1>TEJA-UTIL DAEMON v${app.getVersion()}</h1><button onclick=fetchSessions()>Refresh</button><div id=sess></div><div id=err></div></body></html>`;
const HTML_STYLE = ` body { background: #000; color: #fff; font-family: sans-serif; } #sess { display: flex; flex-direction: column; gap: 10px; } .session { display: flex; flex-direction: row; gap: 10px; } #err { color: #da1616; } `;
const HTML_SCRIPT = `console.log('script loaded and running'); const sess = document.querySelector("#sess"); const fetchSessions = async () => { try { const response = await fetch("http://localhost:${PORT}/sessions"); const data = await response.json(); sess.innerHTML = data.map((session) => "<div class=session>Session ID: " + session.id + "</div>" ).join(""); } catch (e) { console.error(e); const errDiv = document.createElement("div"); errDiv.innerText = e; document.querySelector("#err").appendChild(errDiv); } }; `;

const appPath = app.getAppPath(); // Get the packaged app path
const SSL_KEY_PATH = path.join(appPath, "ssl.key"); // Adjust path accordingly
const SSL_CERT_PATH = path.join(appPath, "ssl.cert");

// Generate HTTPS server options
const httpsOptions = {
  key: fs.readFileSync(SSL_KEY_PATH),
  cert: fs.readFileSync(SSL_CERT_PATH),
};

const sessions = new Map(); // To store session IDs and their child processes
const batches = new Map(); // To store batch IDs and their child processes

const killSessionProcess = (pid, sessionId, then = () => {}) => {
  console.log("killing PID", pid);
  exec(`taskkill /pid ${pid} /t /f`, (err) => {
    if (err) {
      console.error("Failed to kill process:", err);
    } else {
      console.log("Process killed successfully");
    }
    sessions.delete(sessionId); // Remove session
    then();
  });
};
const killBatchProcess = (pid, batchId, then = () => {}) => {
  if(pid==null){console.log("null pid at killBatchProcess"+batchId);return;}
  console.log("killing PID", pid);
  exec(`taskkill /pid ${pid} /t /f`, (err) => {
    if (err) {
      console.error("Failed to kill process:", err);
    } else {
      console.log("Process killed successfully");
    }
    batches.delete(batchId); // Remove session
    then();
  });
};
// Create an Express server (for backward compatibility)

//-----------------CORS-----------------

const allowedOrigins = [
  "https://teja-util.netlify.app",
  "http://localhost:",
  "chrome-extension://",
];
const corsOptions = {
  origin: (origin, callback) => {
    console.log("Origin:", origin);
    if (
      !origin ||
      allowedOrigins.filter((allowedOrigin) => origin.startsWith(allowedOrigin))
        .length > 0
    ) {
      console.log("Origin allowed:", origin);
      callback(null, true);
    } else {
      console.log("Origin not allowed:", origin);
      callback(new Error("Not allowed by CORS"));
    }
  },
};
// -----------------end CORS-----------------

//-----------------PORT-----------------
const createServer = () => {
  try {
    const server = express();
    server.use(express.json());
    server.use(cors(corsOptions));
    server.get("/sessions", (req, res) => {
      console.log("GET /sessions");
      const sessionData = Array.from(sessions.keys());
      res.status(200).send(sessionData || "No sessions found");
    });
    server.get("/batches", (req, res) => {
      console.log("GET /batches");
      const batchData = Array.from(batches.keys());
      res.status(200).send(batchData || "No batches found");
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
//-----------------END PORT-----------------

//-----------------WS-for-cmd-----------------
const createWebSocketServer = () => {
  const wss = new WebSocketServer({ port: WSPORT_CMD });

  wss.on("connection", (ws) => {
    // Create a new session when a WebSocket connection is established
    const sessionId = crypto.randomUUID();
    const childProcess = spawn("cmd.exe", [], {
      detached: false,
      shell: false,
      stdio: "pipe",
      killSignal: "SIGKILL",
    }); // Create a persistent command prompt process

    console.log("childProcess:PID:", childProcess.pid);
    sessions.set(sessionId, childProcess.pid.toString());
    console.log(
      `[Session ${sessionId} ${childProcess.pid}] Created for new WebSocket connection`
    );

    // Send session creation confirmation to the client
    ws.send(
      JSON.stringify({
        action: "session-created",
        sessionId,
        output: `Session ${sessionId} ${childProcess.pid} created successfully`,
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

    const interruptProcess = () => {
      childProcess.kill("SIGINT");
    };

    // Handle WebSocket messages (commands from client)
    ws.on("message", (message) => {
      const { command, action } = JSON.parse(message);

      if (action === "interrupt") {
        interruptProcess();
        console.log(
          `[Session ${sessionId} ${childProcess.pid}] Session interrupted`
        );
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
            output: `Session ${sessionId} ${childProcess.pid} exited successfully`,
          })
        );
        killProcess(childProcess.pid, sessionId);
        console.log(
          `[Session ${sessionId} ${childProcess.pid}] Session ended by client using exit command`
        );
        ws.close();
        return;
      }
      console.log(
        `[Session ${sessionId} ${childProcess.pid}] Executing command: ${command}`
      );
      childProcess.stdin.write(`${command}\n`);
    });

    // Cleanup on WebSocket close
    ws.on("close", () => {
      console.log(
        `[Session ${sessionId} ${childProcess.pid}] WebSocket connection closed`
      );
      if (sessions.has(sessionId)) {
        killSessionProcess(childProcess.pid, sessionId);
        console.log(
          `[Session ${sessionId} ${childProcess.pid}] Session ended by client using exit command`
        );
      }
    });
  });

  console.log(`WebSocket server running at ws://localhost:${WSPORT_CMD}`);
};
//-----------------END WS-----------------

//-----------------WS-for-batch-----------------
const createWebSocketServerBatch = () => {
  const wss = new WebSocketServer({ port: WSPORT_BATCH });
  wss.on("connection", (ws) => {
    // Create a new session when a WebSocket connection is established
    const batchId = crypto.randomUUID();

    batches.set(batchId,null);
    console.log(
      `[Batch ${batchId}] Created for new WebSocket connection`
    );

    // Send session creation confirmation to the client
    ws.send(
      JSON.stringify({
        action: "batch-created",
        sessionId: batchId,
        output: `Batch ${batchId}  created successfully`,
      })
    );

    // Handle WebSocket messages (commands from client)
    ws.on("message", (msg) => {
      handleMessage(msg, batchId, ws);
    });
  });

  console.log(`WebSocket server running at ws://localhost:${WSPORT_BATCH}`);
};
//-----------------END WS_for_batch-----------------

//-----------------WS_BATCH_FUNCTIONS-----------------
async function handleMessage(msg, batchId, ws) {
  const interruptProcess = () => {
    childProcess.kill("SIGINT");
  };
  message = msg.toString();
  console.log("Batch command received", message);
  const { command, action } = JSON.parse(message);

  //command should be a json
  // with {exec:[{"name1":"command1"},{"name2":"command2"},...]}
  if (action === "interrupt") {
    interruptProcess();
    console.log(
      `[Session ${batchId} ${batches.get(batchId)}] Session interrupted`
    );
    return;
  }
  if (command) {
    const isolatedFolder = path.join(appPath, "isolated-" + batchId + "-batch");
    fs.mkdirSync(isolatedFolder);
    const batchFilePath = path.join(isolatedFolder, "batch.json");
    fs.writeFileSync(batchFilePath, JSON.stringify(command));
    console.log("Batch file written to", batchFilePath);
    afterEachExec = (name, code) => {
      ws.send(
        JSON.stringify({
          action: "line-executed",
          sessionId: batchId,
          output: `Command with ${name} executed with code ${code}`,
        })
      );
    };
    afterReport = () => {
      ws.send(
        JSON.stringify({
          action: "batch-executed",
          sessionId: batchId,
          output: `Batch ${batchId} ${batches.get(
            batchId
          )} executed successfully`,
        })
      );
    };

    setCurrentProcess = (pid) => {
      batches.set(batchId, pid);
    };
    await startExecution(
      batchFilePath,
      batchId,
      setCurrentProcess,
      afterEachExec,
      afterReport,
      ws
    );

    sayGoodbyeBatch();
    console.log("Batch execution completed");
  }
  if (!command) {
    ws.send(
      JSON.stringify({
        action: "error",
        batchId: batchId,
        error: "No command provided",
      })
    );
    return;
  }
  if (command === "exit") {
    ws.send(
      JSON.stringify({
        action: "exit",
        sessionId: batchId,
        output: `Session ${batchId} ${childProcess.pid} exited successfully`,
      })
    );
    killBatchProcess(batches.get(batchId), batchId);
    console.log(
      `[Session ${batchId} ${childProcess.pid}] Session ended by client using exit command`
    );
    ws.close();
    return;
  }
  console.log(
    `[Session ${batchId} ${childProcess.pid}] Executing command: ${command}`
  );
}

const startExecution = async (
  batchFilePath,
  batchId,
  setCurrentProcess,
  afterEachExec,
  afterReport,
  ws
) => {
  try {
    const batchFile = fs.readFileSync(batchFilePath);
    const batchjson = JSON.parse(batchFile);
    const prevCwd = process.cwd()+"/isolated-" + batchId + "-batch";
    for (const { name, command } of batchjson.exec) {
      console.log("Executing command:", command, "with name:", name);
      childProcess = spawn("cmd.exe", ["/c", command], {
        cwd: prevCwd,
        detached: false,
        shell: false,
        stdio: "pipe",
        killSignal: "SIGKILL",
      }); // Create a persistent command prompt process
      console.log("childProcess PID:", childProcess.pid);

      // Handle process output (stdout)
      childProcess.stdout.on("data", (data) => {
        ws.send(
          JSON.stringify({
            action: "batch-output",
            sessionId: batchId,
            output: data.toString(),
          })
        );
      });

      // Handle process errors (stderr)
      childProcess.stderr.on("data", (data) => {
        ws.send(
          JSON.stringify({
            action: "batch-error",
            sessionId: batchId,
            error: data.toString(),
          })
        );
      });

      await new Promise((resolve, reject) => {
        let commandExited = false;

        const onExit = (code,) => {
          if (!commandExited) {
            commandExited = true;
            console.log("Command finished with code", code);
            afterEachExec(name, code);
            resolve();
          }
        };
//////////////TODO: set prevcwd to the cwd of the command
        childProcess.stdin.write(`${command}\n`);
        
        // Listen for exit event for each command
        childProcess.once("exit", onExit);
      });
    }

    afterReport();
    console.log("Batch execution completed");
  } catch (error) {
    console.error("Error executing batch:", error);
  }
};

const sayGoodbyeBatch = (childProcess) => {
  console.log("Goodbye");
  killBatchProcess(childProcess.pid, batchId);
  console.log(
    `[BatchId/Session ${batchId} ${childProcess.pid}] Session ended by client using exit command`
  );
};
//-----------------END WS_BATCH_FUNCTIONS-----------------

//-----------------WINDOW-----------------
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
    win.loadURL(
      "data:text/html,<html><body><h1>Failed to load the app.</h1></body></html>"
    );
  });
};

//-----------------END WINDOW-----------------

app.on("ready", () => {
  createServer();
  createWebSocketServer();
  createWebSocketServerBatch();
  createWindow();
  autoUpdater.checkForUpdates();
});

//-----------------KILL-----------------
const killFirstSession = (then = null) => {
  if (sessions.size != 0) {
    const sessionId = sessions.keys().next().value;
    console.log("killing session", sessionId);
    killSessionProcess(sessions.get(sessionId), sessionId, () =>
      killFirstSession(then)
    );
  } else {
    if (then) then();
  }
};
const killFirstBatch = (then = null) => {
  if (batches.size != 0) {
    const batchId = batches.keys().next().value;
    console.log("killing batch", batchId);
    killBatchProcess(batches.get(batchId), batchId, () => killFirstBatch(then));
  } else {
    if (then) then();
  }
};

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    console.log("killing all sessions");
    console.log("sessions", sessions);
    killFirstSession(() => {
      killFirstBatch(() => {
        console.log("quitting app in background,map:", sessions);
        //delete all the isolated folders
        console.log("deleting isolated folders");
        const appPath = app.getAppPath(); // Get the packaged app path
        const isolatedFolders = fs.readdirSync(appPath).filter((file) => {
          return file.startsWith("isolated-");
        });
        for (const folder of isolatedFolders) {
          fs.rmdirSync(path.join(appPath, folder), { recursive: true });
        }
        app.quit();
      });
    });
  }
});
//-----------------END KILL-----------------

// Don't allow multiple instances
app.on("second-instance", () => {
  // Someone tried to run a second instance, we should focus our window.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  } else {
    BrowserWindow.getAllWindows()[0].focus();
  }
});
//-----------------END-----------------

//-----------------ACTIVATE-----------------
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
//-----------------END ACTIVATE-----------------
