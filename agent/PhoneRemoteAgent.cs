using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace PhoneRemoteAgentApp
{
    internal static class Program
    {
        private const string DefaultServerUrl = "https://your-domain.example";

        [STAThread]
        private static void Main(string[] args)
        {
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
            ServicePointManager.DefaultConnectionLimit = 512;
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.ThreadException += delegate(object sender, ThreadExceptionEventArgs e)
            {
                WriteFallbackLog("UI error: " + e.Exception);
            };
            AppDomain.CurrentDomain.UnhandledException += delegate(object sender, UnhandledExceptionEventArgs e)
            {
                WriteFallbackLog("Fatal error: " + e.ExceptionObject);
            };
            string configuredServer = args.Length > 0 ? args[0] : Environment.GetEnvironmentVariable("PHONE_REMOTE_SERVER_URL");
            Application.Run(new AgentForm(string.IsNullOrWhiteSpace(configuredServer) ? DefaultServerUrl : configuredServer));
        }

        private static void WriteFallbackLog(string text)
        {
            try
            {
                string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PhoneRemoteAgent");
                if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
                string file = Path.Combine(dir, "agent.log");
                File.AppendAllText(file, "[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "] " + text + Environment.NewLine, Encoding.UTF8);
            }
            catch { }
        }
    }

    internal sealed class AgentForm : Form
    {
        private const int MaxSearchResults = 100;
        private const int MaxSearchDirs = 2500;
        private const int MaxActiveDownloads = 2;

        private readonly string serverUrl;
        private readonly string appDir;
        private readonly string pinPath;
        private readonly string clientIdPath;
        private readonly string logPath;
        private readonly string clientId;
        private readonly JavaScriptSerializer json = new JavaScriptSerializer();
        private readonly List<RootItem> roots = new List<RootItem>();
        private readonly object stateLock = new object();
        private readonly HashSet<string> excludedDirs = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            ".git", ".svn", ".hg", "node_modules", "vendor", "dist", "build", "target",
            "logs", "log", "tmp", "temp", "cache", ".cache", ".trash", ".npm", ".yarn",
            ".pnpm", ".vscode", ".idea", ".gradle", ".m2", ".nuget", ".cargo", ".rustup",
            ".conda", "appdata", "library", "$recycle.bin", "system volume information",
            "windows", "program files", "program files (x86)", "programdata"
        };

        private Label pinLabel;
        private Label statusLabel;
        private Button copyButton;
        private NotifyIcon notifyIcon;
        private System.Windows.Forms.Timer uiTimer;
        private Form logForm;
        private TextBox logTextBox;

        private volatile bool stopping;
        private Thread workerThread;
        private string agentId = "";
        private string token = "";
        private string currentPin = "------";
        private string pendingStatus = "Starting...";
        private Color pendingColor = ColorTranslator.FromHtml("#64748b");
        private bool allowClose;
        private int activeDownloads;

        internal AgentForm(string serverUrl)
        {
            this.serverUrl = NormalizeServerUrl(serverUrl);
            appDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PhoneRemoteAgent");
            pinPath = Path.Combine(appDir, "last-pin.txt");
            clientIdPath = Path.Combine(appDir, "client-id.txt");
            logPath = Path.Combine(appDir, "agent.log");
            clientId = LoadOrCreateClientId();
            LoadSavedPin();
            BuildRoots();
            BuildUi();
        }

        private static string NormalizeServerUrl(string value)
        {
            string url = (value ?? "https://your-domain.example").Trim().TrimEnd('/');
            return string.IsNullOrEmpty(url) ? "https://your-domain.example" : url;
        }

        private void BuildUi()
        {
            Text = "Phone Remote Agent";
            StartPosition = FormStartPosition.CenterScreen;
            Size = new Size(460, 430);
            MinimumSize = Size;
            MaximumSize = Size;
            MaximizeBox = false;
            FormBorderStyle = FormBorderStyle.FixedSingle;
            BackColor = ColorTranslator.FromHtml("#f4f6f8");
            Font = new Font("Segoe UI", 10f);

            Panel card = new Panel();
            card.Location = new Point(18, 18);
            card.Size = new Size(408, 344);
            card.BackColor = Color.White;
            card.BorderStyle = BorderStyle.FixedSingle;
            Controls.Add(card);

            Label badge = new Label();
            badge.Location = new Point(24, 24);
            badge.Size = new Size(52, 52);
            badge.Text = "OK";
            badge.TextAlign = ContentAlignment.MiddleCenter;
            badge.ForeColor = Color.White;
            badge.BackColor = ColorTranslator.FromHtml("#35c28b");
            badge.Font = new Font("Segoe UI", 16f, FontStyle.Bold);
            card.Controls.Add(badge);

            Label title = new Label();
            title.Location = new Point(92, 22);
            title.Size = new Size(280, 32);
            title.Text = "Phone Remote Agent";
            title.ForeColor = ColorTranslator.FromHtml("#17212b");
            title.Font = new Font("Segoe UI", 18f, FontStyle.Bold);
            card.Controls.Add(title);

            Label subtitle = new Label();
            subtitle.Location = new Point(94, 55);
            subtitle.Size = new Size(280, 24);
            subtitle.Text = "Ready for phone pairing";
            subtitle.ForeColor = ColorTranslator.FromHtml("#64748b");
            card.Controls.Add(subtitle);

            Label caption = new Label();
            caption.Location = new Point(24, 106);
            caption.Size = new Size(356, 24);
            caption.Text = "Pairing PIN";
            caption.ForeColor = ColorTranslator.FromHtml("#166b8f");
            caption.Font = new Font("Segoe UI", 11f, FontStyle.Bold);
            card.Controls.Add(caption);

            Panel pinPanel = new Panel();
            pinPanel.Location = new Point(24, 136);
            pinPanel.Size = new Size(356, 78);
            pinPanel.BackColor = ColorTranslator.FromHtml("#e8f3f7");
            pinPanel.BorderStyle = BorderStyle.FixedSingle;
            card.Controls.Add(pinPanel);

            pinLabel = new Label();
            pinLabel.Location = new Point(0, 7);
            pinLabel.Size = new Size(354, 62);
            pinLabel.Text = currentPin;
            pinLabel.TextAlign = ContentAlignment.MiddleCenter;
            pinLabel.ForeColor = ColorTranslator.FromHtml("#0f536f");
            pinLabel.Font = new Font("Consolas", 34f, FontStyle.Bold);
            pinPanel.Controls.Add(pinLabel);

            statusLabel = new Label();
            statusLabel.Location = new Point(24, 228);
            statusLabel.Size = new Size(266, 24);
            statusLabel.Text = "Starting...";
            statusLabel.ForeColor = ColorTranslator.FromHtml("#64748b");
            card.Controls.Add(statusLabel);

            Button logsButton = new Button();
            logsButton.Location = new Point(300, 222);
            logsButton.Size = new Size(80, 30);
            logsButton.Text = "Logs";
            logsButton.BackColor = ColorTranslator.FromHtml("#edf1f4");
            logsButton.ForeColor = ColorTranslator.FromHtml("#17212b");
            logsButton.Font = new Font("Segoe UI", 9f, FontStyle.Bold);
            logsButton.Click += delegate { ShowLogWindow(); };
            card.Controls.Add(logsButton);

            Label hint = new Label();
            hint.Location = new Point(24, 255);
            hint.Size = new Size(356, 36);
            hint.Text = "Open the phone site, enter this PIN, then browse and download files from this PC.";
            hint.ForeColor = ColorTranslator.FromHtml("#64748b");
            hint.Font = new Font("Segoe UI", 9f);
            card.Controls.Add(hint);

            copyButton = MakeButton("Copy PIN", 24, "#166b8f", Color.White);
            copyButton.Enabled = false;
            copyButton.Click += delegate { CopyPin(); };
            card.Controls.Add(copyButton);

            Button openButton = MakeButton("Open Site", 138, "#e8f3f7", ColorTranslator.FromHtml("#0f536f"));
            openButton.Click += delegate { Process.Start(serverUrl); };
            card.Controls.Add(openButton);

            Button restartButton = MakeButton("Restart", 260, "#edf1f4", ColorTranslator.FromHtml("#17212b"));
            restartButton.Click += delegate { RestartAgent(); };
            card.Controls.Add(restartButton);

            Button stopButton = MakeSmallButton("X", 346);
            stopButton.Click += delegate
            {
                allowClose = true;
                StopAgent();
                notifyIcon.Visible = false;
                Close();
            };
            card.Controls.Add(stopButton);

            Label footer = new Label();
            footer.Location = new Point(20, 372);
            footer.Size = new Size(410, 24);
            footer.Text = "Read-only access. The PIN changes whenever the agent reconnects.";
            footer.ForeColor = ColorTranslator.FromHtml("#64748b");
            footer.Font = new Font("Segoe UI", 8.5f);
            Controls.Add(footer);

            ContextMenuStrip menu = new ContextMenuStrip();
            ToolStripItem showItem = menu.Items.Add("Show");
            ToolStripItem copyItem = menu.Items.Add("Copy PIN");
            ToolStripItem logsItem = menu.Items.Add("Logs");
            ToolStripItem restartItem = menu.Items.Add("Restart");
            ToolStripItem stopItem = menu.Items.Add("Stop and Exit");

            notifyIcon = new NotifyIcon();
            notifyIcon.Icon = SystemIcons.Application;
            notifyIcon.Visible = true;
            notifyIcon.ContextMenuStrip = menu;
            notifyIcon.DoubleClick += delegate { ShowMainWindow(); };
            showItem.Click += delegate { ShowMainWindow(); };
            copyItem.Click += delegate { CopyPin(); };
            logsItem.Click += delegate { ShowLogWindow(); };
            restartItem.Click += delegate { RestartAgent(); };
            stopItem.Click += delegate
            {
                allowClose = true;
                StopAgent();
                notifyIcon.Visible = false;
                Close();
            };

            uiTimer = new System.Windows.Forms.Timer();
            uiTimer.Interval = 600;
            uiTimer.Tick += delegate
            {
                ApplyUiState();
                RefreshLogWindow();
            };

            Shown += delegate
            {
                StartAgent();
                uiTimer.Start();
            };

            FormClosing += delegate(object sender, FormClosingEventArgs e)
            {
                if (!allowClose)
                {
                    e.Cancel = true;
                    Hide();
                    ShowTrayMessage("Still running", "Double-click the tray icon to show the PIN again.");
                }
            };
        }

        private Button MakeButton(string text, int x, string bg, Color fg)
        {
            Button button = new Button();
            button.Location = new Point(x, 300);
            button.Size = new Size(x == 260 ? 80 : 104, 36);
            button.Text = text;
            button.BackColor = ColorTranslator.FromHtml(bg);
            button.ForeColor = fg;
            button.Font = new Font("Segoe UI", 10f, FontStyle.Bold);
            return button;
        }

        private Button MakeSmallButton(string text, int x)
        {
            Button button = new Button();
            button.Location = new Point(x, 300);
            button.Size = new Size(34, 36);
            button.Text = text;
            button.BackColor = ColorTranslator.FromHtml("#f7e8e6");
            button.ForeColor = ColorTranslator.FromHtml("#b42318");
            button.Font = new Font("Segoe UI", 10f, FontStyle.Bold);
            return button;
        }

        private void SetStatus(string text, string color)
        {
            lock (stateLock)
            {
                pendingStatus = text;
                pendingColor = ColorTranslator.FromHtml(color);
            }
            Log(text);
        }

        private void Log(string text)
        {
            try
            {
                if (!Directory.Exists(appDir)) Directory.CreateDirectory(appDir);
                File.AppendAllText(logPath, "[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "] " + text + Environment.NewLine, Encoding.UTF8);
            }
            catch { }
        }

        private void ApplyUiState()
        {
            string status;
            Color color;
            lock (stateLock)
            {
                status = pendingStatus;
                color = pendingColor;
            }

            pinLabel.Text = currentPin;
            statusLabel.Text = status;
            statusLabel.ForeColor = color;
            copyButton.Enabled = currentPin.Length == 6 && currentPin != "------";
            string trayText = "Phone Remote Agent - " + status;
            if (trayText.Length > 63) trayText = trayText.Substring(0, 60) + "...";
            try { notifyIcon.Text = trayText; } catch { }
        }

        private void ShowMainWindow()
        {
            Show();
            WindowState = FormWindowState.Normal;
            Activate();
        }

        private void ShowTrayMessage(string title, string text)
        {
            try
            {
                notifyIcon.BalloonTipTitle = title;
                notifyIcon.BalloonTipText = text;
                notifyIcon.ShowBalloonTip(2500);
            }
            catch { }
        }

        private void ShowLogWindow()
        {
            if (logForm != null && !logForm.IsDisposed)
            {
                logForm.Show();
                logForm.WindowState = FormWindowState.Normal;
                logForm.Activate();
                RefreshLogWindow();
                return;
            }

            logForm = new Form();
            logForm.Text = "Phone Remote Agent Logs";
            logForm.StartPosition = FormStartPosition.CenterParent;
            logForm.Size = new Size(720, 460);
            logForm.MinimumSize = new Size(560, 360);
            logForm.BackColor = ColorTranslator.FromHtml("#f4f6f8");
            logForm.Font = new Font("Segoe UI", 10f);

            Panel bar = new Panel();
            bar.Dock = DockStyle.Top;
            bar.Height = 48;
            bar.BackColor = Color.White;
            logForm.Controls.Add(bar);

            Button refreshButton = new Button();
            refreshButton.Text = "Refresh";
            refreshButton.Location = new Point(12, 10);
            refreshButton.Size = new Size(88, 28);
            refreshButton.Click += delegate { RefreshLogWindow(); };
            bar.Controls.Add(refreshButton);

            Button clearButton = new Button();
            clearButton.Text = "Clear";
            clearButton.Location = new Point(108, 10);
            clearButton.Size = new Size(76, 28);
            clearButton.Click += delegate
            {
                try
                {
                    if (!Directory.Exists(appDir)) Directory.CreateDirectory(appDir);
                    File.WriteAllText(logPath, "", Encoding.UTF8);
                }
                catch { }
                RefreshLogWindow();
            };
            bar.Controls.Add(clearButton);

            Button folderButton = new Button();
            folderButton.Text = "Open Folder";
            folderButton.Location = new Point(192, 10);
            folderButton.Size = new Size(104, 28);
            folderButton.Click += delegate
            {
                try
                {
                    if (!Directory.Exists(appDir)) Directory.CreateDirectory(appDir);
                    Process.Start(appDir);
                }
                catch { }
            };
            bar.Controls.Add(folderButton);

            Label pathLabel = new Label();
            pathLabel.Text = logPath;
            pathLabel.Location = new Point(310, 14);
            pathLabel.Size = new Size(380, 22);
            pathLabel.ForeColor = ColorTranslator.FromHtml("#64748b");
            pathLabel.Anchor = AnchorStyles.Left | AnchorStyles.Top | AnchorStyles.Right;
            bar.Controls.Add(pathLabel);

            logTextBox = new TextBox();
            logTextBox.Dock = DockStyle.Fill;
            logTextBox.Multiline = true;
            logTextBox.ReadOnly = true;
            logTextBox.ScrollBars = ScrollBars.Both;
            logTextBox.WordWrap = false;
            logTextBox.BackColor = Color.White;
            logTextBox.ForeColor = ColorTranslator.FromHtml("#17212b");
            logTextBox.Font = new Font("Consolas", 9.5f);
            logForm.Controls.Add(logTextBox);

            logForm.FormClosed += delegate
            {
                logTextBox = null;
                logForm = null;
            };

            RefreshLogWindow();
            logForm.Show(this);
        }

        private void RefreshLogWindow()
        {
            if (logForm == null || logForm.IsDisposed || logTextBox == null) return;

            try
            {
                string text = ReadLogTail();
                if (logTextBox.Text != text)
                {
                    logTextBox.Text = text;
                    logTextBox.SelectionStart = logTextBox.TextLength;
                    logTextBox.ScrollToCaret();
                }
            }
            catch (Exception ex)
            {
                logTextBox.Text = "Unable to read log: " + ex.Message;
            }
        }

        private string ReadLogTail()
        {
            if (!File.Exists(logPath)) return "No log yet.";

            const int maxBytes = 256 * 1024;
            FileInfo info = new FileInfo(logPath);
            using (FileStream stream = new FileStream(logPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            {
                long start = Math.Max(0, info.Length - maxBytes);
                stream.Seek(start, SeekOrigin.Begin);
                using (StreamReader reader = new StreamReader(stream, Encoding.UTF8))
                {
                    string text = reader.ReadToEnd();
                    if (start > 0) return "... older log omitted ..." + Environment.NewLine + text;
                    return text;
                }
            }
        }

        private void CopyPin()
        {
            if (currentPin.Length == 6 && currentPin != "------")
            {
                Clipboard.SetText(currentPin);
                SetStatus("PIN copied. Enter it on your phone.", "#166b8f");
            }
        }

        private static bool IsPin(string value)
        {
            if (string.IsNullOrEmpty(value) || value.Length != 6) return false;
            foreach (char ch in value)
            {
                if (ch < '0' || ch > '9') return false;
            }
            return true;
        }

        private void LoadSavedPin()
        {
            try
            {
                if (File.Exists(pinPath))
                {
                    string value = File.ReadAllText(pinPath, Encoding.UTF8).Trim();
                    if (IsPin(value)) currentPin = value;
                }
            }
            catch { }
        }

        private void SavePin(string value)
        {
            if (!IsPin(value)) return;
            try
            {
                if (!Directory.Exists(appDir)) Directory.CreateDirectory(appDir);
                File.WriteAllText(pinPath, value, Encoding.UTF8);
            }
            catch { }
        }

        private static bool IsClientId(string value)
        {
            if (string.IsNullOrEmpty(value) || value.Length != 32) return false;
            foreach (char ch in value)
            {
                bool digit = ch >= '0' && ch <= '9';
                bool lowerHex = ch >= 'a' && ch <= 'f';
                bool upperHex = ch >= 'A' && ch <= 'F';
                if (!digit && !lowerHex && !upperHex) return false;
            }
            return true;
        }

        private string LoadOrCreateClientId()
        {
            try
            {
                if (File.Exists(clientIdPath))
                {
                    string saved = File.ReadAllText(clientIdPath, Encoding.UTF8).Trim();
                    if (IsClientId(saved)) return saved.ToLowerInvariant();
                }

                if (!Directory.Exists(appDir)) Directory.CreateDirectory(appDir);
                string created = Guid.NewGuid().ToString("N");
                File.WriteAllText(clientIdPath, created, Encoding.UTF8);
                return created;
            }
            catch
            {
                return Guid.NewGuid().ToString("N");
            }
        }

        private void StartAgent()
        {
            stopping = false;
            if (workerThread != null && workerThread.IsAlive) return;
            workerThread = new Thread(WorkerLoop);
            workerThread.IsBackground = true;
            workerThread.Start();
        }

        private void StopAgent()
        {
            stopping = true;
            SetStatus("Stopped", "#b42318");
        }

        private void RestartAgent()
        {
            stopping = true;
            Thread.Sleep(300);
            agentId = "";
            token = "";
            currentPin = "------";
            StartAgent();
        }

        private void WorkerLoop()
        {
            while (!stopping)
            {
                try
                {
                    Connect();
                    PollLoop();
                }
                catch (Exception ex)
                {
                    if (!stopping)
                    {
                        SetStatus("Connection error: " + ex.Message, "#b42318");
                        Thread.Sleep(5000);
                    }
                }
            }
        }

        private void Connect()
        {
            SetStatus("Connecting to server...", "#0f536f");
            Dictionary<string, object> payload = new Dictionary<string, object>();
            payload["clientId"] = clientId;
            payload["host"] = Environment.MachineName;
            payload["platform"] = "win32";
            payload["roots"] = RootPayloads();
            payload["version"] = "1.1.0-winforms";
            if (IsPin(currentPin))
            {
                payload["pairingPin"] = currentPin;
            }

            Dictionary<string, object> data = PostJson("/api/agent/connect", payload, 35000);
            agentId = Convert.ToString(data["agentId"]);
            token = Convert.ToString(data["token"]);
            currentPin = Convert.ToString(data["pairingPin"]);
            SavePin(currentPin);
            SetStatus("Ready. Enter this PIN on your phone.", "#166b8f");
            ShowTrayMessage("Phone Remote Agent", "New pairing PIN: " + currentPin);
        }

        private void PollLoop()
        {
            int delay = 1000;
            while (!stopping)
            {
                try
                {
                    Dictionary<string, object> payload = new Dictionary<string, object>();
                    payload["agentId"] = agentId;
                    payload["token"] = token;
                    Dictionary<string, object> data = PostJson("/api/agent/poll", payload, 45000);
                    delay = 1000;
                    if (data.ContainsKey("command") && data["command"] != null)
                    {
                        HandleCommand((Dictionary<string, object>)data["command"]);
                    }
                }
                catch (WebException ex)
                {
                    if (GetStatusCode(ex) == 401)
                    {
                        SetStatus("Session expired. Reconnecting...", "#8a5a12");
                        break;
                    }
                    SetStatus("Waiting for server...", "#8a5a12");
                    Thread.Sleep(delay);
                    delay = Math.Min((int)(delay * 1.5) + 500, 10000);
                }
                catch (Exception ex)
                {
                    SetStatus("Agent error: " + ex.Message, "#b42318");
                    Thread.Sleep(delay);
                    delay = Math.Min((int)(delay * 1.5) + 500, 10000);
                }
            }
        }

        private static int GetStatusCode(WebException ex)
        {
            HttpWebResponse response = ex.Response as HttpWebResponse;
            return response == null ? 0 : (int)response.StatusCode;
        }

        private void HandleCommand(Dictionary<string, object> command)
        {
            string id = Convert.ToString(command["id"]);
            string type = Convert.ToString(command["type"]);
            Dictionary<string, object> payload = command.ContainsKey("payload") && command["payload"] != null
                ? (Dictionary<string, object>)command["payload"]
                : new Dictionary<string, object>();

            try
            {
                if (type == "list")
                {
                    SendResult(id, ListDirectory(payload), "");
                    return;
                }
                if (type == "search")
                {
                    SendResult(id, SearchFiles(payload), "");
                    return;
                }
                if (type == "download")
                {
                    StartDownload(id, payload);
                    return;
                }
                throw new Exception("Unknown command: " + type);
            }
            catch (Exception ex)
            {
                Log("Command error [" + type + "]: " + ex.Message);
                SafeSendResult(id, null, ex.Message);
            }
        }

        private void StartDownload(string requestId, Dictionary<string, object> payload)
        {
            lock (stateLock)
            {
                if (activeDownloads >= MaxActiveDownloads)
                {
                    throw new Exception("Too many downloads are running. Please wait for one to finish.");
                }
                activeDownloads++;
            }
            Thread thread = new Thread(delegate()
            {
                try
                {
                    UploadFile(requestId, payload);
                }
                catch (Exception ex)
                {
                    Log("Download error: " + ex.Message);
                    SafeSendResult(requestId, null, ex.Message);
                }
                finally
                {
                    lock (stateLock)
                    {
                        activeDownloads--;
                    }
                }
            });
            thread.IsBackground = true;
            thread.Start();
            SetStatus("Downloading in background. You can keep browsing.", "#166b8f");
        }

        private Dictionary<string, object> ListDirectory(Dictionary<string, object> payload)
        {
            ResolvedPath resolved = ResolveAgentPath(GetString(payload, "rootId"), GetString(payload, "path"));
            DirectoryInfo dir = new DirectoryInfo(resolved.Target);
            if (!dir.Exists) throw new Exception("Target is not a folder.");

            List<Dictionary<string, object>> items = new List<Dictionary<string, object>>();
            foreach (FileSystemInfo entry in dir.GetFileSystemInfos())
            {
                try { items.Add(EntryPayload(resolved.Root, resolved.RelPath, entry)); }
                catch { }
            }

            items.Sort(CompareEntries);
            Dictionary<string, object> result = new Dictionary<string, object>();
            result["root"] = resolved.Root.ToPayload();
            result["path"] = ToSlash(resolved.RelPath);
            string parent = string.IsNullOrEmpty(resolved.RelPath) ? "" : Path.GetDirectoryName(resolved.RelPath) ?? "";
            result["parentPath"] = ToSlash(parent);
            result["items"] = items;
            return result;
        }

        private Dictionary<string, object> SearchFiles(Dictionary<string, object> payload)
        {
            string query = GetString(payload, "q").Trim().ToLowerInvariant();
            if (query.Length < 2) throw new Exception("Search query must contain at least 2 characters.");

            int limit = Math.Min(GetInt(payload, "limit", 80), MaxSearchResults);
            ResolvedPath resolved = ResolveAgentPath(GetString(payload, "rootId"), GetString(payload, "path"));
            List<Dictionary<string, object>> results = new List<Dictionary<string, object>>();
            Queue<SearchNode> queue = new Queue<SearchNode>();
            queue.Enqueue(new SearchNode(resolved.Target, resolved.RelPath));
            int scannedDirs = 0;
            bool truncated = false;

            while (queue.Count > 0 && results.Count < limit)
            {
                if (scannedDirs >= MaxSearchDirs)
                {
                    truncated = true;
                    break;
                }

                SearchNode current = queue.Dequeue();
                scannedDirs++;

                DirectoryInfo dir = new DirectoryInfo(current.Abs);
                FileSystemInfo[] entries;
                try { entries = dir.GetFileSystemInfos(); }
                catch { continue; }

                foreach (FileSystemInfo entry in entries)
                {
                    string lowerName = entry.Name.ToLowerInvariant();
                    if (lowerName.Contains(query))
                    {
                        try
                        {
                            results.Add(EntryPayload(resolved.Root, current.Rel, entry));
                            if (results.Count >= limit) break;
                        }
                        catch { }
                    }

                    DirectoryInfo childDir = entry as DirectoryInfo;
                    if (childDir != null && !excludedDirs.Contains(lowerName))
                    {
                        queue.Enqueue(new SearchNode(childDir.FullName, Path.Combine(current.Rel, entry.Name)));
                    }
                }
            }

            Dictionary<string, object> result = new Dictionary<string, object>();
            result["query"] = query;
            result["root"] = resolved.Root.ToPayload();
            result["path"] = ToSlash(resolved.RelPath);
            result["results"] = results;
            result["scannedDirs"] = scannedDirs;
            result["truncated"] = truncated || results.Count >= limit;
            return result;
        }

        private void UploadFile(string requestId, Dictionary<string, object> payload)
        {
            ResolvedPath resolved = ResolveAgentPath(GetString(payload, "rootId"), GetString(payload, "path"));
            FileInfo file = new FileInfo(resolved.Target);
            if (!file.Exists || (file.Attributes & FileAttributes.Directory) != 0)
            {
                throw new Exception("Only files can be downloaded.");
            }

            Log("Upload start: " + file.FullName + " (" + file.Length + " bytes)");
            Dictionary<string, object> meta = new Dictionary<string, object>();
            meta["prepareMeta"] = true;
            meta["name"] = file.Name;
            meta["size"] = file.Length;
            SafeSendResult(requestId, meta, "");

            string url = serverUrl + "/api/agent/upload?requestId=" + Uri.EscapeDataString(requestId);
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
            request.Method = "POST";
            request.ContentType = "application/octet-stream";
            request.Timeout = 30 * 60 * 1000;
            request.ReadWriteTimeout = 30 * 60 * 1000;
            request.KeepAlive = false;
            request.UserAgent = "PhoneRemoteAgent/1.2";
            request.Headers["x-agent-id"] = agentId;
            request.Headers["x-agent-token"] = token;
            request.Headers["x-file-name"] = Uri.EscapeDataString(file.Name);
            request.Headers["x-file-size"] = file.Length.ToString();
            request.ContentLength = file.Length;

            byte[] buffer = new byte[1024 * 128];
            using (Stream input = file.OpenRead())
            using (Stream output = request.GetRequestStream())
            {
                int read;
                while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
                {
                    output.Write(buffer, 0, read);
                }
            }

            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            {
                if ((int)response.StatusCode < 200 || (int)response.StatusCode >= 300)
                {
                    throw new Exception("Upload failed: " + response.StatusCode);
                }
            }
            Log("Upload finished: " + file.Name);
        }

        private void SendResult(string requestId, object result, string error)
        {
            Dictionary<string, object> payload = new Dictionary<string, object>();
            payload["agentId"] = agentId;
            payload["token"] = token;
            payload["requestId"] = requestId;
            payload["result"] = result;
            payload["error"] = error ?? "";
            PostJson("/api/agent/result", payload, 30000);
        }

        private void SafeSendResult(string requestId, object result, string error)
        {
            try
            {
                SendResult(requestId, result, error);
            }
            catch (Exception ex)
            {
                Log("Unable to report command result: " + ex.Message);
            }
        }

        private Dictionary<string, object> PostJson(string route, Dictionary<string, object> payload, int timeoutMs)
        {
            string body = json.Serialize(payload);
            byte[] bytes = Encoding.UTF8.GetBytes(body);
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(serverUrl + route);
            request.Method = "POST";
            request.ContentType = "application/json; charset=utf-8";
            request.Timeout = timeoutMs;
            request.ReadWriteTimeout = timeoutMs;
            request.KeepAlive = false;
            request.UserAgent = "PhoneRemoteAgent/1.2";
            request.ContentLength = bytes.Length;
            using (Stream stream = request.GetRequestStream())
            {
                stream.Write(bytes, 0, bytes.Length);
            }

            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            using (Stream responseStream = response.GetResponseStream())
            using (StreamReader reader = new StreamReader(responseStream, Encoding.UTF8))
            {
                string text = reader.ReadToEnd();
                object parsed = string.IsNullOrEmpty(text) ? new Dictionary<string, object>() : json.DeserializeObject(text);
                return (Dictionary<string, object>)parsed;
            }
        }

        private void BuildRoots()
        {
            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            AddRoot("User", home, "home");
            AddRoot("Desktop", Path.Combine(home, "Desktop"), "folder");
            AddRoot("Downloads", Path.Combine(home, "Downloads"), "folder");
            AddRoot("Documents", Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "folder");

            foreach (DriveInfo drive in DriveInfo.GetDrives())
            {
                try
                {
                    if (drive.IsReady) AddRoot("Drive " + drive.Name.TrimEnd('\\'), drive.RootDirectory.FullName, "drive");
                }
                catch { }
            }
        }

        private void AddRoot(string label, string path, string kind)
        {
            if (string.IsNullOrEmpty(path) || !Directory.Exists(path)) return;
            string full = Path.GetFullPath(path);
            foreach (RootItem item in roots)
            {
                if (string.Equals(item.Path, full, StringComparison.OrdinalIgnoreCase)) return;
            }
            roots.Add(new RootItem("root-" + roots.Count, label, kind, full));
        }

        private List<Dictionary<string, object>> RootPayloads()
        {
            List<Dictionary<string, object>> list = new List<Dictionary<string, object>>();
            foreach (RootItem root in roots) list.Add(root.ToPayload());
            return list;
        }

        private ResolvedPath ResolveAgentPath(string rootId, string relPath)
        {
            RootItem root = roots.Count > 0 ? roots[0] : null;
            foreach (RootItem item in roots)
            {
                if (item.Id == rootId)
                {
                    root = item;
                    break;
                }
            }
            if (root == null) throw new Exception("No readable root was found.");

            string normalized = NormalizeRelPath(relPath);
            string target = Path.GetFullPath(Path.Combine(root.Path, normalized));
            string rootFull = Path.GetFullPath(root.Path);
            string prefix = rootFull.EndsWith(Path.DirectorySeparatorChar.ToString()) ? rootFull : rootFull + Path.DirectorySeparatorChar;
            if (!string.Equals(target, rootFull, StringComparison.OrdinalIgnoreCase) &&
                !target.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            {
                throw new Exception("Path is outside the selected root.");
            }
            return new ResolvedPath(root, normalized, target);
        }

        private static string NormalizeRelPath(string value)
        {
            string raw = (value ?? "").Replace('\\', '/').TrimStart('/');
            if (string.IsNullOrWhiteSpace(raw)) return "";
            string[] parts = raw.Split('/');
            foreach (string part in parts)
            {
                if (part == "..") throw new Exception("Invalid path.");
            }
            if (Path.IsPathRooted(raw)) throw new Exception("Invalid path.");
            return Path.GetFullPath(Path.Combine("C:\\", raw)).Substring(3);
        }

        private Dictionary<string, object> EntryPayload(RootItem root, string relPath, FileSystemInfo entry)
        {
            bool isDir = (entry.Attributes & FileAttributes.Directory) != 0;
            FileInfo file = entry as FileInfo;
            Dictionary<string, object> payload = new Dictionary<string, object>();
            payload["name"] = entry.Name;
            payload["relPath"] = ToSlash(Path.Combine(relPath, entry.Name));
            payload["rootId"] = root.Id;
            payload["rootLabel"] = root.Label;
            payload["isDir"] = isDir;
            payload["type"] = isDir ? "folder" : "file";
            payload["size"] = isDir || file == null ? null : (object)file.Length;
            payload["sizeLabel"] = isDir || file == null ? "" : FormatBytes(file.Length);
            payload["mtime"] = entry.LastWriteTimeUtc.ToString("o");
            return payload;
        }

        private static int CompareEntries(Dictionary<string, object> a, Dictionary<string, object> b)
        {
            bool ad = Convert.ToBoolean(a["isDir"]);
            bool bd = Convert.ToBoolean(b["isDir"]);
            if (ad != bd) return ad ? -1 : 1;
            return string.Compare(Convert.ToString(a["name"]), Convert.ToString(b["name"]), StringComparison.CurrentCultureIgnoreCase);
        }

        private static string ToSlash(string value)
        {
            return (value ?? "").Replace('\\', '/');
        }

        private static string FormatBytes(long bytes)
        {
            string[] units = { "B", "KB", "MB", "GB", "TB" };
            double value = bytes;
            int index = 0;
            while (value >= 1024 && index < units.Length - 1)
            {
                value /= 1024;
                index++;
            }
            return (value >= 10 || index == 0 ? value.ToString("0") : value.ToString("0.0")) + " " + units[index];
        }

        private static string GetString(Dictionary<string, object> data, string key)
        {
            return data.ContainsKey(key) && data[key] != null ? Convert.ToString(data[key]) : "";
        }

        private static int GetInt(Dictionary<string, object> data, string key, int fallback)
        {
            if (!data.ContainsKey(key) || data[key] == null) return fallback;
            try { return Convert.ToInt32(data[key]); }
            catch { return fallback; }
        }
    }

    internal sealed class RootItem
    {
        public readonly string Id;
        public readonly string Label;
        public readonly string Kind;
        public readonly string Path;

        public RootItem(string id, string label, string kind, string path)
        {
            Id = id;
            Label = label;
            Kind = kind;
            Path = path;
        }

        public Dictionary<string, object> ToPayload()
        {
            Dictionary<string, object> payload = new Dictionary<string, object>();
            payload["id"] = Id;
            payload["label"] = Label;
            payload["kind"] = Kind;
            payload["path"] = Path;
            return payload;
        }
    }

    internal sealed class ResolvedPath
    {
        public readonly RootItem Root;
        public readonly string RelPath;
        public readonly string Target;

        public ResolvedPath(RootItem root, string relPath, string target)
        {
            Root = root;
            RelPath = relPath;
            Target = target;
        }
    }

    internal sealed class SearchNode
    {
        public readonly string Abs;
        public readonly string Rel;

        public SearchNode(string abs, string rel)
        {
            Abs = abs;
            Rel = rel;
        }
    }
}
